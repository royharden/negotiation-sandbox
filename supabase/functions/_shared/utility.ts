import type { Issue, IssueScore, NumberIssue, PrivateCard, Scenario, Terms } from "./types.ts";

export function decimalPlaces(step: number): number {
  const text = step.toString().toLowerCase();
  const exponent = text.split("e-")[1];
  if (text.includes("e-") && exponent) {
    const places = Number(exponent);
    return Number.isFinite(places) ? places : 0;
  }
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function alignNumber(issue: Pick<NumberIssue, "min" | "step">, value: number): number {
  const steps = Math.round((value - issue.min) / issue.step);
  const snapped = issue.min + steps * issue.step;
  return Number(snapped.toFixed(decimalPlaces(issue.step)));
}

export function numberOnStep(issue: Pick<NumberIssue, "min" | "max" | "step">, value: number): boolean {
  if (!Number.isFinite(value) || value < issue.min - 1e-9 || value > issue.max + 1e-9) {
    return false;
  }
  const aligned = alignNumber(issue, value);
  return Math.abs(aligned - value) <= 1e-6 && aligned >= issue.min - 1e-9 && aligned <= issue.max + 1e-9;
}

export function issueUtility(issue: Issue, score: IssueScore, value: number | string): number {
  if (issue.kind === "number" && score.kind === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    const span = issue.max - issue.min;
    const t = (numeric - issue.min) / span;
    return score.atMin + t * (score.atMax - score.atMin);
  }
  if (issue.kind === "choice" && score.kind === "choice") {
    const points = score.options[String(value)];
    if (points === undefined) {
      throw new Error(`unknown option ${String(value)} for ${issue.id}`);
    }
    return points;
  }
  throw new Error(`score kind does not match issue ${issue.id}`);
}

export function packageUtility(issues: Issue[], card: PrivateCard, terms: Terms): number {
  let sum = 0;
  for (const issue of issues) {
    const score = card.scores[issue.id];
    const value = terms[issue.id];
    if (!score || value === undefined) {
      throw new Error(`missing term or score for ${issue.id}`);
    }
    sum += issueUtility(issue, score, value);
  }
  return sum;
}

export function roleUtility(scenario: Scenario, role: "buyer" | "seller", terms: Terms): number {
  return packageUtility(scenario.issues, scenario.parties[role].private, terms);
}
