import type { ChoiceIssue, Issue, IssueScore, NumberIssue, Party, PrivateCard, PublicScenario, Role, Rules, Scenario } from "./types.ts";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown, label: string, max: number): string | { error: string } {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    return { error: `${label} must be 1 to ${max} characters` };
  }
  return value;
}

export function parseScenario(value: unknown): { ok: true; scenario: Scenario } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "scenario must be an object" };
  if (!exactKeys(value, ["schemaVersion", "id", "title", "publicBrief", "issues", "parties", "rules"])) {
    return { ok: false, error: "scenario has missing or unknown fields" };
  }
  if (value.schemaVersion !== 1) return { ok: false, error: "schemaVersion must be 1" };

  const id = text(value.id, "id", 64);
  if (typeof id !== "string") return { ok: false, error: id.error };
  if (!ID_PATTERN.test(id)) return { ok: false, error: "id must be a lowercase slug" };

  const title = text(value.title, "title", 120);
  if (typeof title !== "string") return { ok: false, error: title.error };
  const publicBrief = text(value.publicBrief, "publicBrief", 500);
  if (typeof publicBrief !== "string") return { ok: false, error: publicBrief.error };

  const issues = parseIssues(value.issues);
  if (!issues.ok) return issues;
  const parties = parseParties(value.parties, issues.issues);
  if (!parties.ok) return parties;
  const rules = parseRules(value.rules);
  if (!rules.ok) return rules;

  return {
    ok: true,
    scenario: {
      schemaVersion: 1,
      id,
      title,
      publicBrief,
      issues: issues.issues,
      parties: parties.parties,
      rules: rules.rules,
    },
  };
}

export function toPublicScenario(scenario: Scenario): PublicScenario {
  return {
    schemaVersion: scenario.schemaVersion,
    id: scenario.id,
    title: scenario.title,
    publicBrief: scenario.publicBrief,
    issues: structuredClone(scenario.issues),
    parties: {
      buyer: { publicBrief: scenario.parties.buyer.publicBrief },
      seller: { publicBrief: scenario.parties.seller.publicBrief },
    },
    rules: { ...scenario.rules },
  };
}

function parseIssues(value: unknown): { ok: true; issues: Issue[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    return { ok: false, error: "issues must contain 1 to 6 entries" };
  }
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const issue = parseIssue(entry);
    if (!issue.ok) return issue;
    if (seen.has(issue.issue.id)) return { ok: false, error: `duplicate issue ${issue.issue.id}` };
    seen.add(issue.issue.id);
    issues.push(issue.issue);
  }
  return { ok: true, issues };
}

function parseIssue(value: unknown): { ok: true; issue: Issue } | { ok: false; error: string } {
  if (!isRecord(value) || (value.kind !== "number" && value.kind !== "choice")) {
    return { ok: false, error: "issue kind must be number or choice" };
  }
  const id = text(value.id, "issue id", 64);
  if (typeof id !== "string") return { ok: false, error: id.error };
  if (!ID_PATTERN.test(id)) return { ok: false, error: `issue id ${id} must be a lowercase slug` };
  const label = text(value.label, `issue ${id} label`, 80);
  if (typeof label !== "string") return { ok: false, error: label.error };

  if (value.kind === "number") {
    if (!allowedKeys(value, ["id", "label", "kind", "min", "max", "step", "unit"])) {
      return { ok: false, error: `issue ${id} has unknown fields` };
    }
    if (!isFiniteNumber(value.min) || !isFiniteNumber(value.max) || !isFiniteNumber(value.step)) {
      return { ok: false, error: `issue ${id} min, max, and step must be finite numbers` };
    }
    if (!(value.min < value.max) || !(value.step > 0)) {
      return { ok: false, error: `issue ${id} needs min < max and step > 0` };
    }
    const steps = (value.max - value.min) / value.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { ok: false, error: `issue ${id} range is not a whole number of steps` };
    }
    const issue: NumberIssue = { id, label, kind: "number", min: value.min, max: value.max, step: value.step };
    if (value.unit !== undefined) {
      const unit = text(value.unit, `issue ${id} unit`, 16);
      if (typeof unit !== "string") return { ok: false, error: unit.error };
      issue.unit = unit;
    }
    return { ok: true, issue };
  }

  if (!exactKeys(value, ["id", "label", "kind", "options"])) {
    return { ok: false, error: `issue ${id} has missing or unknown fields` };
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 8) {
    return { ok: false, error: `issue ${id} needs 2 to 8 options` };
  }
  const options: string[] = [];
  for (const option of value.options) {
    if (typeof option !== "string" || option.length < 1 || option.length > 40) {
      return { ok: false, error: `issue ${id} options must be short strings` };
    }
    if (options.includes(option)) return { ok: false, error: `issue ${id} repeats option ${option}` };
    options.push(option);
  }
  const issue: ChoiceIssue = { id, label, kind: "choice", options };
  return { ok: true, issue };
}

function parseParties(
  value: unknown,
  issues: Issue[],
): { ok: true; parties: Record<Role, Party> } | { ok: false; error: string } {
  if (!isRecord(value) || !exactKeys(value, ["buyer", "seller"])) {
    return { ok: false, error: "parties must contain buyer and seller only" };
  }
  const buyer = parseParty(value.buyer, "buyer", issues);
  if (!buyer.ok) return buyer;
  const seller = parseParty(value.seller, "seller", issues);
  if (!seller.ok) return seller;
  return { ok: true, parties: { buyer: buyer.party, seller: seller.party } };
}

function parseParty(
  value: unknown,
  role: Role,
  issues: Issue[],
): { ok: true; party: Party } | { ok: false; error: string } {
  if (!isRecord(value) || !exactKeys(value, ["publicBrief", "private"])) {
    return { ok: false, error: `${role} must contain publicBrief and private` };
  }
  const publicBrief = text(value.publicBrief, `${role} publicBrief`, 500);
  if (typeof publicBrief !== "string") return { ok: false, error: publicBrief.error };
  const card = parseCard(value.private, role, issues);
  if (!card.ok) return card;
  return { ok: true, party: { publicBrief, private: card.card } };
}

function parseCard(
  value: unknown,
  role: Role,
  issues: Issue[],
): { ok: true; card: PrivateCard } | { ok: false; error: string } {
  if (!isRecord(value) || !exactKeys(value, ["reservationUtility", "scores"])) {
    return { ok: false, error: `${role} private card has missing or unknown fields` };
  }
  if (!isFiniteNumber(value.reservationUtility)) {
    return { ok: false, error: `${role} reservationUtility must be a finite number` };
  }
  if (!isRecord(value.scores)) return { ok: false, error: `${role} scores must be an object` };
  const scoreKeys = Object.keys(value.scores);
  if (scoreKeys.length !== issues.length || issues.some((issue) => !scoreKeys.includes(issue.id))) {
    return { ok: false, error: `${role} scores must match the issues exactly` };
  }
  const scores: Record<string, IssueScore> = {};
  for (const issue of issues) {
    const score = parseScore(value.scores[issue.id], role, issue);
    if (!score.ok) return score;
    scores[issue.id] = score.score;
  }
  return { ok: true, card: { reservationUtility: value.reservationUtility, scores } };
}

function parseScore(
  value: unknown,
  role: Role,
  issue: Issue,
): { ok: true; score: IssueScore } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: `${role} score for ${issue.id} must be an object` };
  if (issue.kind === "number") {
    if (!exactKeys(value, ["kind", "atMin", "atMax"]) || value.kind !== "number") {
      return { ok: false, error: `${role} score for ${issue.id} must be a number score` };
    }
    if (!isFiniteNumber(value.atMin) || !isFiniteNumber(value.atMax)) {
      return { ok: false, error: `${role} score for ${issue.id} must use finite endpoints` };
    }
    return { ok: true, score: { kind: "number", atMin: value.atMin, atMax: value.atMax } };
  }
  if (!exactKeys(value, ["kind", "options"]) || value.kind !== "choice" || !isRecord(value.options)) {
    return { ok: false, error: `${role} score for ${issue.id} must be a choice score` };
  }
  const optionKeys = Object.keys(value.options);
  if (optionKeys.length !== issue.options.length || issue.options.some((option) => !optionKeys.includes(option))) {
    return { ok: false, error: `${role} score for ${issue.id} must score every option` };
  }
  const options: Record<string, number> = {};
  for (const option of issue.options) {
    const points = value.options[option];
    if (!isFiniteNumber(points)) {
      return { ok: false, error: `${role} score for ${issue.id} option ${option} must be a finite number` };
    }
    options[option] = points;
  }
  return { ok: true, score: { kind: "choice", options } };
}

function parseRules(value: unknown): { ok: true; rules: Rules } | { ok: false; error: string } {
  if (!isRecord(value) || !exactKeys(value, ["maxRounds", "openingRole", "disagreementUtility"])) {
    return { ok: false, error: "rules have missing or unknown fields" };
  }
  if (!isFiniteNumber(value.maxRounds) || !Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 20) {
    return { ok: false, error: "maxRounds must be an integer from 1 to 20" };
  }
  if (value.openingRole !== "buyer" && value.openingRole !== "seller") {
    return { ok: false, error: "openingRole must be buyer or seller" };
  }
  if (!isFiniteNumber(value.disagreementUtility)) {
    return { ok: false, error: "disagreementUtility must be a finite number" };
  }
  return {
    ok: true,
    rules: {
      maxRounds: value.maxRounds,
      openingRole: value.openingRole,
      disagreementUtility: value.disagreementUtility,
    },
  };
}
