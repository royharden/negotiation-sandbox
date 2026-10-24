import { fnv1a, stableStringify } from "./hash.ts";
import { buildView, replay } from "./referee.ts";
import { toPublicScenario } from "./scenario.ts";
import type { GameState, PublicTurn, Role, Scenario } from "./types.ts";
import { PROMPT_VERSION } from "./types.ts";

export function promptFingerprint(scenario: Scenario): string {
  return fnv1a(`${PROMPT_VERSION}|${stableStringify(toPublicScenario(scenario))}`);
}

export function buildModelPrompt(input: {
  scenario: Scenario;
  role: Role;
  history: PublicTurn[];
  seed: number;
}): { ok: true; system: string; user: string; promptHash: string; state: GameState } | { ok: false; error: string } {
  const replayed = replay(input.scenario, input.history);
  if (!replayed.ok) return replayed;
  if (replayed.state.terminal) return { ok: false, error: "game is over" };
  if (replayed.state.nextRole !== input.role) return { ok: false, error: "it is not this role's turn" };

  const view = buildView(input.scenario, replayed.state, input.role, input.seed);
  const system = [
    "You are one party in a two-party negotiation.",
    "Reply with one JSON object and no markdown.",
    "The object is an action whose type is offer, accept, or walk.",
    "An offer includes terms for every issue. accept and walk must not include terms.",
    "Optional note is public cheap talk, at most 280 characters. Do not put private numbers in the note.",
    "Optional claims may state your own reservation or a score. Claims are checked against your true card.",
    "You cannot see the other party's private card. Never invent the referee's score.",
    "Shape example only, not a recommendation: {\"type\":\"offer\",\"terms\":{\"issue\":\"value\"},\"note\":\"public text\"}.",
  ].join(" ");
  const user = stableStringify({
    seed: view.seed,
    yourRole: view.role,
    publicScenario: view.publicScenario,
    yourPrivateCard: view.ownPrivate,
    standingOffer: view.standing,
    history: view.history,
    turnsPlayed: view.turnsPlayed,
    maxTurns: view.maxTurns,
  });
  return { ok: true, system, user, promptHash: promptFingerprint(input.scenario), state: replayed.state };
}
