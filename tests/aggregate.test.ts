import assert from "node:assert/strict";
import test from "node:test";
import { fraction, isAttempted, pairedDifferences, resultRows, stats, summarizeCells } from "../supabase/functions/_shared/aggregate.ts";
import { csvCell, gamesCsv, toCsv, turnsCsv } from "../supabase/functions/_shared/csv.ts";
import { instantiate } from "../supabase/functions/_shared/instantiate.ts";
import { ModelBlocked, runMatrix, scriptedSeat } from "../supabase/functions/_shared/runner.ts";
import type { Seat } from "../supabase/functions/_shared/runner.ts";
import { buildRunSpec, cellKey, modelConfig, scriptedConfig } from "../supabase/functions/_shared/runspec.ts";
import type { CellSpec } from "../supabase/functions/_shared/runspec.ts";
import { parseDefinition } from "../supabase/functions/_shared/scenario.ts";
import type { AgentConfig, Role } from "../supabase/functions/_shared/types.ts";
import { miniV2Definition } from "./mini.ts";

function definition() {
  const parsed = parseDefinition(miniV2Definition(3));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.definition;
}

const blockedSeat: Seat = () => {
  throw new ModelBlocked("Live is not configured.");
};

function seat(config: AgentConfig): Seat {
  return config.kind === "scripted" ? scriptedSeat(config.policy) : blockedSeat;
}

let id = 0;
const nextId = () => `agg-${String(id++).padStart(8, "0")}`;

async function sample(skipPlan?: number) {
  const def = definition();
  const cells: CellSpec[] = [
    { cellId: "cc", roles: { buyer: scriptedConfig("concession"), seller: scriptedConfig("concession") } },
    { cellId: "bc", roles: { buyer: scriptedConfig("bluff"), seller: scriptedConfig("concession") } },
    { cellId: "mc", roles: { buyer: modelConfig("m"), seller: scriptedConfig("concession") } },
  ];
  const built = buildRunSpec({ label: "agg", definition: def, instanceSeeds: [1, 2], cells });
  if (!built.ok) throw new Error(built.error);
  const result = await runMatrix({
    spec: built.spec,
    newExecutionId: nextId,
    skip: (planned) => planned.planIndex === skipPlan,
    seatsFor: (cell) => ({ buyer: seat(cell.roles.buyer), seller: seat(cell.roles.seller) } as Record<Role, Seat>),
  });
  const ids = new Map<number, string>();
  for (const seed of [1, 2]) {
    const instance = instantiate(def, seed);
    if (instance.ok) ids.set(seed, instance.instance.instanceId);
  }
  return { spec: built.spec, result, rows: resultRows(built.spec, result.planned, result.executions, ids) };
}

test("stats and fractions never invent a value for an empty denominator", () => {
  assert.deepEqual(stats([]), { n: 0, mean: null, median: null, min: null, max: null });
  assert.deepEqual(stats([3, 1, 2, 10]), { n: 4, mean: 4, median: 2.5, min: 1, max: 10 });
  assert.deepEqual(fraction(0, 0), { count: 0, of: 0, value: null });
});

test("planned, attempted and resolved denominators stay separate", async () => {
  const { rows } = await sample(3);
  assert.equal(rows.length, 6, "every planned match has a row");
  assert.equal(rows[3]?.status, "not_started");
  const summaries = summarizeCells(rows);
  const live = summaries.find((item) => item.cellId === "mc");
  assert.ok(live);
  if (live) {
    assert.equal(live.planned, 2);
    assert.equal(live.failures.blocked, 2);
    assert.equal(live.attempted, 0, "preflight-blocked cells are not attempted");
    assert.equal(live.agreementOfAttempted.value, null);
    assert.equal(live.utility.buyer.n, 0, "no zero is substituted for missing utility");
  }
  const cc = summaries.find((item) => item.cellId === "cc");
  assert.ok(cc);
  if (cc) {
    assert.equal(cc.planned, 2);
    assert.equal(cc.notStarted, 1);
    assert.equal(cc.attempted, 1);
    assert.equal(cc.agreementOfResolved.of, cc.resolved);
  }
  assert.equal(rows.filter(isAttempted).length, 3);
});

test("paired differences use only matching complete instances and report missing pairs", async () => {
  const full = await sample();
  const paired = pairedDifferences(full.rows, "cc", "bc", (metrics) => metrics.welfare);
  assert.equal(paired.sharedComplete + paired.missingPairs, 2);
  for (const delta of paired.deltas) assert.equal(delta.delta, delta.b - delta.a);
  const partial = await sample(0);
  const missing = pairedDifferences(partial.rows, "cc", "bc", (metrics) => metrics.welfare);
  assert.ok(missing.missingPairs >= 1, "the unstarted seed-1 cc match leaves its pair missing");
  const vsBlocked = pairedDifferences(full.rows, "cc", "mc", (metrics) => metrics.welfare);
  assert.equal(vsBlocked.sharedComplete, 0);
  assert.equal(vsBlocked.missingPairs, 2);
});

test("prompt variants and model ids never share a cell key", () => {
  const spec = { definitionDigest: "a".repeat(64), versions: { ruleset: 2 as const, engine: "", scoring: "", prompt: "", generator: "", canonical: "", hash: "" } };
  const neutral = cellKey(spec, { cellId: "x", roles: { buyer: modelConfig("m"), seller: scriptedConfig("firm") } });
  const warned = cellKey(spec, { cellId: "x", roles: { buyer: modelConfig("m", "honesty-warned"), seller: scriptedConfig("firm") } });
  const other = cellKey(spec, { cellId: "x", roles: { buyer: modelConfig("n"), seller: scriptedConfig("firm") } });
  assert.equal(new Set([neutral, warned, other]).size, 3);
});

test("CSV quoting and spreadsheet formula neutralization", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-x"), "'-x");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(-3), "-3", "numbers are not text");
  assert.equal(csvCell(null), "");
  assert.equal(toCsv(["a", "b"], [[1, "x"]]), "a,b\r\n1,x\r\n");
});

test("games.csv has one row per planned match and turns.csv one row per attempt, without private cards", async () => {
  const { rows, result } = await sample(3);
  const games = gamesCsv(rows).trimEnd().split("\r\n");
  assert.equal(games.length, 1 + rows.length);
  const turns = turnsCsv(result.executions).trimEnd().split("\r\n");
  assert.equal(turns.length, 1 + result.executions.reduce((sum, execution) => sum + execution.attempts.length, 0));
  const all = gamesCsv(rows) + turnsCsv(result.executions);
  assert.equal(all.includes("reservationUtility"), false);
  assert.equal(all.includes("atMin"), false);
});
