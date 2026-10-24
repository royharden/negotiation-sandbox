import { canonicalJson, utf8Length } from "./hash.ts";
import { parseJsonStrict } from "./json.ts";
import type {
  ChoiceIssue,
  Issue,
  IssueScore,
  NumberIssue,
  Party,
  PrivateCard,
  PublicScenario,
  Role,
  Rules,
  Scenario,
  ScenarioDefinition,
  VariationField,
  VariationTarget,
} from "./types.ts";
import { LIMITS } from "./types.ts";
import { decimalPlaces, gridCount } from "./utility.ts";

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
  const party = (role: Role) => {
    const source = scenario.parties[role];
    return source.label === undefined
      ? { publicBrief: source.publicBrief }
      : { label: source.label, publicBrief: source.publicBrief };
  };
  return {
    schemaVersion: scenario.schemaVersion,
    id: scenario.id,
    title: scenario.title,
    publicBrief: scenario.publicBrief,
    issues: structuredClone(scenario.issues),
    parties: { buyer: party("buyer"), seller: party("seller") },
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

// ---------------------------------------------------------------------------
// Schema v2 (rulesetVersion 2). v1 files keep the parser above with their original semantics.
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ISSUE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const VARIATION_FIELDS: readonly VariationField[] = ["reservation", "number-min-score", "number-max-score", "choice-score"];

/** Parse pasted/loaded scenario JSON text: size cap, duplicate-key rejection, then the versioned parser. */
export function parseScenarioText(text: string): { ok: true; definition: ScenarioDefinition } | { ok: false; error: string } {
  if (utf8Length(text) > LIMITS.maxDefinitionBytes) {
    return { ok: false, error: `scenario JSON is larger than ${LIMITS.maxDefinitionBytes} bytes` };
  }
  const json = parseJsonStrict(text);
  if (!json.ok) return { ok: false, error: `scenario JSON: ${json.error}` };
  return parseDefinition(json.value);
}

/** Versioned entry point. v1 returns the historical fixed-card scenario; v2 a definition with optional variation. */
export function parseDefinition(value: unknown): { ok: true; definition: ScenarioDefinition } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "scenario must be an object" };
  if (value.schemaVersion === 1) {
    const v1 = parseScenario(value);
    return v1.ok ? { ok: true, definition: v1.scenario } : v1;
  }
  if (value.schemaVersion !== 2) return { ok: false, error: "schemaVersion must be 1 or 2" };
  const v2 = parseScenarioV2(value);
  if (!v2.ok) return v2;
  if (utf8Length(canonicalJson(v2.value)) > LIMITS.maxDefinitionBytes) {
    return { ok: false, error: `scenario is larger than ${LIMITS.maxDefinitionBytes} bytes` };
  }
  return { ok: true, definition: v2.value };
}

/** Accepts a concrete v2 instance scenario too (no variation): used to re-validate sampled snapshots. */
export function parseScenarioV2(value: Record<string, unknown>): Parsed<ScenarioDefinition> {
  const required = ["schemaVersion", "rulesetVersion", "id", "title", "publicBrief", "issues", "parties", "rules"];
  if (!allowedKeys(value, [...required, "variation"]) || !required.every((key) => own(value, key))) {
    return { ok: false, error: "v2 scenario has missing or unknown fields" };
  }
  if (value.schemaVersion !== 2) return { ok: false, error: "schemaVersion must be 2" };
  if (value.rulesetVersion !== 2) return { ok: false, error: "rulesetVersion must be 2" };
  const id = text(value.id, "id", LIMITS.maxIdLength);
  if (typeof id !== "string") return { ok: false, error: id.error };
  if (!ID_PATTERN.test(id)) return { ok: false, error: "id must be a lowercase slug" };
  const title = text(value.title, "title", LIMITS.maxTitleLength);
  if (typeof title !== "string") return { ok: false, error: title.error };
  const publicBrief = text(value.publicBrief, "publicBrief", LIMITS.maxPublicBrief);
  if (typeof publicBrief !== "string") return { ok: false, error: publicBrief.error };

  const issues = parseIssuesV2(value.issues);
  if (!issues.ok) return issues;
  const parties = parsePartiesV2(value.parties, issues.value);
  if (!parties.ok) return parties;
  const rules = parseRulesV2(value.rules);
  if (!rules.ok) return rules;

  const definition: ScenarioDefinition = {
    schemaVersion: 2,
    rulesetVersion: 2,
    id,
    title,
    publicBrief,
    issues: issues.value,
    parties: parties.value,
    rules: rules.value,
  };
  if (value.variation !== undefined) {
    const variation = parseVariation(value.variation, definition);
    if (!variation.ok) return variation;
    if (variation.value.length > 0) definition.variation = variation.value;
  }
  return { ok: true, value: definition };
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedNumber(value: unknown, label: string): Parsed<number> {
  if (!isFiniteNumber(value)) return { ok: false, error: `${label} must be a finite number` };
  if (Math.abs(value) > LIMITS.maxAbsValue) return { ok: false, error: `${label} must be within +/-${LIMITS.maxAbsValue}` };
  if (decimalPlaces(value) > LIMITS.maxDecimals) return { ok: false, error: `${label} has more than ${LIMITS.maxDecimals} decimal places` };
  return { ok: true, value };
}

function parseIssuesV2(value: unknown): Parsed<Issue[]> {
  if (!Array.isArray(value) || value.length < LIMITS.minIssues || value.length > LIMITS.maxIssues) {
    return { ok: false, error: `issues must contain ${LIMITS.minIssues} to ${LIMITS.maxIssues} entries` };
  }
  const issues: Issue[] = [];
  const seen = new Set<string>();
  let packages = 1;
  for (const entry of value) {
    const issue = parseIssueV2(entry);
    if (!issue.ok) return issue;
    if (seen.has(issue.value.id)) return { ok: false, error: `duplicate issue ${issue.value.id}` };
    seen.add(issue.value.id);
    issues.push(issue.value);
    packages *= issue.value.kind === "number" ? gridCount(issue.value) ?? Infinity : issue.value.options.length;
    if (packages > LIMITS.maxPackages) {
      return { ok: false, error: `the issue grid has more than ${LIMITS.maxPackages} packages` };
    }
  }
  return { ok: true, value: issues };
}

function parseIssueV2(value: unknown): Parsed<Issue> {
  if (!isRecord(value) || (value.kind !== "number" && value.kind !== "choice")) {
    return { ok: false, error: "issue kind must be number or choice" };
  }
  const id = text(value.id, "issue id", LIMITS.maxIdLength);
  if (typeof id !== "string") return { ok: false, error: id.error };
  if (!ISSUE_ID_PATTERN.test(id)) return { ok: false, error: `issue id ${id} must be an ASCII identifier` };
  const label = text(value.label, `issue ${id} label`, LIMITS.maxLabelLength);
  if (typeof label !== "string") return { ok: false, error: label.error };

  if (value.kind === "number") {
    if (!allowedKeys(value, ["id", "label", "kind", "min", "max", "step", "unit"])) {
      return { ok: false, error: `issue ${id} has unknown fields` };
    }
    const min = boundedNumber(value.min, `issue ${id} min`);
    if (!min.ok) return min;
    const max = boundedNumber(value.max, `issue ${id} max`);
    if (!max.ok) return max;
    const step = boundedNumber(value.step, `issue ${id} step`);
    if (!step.ok) return step;
    if (!(min.value < max.value) || !(step.value > 0)) {
      return { ok: false, error: `issue ${id} needs min < max and step > 0` };
    }
    if (gridCount({ min: min.value, max: max.value, step: step.value }) === null) {
      return { ok: false, error: `issue ${id} range is not a whole number of steps` };
    }
    const issue: NumberIssue = { id, label, kind: "number", min: min.value, max: max.value, step: step.value };
    if (value.unit !== undefined) {
      const unit = text(value.unit, `issue ${id} unit`, 16);
      if (typeof unit !== "string") return { ok: false, error: unit.error };
      issue.unit = unit;
    }
    return { ok: true, value: issue };
  }

  if (!exactKeys(value, ["id", "label", "kind", "options"])) {
    return { ok: false, error: `issue ${id} has missing or unknown fields` };
  }
  if (!Array.isArray(value.options) || value.options.length < LIMITS.minChoices || value.options.length > LIMITS.maxChoices) {
    return { ok: false, error: `issue ${id} needs ${LIMITS.minChoices} to ${LIMITS.maxChoices} options` };
  }
  const options: string[] = [];
  for (const option of value.options) {
    if (typeof option !== "string" || option.length < 1 || option.length > LIMITS.maxChoiceLength) {
      return { ok: false, error: `issue ${id} options must be 1 to ${LIMITS.maxChoiceLength} characters` };
    }
    if (options.includes(option)) return { ok: false, error: `issue ${id} repeats option ${option}` };
    options.push(option);
  }
  const issue: ChoiceIssue = { id, label, kind: "choice", options };
  return { ok: true, value: issue };
}

function parsePartiesV2(value: unknown, issues: Issue[]): Parsed<Record<Role, Party>> {
  if (!isRecord(value) || !exactKeys(value, ["buyer", "seller"])) {
    return { ok: false, error: "parties must contain buyer and seller only" };
  }
  const buyer = parsePartyV2(value.buyer, "buyer", issues);
  if (!buyer.ok) return buyer;
  const seller = parsePartyV2(value.seller, "seller", issues);
  if (!seller.ok) return seller;
  return { ok: true, value: { buyer: buyer.value, seller: seller.value } };
}

function parsePartyV2(value: unknown, role: Role, issues: Issue[]): Parsed<Party> {
  if (!isRecord(value) || !exactKeys(value, ["label", "publicBrief", "private"])) {
    return { ok: false, error: `${role} must contain label, publicBrief and private` };
  }
  const label = text(value.label, `${role} label`, LIMITS.maxLabelLength);
  if (typeof label !== "string") return { ok: false, error: label.error };
  const publicBrief = text(value.publicBrief, `${role} publicBrief`, LIMITS.maxPartyBrief);
  if (typeof publicBrief !== "string") return { ok: false, error: publicBrief.error };
  if (!isRecord(value.private) || !exactKeys(value.private, ["reservationUtility", "scores"])) {
    return { ok: false, error: `${role} private card has missing or unknown fields` };
  }
  const reservation = boundedNumber(value.private.reservationUtility, `${role} reservationUtility`);
  if (!reservation.ok) return reservation;
  const scoresRaw = value.private.scores;
  if (!isRecord(scoresRaw)) return { ok: false, error: `${role} scores must be an object` };
  const scoreKeys = Object.keys(scoresRaw);
  if (scoreKeys.length !== issues.length || issues.some((issue) => !own(scoresRaw, issue.id))) {
    return { ok: false, error: `${role} scores must match the issues exactly` };
  }
  const scores: Record<string, IssueScore> = {};
  for (const issue of issues) {
    const raw = scoresRaw[issue.id];
    if (!isRecord(raw)) return { ok: false, error: `${role} score for ${issue.id} must be an object` };
    if (issue.kind === "number") {
      if (!exactKeys(raw, ["kind", "atMin", "atMax"]) || raw.kind !== "number") {
        return { ok: false, error: `${role} score for ${issue.id} must be a number score` };
      }
      const atMin = boundedNumber(raw.atMin, `${role} ${issue.id} atMin`);
      if (!atMin.ok) return atMin;
      const atMax = boundedNumber(raw.atMax, `${role} ${issue.id} atMax`);
      if (!atMax.ok) return atMax;
      scores[issue.id] = { kind: "number", atMin: atMin.value, atMax: atMax.value };
      continue;
    }
    if (!exactKeys(raw, ["kind", "options"]) || raw.kind !== "choice" || !isRecord(raw.options)) {
      return { ok: false, error: `${role} score for ${issue.id} must be a choice score` };
    }
    const pointsRaw = raw.options;
    const optionKeys = Object.keys(pointsRaw);
    if (optionKeys.length !== issue.options.length || issue.options.some((option) => !own(pointsRaw, option))) {
      return { ok: false, error: `${role} score for ${issue.id} must score exactly the declared options` };
    }
    const options: Record<string, number> = {};
    for (const option of issue.options) {
      const points = boundedNumber(pointsRaw[option], `${role} ${issue.id} option ${option}`);
      if (!points.ok) return points;
      Object.defineProperty(options, option, { value: points.value, enumerable: true, writable: true, configurable: true });
    }
    scores[issue.id] = { kind: "choice", options };
  }
  const card: PrivateCard = { reservationUtility: reservation.value, scores };
  return { ok: true, value: { label, publicBrief, private: card } };
}

function parseRulesV2(value: unknown): Parsed<Rules> {
  if (!isRecord(value) || !exactKeys(value, ["maxRounds", "openingRole"])) {
    return { ok: false, error: "v2 rules must contain maxRounds and openingRole only" };
  }
  if (!isFiniteNumber(value.maxRounds) || !Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > LIMITS.maxRounds) {
    return { ok: false, error: `maxRounds must be an integer from 1 to ${LIMITS.maxRounds}` };
  }
  if (value.openingRole !== "buyer" && value.openingRole !== "seller") {
    return { ok: false, error: "openingRole must be buyer or seller" };
  }
  return { ok: true, value: { maxRounds: value.maxRounds, openingRole: value.openingRole } };
}

/** Canonical target key; also the sort key and part of the sampler stream encoding. */
export function variationKey(target: Pick<VariationTarget, "role" | "field" | "issueId" | "option">): string {
  return canonicalJson({ role: target.role, field: target.field, issueId: target.issueId ?? null, option: target.option ?? null });
}

/** Base value a variation target offsets. Null when the reference is invalid for that field. */
export function variationBase(definition: Scenario, target: Pick<VariationTarget, "role" | "field" | "issueId" | "option">): number | null {
  const card = definition.parties[target.role].private;
  if (target.field === "reservation") {
    return target.issueId === undefined && target.option === undefined ? card.reservationUtility : null;
  }
  if (target.issueId === undefined || !own(card.scores, target.issueId)) return null;
  const score = card.scores[target.issueId];
  if (!score) return null;
  if (target.field === "choice-score") {
    if (score.kind !== "choice" || target.option === undefined || !own(score.options, target.option)) return null;
    return score.options[target.option] ?? null;
  }
  if (score.kind !== "number" || target.option !== undefined) return null;
  return target.field === "number-min-score" ? score.atMin : score.atMax;
}

function parseVariation(value: unknown, definition: Scenario): Parsed<VariationTarget[]> {
  if (!Array.isArray(value) || value.length > LIMITS.maxVariationTargets) {
    return { ok: false, error: `variation must be an array of at most ${LIMITS.maxVariationTargets} targets` };
  }
  const targets: VariationTarget[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, error: "variation target must be an object" };
    if (!allowedKeys(entry, ["role", "field", "issueId", "option", "jitterMin", "jitterMax"])) {
      return { ok: false, error: "variation target has unknown fields" };
    }
    if (entry.role !== "buyer" && entry.role !== "seller") return { ok: false, error: "variation role must be buyer or seller" };
    if (typeof entry.field !== "string" || !VARIATION_FIELDS.includes(entry.field as VariationField)) {
      return { ok: false, error: "variation field must be reservation, number-min-score, number-max-score or choice-score" };
    }
    const field = entry.field as VariationField;
    if (entry.issueId !== undefined && typeof entry.issueId !== "string") return { ok: false, error: "variation issueId must be a string" };
    if (entry.option !== undefined && typeof entry.option !== "string") return { ok: false, error: "variation option must be a string" };
    const needsIssue = field !== "reservation";
    const needsOption = field === "choice-score";
    if (needsIssue !== (entry.issueId !== undefined) || needsOption !== (entry.option !== undefined)) {
      return { ok: false, error: `variation ${field} has the wrong issueId/option fields` };
    }
    const jitterMin = entry.jitterMin;
    const jitterMax = entry.jitterMax;
    if (!isJitter(jitterMin) || !isJitter(jitterMax)) {
      return { ok: false, error: `variation jitterMin/jitterMax must be integers within +/-${LIMITS.maxJitter}` };
    }
    if (jitterMin > jitterMax) return { ok: false, error: "variation jitterMin must not exceed jitterMax" };
    const target: VariationTarget = { role: entry.role, field, jitterMin, jitterMax };
    if (typeof entry.issueId === "string") target.issueId = entry.issueId;
    if (typeof entry.option === "string") target.option = entry.option;
    const key = variationKey(target);
    const base = variationBase(definition, target);
    if (base === null) return { ok: false, error: `variation ${key} references no matching card field` };
    if (Math.abs(base + jitterMin) > LIMITS.maxAbsValue || Math.abs(base + jitterMax) > LIMITS.maxAbsValue) {
      return { ok: false, error: `variation ${key} can exceed +/-${LIMITS.maxAbsValue}` };
    }
    if (seen.has(key)) return { ok: false, error: `duplicate variation target ${key}` };
    seen.add(key);
    targets.push(target);
  }
  return { ok: true, value: targets };
}

function isJitter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= LIMITS.maxJitter;
}
