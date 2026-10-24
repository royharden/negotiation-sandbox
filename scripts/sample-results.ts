/**
 * Sample-results generator. WRITTEN BUT NOT RUN during Dirty Mode construction.
 *
 * Run only when activation is authorized (Node 22+ with type stripping):
 *   node --experimental-strip-types scripts/sample-results.ts [outDir]
 *
 * It runs the default scripted Sandbox matrix (three ordered pairings x instance seeds 1 and 2, one
 * replicate) on each bundled v2 scenario plus the compatible synthetic fixture demo, then writes every
 * transcript as JSONL, games.csv, turns.csv and summary.json. Any README number must cite the
 * summary's run_spec_sha256, engine version and transcript hashes. No provider is called.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultRows, summarizeCells } from "../supabase/functions/_shared/aggregate.ts";
import { gamesCsv, turnsCsv } from "../supabase/functions/_shared/csv.ts";
import { fixtureConfig, parseFixture } from "../supabase/functions/_shared/fixtureAgent.ts";
import type { SyntheticFixture } from "../supabase/functions/_shared/fixtureAgent.ts";
import { instantiate } from "../supabase/functions/_shared/instantiate.ts";
import { parseJsonStrict } from "../supabase/functions/_shared/json.ts";
import { fixtureSeat, runMatrix, scriptedSeat } from "../supabase/functions/_shared/runner.ts";
import type { MatchExecution, Seat } from "../supabase/functions/_shared/runner.ts";
import { buildRunSpec, runSpecDigest, scriptedConfig } from "../supabase/functions/_shared/runspec.ts";
import type { CellSpec, RunSpec } from "../supabase/functions/_shared/runspec.ts";
import { parseScenarioText } from "../supabase/functions/_shared/scenario.ts";
import { buildTranscript, encodeJsonl } from "../supabase/functions/_shared/transcript.ts";
import type { AgentConfig, Role } from "../supabase/functions/_shared/types.ts";
import { ENGINE_VERSION } from "../supabase/functions/_shared/types.ts";
import { sha256Hex } from "../supabase/functions/_shared/hash.ts";

const root = new URL("../", import.meta.url);
const outDir = process.argv[2] ?? "sample-results";

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function loadFixture(path: string): SyntheticFixture {
  const json = parseJsonStrict(read(path));
  if (!json.ok) throw new Error(json.error);
  const parsed = parseFixture(json.value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.fixture;
}

function seatFor(config: AgentConfig, fixtures: SyntheticFixture[]): Seat {
  if (config.kind === "scripted") return scriptedSeat(config.policy);
  if (config.kind === "fixture") {
    const fixture = fixtures.find((item) => item.id === config.fixtureId);
    if (!fixture) throw new Error(`missing fixture ${config.fixtureId}`);
    return fixtureSeat(fixture);
  }
  throw new Error("the sample generator never calls a model");
}

async function runSpec(name: string, spec: RunSpec, fixtures: SyntheticFixture[]) {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const instances = new Map<number, ReturnType<typeof instantiate>>();
  for (const seed of spec.instanceSeeds) instances.set(seed, instantiate(spec.definition, seed));
  const result = await runMatrix({
    spec,
    newExecutionId: randomUUID,
    seatsFor: (cell: CellSpec) => ({ buyer: seatFor(cell.roles.buyer, fixtures), seller: seatFor(cell.roles.seller, fixtures) } as Record<Role, Seat>),
  });
  const transcriptHashes: Record<string, string> = {};
  for (const execution of result.executions as MatchExecution[]) {
    const built = instances.get(execution.instanceSeed);
    if (!built?.ok) throw new Error(`instance ${execution.instanceSeed} failed`);
    const text = encodeJsonl(buildTranscript({ spec, instance: built.instance, execution, fixtures }));
    const file = `${execution.cellId}-seed${execution.instanceSeed}-r${execution.replicate}-${execution.executionId}.jsonl`;
    writeFileSync(join(dir, file), text);
    transcriptHashes[file] = sha256Hex(text);
  }
  const ids = new Map<number, string>();
  for (const [seed, built] of instances) if (built.ok) ids.set(seed, built.instance.instanceId);
  const rows = resultRows(spec, result.planned, result.executions, ids);
  writeFileSync(join(dir, "games.csv"), gamesCsv(rows));
  writeFileSync(join(dir, "turns.csv"), turnsCsv(result.executions));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    generatedBy: "scripts/sample-results.ts",
    engineVersion: ENGINE_VERSION,
    run_spec_sha256: runSpecDigest(spec),
    runSpec: spec,
    transcriptHashes,
    cells: summarizeCells(rows),
  }, null, 2));
  console.log(`${name}: ${result.executions.length}/${result.planned.length} matches -> ${dir}`);
}

const pairings: Array<[CellSpec["cellId"], AgentConfig, AgentConfig]> = [
  ["concession-concession", scriptedConfig("concession"), scriptedConfig("concession")],
  ["concession-firm", scriptedConfig("concession"), scriptedConfig("firm")],
  ["bluff-concession", scriptedConfig("bluff"), scriptedConfig("concession")],
];

const fixture = loadFixture("fixtures/agents/synthetic-warehouse-demo.json");
for (const file of ["warehouse-lease-v2", "design-retainer-v2"]) {
  const parsed = parseScenarioText(read(`fixtures/scenarios/${file}.json`));
  if (!parsed.ok) throw new Error(parsed.error);
  const built = buildRunSpec({
    label: `${file} default sandbox`,
    definition: parsed.definition,
    instanceSeeds: [1, 2],
    cells: pairings.map(([cellId, buyer, seller]) => ({ cellId, roles: { buyer, seller } })),
  });
  if (!built.ok) throw new Error(built.error);
  await runSpec(file, built.spec, [fixture]);
}

const warehouse = parseScenarioText(read("fixtures/scenarios/warehouse-lease-v2.json"));
if (!warehouse.ok) throw new Error(warehouse.error);
const demo = buildRunSpec({
  label: "synthetic fixture demo",
  definition: warehouse.definition,
  instanceSeeds: [1],
  cells: [{ cellId: "synthetic-demo", roles: { buyer: fixtureConfig(fixture), seller: scriptedConfig("concession") } }],
});
if (!demo.ok) throw new Error(demo.error);
await runSpec("synthetic-demo", demo.spec, [fixture]);
