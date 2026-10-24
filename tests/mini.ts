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
