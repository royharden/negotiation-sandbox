import type { Issue, IssueScore, NumberIssue, PrivateCard, Role, Scenario, Terms } from "./types.ts";
import { LIMITS } from "./types.ts";

/** Decimal places in the shortest round-trip form of a finite number ("1.5e-7" has 8). */
export function decimalPlaces(value: number): number {
  const text = Math.abs(value).toString().toLowerCase();
  const [mantissa = "", exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const dot = mantissa.indexOf(".");
  const fraction = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, fraction - exponent);
}

/** Integer form of a value at a decimal scale, or null when the value has more precision. */
export function toScaled(value: number, places: number): number | null {
  if (!Number.isFinite(value) || decimalPlaces(value) > places) return null;
  const scaled = Math.round(value * 10 ** places);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function gridScale(issue: Pick<NumberIssue, "min" | "max" | "step">, value?: number): number {
  const places = [issue.min, issue.max, issue.step, ...(value === undefined ? [] : [value])].map(decimalPlaces);
  return Math.max(...places);
}

/**
 * Exact grid legality: inside the inclusive range and (value - min) is an integer multiple of step,
 * computed on integers scaled by all decimal places (including a fractional origin). No rounding repair.
 */
export function numberOnGrid(issue: Pick<NumberIssue, "min" | "max" | "step">, value: number): boolean {
  if (!Number.isFinite(value) || decimalPlaces(value) > LIMITS.maxDecimals) return false;
  const places = gridScale(issue, value);
  const v = toScaled(value, places);
  const min = toScaled(issue.min, places);
  const max = toScaled(issue.max, places);
  const step = toScaled(issue.step, places);
  if (v === null || min === null || max === null || step === null || step <= 0) return false;
  if (v < min || v > max) return false;
  return (v - min) % step === 0;
}

/** Kept name for v1 callers; now the exact grid test. v1 fixtures use integral grids, so behaviour is unchanged. */
export function numberOnStep(issue: Pick<NumberIssue, "min" | "max" | "step">, value: number): boolean {
  return numberOnGrid(issue, value);
}

/** Number of grid points, or null when the range is not a whole number of steps. */
export function gridCount(issue: Pick<NumberIssue, "min" | "max" | "step">): number | null {
  const places = gridScale(issue);
  const min = toScaled(issue.min, places);
  const max = toScaled(issue.max, places);
  const step = toScaled(issue.step, places);
  if (min === null || max === null || step === null || step <= 0 || max <= min) return null;
  if ((max - min) % step !== 0) return null;
  return (max - min) / step + 1;
}

export function gridValues(issue: NumberIssue): number[] {
  const places = gridScale(issue);
  const min = toScaled(issue.min, places) ?? 0;
  const step = toScaled(issue.step, places) ?? 1;
  const count = gridCount(issue) ?? 0;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(fromScaled(min + index * step, places));
  return values;
}

/** Nearest grid point by whole steps from min, clamped into range. Used only by scripted policies. */
export function alignNumber(issue: Pick<NumberIssue, "min" | "step"> & Partial<Pick<NumberIssue, "max">>, value: number): number {
  const places = Math.max(decimalPlaces(issue.min), decimalPlaces(issue.step), issue.max === undefined ? 0 : decimalPlaces(issue.max));
  const min = toScaled(issue.min, places) ?? 0;
  const step = toScaled(issue.step, places) ?? 1;
  let steps = Math.round((value - issue.min) / issue.step);
  if (steps < 0) steps = 0;
  if (issue.max !== undefined) {
    const max = toScaled(issue.max, places);
    if (max !== null) steps = Math.min(steps, Math.floor((max - min) / step));
  }
  return fromScaled(min + steps * step, places);
}

function fromScaled(scaled: number, places: number): number {
  return Number((scaled / 10 ** places).toFixed(places));
}

export function issueUtility(issue: Issue, score: IssueScore, value: number | string): number {
  if (issue.kind === "number" && score.kind === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    const span = issue.max - issue.min;
    const t = (numeric - issue.min) / span;
    return score.atMin + t * (score.atMax - score.atMin);
  }
  if (issue.kind === "choice" && score.kind === "choice") {
    const key = String(value);
    if (!Object.prototype.hasOwnProperty.call(score.options, key)) {
      throw new Error(`unknown option ${key} for ${issue.id}`);
    }
    const points = score.options[key];
    if (typeof points !== "number") throw new Error(`unknown option ${key} for ${issue.id}`);
    return points;
  }
  throw new Error(`score kind does not match issue ${issue.id}`);
}

export function packageUtility(issues: Issue[], card: PrivateCard, terms: Terms): number {
  let sum = 0;
  for (const issue of issues) {
    const score = Object.prototype.hasOwnProperty.call(card.scores, issue.id) ? card.scores[issue.id] : undefined;
    const value = Object.prototype.hasOwnProperty.call(terms, issue.id) ? terms[issue.id] : undefined;
    if (!score || value === undefined) {
      throw new Error(`missing term or score for ${issue.id}`);
    }
    sum += issueUtility(issue, score, value);
  }
  return sum;
}

export function roleUtility(scenario: Scenario, role: Role, terms: Terms): number {
  return packageUtility(scenario.issues, scenario.parties[role].private, terms);
}

export function rulesetOf(scenario: Pick<Scenario, "schemaVersion">): 1 | 2 {
  return scenario.schemaVersion === 2 ? 2 : 1;
}

/** No-deal payoff: v1 shared historical disagreementUtility; v2 each role's sampled reservation. */
export function noDealUtility(scenario: Scenario, role: Role): number {
  if (rulesetOf(scenario) === 2) return scenario.parties[role].private.reservationUtility;
  return scenario.rules.disagreementUtility ?? 0;
}
