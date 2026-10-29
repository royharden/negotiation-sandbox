import type { ResultRow } from "./aggregate.ts";
import type { MatchExecution } from "./runner.ts";
import type { Action } from "./types.ts";

export type CsvCell = string | number | boolean | null;

/**
 * RFC 4180 quoting. Free-text cells that start with = + - @ TAB or CR are prefixed with an apostrophe so a
 * spreadsheet never evaluates them as formulas. Numbers are emitted as numbers.
 */
export function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map((cell) => csvCell(cell)).join(",")).join("\r\n") + "\r\n";
}

const GAME_HEADER = [
  "plan_index", "cell_id", "cell_key", "agent_class", "buyer_config", "seller_config", "instance_seed", "replicate",
  "instance_id", "execution_id", "status", "outcome", "failure_role", "failure_reason", "legal_turns", "attempts",
  "buyer_utility", "seller_utility", "buyer_gain", "seller_gain", "welfare", "joint_gain", "efficiency",
  "efficiency_null_reason", "pareto_dominated", "zopa_empty", "missed_deal", "deal_with_empty_zopa",
  "buyer_ir", "seller_ir", "buyer_claims_false", "buyer_claims_evaluated", "seller_claims_false", "seller_claims_evaluated",
  "buyer_invalid_attempts", "seller_invalid_attempts", "scoring_version", "ruleset",
];

/** games.csv: one row per planned match, status and nullable metrics. No private cards or credentials. */
export function gamesCsv(rows: ResultRow[]): string {
  return toCsv(GAME_HEADER, rows.map((row) => {
    const m = row.metrics;
    return [
      row.planIndex, row.cellId, row.cellKey, row.agentClass, row.buyerConfig, row.sellerConfig, row.instanceSeed, row.replicate,
      row.instanceId, row.executionId, row.status, m?.outcome ?? null, m?.failureRole ?? null, m?.failureReason ?? null,
      m?.legalTurns ?? null, row.attemptCount,
      m?.roles.buyer.utility ?? null, m?.roles.seller.utility ?? null, m?.roles.buyer.gain ?? null, m?.roles.seller.gain ?? null,
      m?.welfare ?? null, m?.jointGain ?? null, m?.efficiency ?? null, m?.efficiencyNullReason ?? null,
      m?.paretoDominated ?? null, m?.zopaEmpty ?? null, m?.missedDeal ?? null, m?.dealWithEmptyZopa ?? null,
      m?.roles.buyer.individuallyRational ?? null, m?.roles.seller.individuallyRational ?? null,
      m?.roles.buyer.claimsFalse ?? null, m?.roles.buyer.claimsEvaluated ?? null, m?.roles.seller.claimsFalse ?? null, m?.roles.seller.claimsEvaluated ?? null,
      m?.roles.buyer.invalidAttempts ?? null, m?.roles.seller.invalidAttempts ?? null, m?.scoringVersion ?? null, m?.ruleset ?? null,
    ];
  }));
}

const TURN_HEADER = [
  "execution_id", "cell_id", "instance_seed", "replicate", "attempt_index", "role", "legal_turn", "attempt_no", "agent_key",
  "verdict", "error", "action_type", "public_terms", "public_note", "claim_count",
];

/** Public action summary: terms as id=value pairs. */
export function termsSummary(action: Action | null): string | null {
  if (!action?.terms) return null;
  return Object.entries(action.terms).map(([key, value]) => `${key}=${value}`).join("; ");
}

/** turns.csv: one row per attempt with validity/error/claim counts and public action content only. */
export function turnsCsv(executions: MatchExecution[]): string {
  const rows: CsvCell[][] = [];
  for (const execution of executions) {
    for (const attempt of execution.attempts) {
      rows.push([
        execution.executionId, execution.cellId, execution.instanceSeed, execution.replicate, attempt.index, attempt.role,
        attempt.legalTurn, attempt.attemptNo, attempt.agentKey, attempt.verdict, attempt.error, attempt.parsed?.type ?? null,
        termsSummary(attempt.parsed), attempt.parsed?.note ?? null, attempt.parsed?.claims?.length ?? 0,
      ]);
    }
  }
  return toCsv(TURN_HEADER, rows);
}
