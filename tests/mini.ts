import { parseScenario } from "../supabase/functions/_shared/scenario.ts";
import type { Scenario } from "../supabase/functions/_shared/types.ts";

export function miniScenario(sellerReservation = 20): Scenario {
  const parsed = parseScenario({
    schemaVersion: 1,
    id: "mini-sale",
    title: "Mini sale",
    publicBrief: "A buyer and a seller trade one price and one color.",
    issues: [
      { id: "price", label: "Price", kind: "number", min: 0, max: 100, step: 10 },
      { id: "color", label: "Color", kind: "choice", options: ["red", "blue"] },
    ],
    parties: {
      buyer: {
        publicBrief: "You want a low price and you prefer blue.",
        private: {
          reservationUtility: 20,
          scores: {
            price: { kind: "number", atMin: 100, atMax: 0 },
            color: { kind: "choice", options: { red: 0, blue: 10 } },
          },
        },
      },
      seller: {
        publicBrief: "You want a high price and you prefer red.",
        private: {
          reservationUtility: sellerReservation,
          scores: {
            price: { kind: "number", atMin: 0, atMax: 100 },
            color: { kind: "choice", options: { red: 10, blue: 0 } },
          },
        },
      },
    },
    rules: { maxRounds: 4, openingRole: "buyer", disagreementUtility: 0 },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.scenario;
}

/**
 * Hand-traced v2 oracle: x in {0,1,2}, c in {a,b}; both reservations 1.
 * Buyer utilities (x,c): (0,a)4 (0,b)6 (1,a)2 (1,b)4 (2,a)0 (2,b)2.
 * Seller utilities:      (0,a)3 (0,b)0 (1,a)5 (1,b)2 (2,a)7 (2,b)4.
 * IR for both (U >= 1 each): (0,a) gains 3+2=5, (1,a) 1+4=5, (1,b) 3+1=4, (2,b) 1+3=4. maxJointGain = 5.
 * Pareto: (1,b) is dominated by (0,a); (2,b) by (1,a); (0,b) and (2,a) are not dominated.
 */
export function miniV2Definition(maxRounds = 2): Record<string, unknown> {
  return {
    schemaVersion: 2,
    rulesetVersion: 2,
    id: "mini-v2",
    title: "Mini v2",
    publicBrief: "Two issues, hand-traced.",
    issues: [
      { id: "x", label: "X", kind: "number", min: 0, max: 2, step: 1 },
      { id: "c", label: "C", kind: "choice", options: ["a", "b"] },
    ],
    parties: {
      buyer: {
        label: "Buyer",
        publicBrief: "Low x, prefers b.",
        private: { reservationUtility: 1, scores: { x: { kind: "number", atMin: 4, atMax: 0 }, c: { kind: "choice", options: { a: 0, b: 2 } } } },
      },
      seller: {
        label: "Seller",
        publicBrief: "High x, prefers a.",
        private: { reservationUtility: 1, scores: { x: { kind: "number", atMin: 0, atMax: 4 }, c: { kind: "choice", options: { a: 3, b: 0 } } } },
      },
    },
    rules: { maxRounds, openingRole: "buyer" },
  };
}
