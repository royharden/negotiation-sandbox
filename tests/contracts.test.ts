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

// SQL/source text assertions below are SMOKE CHECKS of the written source. They are not
// transaction, grant or RLS evidence; that needs a real database with two genuine user clients.

test("smoke: the forward migration declares the service-only ledger, claim and grants", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261023190000_v2_artifacts_and_model_calls.sql", import.meta.url), "utf8");
  assert.match(sql, /create table public\.model_calls/);
  assert.match(sql, /unique \(owner_id, operation_id\)/);
  assert.match(sql, /unique \(owner_id, turn_key, attempt_no\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /create or replace function public\.claim_model_attempt/);
  assert.match(sql, /create or replace function public\.finish_model_attempt/);
  assert.equal((sql.match(/set search_path = ''/g) ?? []).length, 2);
  assert.equal((sql.match(/security definer/g) ?? []).length, 2);
  assert.match(sql, /revoke all on function public\.claim_model_attempt\([^)]*\) from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.finish_model_attempt\([^)]*\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.claim_model_attempt\([^)]*\) to service_role/);
  assert.match(sql, /revoke execute on function public\.reserve_llm_turn\(\) from authenticated/);
  assert.match(sql, /revoke insert, update, delete on public\.model_calls from anon, authenticated/);
  assert.match(sql, /model_calls_select on public\.model_calls\s+for select/);
  assert.equal(/create policy \w+ on public\.model_calls\s+for (insert|update|delete|all)/.test(sql), false);
  // Reserve on the EXISTING counter under its <= 40 bound; no second counter or competing tables.
  assert.match(sql, /insert into public\.llm_turn_usage/);
  assert.match(sql, /where u\.turn_count < 40/);
  assert.match(sql, /quota_exhausted/);
  assert.equal(/create table public\.(transcripts|app_config)/.test(sql), false);
  assert.equal(/drop table/i.test(sql), false);
  // v2 artifact columns stay nullable with a version-aware shape check and 1 MiB bound.
  assert.match(sql, /add column artifact_jsonl text,/);
  assert.match(sql, /octet_length\(artifact_jsonl\) <= 1048576/);
  assert.match(sql, /runs_owner_execution_idx/);
  assert.match(sql, /coalesce\(artifact_version, 0\) = 2/);
  assert.match(sql, /s\.visibility = 'public' or s\.owner_id = \(select auth\.uid\(\)\)/);
});

test("smoke: the handler checks LLM_API_KEY before claiming and never uses reserve_llm_turn", () => {
  const handler = readFileSync(new URL("../supabase/functions/negotiate-turn/handler.ts", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../supabase/functions/negotiate-turn/index.ts", import.meta.url), "utf8");
  assert.equal(handler.includes("reserve_llm_turn"), false);
  assert.equal(entry.includes("reserve_llm_turn"), false);
  const turnStart = handler.indexOf("async function turn(");
  assert.ok(turnStart > 0);
  const turnSource = handler.slice(turnStart);
  const keyAt = turnSource.indexOf("settings.apiKey");
  const claimAt = turnSource.indexOf("deps.claim(");
  assert.ok(keyAt >= 0 && claimAt > keyAt);
  assert.ok(handler.indexOf('env("LLM_API_KEY")') >= 0);
  assert.match(handler, /missing_secret/);
  assert.match(handler, /redirect:\s*"error"/);
  // handler.ts must stay importable from Node: no Deno globals, no npm:/jsr: specifiers.
  assert.equal(/\bDeno\./.test(handler), false);
  assert.equal(/from "(npm|jsr):/.test(handler), false);
  assert.match(entry, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(entry, /auth\.getUser\(token\)/);
  assert.equal(entry.includes("I accept that package"), false);
  assert.equal(handler.includes("I accept that package"), false);
});

function extract(sql: string, tag: string): string {
  const marker = `$${tag}$`;
  const start = sql.indexOf(marker);
  const end = sql.indexOf(marker, start + marker.length);
  if (start < 0 || end < 0) throw new Error(`missing $${tag}$ block`);
  return sql.slice(start + marker.length, end);
}
