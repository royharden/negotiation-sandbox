import type { MatchExecution } from "./runner.ts";
import { agentClass, agentKey, cellKey, findCell } from "./runspec.ts";
import type { PlannedMatch, RunSpec } from "./runspec.ts";
import type { MatchMetrics, MatchStatus, Role } from "./types.ts";

/** One row per PLANNED match; unrun matches stay visible as not_started. */
export type ResultRow = {
  planIndex: number;
  cellId: string;
  cellKey: string;
  agentClass: "scripted" | "synthetic" | "live";
  buyerConfig: string;
  sellerConfig: string;
  instanceSeed: number;
  replicate: number;
  instanceId: string | null;
  executionId: string | null;
  status: MatchStatus;
  attemptCount: number;
  metrics: MatchMetrics | null;
};

export type Fraction = { count: number; of: number; value: number | null };
export type Stats = { n: number; mean: number | null; median: number | null; min: number | null; max: number | null };

export type CellSummary = {
  cellId: string;
  cellKey: string;
  agentClass: ResultRow["agentClass"];
  buyerConfig: string;
  sellerConfig: string;
  planned: number;
  attempted: number;
  resolved: number;
  notStarted: number;
  outcomes: { agreement: number; walk: number; cap: number };
  failures: Record<"format_failure" | "provider_error" | "blocked" | "cancelled" | "incomplete", number>;
  agreementOfAttempted: Fraction;
  agreementOfResolved: Fraction;
  utility: Record<Role, Stats>;
  gain: Record<Role, Stats>;
  welfare: Stats;
  irViolation: Record<Role, Fraction>;
  missedDeal: Fraction;
  dealWithEmptyZopa: Fraction;
  falseStructuredClaim: Record<Role, Fraction>;
  claimDisclosure: Record<Role, Fraction>;
  ownNumberDisclosureCandidates: Record<Role, Fraction>;
  claimActionInconsistency: Record<Role, Fraction>;
  claimChangeCount: Record<Role, number>;
  reservationMisstatement: Record<Role, Stats>;
  invalidAttempts: Record<Role, number>;
  attemptsTotal: number;
};

export function resultRows(spec: RunSpec, planned: PlannedMatch[], executions: Array<MatchExecution & { planIndex: number }>, instanceIds: Map<number, string>): ResultRow[] {
  const byPlan = new Map<number, MatchExecution & { planIndex: number }>();
  for (const execution of executions) byPlan.set(execution.planIndex, execution);
  return planned.map((match) => {
    const cell = findCell(spec, match.cellId);
    if (!cell) throw new Error(`no cell ${match.cellId}`);
    const execution = byPlan.get(match.planIndex);
    return {
      planIndex: match.planIndex,
      cellId: match.cellId,
      cellKey: cellKey(spec, cell),
      agentClass: agentClass(cell),
      buyerConfig: agentKey(cell.roles.buyer),
      sellerConfig: agentKey(cell.roles.seller),
      instanceSeed: match.instanceSeed,
      replicate: match.replicate,
      instanceId: instanceIds.get(match.instanceSeed) ?? null,
      executionId: execution?.executionId ?? null,
      status: execution?.status ?? "not_started",
      attemptCount: execution?.attempts.length ?? 0,
      metrics: execution?.metrics ?? null,
    };
  });
}

/**
 * Attempted = execution started: any recorded attempt or a claimed provider attempt. Preflight-blocked
 * (blocked/cancelled before any attempt) and unstarted matches are planned but not attempted.
 */
export function isAttempted(row: ResultRow): boolean {
  if (row.status === "not_started" || row.status === "running") return false;
  if (row.attemptCount > 0) return true;
  return row.status === "provider_error" || row.status === "incomplete";
}

export function isResolved(row: ResultRow): boolean {
  return row.status === "complete" && row.metrics?.outcome !== null && row.metrics?.outcome !== undefined;
}

export function fraction(count: number, of: number): Fraction {
  return { count, of, value: of === 0 ? null : count / of };
}

export function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] ?? null : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}

function perRole<T>(make: (role: Role) => T): Record<Role, T> {
  return { buyer: make("buyer"), seller: make("seller") };
}

function numbers(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

/** Aggregates only within one exact cell key (definition, ruleset, per-role configuration, prompt variant). */
export function summarizeCells(rows: ResultRow[]): CellSummary[] {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const group = groups.get(row.cellKey);
    if (group) group.push(row);
    else groups.set(row.cellKey, [row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as ResultRow;
    const attempted = group.filter(isAttempted);
    const resolved = group.filter(isResolved);
    const metrics = group.map((row) => row.metrics).filter((item): item is MatchMetrics => item !== null && isAttemptedMetrics(item));
    const legalMetrics = attempted.map((row) => row.metrics).filter((item): item is MatchMetrics => item !== null);
    const agreements = resolved.filter((row) => row.metrics?.outcome === "agreement");
    const noDeals = resolved.filter((row) => row.metrics?.outcome === "walk" || row.metrics?.outcome === "cap");
    const count = (status: MatchStatus) => group.filter((row) => row.status === status).length;
    return {
      cellId: first.cellId,
      cellKey: first.cellKey,
      agentClass: first.agentClass,
      buyerConfig: first.buyerConfig,
      sellerConfig: first.sellerConfig,
      planned: group.length,
      attempted: attempted.length,
      resolved: resolved.length,
      notStarted: count("not_started"),
      outcomes: {
        agreement: agreements.length,
        walk: resolved.filter((row) => row.metrics?.outcome === "walk").length,
        cap: resolved.filter((row) => row.metrics?.outcome === "cap").length,
      },
      failures: {
        format_failure: count("format_failure"),
        provider_error: count("provider_error"),
        blocked: count("blocked"),
        cancelled: count("cancelled"),
        incomplete: count("incomplete"),
      },
      agreementOfAttempted: fraction(agreements.length, attempted.length),
      agreementOfResolved: fraction(agreements.length, resolved.length),
      utility: perRole((role) => stats(numbers(resolved.map((row) => row.metrics?.roles[role].utility)))),
      gain: perRole((role) => stats(numbers(resolved.map((row) => row.metrics?.roles[role].gain)))),
      welfare: stats(numbers(resolved.map((row) => row.metrics?.welfare))),
      irViolation: perRole((role) => fraction(agreements.filter((row) => row.metrics?.roles[role].individuallyRational === false).length, agreements.length)),
      missedDeal: fraction(noDeals.filter((row) => row.metrics?.missedDeal === true).length, noDeals.length),
      dealWithEmptyZopa: fraction(agreements.filter((row) => row.metrics?.dealWithEmptyZopa === true).length, agreements.length),
      // Claim evidence from legal turns survives failures, so these use every attempted match.
      falseStructuredClaim: perRole((role) => sumFraction(legalMetrics, (item) => item.roles[role].claimsFalse, (item) => item.roles[role].claimsEvaluated)),
      claimDisclosure: perRole((role) => sumFraction(legalMetrics, (item) => item.roles[role].turnsWithClaims, (item) => item.roles[role].legalTurns)),
      ownNumberDisclosureCandidates: perRole((role) => sumFraction(legalMetrics, (item) => item.roles[role].ownNumberCandidates, (item) => item.roles[role].notesNonEmpty)),
      claimActionInconsistency: perRole((role) => sumFraction(legalMetrics, (item) => item.roles[role].acceptanceInconsistent, (item) => item.roles[role].acceptanceChecks)),
      claimChangeCount: perRole((role) => legalMetrics.reduce((sum, item) => sum + item.roles[role].claimChangeCount, 0)),
      reservationMisstatement: perRole((role) => stats(legalMetrics.flatMap((item) => item.roles[role].reservationMisstatements))),
      invalidAttempts: perRole((role) => metrics.reduce((sum, item) => sum + item.roles[role].invalidAttempts, 0)),
      attemptsTotal: group.reduce((sum, row) => sum + row.attemptCount, 0),
    };
  });
}

function isAttemptedMetrics(item: MatchMetrics): boolean {
  return item.status !== "not_started" && item.status !== "running";
}

function sumFraction(items: MatchMetrics[], count: (item: MatchMetrics) => number, of: (item: MatchMetrics) => number): Fraction {
  return fraction(items.reduce((sum, item) => sum + count(item), 0), items.reduce((sum, item) => sum + of(item), 0));
}

export type PairedDelta = { instanceId: string; instanceSeed: number; replicate: number; a: number; b: number; delta: number };

/**
 * Descriptive paired differences between two cells on identical instance_id + instance seed + replicate
 * (policy seeds derive from those). Only both-complete pairs with a defined metric count.
 * Not a causal effect and not an inferential interval.
 */
export function pairedDifferences(rows: ResultRow[], cellA: string, cellB: string, metric: (metrics: MatchMetrics) => number | null): {
  sharedComplete: number;
  missingPairs: number;
  deltas: PairedDelta[];
  meanDelta: number | null;
} {
  const key = (row: ResultRow) => `${row.instanceId ?? "?"}|${row.instanceSeed}|${row.replicate}`;
  const left = new Map(rows.filter((row) => row.cellId === cellA).map((row) => [key(row), row] as const));
  const right = new Map(rows.filter((row) => row.cellId === cellB).map((row) => [key(row), row] as const));
  const keys = new Set([...left.keys(), ...right.keys()]);
  const deltas: PairedDelta[] = [];
  let missingPairs = 0;
  for (const item of keys) {
    const a = left.get(item);
    const b = right.get(item);
    const av = a && isResolved(a) && a.metrics ? metric(a.metrics) : null;
    const bv = b && isResolved(b) && b.metrics ? metric(b.metrics) : null;
    if (!a || !b || av === null || bv === null || a.instanceId === null) {
      missingPairs += 1;
      continue;
    }
    deltas.push({ instanceId: a.instanceId, instanceSeed: a.instanceSeed, replicate: a.replicate, a: av, b: bv, delta: bv - av });
  }
  deltas.sort((x, y) => x.instanceSeed - y.instanceSeed || x.replicate - y.replicate);
  return {
    sharedComplete: deltas.length,
    missingPairs,
    deltas,
    meanDelta: deltas.length === 0 ? null : deltas.reduce((sum, item) => sum + item.delta, 0) / deltas.length,
  };
}
