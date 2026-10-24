import { analyzeDeception } from "./deception.ts";
import type { GameState, Role, Scenario, Scores } from "./types.ts";
import { roleUtility } from "./utility.ts";

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

  const payoff = scenario.rules.disagreementUtility;
  return {
    ...shared,
    outcome: "disagreement",
    terminalReason: state.terminal?.kind === "disagreement" ? state.terminal.reason : "cap",
    agreedTerms: null,
    buyerUtility: payoff,
    sellerUtility: payoff,
    welfare: payoff * 2,
    surplus: null,
    buyerShare: null,
    buyerIndividuallyRational: null,
    sellerIndividuallyRational: null,
    failureRole: null,
    failureReason: null,
  };
}
