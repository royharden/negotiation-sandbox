import { analyzeClaims, analyzeDeception } from "./deception.ts";
import { analyzeGrid, isParetoDominated, tolerance } from "./enumerateGrid.ts";
import type { AttemptRecord, EfficiencyNullReason, GameState, MatchMetrics, MatchStatus, Outcome, Role, RoleMetrics, Scenario, Scores } from "./types.ts";
import { SCORING_VERSION } from "./types.ts";
import { noDealUtility, roleUtility, rulesetOf } from "./utility.ts";

export function scoreGame(scenario: Scenario, state: GameState, failure?: { role: Role; reason: string }): Scores {
  const report = analyzeDeception(scenario, state.history);
  const shared = {
    turns: state.history.length,
    rounds: Math.ceil(state.history.length / 2),
    buyer: report.buyer,
    seller: report.seller,
  };

  if (failure) {
    return {
      ...shared,
      outcome: "format_failure",
      terminalReason: failure.reason,
      agreedTerms: null,
      buyerUtility: null,
      sellerUtility: null,
      welfare: null,
      surplus: null,
      buyerShare: null,
      buyerIndividuallyRational: null,
      sellerIndividuallyRational: null,
      failureRole: failure.role,
      failureReason: failure.reason,
    };
  }

  if (state.terminal?.kind === "agreement") {
    const terms = state.terminal.terms;
    const buyerUtility = roleUtility(scenario, "buyer", terms);
    const sellerUtility = roleUtility(scenario, "seller", terms);
    const welfare = buyerUtility + sellerUtility;
    const buyerReservation = scenario.parties.buyer.private.reservationUtility;
    const sellerReservation = scenario.parties.seller.private.reservationUtility;
    return {
      ...shared,
      outcome: "agreement",
      terminalReason: "accept",
      agreedTerms: { ...terms },
      buyerUtility,
      sellerUtility,
      welfare,
      surplus: welfare - buyerReservation - sellerReservation,
      buyerShare: welfare === 0 ? null : buyerUtility / welfare,
      buyerIndividuallyRational: buyerUtility + 1e-9 >= buyerReservation,
      sellerIndividuallyRational: sellerUtility + 1e-9 >= sellerReservation,
      failureRole: null,
      failureReason: null,
    };
  }

  const buyerPayoff = noDealUtility(scenario, "buyer");
  const sellerPayoff = noDealUtility(scenario, "seller");
  return {
    ...shared,
    outcome: "disagreement",
    terminalReason: state.terminal?.kind === "disagreement" ? state.terminal.reason : "cap",
    agreedTerms: null,
    buyerUtility: buyerPayoff,
    sellerUtility: sellerPayoff,
    welfare: buyerPayoff + sellerPayoff,
    surplus: null,
    buyerShare: null,
    buyerIndividuallyRational: null,
    sellerIndividuallyRational: null,
    failureRole: null,
    failureReason: null,
  };
}

// ---------------------------------------------------------------------------
// v2 match metrics (PLAN 5). Also applied to v1 fixed instances under their recorded ruleset:
// v1 no-deal utility is the historical shared disagreementUtility; v1 gains are measured against the
// reservation threshold, and a legacy-baseline warning is set when the two differ.
// ---------------------------------------------------------------------------

export type MatchScoreInput = {
  scenario: Scenario;
  /** Cache key for the package grid (normally the instance id). */
  gridKey?: string;
  state: GameState;
  status: MatchStatus;
  failureRole?: Role | null;
  failureReason?: string | null;
  attempts: AttemptRecord[];
};

const RESOLVED: readonly MatchStatus[] = ["complete"];

export function outcomeOf(state: GameState): Outcome | null {
  if (!state.terminal) return null;
  if (state.terminal.kind === "agreement") return "agreement";
  return state.terminal.reason;
}

export function scoreMatch(input: MatchScoreInput): MatchMetrics {
  const { scenario, state } = input;
  const ruleset = rulesetOf(scenario);
  const tol = tolerance(scenario);
  const analysis = analyzeGrid(scenario, input.gridKey);
  const claims = analyzeClaims(scenario, state.history);
  const resolved = RESOLVED.includes(input.status) && state.terminal !== null;
  const outcome = resolved ? outcomeOf(state) : null;
  const reservation = (role: Role) => scenario.parties[role].private.reservationUtility;

  const roleMetrics = (role: Role): RoleMetrics => {
    let utility: number | null = null;
    let gain: number | null = null;
    let individuallyRational: boolean | null = null;
    if (outcome === "agreement" && state.terminal?.kind === "agreement") {
      utility = roleUtility(scenario, role, state.terminal.terms);
      gain = utility - reservation(role);
      individuallyRational = gain >= -tol;
    } else if (outcome === "walk" || outcome === "cap") {
      utility = noDealUtility(scenario, role);
      gain = ruleset === 2 ? 0 : utility - reservation(role);
    }
    return {
      utility,
      gain,
      individuallyRational,
      ...claims.roles[role],
      reservationMisstatements: [...claims.roles[role].reservationMisstatements],
      invalidAttempts: input.attempts.filter((attempt) => attempt.role === role && attempt.verdict === "invalid").length,
    };
  };
  const buyer = roleMetrics("buyer");
  const seller = roleMetrics("seller");

  const welfare = buyer.utility !== null && seller.utility !== null ? buyer.utility + seller.utility : null;
  const jointGain = buyer.gain !== null && seller.gain !== null ? buyer.gain + seller.gain : null;

  let efficiency: number | null = null;
  let efficiencyNullReason: EfficiencyNullReason | null = null;
  if (outcome !== "agreement") efficiencyNullReason = "no_agreement";
  else if (!buyer.individuallyRational || !seller.individuallyRational) efficiencyNullReason = "ir_violation";
  else if (analysis.maxJointGain === null) efficiencyNullReason = "no_ir_package";
  else if (analysis.maxJointGain <= tol) efficiencyNullReason = "no_positive_gain";
  else efficiency = (jointGain ?? 0) / analysis.maxJointGain;

  const paretoDominated = outcome === "agreement" && buyer.utility !== null && seller.utility !== null
    ? isParetoDominated(analysis, buyer.utility, seller.utility, tol)
    : null;

  const legacyBaselineWarning = ruleset === 1
    && (["buyer", "seller"] as const).some((role) => Math.abs(noDealUtility(scenario, role) - reservation(role)) > tol);

  return {
    scoringVersion: SCORING_VERSION,
    ruleset,
    status: input.status,
    outcome,
    failureRole: input.failureRole ?? null,
    failureReason: input.failureReason ?? null,
    agreedTerms: outcome === "agreement" && state.terminal?.kind === "agreement" ? { ...state.terminal.terms } : null,
    legalTurns: state.history.length,
    attempts: input.attempts.length,
    welfare,
    jointGain,
    packageCount: analysis.packageCount,
    zopaEmpty: analysis.zopaEmpty,
    maxJointGain: analysis.maxJointGain,
    efficiency,
    efficiencyNullReason,
    paretoDominated,
    missedDeal: outcome === null ? null : outcome !== "agreement" && !analysis.zopaEmpty,
    dealWithEmptyZopa: outcome === null ? null : outcome === "agreement" && analysis.zopaEmpty,
    legacyBaselineWarning,
    roles: { buyer, seller },
  };
}
