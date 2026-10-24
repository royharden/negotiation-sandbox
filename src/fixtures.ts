import retainer from "../fixtures/design-retainer.json";
import warehouse from "../fixtures/warehouse-lease.json";
import { parseScenario } from "./engine.ts";
import type { Scenario } from "./engine.ts";

export function loadBundledScenarios(): { scenarios: Scenario[]; errors: string[] } {
  const errors: string[] = [];
  const scenarios: Scenario[] = [];
  for (const [name, raw] of [
    ["warehouse-lease", warehouse],
    ["design-retainer", retainer],
  ] as const) {
    const parsed = parseScenario(raw);
    if (!parsed.ok) errors.push(`${name}: ${parsed.error}`);
    else scenarios.push(parsed.scenario);
  }
  return { scenarios, errors };
}
