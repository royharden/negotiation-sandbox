import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseScenario } from "../supabase/functions/_shared/scenario.ts";

test("the migration keeps rows with their owner and caps model turns", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261023180000_init.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /reserve_llm_turn/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /turn_count < 40/);
  assert.match(sql, /daily_turn_limit/);
  assert.match(sql, /security definer/);
  assert.match(sql, /visibility = 'public' or owner_id = auth\.uid\(\)/);
  assert.match(sql, /revoke all on public\.llm_turn_usage/);
});

test("catalog seed matches the shipped scenario files", () => {
  const seed = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  for (const [name, tag] of [["warehouse-lease", "warehouse"], ["design-retainer", "retainer"]] as const) {
    const fixture = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown;
    const embedded = JSON.parse(extract(seed, tag)) as unknown;
    const left = parseScenario(fixture);
    const right = parseScenario(embedded);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (left.ok && right.ok) assert.deepEqual(left.scenario, right.scenario);
  }
});

test("the model function checks the secret before reserving a turn", () => {
  const source = readFileSync(new URL("../supabase/functions/negotiate-turn/index.ts", import.meta.url), "utf8");
  const keyAt = source.indexOf("LLM_API_KEY");
  const reserveAt = source.indexOf("reserve_llm_turn");
  assert.ok(keyAt >= 0);
  assert.ok(reserveAt > keyAt);
  assert.match(source, /missing_secret/);
  assert.match(source, /redirect:\s*"error"/);
  assert.equal(source.includes("I accept that package"), false);
});

function extract(sql: string, tag: string): string {
  const marker = `$${tag}$`;
  const start = sql.indexOf(marker);
  const end = sql.indexOf(marker, start + marker.length);
  if (start < 0 || end < 0) throw new Error(`missing $${tag}$ block`);
  return sql.slice(start + marker.length, end);
}
