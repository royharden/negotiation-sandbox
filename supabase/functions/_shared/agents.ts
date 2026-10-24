import type { Action, AgentView, Issue, PrivateCard, ScriptedId, Terms } from "./types.ts";
import { alignNumber, packageUtility } from "./utility.ts";

export function scriptedAction(style: ScriptedId, view: AgentView): Action {
  const issues = view.publicScenario.issues;
  const card = view.ownPrivate;
  const ideal = idealTerms(issues, card);
  const center = centerTerms(issues);
  const myOffers = view.history.filter((turn) => turn.role === view.role && turn.action.type === "offer").length;
  const progress = Math.min(1, myOffers / Math.max(1, view.maxRounds - 1));
  const offerProgress = style === "firm" ? 0.25 * progress : progress;
  const terms = mixTerms(issues, ideal, center, offerProgress);
  const claims = claimsFor(style, card, view.seed, myOffers);

  if (view.standing && view.standing.role !== view.role) {
    const utility = packageUtility(issues, card, view.standing.terms);
    const idealUtility = packageUtility(issues, card, ideal);
    const aspiration = style === "firm"
      ? card.reservationUtility + 0.65 * (idealUtility - card.reservationUtility)
      : card.reservationUtility + (1 - progress) * (idealUtility - card.reservationUtility);
    const slack = style === "firm" ? 0 : (view.seed % 5) * 0.5;
    if (utility + 1e-9 >= card.reservationUtility + slack && utility + 1e-9 >= aspiration - slack) {
      return spoken("accept", undefined, style === "bluff" ? claims : undefined);
    }
  }

  return spoken("offer", terms, claims);
}

function claimsFor(style: ScriptedId, card: PrivateCard, seed: number, myOffers: number): Action["claims"] {
  if (style === "bluff") {
    return [{ about: "reservation", stated: card.reservationUtility + 20 + (seed % 7) }];
  }
  if (style === "concession" && myOffers === 0) {
    return [{ about: "reservation", stated: card.reservationUtility }];
  }
  return undefined;
}

function spoken(type: "offer" | "accept", terms: Terms | undefined, claims: Action["claims"]): Action {
  const action: Action = {
    type,
    note: type === "accept" ? "I accept that package." : "That package is my current proposal.",
  };
  if (type === "offer" && terms) action.terms = terms;
  if (claims && claims.length > 0) action.claims = claims;
  return action;
}

function idealTerms(issues: Issue[], card: PrivateCard): Terms {
  const terms: Terms = {};
  for (const issue of issues) {
    const score = card.scores[issue.id];
    if (!score) throw new Error(`missing score for ${issue.id}`);
    if (issue.kind === "number" && score.kind === "number") {
      terms[issue.id] = score.atMin >= score.atMax ? issue.min : issue.max;
    } else if (issue.kind === "choice" && score.kind === "choice") {
      let best = issue.options[0] ?? "";
      let bestValue = score.options[best] ?? Number.NEGATIVE_INFINITY;
      for (const option of issue.options) {
        const value = score.options[option] ?? Number.NEGATIVE_INFINITY;
        if (value > bestValue || (value === bestValue && option < best)) {
          best = option;
          bestValue = value;
        }
      }
      terms[issue.id] = best;
    }
  }
  return terms;
}

function centerTerms(issues: Issue[]): Terms {
  const terms: Terms = {};
  for (const issue of issues) {
    if (issue.kind === "number") {
      terms[issue.id] = alignNumber(issue, (issue.min + issue.max) / 2);
    } else {
      terms[issue.id] = issue.options[Math.floor((issue.options.length - 1) / 2)] ?? issue.options[0] ?? "";
    }
  }
  return terms;
}

function mixTerms(issues: Issue[], ideal: Terms, center: Terms, progress: number): Terms {
  const terms: Terms = {};
  for (const issue of issues) {
    if (issue.kind === "number") {
      const from = ideal[issue.id];
      const to = center[issue.id];
      if (typeof from !== "number" || typeof to !== "number") throw new Error(`bad number term for ${issue.id}`);
      terms[issue.id] = alignNumber(issue, from + (to - from) * progress);
    } else {
      const chosen = progress >= 0.67 ? center[issue.id] : ideal[issue.id];
      if (typeof chosen !== "string") throw new Error(`bad choice term for ${issue.id}`);
      terms[issue.id] = chosen;
    }
  }
  return terms;
}
