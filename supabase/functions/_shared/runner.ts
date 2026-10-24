import { scriptedAction } from "./agents.ts";
import { promptFingerprint } from "./prompt.ts";
import { applyAction, buildView, initialState, maxTurns } from "./referee.ts";
import { scoreGame } from "./score.ts";
import type { Action, AgentId, AgentView, GameState, PlayResult, Role, Scenario, ScriptedId } from "./types.ts";

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
