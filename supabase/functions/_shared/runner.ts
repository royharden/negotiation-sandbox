import { scriptedAction } from "./agents.ts";
import { createFixtureCursor, fixtureCompatible, FixtureNotApplicable } from "./fixtureAgent.ts";
import type { SyntheticFixture } from "./fixtureAgent.ts";
import { canonicalJson, utf8Length } from "./hash.ts";
import { instantiate } from "./instantiate.ts";
import { promptFingerprint } from "./prompt.ts";
import { applyAction, buildView, initialState, maxTurns, parseActionText } from "./referee.ts";
import { REQUEST_LIMITS } from "./request.ts";
import type { RepairFeedback } from "./request.ts";
import { policySeedFor } from "./rng.ts";
import { agentKey, findCell, planMatches } from "./runspec.ts";
import type { CellSpec, PlannedMatch, RunSpec } from "./runspec.ts";
import { scoreGame, scoreMatch } from "./score.ts";
import type {
  Action,
  AgentConfig,
  AgentId,
  AgentView,
  AttemptRecord,
  GameState,
  Instance,
  LiveCallInfo,
  MatchMetrics,
  MatchStatus,
  PlayResult,
  Role,
  Scenario,
  ScriptedId,
} from "./types.ts";
import { rulesetOf } from "./utility.ts";

export class ModelBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBlocked";
  }
}

export class FormatFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatFailure";
  }
}

// ---------------------------------------------------------------------------
// Legacy v1 runner (historical behaviour and oracles; kept for v1 rows and tests).
// ---------------------------------------------------------------------------

export async function playGame(input: {
  scenario: Scenario;
  seed: number;
  buyerAgent: AgentId;
  sellerAgent: AgentId;
  decide: (view: AgentView) => Action | Promise<Action>;
}): Promise<PlayResult> {
  const promptHash = promptFingerprint(input.scenario);
  let state = initialState(input.scenario);
  const cap = maxTurns(input.scenario);

  while (!state.terminal) {
    if (state.turnsPlayed >= cap) {
      state = { ...state, terminal: { kind: "disagreement", reason: "cap" } };
      break;
    }
    const role = state.nextRole;
    const view = buildView(input.scenario, state, role, input.seed);
    let action: Action;
    try {
      action = await input.decide(view);
    } catch (error) {
      if (error instanceof ModelBlocked) {
        return baseResult(input, state, promptHash, "blocked", null, error.message);
      }
      const reason = error instanceof Error ? error.message : "agent failed";
      return baseResult(input, state, promptHash, "format_failure", scoreGame(input.scenario, state, { role, reason }), reason);
    }
    const next = applyAction(input.scenario, state, role, action);
    if (!next.ok) {
      return baseResult(input, state, promptHash, "format_failure", scoreGame(input.scenario, state, { role, reason: next.error }), next.error);
    }
    state = next.state;
  }

  return baseResult(input, state, promptHash, "complete", scoreGame(input.scenario, state));
}

export async function runBatch(input: {
  scenario: Scenario;
  seeds: number[];
  pairings: Array<{ buyer: AgentId; seller: AgentId }>;
  decide?: (pairing: { buyer: AgentId; seller: AgentId }, view: AgentView) => Action | Promise<Action>;
  stopOnBlocked?: boolean;
}): Promise<PlayResult[]> {
  const rows: PlayResult[] = [];
  for (const seed of input.seeds) {
    for (const pairing of input.pairings) {
      const scripted = pairing.buyer !== "model" && pairing.seller !== "model";
      const decide = input.decide
        ? (view: AgentView) => input.decide!(pairing, view)
        : scripted
          ? (view: AgentView) => scriptedAction(asScripted(pairing[view.role]), view)
          : () => {
              throw new ModelBlocked("A model pairing needs a signed-in model caller.");
            };
      const row = await playGame({
        scenario: input.scenario,
        seed,
        buyerAgent: pairing.buyer,
        sellerAgent: pairing.seller,
        decide,
      });
      rows.push(row);
      if (input.stopOnBlocked && row.status === "blocked") return rows;
    }
  }
  return rows;
}

export function scriptedDecide(pairing: { buyer: ScriptedId; seller: ScriptedId }): (view: AgentView) => Action {
  return (view) => scriptedAction(pairing[view.role], view);
}

function asScripted(agent: AgentId): ScriptedId {
  if (agent === "model") throw new ModelBlocked("scripted decide was given a model");
  return agent;
}

function baseResult(
  input: { seed: number; buyerAgent: AgentId; sellerAgent: AgentId },
  state: GameState,
  promptHash: string,
  status: PlayResult["status"],
  scores: PlayResult["scores"],
  error?: string,
): PlayResult {
  return {
    seed: input.seed,
    buyerAgent: input.buyerAgent,
    sellerAgent: input.sellerAgent,
    status,
    history: state.history,
    scores,
    promptHash,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// v2 match runner (PLAN 4.3, 6.1): attempt records, one error-informed repair for model/fixture seats,
// distinct failure statuses, fresh per-match seat state, sequential matrix with cancellation.
// ---------------------------------------------------------------------------

export class ProviderFailure extends Error {
  readonly category: string;
  readonly live: LiveCallInfo | null;
  /** True when a paid request may have been dispatched but its result is unknown (no auto-retry). */
  readonly uncertain: boolean;
  constructor(message: string, category: string, live: LiveCallInfo | null = null, uncertain = false) {
    super(message);
    this.name = "ProviderFailure";
    this.category = category;
    this.live = live;
    this.uncertain = uncertain;
  }
}

export class MatchCancelled extends Error {
  constructor(message = "cancelled by the operator") {
    super(message);
    this.name = "MatchCancelled";
  }
}

export type SeatContext = {
  scenario: Scenario;
  instance: Instance;
  state: GameState;
  role: Role;
  legalTurn: number;
  attemptNo: 1 | 2;
  view: AgentView;
  config: AgentConfig;
  repair: RepairFeedback | null;
  /** live call id of the invalid first attempt, for a model repair. */
  repairOf: string | null;
  executionId: string;
  /** The other role's configuration (fixture seats check their declared compatibility against it). */
  opponent: AgentConfig;
};

export type SeatDecision = { raw: string; live?: LiveCallInfo | null };
export type Seat = (context: SeatContext) => SeatDecision | Promise<SeatDecision>;

export type MatchExecution = {
  executionId: string;
  cellId: string;
  instanceSeed: number;
  replicate: number;
  policySeeds: Record<Role, number>;
  status: MatchStatus;
  state: GameState;
  attempts: AttemptRecord[];
  failureRole: Role | null;
  failureReason: string | null;
  /** Live metadata of a provider call that failed or became uncertain (may represent a paid request). */
  failureCall: LiveCallInfo | null;
  metrics: MatchMetrics;
};

export function scriptedSeat(policy: ScriptedId): Seat {
  return ({ view }) => ({ raw: canonicalJson(scriptedAction(policy, view)) });
}

/**
 * Each call returns a seat with a fresh cursor, so fixture state never leaks across matches. The seat
 * refuses (fixture_not_applicable) outside its declared definition/seed/role/opponent cell.
 */
export function fixtureSeat(fixture: SyntheticFixture): Seat {
  const next = createFixtureCursor(fixture);
  return ({ legalTurn, attemptNo, state, instance, role, opponent }) => {
    if (!fixtureCompatible(fixture, instance.scenario, instance.instanceSeed, role, opponent)) {
      throw new FixtureNotApplicable(`fixture ${fixture.id} is declared only for ${fixture.compatible.definitionId} seeds ${fixture.compatible.instanceSeeds.join(",")} as ${fixture.compatible.role} against its declared opponent`);
    }
    return { raw: next({ legalTurn, attemptNo, standingRole: state.standing?.role ?? null }) };
  };
}

export function boundRaw(raw: string): { raw: string; tooLong: boolean } {
  if (utf8Length(raw) <= REQUEST_LIMITS.maxRawOutputBytes) return { raw, tooLong: false };
  let cut = raw.slice(0, REQUEST_LIMITS.maxRawOutputBytes);
  while (utf8Length(cut) > REQUEST_LIMITS.maxRawOutputBytes) cut = cut.slice(0, -1);
  return { raw: cut, tooLong: true };
}

export function policySeedsFor(instance: Instance, replicate: number): Record<Role, number> {
  const ruleset = rulesetOf(instance.scenario);
  const seed = (role: Role) => policySeedFor({ ruleset, definitionDigest: instance.definitionDigest, instanceSeed: instance.instanceSeed, replicate, role });
  return { buyer: seed("buyer"), seller: seed("seller") };
}

export const RAW_TOO_LONG_ERROR = `output is larger than ${REQUEST_LIMITS.maxRawOutputBytes} bytes`;

/**
 * Validate one raw attempt exactly as the referee will: strict whole-output parse, then the transition.
 * Shared by the runner, the edge function and transcript verification.
 */
export function judgeAttempt(scenario: Scenario, state: GameState, role: Role, raw: string): { ok: true; action: Action; state: GameState } | { ok: false; parsed: Action | null; error: string } {
  const parsed = parseActionText(raw, rulesetOf(scenario));
  if (!parsed.ok) return { ok: false, parsed: null, error: parsed.error };
  const next = applyAction(scenario, state, role, parsed.action);
  if (!next.ok) return { ok: false, parsed: parsed.action, error: next.error };
  return { ok: true, action: parsed.action, state: next.state };
}

export async function playMatch(input: {
  instance: Instance;
  cell: CellSpec;
  replicate: number;
  executionId: string;
  seats: Record<Role, Seat>;
  isCancelled?: () => boolean;
}): Promise<MatchExecution> {
  const scenario = input.instance.scenario;
  const policySeeds = policySeedsFor(input.instance, input.replicate);
  let state = initialState(scenario);
  const attempts: AttemptRecord[] = [];

  let failureCall: LiveCallInfo | null = null;
  const finish = (status: MatchStatus, failureRole: Role | null = null, failureReason: string | null = null): MatchExecution => ({
    executionId: input.executionId,
    cellId: input.cell.cellId,
    instanceSeed: input.instance.instanceSeed,
    replicate: input.replicate,
    policySeeds,
    status,
    state,
    attempts,
    failureRole,
    failureReason,
    failureCall,
    metrics: scoreMatch({ scenario, gridKey: input.instance.instanceId, state, status, failureRole, failureReason, attempts }),
  });

  while (!state.terminal) {
    if (input.isCancelled?.()) return finish("cancelled", null, "cancelled by the operator");
    const role = state.nextRole;
    const config = input.cell.roles[role];
    const legalTurn = state.history.length;
    let repair: RepairFeedback | null = null;
    let repairOf: string | null = null;
    let advanced = false;

    for (const attemptNo of [1, 2] as const) {
      const view = buildView(scenario, state, role, policySeeds[role]);
      let decision: SeatDecision;
      try {
        decision = await input.seats[role]({
          scenario,
          instance: input.instance,
          state,
          role,
          legalTurn,
          attemptNo,
          view,
          config,
          repair,
          repairOf,
          executionId: input.executionId,
          opponent: input.cell.roles[role === "buyer" ? "seller" : "buyer"],
        });
      } catch (error) {
        if (error instanceof MatchCancelled) return finish("cancelled", role, error.message);
        if (error instanceof ModelBlocked) return finish("blocked", role, error.message);
        if (error instanceof FixtureNotApplicable) return finish("blocked", role, `fixture_not_applicable: ${error.message}`);
        if (error instanceof ProviderFailure) {
          failureCall = error.live;
          return finish(error.uncertain ? "incomplete" : "provider_error", role, `${error.category}: ${error.message}`);
        }
        // A scripted policy throwing is a recorded policy defect, never replaced with a fallback action.
        return finish("format_failure", role, `agent_error: ${error instanceof Error ? error.message : "seat failed"}`);
      }
      const bounded = boundRaw(decision.raw);
      const judged = bounded.tooLong
        ? { ok: false as const, parsed: null, error: RAW_TOO_LONG_ERROR }
        : judgeAttempt(scenario, state, role, bounded.raw);
      attempts.push({
        index: attempts.length,
        role,
        legalTurn,
        attemptNo,
        agentKey: agentKey(config),
        raw: bounded.raw,
        rawTruncated: bounded.tooLong,
        parsed: judged.ok ? judged.action : judged.parsed,
        verdict: judged.ok ? "legal" : "invalid",
        error: judged.ok ? null : judged.error,
        live: decision.live ?? null,
      });
      if (judged.ok) {
        state = judged.state;
        advanced = true;
        break;
      }
      if (config.kind === "scripted" || attemptNo === 2) {
        return finish("format_failure", role, judged.error);
      }
      repair = { priorOutput: bounded.raw, validationError: judged.error };
      repairOf = decision.live?.modelCallId ?? null;
    }
    if (!advanced) return finish("format_failure", role, "no legal action");
  }
  return finish("complete");
}

export type MatrixProgress = { planned: PlannedMatch[]; done: MatchExecution[]; current: PlannedMatch | null };

/**
 * Plan the whole matrix first, then run sequentially, yielding between matches. A blocked cell does not
 * stop independent cells; cancellation leaves the remaining planned matches not_started.
 */
export async function runMatrix(input: {
  spec: RunSpec;
  seatsFor: (cell: CellSpec, planned: PlannedMatch) => Record<Role, Seat>;
  newExecutionId: () => string;
  isCancelled?: () => boolean;
  onProgress?: (progress: MatrixProgress) => void;
  skip?: (planned: PlannedMatch) => boolean;
  yieldBetween?: () => Promise<void>;
}): Promise<{ planned: PlannedMatch[]; executions: Array<MatchExecution & { planIndex: number }>; cancelled: boolean }> {
  const planned = planMatches(input.spec);
  const executions: Array<MatchExecution & { planIndex: number }> = [];
  const instances = new Map<number, Instance>();
  for (const match of planned) {
    if (input.isCancelled?.()) return { planned, executions, cancelled: true };
    if (input.skip?.(match)) continue;
    const cell = findCell(input.spec, match.cellId);
    if (!cell) continue;
    let instance = instances.get(match.instanceSeed);
    if (!instance) {
      const built = instantiate(input.spec.definition, match.instanceSeed);
      if (!built.ok) throw new Error(built.error);
      instance = built.instance;
      instances.set(match.instanceSeed, instance);
    }
    input.onProgress?.({ planned, done: executions, current: match });
    const execution = await playMatch({
      instance,
      cell,
      replicate: match.replicate,
      executionId: input.newExecutionId(),
      seats: input.seatsFor(cell, match),
      isCancelled: input.isCancelled,
    });
    executions.push({ ...execution, planIndex: match.planIndex });
    input.onProgress?.({ planned, done: executions, current: null });
    if (input.yieldBetween) await input.yieldBetween();
  }
  return { planned, executions, cancelled: input.isCancelled?.() ?? false };
}
