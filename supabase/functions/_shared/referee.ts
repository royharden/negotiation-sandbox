import { parseWholeJsonOutput } from "./json.ts";
import { isRecord, toPublicScenario } from "./scenario.ts";
import type { Action, AgentView, Claim, GameState, PublicTurn, Role, Scenario, Terms } from "./types.ts";
import { MAX_CLAIMS, MAX_NOTE_LENGTH } from "./types.ts";
import { numberOnStep, rulesetOf } from "./utility.ts";

export function otherRole(role: Role): Role {
  return role === "buyer" ? "seller" : "buyer";
}

export function maxTurns(scenario: Scenario): number {
  return scenario.rules.maxRounds * 2;
}

export function initialState(scenario: Scenario): GameState {
  return {
    nextRole: scenario.rules.openingRole,
    turnsPlayed: 0,
    standing: null,
    history: [],
    terminal: null,
  };
}

export function buildView(scenario: Scenario, state: GameState, role: Role, seed: number): AgentView {
  return {
    role,
    seed,
    maxRounds: scenario.rules.maxRounds,
    maxTurns: maxTurns(scenario),
    turnsPlayed: state.turnsPlayed,
    publicScenario: structuredClone(toPublicScenario(scenario)),
    ownPrivate: structuredClone(scenario.parties[role].private),
    history: structuredClone(state.history),
    standing: state.standing ? { role: state.standing.role, terms: { ...state.standing.terms } } : null,
  };
}

/**
 * Strict whole-output action parse (v2 path, used for every attempt): one JSON object, optionally in one
 * surrounding code fence, duplicate keys and any other text rejected. No brace searching.
 */
export function parseActionText(text: string, ruleset: 1 | 2): { ok: true; action: Action } | { ok: false; error: string } {
  const json = parseWholeJsonOutput(text);
  if (!json.ok) return { ok: false, error: `not one JSON action object: ${json.error}` };
  return parseAction(json.value, ruleset);
}

/** Legacy v1 reader kept for historical callers. */
export function parseActionJson(text: string): { ok: true; action: Action } | { ok: false; error: string } {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return parseAction(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, error: "model output is not JSON" };
  }
}

export function parseAction(value: unknown, ruleset: 1 | 2 = 1): { ok: true; action: Action } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "action must be an object" };
  if (!Object.keys(value).every((key) => ["type", "terms", "note", "claims"].includes(key))) {
    return { ok: false, error: "action has an unknown field" };
  }
  if (value.type !== "offer" && value.type !== "accept" && value.type !== "walk") {
    return { ok: false, error: "action type must be offer, accept, or walk" };
  }
  const action: Action = { type: value.type };
  if (value.note !== undefined) {
    if (typeof value.note !== "string") return { ok: false, error: "note must be a string" };
    if (value.note.length > MAX_NOTE_LENGTH) return { ok: false, error: "note is too long" };
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value.note)) {
      return { ok: false, error: "note contains control characters" };
    }
    action.note = value.note;
  }
  if (value.claims !== undefined) {
    const claims = parseClaims(value.claims, ruleset);
    if (!claims.ok) return claims;
    action.claims = claims.claims;
  }
  if (value.type === "offer") {
    if (!isRecord(value.terms)) return { ok: false, error: "offer requires terms" };
    action.terms = { ...value.terms } as Terms;
  } else if (value.terms !== undefined) {
    return { ok: false, error: `${value.type} must not include terms` };
  }
  return { ok: true, action };
}

export function applyAction(
  scenario: Scenario,
  state: GameState,
  role: Role,
  action: Action,
): { ok: true; state: GameState } | { ok: false; error: string } {
  if (state.terminal) return { ok: false, error: "game is over" };
  if (role !== state.nextRole) return { ok: false, error: "out of turn" };
  if (state.turnsPlayed >= maxTurns(scenario)) return { ok: false, error: "round cap reached" };

  const structural = parseAction(action, rulesetOf(scenario));
  if (!structural.ok) return structural;
  const legal = legalize(scenario, structural.action);
  if (!legal.ok) return legal;
  const clean = legal.action;
  const history = [...state.history, { role, action: cloneAction(clean) }];

  if (clean.type === "accept") {
    if (!state.standing || state.standing.role === role) {
      return { ok: false, error: "accept requires a standing offer from the other party" };
    }
    return {
      ok: true,
      state: {
        nextRole: otherRole(role),
        turnsPlayed: state.turnsPlayed + 1,
        standing: { role: state.standing.role, terms: { ...state.standing.terms } },
        history,
        terminal: { kind: "agreement", terms: { ...state.standing.terms } },
      },
    };
  }

  if (clean.type === "walk") {
    return {
      ok: true,
      state: {
        nextRole: otherRole(role),
        turnsPlayed: state.turnsPlayed + 1,
        standing: state.standing ? { role: state.standing.role, terms: { ...state.standing.terms } } : null,
        history,
        terminal: { kind: "disagreement", reason: "walk" },
      },
    };
  }

  const terms = clean.terms ?? {};
  const turnsPlayed = state.turnsPlayed + 1;
  if (turnsPlayed >= maxTurns(scenario)) {
    // Canonical cap: an offer on the final legal turn closes the match as cap and the offer expires.
    return {
      ok: true,
      state: { nextRole: otherRole(role), turnsPlayed, standing: null, history, terminal: { kind: "disagreement", reason: "cap" } },
    };
  }
  return {
    ok: true,
    state: {
      nextRole: otherRole(role),
      turnsPlayed,
      standing: { role, terms: { ...terms } },
      history,
      terminal: null,
    },
  };
}

export function replay(
  scenario: Scenario,
  history: PublicTurn[],
): { ok: true; state: GameState } | { ok: false; error: string } {
  let state = initialState(scenario);
  for (const turn of history) {
    const next = applyAction(scenario, state, turn.role, turn.action);
    if (!next.ok) return next;
    state = next.state;
  }
  return { ok: true, state };
}

function legalize(scenario: Scenario, action: Action): { ok: true; action: Action } | { ok: false; error: string } {
  if (action.claims) {
    for (const claim of action.claims) {
      const check = claimMatchesScenario(scenario, claim);
      if (!check.ok) return check;
    }
  }
  if (action.type !== "offer") return { ok: true, action };
  const terms = action.terms;
  if (!terms) return { ok: false, error: "offer requires terms" };
  if (Object.keys(terms).length !== scenario.issues.length) {
    return { ok: false, error: "offer must set every issue and no other field" };
  }
  const clean: Terms = {};
  for (const issue of scenario.issues) {
    if (!Object.prototype.hasOwnProperty.call(terms, issue.id)) {
      return { ok: false, error: `offer is missing ${issue.id}` };
    }
    const value = terms[issue.id];
    if (issue.kind === "number") {
      if (typeof value !== "number" || !numberOnStep(issue, value)) {
        return { ok: false, error: `${issue.id} is not an allowed number` };
      }
      clean[issue.id] = value;
    } else if (typeof value !== "string" || !issue.options.includes(value)) {
      return { ok: false, error: `${issue.id} is not an allowed option` };
    } else {
      clean[issue.id] = value;
    }
  }
  return { ok: true, action: { ...action, terms: clean } };
}

function claimMatchesScenario(scenario: Scenario, claim: Claim): { ok: true } | { ok: false; error: string } {
  if (claim.about === "reservation") return { ok: true };
  const issue = scenario.issues.find((item) => item.id === claim.issueId);
  if (!issue) return { ok: false, error: `claim issue ${claim.issueId} does not exist` };
  if (claim.about === "number-score") {
    if (issue.kind !== "number") return { ok: false, error: `${claim.issueId} is not a number issue` };
    return { ok: true };
  }
  if (issue.kind !== "choice" || !issue.options.includes(claim.option)) {
    return { ok: false, error: `${claim.issueId} has no option ${claim.option}` };
  }
  return { ok: true };
}

function parseClaims(value: unknown, ruleset: 1 | 2): { ok: true; claims: Claim[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "claims must be an array" };
  if (value.length > MAX_CLAIMS) return { ok: false, error: "too many claims" };
  const claims: Claim[] = [];
  for (const item of value) {
    const parsed = parseClaim(item, ruleset);
    if (!parsed.ok) return parsed;
    claims.push(parsed.claim);
  }
  return { ok: true, claims };
}

function parseClaim(value: unknown, ruleset: 1 | 2): { ok: true; claim: Claim } | { ok: false; error: string } {
  if (!isRecord(value) || typeof value.about !== "string") return { ok: false, error: "claim must be an object" };
  if (!isFiniteNumber(value.stated)) return { ok: false, error: "claim stated must be a finite number" };
  if (ruleset === 2 && Math.abs(value.stated) > 1_000_000) return { ok: false, error: "claim stated must be within +/-1000000" };
  if (value.about === "reservation") {
    if (ruleset === 1) {
      if (!exactKeys(value, ["about", "stated"])) return { ok: false, error: "reservation claim has unknown fields" };
      return { ok: true, claim: { about: "reservation", stated: value.stated } };
    }
    if (!exactKeys(value, ["about", "relation", "stated"])) {
      return { ok: false, error: "reservation claim needs exactly about, relation and stated" };
    }
    if (value.relation !== "eq" && value.relation !== "at_least" && value.relation !== "at_most") {
      return { ok: false, error: "reservation claim relation must be eq, at_least or at_most" };
    }
    return { ok: true, claim: { about: "reservation", relation: value.relation, stated: value.stated } };
  }
  if (value.about === "number-score") {
    if (!exactKeys(value, ["about", "issueId", "endpoint", "stated"])) {
      return { ok: false, error: "number-score claim has unknown fields" };
    }
    if (typeof value.issueId !== "string" || (value.endpoint !== "min" && value.endpoint !== "max")) {
      return { ok: false, error: "number-score claim needs an issue and an endpoint" };
    }
    return { ok: true, claim: { about: "number-score", issueId: value.issueId, endpoint: value.endpoint, stated: value.stated } };
  }
  if (value.about === "choice-score") {
    if (!exactKeys(value, ["about", "issueId", "option", "stated"])) {
      return { ok: false, error: "choice-score claim has unknown fields" };
    }
    if (typeof value.issueId !== "string" || typeof value.option !== "string") {
      return { ok: false, error: "choice-score claim needs an issue and an option" };
    }
    return { ok: true, claim: { about: "choice-score", issueId: value.issueId, option: value.option, stated: value.stated } };
  }
  return { ok: false, error: "unknown claim about" };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cloneAction(action: Action): Action {
  return {
    type: action.type,
    ...(action.terms ? { terms: { ...action.terms } } : {}),
    ...(action.note !== undefined ? { note: action.note } : {}),
    ...(action.claims ? { claims: action.claims.map((claim) => ({ ...claim })) } : {}),
  };
}
