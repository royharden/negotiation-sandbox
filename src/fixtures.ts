import demoFixture from "../fixtures/agents/synthetic-warehouse-demo.json";
import retainer from "../fixtures/design-retainer.json";
import retainerV2 from "../fixtures/scenarios/design-retainer-v2.json";
import noZopa from "../fixtures/scenarios/no-zopa.json";
import warehouseV2 from "../fixtures/scenarios/warehouse-lease-v2.json";
import warehouse from "../fixtures/warehouse-lease.json";
import { parseDefinition, parseFixture } from "./engine.ts";
import type { ScenarioDefinition, SyntheticFixture } from "./engine.ts";

/** Bundled definitions: v2 first (Sandbox default), then the preserved v1 files (legacy ruleset). */
export function loadBundledDefinitions(): { definitions: ScenarioDefinition[]; errors: string[] } {
  const errors: string[] = [];
  const definitions: ScenarioDefinition[] = [];
  for (const [name, raw] of [
    ["warehouse-lease-v2", warehouseV2],
    ["design-retainer-v2", retainerV2],
    ["no-zopa", noZopa],
    ["warehouse-lease (v1)", warehouse],
    ["design-retainer (v1)", retainer],
  ] as const) {
    const parsed = parseDefinition(raw);
    if (!parsed.ok) errors.push(`${name}: ${parsed.error}`);
    else definitions.push(parsed.definition);
  }
  return { definitions, errors };
}

export function loadBundledFixtures(): { fixtures: SyntheticFixture[]; errors: string[] } {
  const parsed = parseFixture(demoFixture);
  return parsed.ok ? { fixtures: [parsed.fixture], errors: [] } : { fixtures: [], errors: [`synthetic fixture: ${parsed.error}`] };
}
