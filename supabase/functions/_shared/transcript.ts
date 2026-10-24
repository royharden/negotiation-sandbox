import { scriptedAction } from "./agents.ts";
import { createFixtureCursor, fixtureCompatible, fixtureDigest, FixtureNotApplicable, parseFixture } from "./fixtureAgent.ts";
import type { SyntheticFixture } from "./fixtureAgent.ts";
import { canonicalJson, digestOf, isSha256Hex, utf8Length } from "./hash.ts";
import { verifyInstance } from "./instantiate.ts";
import { parseJsonStrict } from "./json.ts";
import { templateDigests } from "./prompt.ts";
import { buildView, initialState } from "./referee.ts";
import { REQUEST_LIMITS } from "./request.ts";
import { boundRaw, fixtureNotDeclaredMessage, judgeAttempt, OPERATOR_CANCEL_REASON, policySeedsFor, RAW_TOO_LONG_ERROR } from "./runner.ts";
import type { MatchExecution } from "./runner.ts";
import { agentClass, agentKey, cellKey, currentVersions, findCell, runSpecDigest, validateRunSpec } from "./runspec.ts";
import type { RunSpec, RunVersions } from "./runspec.ts";
import { isRecord, parseDefinition } from "./scenario.ts";
import { scoreMatch } from "./score.ts";
import type { AgentConfig, AttemptRecord, GameState, Instance, LiveCallInfo, MatchMetrics, MatchStatus, PromptVariant, Role, ScenarioDefinition } from "./types.ts";

export const TRANSCRIPT_VERSION = 2 as const;
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
export const MAX_ATTEMPTS_PER_MATCH = 80;

export type TranscriptHeader = {
  record: "header";
  transcriptVersion: typeof TRANSCRIPT_VERSION;
  definition: ScenarioDefinition;
  definitionDigest: string;
  instance: Instance;
  runSpec: RunSpec;
  runSpecDigest: string;
  executionId: string;
  cellId: string;
  cellKey: string;
  agentClass: "scripted" | "synthetic" | "live";
  instanceSeed: number;
  replicate: number;
  policySeeds: Record<Role, number>;
  roles: Record<Role, AgentConfig>;
  versions: RunVersions;
  templateDigests: Record<PromptVariant, string>;
  /** Full documents of any synthetic fixture seats, so replay can check their authored attempts. */
  fixtures: SyntheticFixture[];
  gitSha: string | null;
};

export type TranscriptAttempt = { record: "attempt"; transcriptVersion: typeof TRANSCRIPT_VERSION } & AttemptRecord;

export type TranscriptFooter = {
  record: "footer";
  transcriptVersion: typeof TRANSCRIPT_VERSION;
  status: MatchStatus;
  failureRole: Role | null;
  failureReason: string | null;
  /** Live metadata of a failed/uncertain provider call, kept so a possibly paid request is never lost. */
  failureCall: LiveCallInfo | null;
  /** SHA-256 of canonical {header, attempts}; the footer itself is excluded. */
  contentSha256: string;
  /** Cached derived metrics. Never trusted: recomputed on every import/load. */
  metrics: MatchMetrics;
};

export type TranscriptDocument = { header: TranscriptHeader; attempts: TranscriptAttempt[]; footer: TranscriptFooter | null };

export function contentDigest(header: TranscriptHeader, attempts: TranscriptAttempt[]): string {
  return digestOf({ header, attempts });
}

export function buildTranscript(input: {
  spec: RunSpec;
  instance: Instance;
  execution: MatchExecution;
  fixtures?: SyntheticFixture[];
  gitSha?: string | null;
}): TranscriptDocument {
  const cell = findCell(input.spec, input.execution.cellId);
  if (!cell) throw new Error(`run spec has no cell ${input.execution.cellId}`);
  const header: TranscriptHeader = {
    record: "header",
    transcriptVersion: TRANSCRIPT_VERSION,
    definition: input.spec.definition,
    definitionDigest: input.spec.definitionDigest,
    instance: input.instance,
    runSpec: input.spec,
    runSpecDigest: runSpecDigest(input.spec),
    executionId: input.execution.executionId,
    cellId: cell.cellId,
    cellKey: cellKey(input.spec, cell),
    agentClass: agentClass(cell),
    instanceSeed: input.execution.instanceSeed,
    replicate: input.execution.replicate,
    policySeeds: input.execution.policySeeds,
    roles: cell.roles,
    versions: input.spec.versions,
    templateDigests: templateDigests(),
    fixtures: (input.fixtures ?? []).filter((fixture) =>
      [cell.roles.buyer, cell.roles.seller].some((config) => config.kind === "fixture" && config.fixtureId === fixture.id)),
    gitSha: input.gitSha ?? input.spec.gitSha,
  };
  const attempts: TranscriptAttempt[] = input.execution.attempts.map((attempt) => ({ record: "attempt", transcriptVersion: TRANSCRIPT_VERSION, ...attempt }));
  const openStatuses: MatchStatus[] = ["not_started", "running"];
  const footer: TranscriptFooter | null = openStatuses.includes(input.execution.status)
    ? null
    : {
        record: "footer",
        transcriptVersion: TRANSCRIPT_VERSION,
        status: input.execution.status,
        failureRole: input.execution.failureRole,
        failureReason: input.execution.failureReason,
        failureCall: input.execution.failureCall,
        contentSha256: contentDigest(header, attempts),
        metrics: input.execution.metrics,
      };
  return { header, attempts, footer };
}

/** JSONL: one canonical JSON record per line, header first, footer last (when present). */
export function encodeJsonl(document: TranscriptDocument): string {
  const lines = [document.header, ...document.attempts, ...(document.footer ? [document.footer] : [])].map((record) => canonicalJson(record));
  const text = `${lines.join("\n")}\n`;
  if (utf8Length(text) > MAX_TRANSCRIPT_BYTES) throw new Error(`transcript is larger than ${MAX_TRANSCRIPT_BYTES} bytes; it is not truncated`);
  return text;
}

export type VerificationReport = {
  /** Every check passed and a footer is present. */
  verified: boolean;
  /** The readable prefix is internally consistent (even without a footer). */
  consistent: boolean;
  problems: string[];
  document: TranscriptDocument;
  recomputed: {
    status: MatchStatus;
    failureRole: Role | null;
    failureReason: string | null;
    state: GameState;
    metrics: MatchMetrics;
    contentSha256: string;
  };
};

const NON_RECOMPUTABLE: readonly MatchStatus[] = ["blocked", "provider_error", "cancelled", "incomplete"];

const HEADER_KEYS = [
  "record", "transcriptVersion", "definition", "definitionDigest", "instance", "runSpec", "runSpecDigest", "executionId",
  "cellId", "cellKey", "agentClass", "instanceSeed", "replicate", "policySeeds", "roles", "versions", "templateDigests", "fixtures", "gitSha",
];
const ATTEMPT_KEYS = ["record", "transcriptVersion", "index", "role", "legalTurn", "attemptNo", "agentKey", "raw", "rawTruncated", "parsed", "verdict", "error", "live"];
const FOOTER_KEYS = ["record", "transcriptVersion", "status", "failureRole", "failureReason", "failureCall", "contentSha256", "metrics"];
const LIVE_KEYS = ["operationId", "modelCallId", "requestDigest", "providerModel", "status", "usage", "latencyMs", "outputDigest"];

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validLive(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !sameKeys(value, LIVE_KEYS)) return false;
  const text = (item: unknown) => item === null || (typeof item === "string" && item.length <= 200);
  return typeof value.operationId === "string" && text(value.modelCallId) && text(value.requestDigest) && text(value.providerModel)
    && typeof value.status === "string" && text(value.outputDigest)
    && (value.latencyMs === null || typeof value.latencyMs === "number")
    && (value.usage === null || isRecord(value.usage));
}

/**
 * Full import/load/resume verification (PLAN 6.2): size/version/shape; snapshots and digests; run spec
 * and cell identity; strict re-parse of every attempt; recomputed verdicts, turn order, repair limits,
 * terminal immutability; scripted/fixture attempts reproduced; all metrics recomputed and compared.
 * Never executes imported code and never initializes a provider.
 */
export function verifyTranscript(text: string): { ok: false; error: string } | { ok: true; report: VerificationReport } {
  if (utf8Length(text) > MAX_TRANSCRIPT_BYTES) return { ok: false, error: `transcript is larger than ${MAX_TRANSCRIPT_BYTES} bytes` };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { ok: false, error: "transcript is empty" };
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseJsonStrict(line.replace(/\r$/, ""));
    if (!parsed.ok || !isRecord(parsed.value)) return { ok: false, error: `line ${index + 1} is not a JSON object${parsed.ok ? "" : `: ${parsed.error}`}` };
    if (parsed.value.transcriptVersion !== TRANSCRIPT_VERSION) return { ok: false, error: `line ${index + 1} has an unsupported transcriptVersion` };
    records.push(parsed.value);
  }
  const head = records[0];
  if (!head || head.record !== "header") return { ok: false, error: "the first record must be the header" };
  const last = records[records.length - 1];
  const hasFooter = records.length > 1 && last?.record === "footer";
  const attemptRecords = records.slice(1, hasFooter ? -1 : undefined);
  if (attemptRecords.some((record) => record.record !== "attempt")) return { ok: false, error: "records between header and footer must be attempts" };
  if (attemptRecords.length > MAX_ATTEMPTS_PER_MATCH) return { ok: false, error: `more than ${MAX_ATTEMPTS_PER_MATCH} attempts` };

  const problems: string[] = [];
  if (!sameKeys(head, HEADER_KEYS)) return { ok: false, error: "header has missing or unknown fields" };
  for (const [index, record] of attemptRecords.entries()) {
    if (!sameKeys(record, ATTEMPT_KEYS)) return { ok: false, error: `attempt ${index} has missing or unknown fields (no private-reasoning or extra fields are allowed)` };
    if (typeof record.rawTruncated !== "boolean" || !validLive(record.live)) return { ok: false, error: `attempt ${index} has malformed truncation or live call fields` };
  }
  if (hasFooter && last && (!sameKeys(last, FOOTER_KEYS) || !validLive(last.failureCall))) return { ok: false, error: "footer has missing or unknown fields" };
  const header = head as unknown as TranscriptHeader;

  // Definition, instance and run spec identity.
  const definition = parseDefinition(header.definition);
  if (!definition.ok) return { ok: false, error: `header definition: ${definition.error}` };
  if (!isSha256Hex(header.definitionDigest) || digestOf(definition.definition) !== header.definitionDigest) problems.push("definition digest does not match the definition");
  const spec = validateRunSpec(header.runSpec);
  if (!spec.ok) return { ok: false, error: `header run spec: ${spec.error}` };
  if (runSpecDigest(spec.spec) !== header.runSpecDigest) problems.push("run spec digest does not match the run spec");
  if (spec.spec.definitionDigest !== header.definitionDigest || digestOf(spec.spec.definition) !== digestOf(definition.definition)) {
    problems.push("run spec definition differs from the header definition");
  }
  const instance = verifyInstance(definition.definition, header.instance);
  if (!instance.ok) return { ok: false, error: `header instance: ${instance.error}` };
  if (header.instanceSeed !== instance.instance.instanceSeed) problems.push("header instance seed differs from the instance snapshot");
  if (!spec.spec.instanceSeeds.includes(header.instanceSeed)) problems.push("instance seed is not in the run spec");
  if (!Number.isInteger(header.replicate) || header.replicate < 0 || header.replicate >= spec.spec.replicates) problems.push("replicate is outside the run spec");
  const cell = findCell(spec.spec, header.cellId);
  if (!cell) return { ok: false, error: `run spec has no cell ${String(header.cellId)}` };
  if (canonicalJson(cell.roles) !== canonicalJson(header.roles)) problems.push("header role configs differ from the run spec cell");
  if (header.cellKey !== cellKey(spec.spec, cell)) problems.push("cell key does not match the cell configuration");
  if (header.agentClass !== agentClass(cell)) problems.push("agent class does not match the cell");
  if (header.gitSha !== null && (typeof header.gitSha !== "string" || !/^[0-9a-f]{7,64}$/.test(header.gitSha))) problems.push("gitSha must be a hex SHA or null");
  if (typeof header.executionId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(header.executionId)) problems.push("execution id is missing or malformed");
  const versions = currentVersions(definition.definition);
  if (canonicalJson(header.versions) !== canonicalJson(versions) || canonicalJson(spec.spec.versions) !== canonicalJson(versions)) {
    problems.push("recorded engine/scoring/prompt/generator versions are not available in this build");
  }
  if (canonicalJson(header.templateDigests) !== canonicalJson(templateDigests())) problems.push("prompt template digests differ from this build (historical template unavailable)");
  const expectedSeeds = policySeedsFor(instance.instance, header.replicate);
  if (canonicalJson(header.policySeeds) !== canonicalJson(expectedSeeds)) problems.push("policy seeds do not match their derivation");

  // Fixture documents for synthetic seats.
  const fixtures = new Map<string, SyntheticFixture>();
  if (!Array.isArray(header.fixtures)) return { ok: false, error: "header fixtures must be an array" };
  for (const raw of header.fixtures) {
    const fixture = parseFixture(raw);
    if (!fixture.ok) return { ok: false, error: `header fixture: ${fixture.error}` };
    fixtures.set(fixture.fixture.id, fixture.fixture);
  }
  const fixtureCursors: Partial<Record<Role, ReturnType<typeof createFixtureCursor>>> = {};
  for (const role of ["buyer", "seller"] as const) {
    const config = cell.roles[role];
    if (config.kind !== "fixture") continue;
    const fixture = fixtures.get(config.fixtureId);
    if (!fixture || fixtureDigest(fixture) !== config.fixtureDigest) {
      problems.push(`fixture ${config.fixtureId} document is missing or its digest differs`);
      continue;
    }
    const opponent = cell.roles[role === "buyer" ? "seller" : "buyer"];
    if (!fixtureCompatible(fixture, definition.definition, header.instanceSeed, role, opponent)) {
      problems.push(`fixture ${config.fixtureId} is not declared for this definition/seed/role/opponent cell`);
    }
    fixtureCursors[role] = createFixtureCursor(fixture);
  }

  // Replay every attempt through the strict parser and referee.
  const scenario = instance.instance.scenario;
  let state = initialState(scenario);
  let status: MatchStatus | null = null;
  let failureRole: Role | null = null;
  let failureReason: string | null = null;
  let pendingRepair: { role: Role; legalTurn: number } | null = null;
  const attempts: TranscriptAttempt[] = [];
  for (const [position, record] of attemptRecords.entries()) {
    const attempt = record as unknown as TranscriptAttempt;
    attempts.push(attempt);
    const where = `attempt ${position}`;
    if (status !== null || state.terminal) {
      problems.push(`${where} follows a terminal state`);
      break;
    }
    if (attempt.index !== position) problems.push(`${where} has index ${String(attempt.index)}`);
    if (attempt.role !== state.nextRole) problems.push(`${where} is out of turn`);
    if (attempt.legalTurn !== state.history.length) problems.push(`${where} has the wrong legal turn`);
    const expectedNo = pendingRepair && pendingRepair.role === attempt.role && pendingRepair.legalTurn === attempt.legalTurn ? 2 : 1;
    if (attempt.attemptNo !== expectedNo) problems.push(`${where} has attempt number ${String(attempt.attemptNo)}, expected ${expectedNo}`);
    const config = cell.roles[attempt.role];
    if (!config) {
      problems.push(`${where} has an unknown role`);
      break;
    }
    if (attempt.agentKey !== agentKey(config)) problems.push(`${where} agent key differs from the cell`);
    if (typeof attempt.raw !== "string") {
      problems.push(`${where} has no raw output`);
      break;
    }
    if (config.kind === "scripted") {
      const view = buildView(scenario, state, attempt.role, expectedSeeds[attempt.role]);
      if (attempt.raw !== canonicalJson(scriptedAction(config.policy, view))) problems.push(`${where} does not reproduce the scripted policy`);
    } else if (config.kind === "fixture") {
      const cursor = fixtureCursors[attempt.role];
      if (cursor) {
        try {
          // Compare the bounded form: an authored step over the byte bound is stored as its bounded prefix.
          const authored = boundRaw(cursor({ legalTurn: attempt.legalTurn, attemptNo: attempt.attemptNo, standingRole: state.standing?.role ?? null }));
          if (authored.raw !== attempt.raw || authored.tooLong !== attempt.rawTruncated) {
            problems.push(`${where} differs from the authored fixture attempt`);
          }
        } catch (error) {
          if (error instanceof FixtureNotApplicable) problems.push(`${where}: ${error.message}`);
          else throw error;
        }
      }
    }
    if (config.kind !== "model" && attempt.live !== null) problems.push(`${where} carries live call metadata on a non-model seat`);
    // A truncated attempt stores only its bounded prefix; it is invalid by the size rule and never re-parsed.
    if (boundRaw(attempt.raw).tooLong) problems.push(`${where} raw output exceeds the byte bound`);
    if (attempt.rawTruncated && config.kind === "scripted") problems.push(`${where} is a truncated scripted action`);
    // boundRaw keeps the prefix within 3 bytes of the bound, so a short raw cannot claim truncation.
    if (attempt.rawTruncated && utf8Length(attempt.raw) < REQUEST_LIMITS.maxRawOutputBytes - 3) problems.push(`${where} claims truncation but its raw output is short`);
    const judged = attempt.rawTruncated ? { ok: false as const, parsed: null, error: RAW_TOO_LONG_ERROR } : judgeAttempt(scenario, state, attempt.role, attempt.raw);
    const verdict = judged.ok ? "legal" : "invalid";
    if (attempt.verdict !== verdict) problems.push(`${where} verdict ${String(attempt.verdict)} does not reproduce (${verdict})`);
    if ((judged.ok ? null : judged.error) !== attempt.error) problems.push(`${where} validation error does not reproduce`);
    const parsed = judged.ok ? judged.action : judged.parsed;
    if (canonicalJson(parsed) !== canonicalJson(attempt.parsed ?? null)) problems.push(`${where} parsed action does not reproduce`);
    if (judged.ok) {
      state = judged.state;
      pendingRepair = null;
      continue;
    }
    if (config.kind === "scripted" || attempt.attemptNo === 2) {
      status = "format_failure";
      failureRole = attempt.role;
      failureReason = judged.error;
    } else {
      pendingRepair = { role: attempt.role, legalTurn: attempt.legalTurn };
    }
  }

  const footer = hasFooter ? (last as unknown as TranscriptFooter) : null;
  if (status === null && state.terminal) status = "complete";
  if (status === null) {
    // Non-terminal prefix. What can stop the match here depends on the seat that would act next, exactly as
    // in playMatch: scripted and fixture seats are recomputed; only model seats can end provider_error,
    // incomplete or blocked by configuration, and only an operator cancellation can stop any seat.
    const nextRole = pendingRepair ? pendingRepair.role : state.nextRole;
    const next = cell.roles[nextRole];
    const operatorCancel = footer?.status === "cancelled" && footer.failureRole === null
      && footer.failureReason === OPERATOR_CANCEL_REASON && footer.failureCall === null && !pendingRepair;
    if (next.kind === "model") {
      if (footer && NON_RECOMPUTABLE.includes(footer.status)) {
        status = footer.status;
        failureRole = footer.failureRole;
        failureReason = footer.failureReason;
      } else {
        status = "incomplete";
        if (footer) problems.push(`footer status ${String(footer.status)} contradicts an unfinished attempt prefix`);
      }
    } else if (operatorCancel) {
      status = "cancelled";
      failureReason = OPERATOR_CANCEL_REASON;
    } else if (next.kind === "scripted") {
      try {
        scriptedAction(next.policy, buildView(scenario, state, nextRole, expectedSeeds[nextRole]));
        status = "incomplete";
        if (footer) problems.push(`footer status ${String(footer.status)} is impossible here: the next seat is scripted and would act`);
      } catch (error) {
        // A scripted policy that throws is a recorded policy defect (format_failure, agent_error) and is recomputable.
        status = "format_failure";
        failureRole = nextRole;
        failureReason = `agent_error: ${error instanceof Error ? error.message : "seat failed"}`;
      }
    } else {
      const fixture = fixtures.get(next.fixtureId);
      const opponent = cell.roles[nextRole === "buyer" ? "seller" : "buyer"];
      let refusal: string | null = null;
      if (!fixture) refusal = null;
      else if (!fixtureCompatible(fixture, definition.definition, header.instanceSeed, nextRole, opponent)) refusal = fixtureNotDeclaredMessage(fixture);
      else {
        try {
          fixtureCursors[nextRole]?.({ legalTurn: state.history.length, attemptNo: pendingRepair ? 2 : 1, standingRole: state.standing?.role ?? null });
        } catch (error) {
          if (error instanceof FixtureNotApplicable) refusal = error.message;
          else throw error;
        }
      }
      if (refusal !== null) {
        status = "blocked";
        failureRole = nextRole;
        failureReason = `fixture_not_applicable: ${refusal}`;
      } else {
        status = "incomplete";
        if (footer) problems.push(`footer status ${String(footer.status)} is impossible here: the next fixture seat would act`);
      }
    }
  }
  if (pendingRepair && status === "complete") problems.push("a repair is pending at completion");

  const metrics = scoreMatch({ scenario, gridKey: instance.instance.instanceId, state, status, failureRole, failureReason, attempts });
  const recomputedDigest = contentDigest(header, attempts);
  if (footer) {
    if (footer.status !== status) problems.push(`footer status ${String(footer.status)} does not reproduce (${status})`);
    if (footer.contentSha256 !== recomputedDigest) problems.push("footer content hash does not match the header and attempts");
    if (canonicalJson(footer.metrics) !== canonicalJson(metrics)) problems.push("cached footer metrics do not reproduce; the recomputed values are shown instead");
    if (footer.failureRole !== failureRole || footer.failureReason !== failureReason) problems.push("footer failure role/reason does not reproduce");
    if (footer.failureCall !== null && (!NON_RECOMPUTABLE.includes(status) || cell.roles[failureRole ?? state.nextRole].kind !== "model")) {
      problems.push("footer carries failed-call metadata that only a model seat can produce");
    }
  } else {
    problems.push("no footer: this is an incomplete export and cannot be accepted as a resolved match");
  }

  return {
    ok: true,
    report: {
      verified: problems.length === 0,
      consistent: problems.every((problem) => problem.startsWith("no footer")),
      problems,
      document: { header, attempts, footer },
      recomputed: { status, failureRole, failureReason, state, metrics, contentSha256: recomputedDigest },
    },
  };
}

export function resumeKey(parts: { runSpecDigest: string; cellId: string; instanceSeed: number; replicate: number }): string {
  return `${parts.runSpecDigest}|${parts.cellId}|${parts.instanceSeed}|${parts.replicate}`;
}

/**
 * A planned cell may be skipped on resume only when its artifact fully verified and reached a terminal
 * execution status. Never by newest filename, timestamp or footer presence alone.
 */
export function verifiedResumeKey(report: VerificationReport): string | null {
  if (!report.verified) return null;
  if (report.recomputed.status !== "complete" && report.recomputed.status !== "format_failure") return null;
  const header = report.document.header;
  return resumeKey({ runSpecDigest: header.runSpecDigest, cellId: header.cellId, instanceSeed: header.instanceSeed, replicate: header.replicate });
}
