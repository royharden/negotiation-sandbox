import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixtureCompatible, fixtureConfig, parseFixture } from "../supabase/functions/_shared/fixtureAgent.ts";
import type { SyntheticFixture } from "../supabase/functions/_shared/fixtureAgent.ts";
import { instantiate } from "../supabase/functions/_shared/instantiate.ts";
import { parseJsonStrict } from "../supabase/functions/_shared/json.ts";
import { initialState, replay } from "../supabase/functions/_shared/referee.ts";
import { buildRoleRequest } from "../supabase/functions/_shared/request.ts";
import { fixtureSeat, playMatch, runMatrix, scriptedSeat } from "../supabase/functions/_shared/runner.ts";
import type { Seat } from "../supabase/functions/_shared/runner.ts";
import { buildRunSpec, modelConfig, planMatches, scriptedConfig, worstCaseModelCalls } from "../supabase/functions/_shared/runspec.ts";
import type { CellSpec, RunSpec } from "../supabase/functions/_shared/runspec.ts";
import { parseDefinition, parseScenarioText } from "../supabase/functions/_shared/scenario.ts";
import { buildTranscript, encodeJsonl, verifiedResumeKey, verifyTranscript } from "../supabase/functions/_shared/transcript.ts";
import type { AgentConfig, Role, ScenarioDefinition, ScriptedId } from "../supabase/functions/_shared/types.ts";

function definitionFrom(path: string): ScenarioDefinition {
  const parsed = parseScenarioText(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.definition;
}

function demoFixture(): SyntheticFixture {
  const json = parseJsonStrict(readFileSync(new URL("../fixtures/agents/synthetic-warehouse-demo.json", import.meta.url), "utf8"));
  if (!json.ok) throw new Error(json.error);
  const parsed = parseFixture(json.value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.fixture;
}

function cell(cellId: string, buyer: AgentConfig, seller: AgentConfig): CellSpec {
  return { cellId, roles: { buyer, seller } };
}

const DEFAULT_PAIRINGS: Array<[ScriptedId, ScriptedId]> = [["concession", "concession"], ["concession", "firm"], ["bluff", "concession"]];

function defaultSpec(definition: ScenarioDefinition): RunSpec {
  const built = buildRunSpec({
    label: "default sandbox",
    definition,
    instanceSeeds: [1, 2],
    cells: DEFAULT_PAIRINGS.map(([buyer, seller]) => cell(`${buyer}-${seller}`, scriptedConfig(buyer), scriptedConfig(seller))),
  });
  if (!built.ok) throw new Error(built.error);
  return built.spec;
}

function scriptedSeats(spec: RunSpec, cellId: string): Record<Role, Seat> {
  const roles = spec.cells.find((item) => item.cellId === cellId)?.roles;
  const seat = (config: AgentConfig | undefined): Seat => {
    if (config?.kind !== "scripted") throw new Error("scripted cells only");
    return scriptedSeat(config.policy);
  };
  return { buyer: seat(roles?.buyer), seller: seat(roles?.seller) };
}

let counter = 0;
const nextId = () => `exec-${String(counter++).padStart(8, "0")}`;

async function oneTranscript(): Promise<string> {
  const definition = definitionFrom("scenarios/warehouse-lease-v2.json");
  const spec = defaultSpec(definition);
  const built = instantiate(definition, 1);
  if (!built.ok) throw new Error(built.error);
  const execution = await playMatch({
    instance: built.instance,
    cell: spec.cells[0] as CellSpec,
    replicate: 0,
    executionId: nextId(),
    seats: scriptedSeats(spec, "concession-concession"),
  });
  return encodeJsonl(buildTranscript({ spec, instance: built.instance, execution }));
}

test("the default sandbox plans exactly six matches and runs them in order", async () => {
  const spec = defaultSpec(definitionFrom("scenarios/warehouse-lease-v2.json"));
  const planned = planMatches(spec);
  assert.equal(planned.length, 6);
  assert.deepEqual(planned.map((match) => `${match.instanceSeed}:${match.cellId}`), [
    "1:concession-concession", "1:concession-firm", "1:bluff-concession",
    "2:concession-concession", "2:concession-firm", "2:bluff-concession",
  ]);
  const result = await runMatrix({ spec, seatsFor: (item) => scriptedSeats(spec, item.cellId), newExecutionId: nextId });
  assert.equal(result.executions.length, 6);
  assert.equal(new Set(result.executions.map((execution) => execution.executionId)).size, 6);
  for (const execution of result.executions) assert.ok(["complete", "format_failure"].includes(execution.status));
  assert.equal(worstCaseModelCalls(spec), 0, "scripted sandbox makes no paid calls");
});

test("cancellation leaves later planned matches not started", async () => {
  const spec = defaultSpec(definitionFrom("scenarios/warehouse-lease-v2.json"));
  let calls = 0;
  const result = await runMatrix({
    spec,
    seatsFor: (item) => scriptedSeats(spec, item.cellId),
    newExecutionId: nextId,
    isCancelled: () => calls >= 2,
    onProgress: (progress) => { calls = progress.done.length; },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.executions.length, 2);
  assert.equal(result.planned.length, 6);
});

test("live preflight bounds: model/model 24 attempts and one model seat 12 at maxRounds 6", () => {
  const definition = definitionFrom("scenarios/warehouse-lease-v2.json");
  const model = modelConfig("configured-model");
  const both = buildRunSpec({ label: "live", definition, instanceSeeds: [1], cells: [cell("mm", model, model)] });
  const one = buildRunSpec({ label: "live", definition, instanceSeeds: [1], cells: [cell("ms", model, scriptedConfig("firm"))] });
  assert.equal(both.ok && one.ok, true);
  if (both.ok && one.ok) {
    assert.equal(worstCaseModelCalls(both.spec), 24);
    assert.equal(worstCaseModelCalls(one.spec), 12);
  }
});

test("a transcript round-trips, recomputes, and gives a verified resume key", async () => {
  const text = await oneTranscript();
  const verified = verifyTranscript(text);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.deepEqual(verified.report.problems, []);
  assert.equal(verified.report.verified, true);
  assert.notEqual(verifiedResumeKey(verified.report), null);
  assert.equal(text.split("\n").filter(Boolean).every((line) => parseJsonStrict(line).ok), true);
});

test("tampered footer metrics, actions or configs do not reproduce", async () => {
  const lines = (await oneTranscript()).trimEnd().split("\n");
  const footer = JSON.parse(lines[lines.length - 1] as string) as { metrics: { welfare: number | null } };
  footer.metrics.welfare = 9999;
  const metricsTampered = [...lines.slice(0, -1), JSON.stringify(footer)].join("\n");
  const one = verifyTranscript(metricsTampered);
  assert.equal(one.ok && one.report.verified, false);
  if (one.ok) {
    assert.ok(one.report.problems.some((problem) => problem.includes("cached footer metrics")));
    assert.notEqual(one.report.recomputed.metrics.welfare, 9999, "the cached value is never accepted");
  }

  const attempt = JSON.parse(lines[1] as string) as { raw: string };
  attempt.raw = attempt.raw.replace("\"offer\"", "\"walk\"");
  const actionTampered = [lines[0], JSON.stringify(attempt), ...lines.slice(2)].join("\n");
  const two = verifyTranscript(actionTampered);
  assert.equal(two.ok && two.report.verified, false);

  const header = JSON.parse(lines[0] as string) as { roles: { buyer: { policy: string } } };
  header.roles.buyer.policy = "firm";
  const configTampered = [JSON.stringify(header), ...lines.slice(1)].join("\n");
  const three = verifyTranscript(configTampered);
  assert.equal(three.ok && three.report.verified, false);

  const noFooter = verifyTranscript(lines.slice(0, -1).join("\n"));
  assert.equal(noFooter.ok, true);
  if (noFooter.ok) {
    assert.equal(noFooter.report.verified, false);
    assert.equal(noFooter.report.consistent, true);
    assert.equal(verifiedResumeKey(noFooter.report), null);
  }
  assert.equal(verifyTranscript("x".repeat(1024 * 1024 + 1)).ok, false, "oversized documents are rejected, not truncated");
  assert.equal(verifyTranscript('{"record":"header","transcriptVersion":2,"a":1,"a":2}').ok, false, "duplicate keys");
});

test("the synthetic fixture demo: illegal accept, feedback, repair and a false claim, all refereed", async () => {
  const fixture = demoFixture();
  const definition = definitionFrom("scenarios/warehouse-lease-v2.json");
  const opponent = scriptedConfig("concession");
  assert.equal(fixtureCompatible(fixture, definition, 1, "buyer", opponent), true);
  assert.equal(fixtureCompatible(fixture, definition, 2, "buyer", opponent), false);
  assert.equal(fixtureCompatible(fixture, definition, 1, "buyer", scriptedConfig("firm")), false);

  const built = buildRunSpec({ label: "fixture demo", definition, instanceSeeds: [1], cells: [cell("demo", fixtureConfig(fixture), opponent)] });
  const instance = instantiate(definition, 1);
  assert.equal(built.ok && instance.ok, true);
  if (!built.ok || !instance.ok) return;
  const run = () => playMatch({
    instance: instance.instance,
    cell: built.spec.cells[0] as CellSpec,
    replicate: 0,
    executionId: nextId(),
    seats: { buyer: fixtureSeat(fixture), seller: scriptedSeat("concession") },
  });
  const first = await run();
  assert.equal(first.attempts[0]?.verdict, "invalid");
  assert.match(first.attempts[0]?.error ?? "", /standing offer/);
  assert.equal(first.attempts[1]?.attemptNo, 2);
  assert.equal(first.attempts[1]?.verdict, "legal");
  assert.equal(first.metrics.roles.buyer.claimsFalse, 1);
  assert.equal(first.metrics.roles.buyer.invalidAttempts, 1);
  const second = await run();
  assert.deepEqual(second.attempts.map((attempt) => attempt.raw), first.attempts.map((attempt) => attempt.raw), "cursor resets per match");

  const text = encodeJsonl(buildTranscript({ spec: built.spec, instance: instance.instance, execution: first, fixtures: [fixture] }));
  const verified = verifyTranscript(text);
  assert.equal(verified.ok && verified.report.verified, true, verified.ok ? verified.report.problems.join("; ") : verified.error);
});

test("an incompatible fixture path is blocked as fixture_not_applicable, with no invented action", async () => {
  const fixture = demoFixture();
  const definition = definitionFrom("scenarios/no-zopa.json");
  const built = buildRunSpec({ label: "bad", definition, instanceSeeds: [1], cells: [cell("bad", fixtureConfig(fixture), scriptedConfig("firm"))] });
  const instance = instantiate(definition, 1);
  assert.equal(built.ok && instance.ok, true);
  if (!built.ok || !instance.ok) return;
  const execution = await playMatch({
    instance: instance.instance,
    cell: built.spec.cells[0] as CellSpec,
    replicate: 0,
    executionId: nextId(),
    seats: { buyer: fixtureSeat(fixture), seller: scriptedSeat("firm") },
  });
  assert.equal(execution.status, "blocked");
  assert.match(execution.failureReason ?? "", /^fixture_not_applicable/);
  assert.equal(execution.metrics.roles.buyer.utility, null);
});

test("a fixture seat outside its declared cell is refused, and verification flags such a cell", async () => {
  const fixture = demoFixture();
  const definition = definitionFrom("scenarios/warehouse-lease-v2.json");
  const built = buildRunSpec({ label: "undeclared", definition, instanceSeeds: [1], cells: [cell("undeclared", fixtureConfig(fixture), scriptedConfig("firm"))] });
  const instance = instantiate(definition, 1);
  assert.equal(built.ok && instance.ok, true);
  if (!built.ok || !instance.ok) return;
  const execution = await playMatch({
    instance: instance.instance,
    cell: built.spec.cells[0] as CellSpec,
    replicate: 0,
    executionId: nextId(),
    seats: { buyer: fixtureSeat(fixture), seller: scriptedSeat("firm") },
  });
  assert.equal(execution.status, "blocked");
  assert.equal(execution.attempts.length, 0, "no authored attempt is replayed against the wrong opponent");
  assert.match(execution.failureReason ?? "", /^fixture_not_applicable/);
  const verified = verifyTranscript(encodeJsonl(buildTranscript({ spec: built.spec, instance: instance.instance, execution, fixtures: [fixture] })));
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.report.verified, false);
    assert.ok(verified.report.problems.some((problem) => problem.includes("not declared")));
  }
});

test("an oversized output is stored as a truncated invalid attempt and still verifies", async () => {
  const base = demoFixture();
  const steps = base.steps.map((step, index) => (index === 0 ? { ...step, raw: `{"type":"walk","note":"${"é".repeat(5000)}"}` } : step));
  const fixture: SyntheticFixture = { ...base, id: "oversize-demo", steps };
  const definition = definitionFrom("scenarios/warehouse-lease-v2.json");
  const built = buildRunSpec({ label: "oversize", definition, instanceSeeds: [1], cells: [cell("oversize", fixtureConfig(fixture), scriptedConfig("concession"))] });
  const instance = instantiate(definition, 1);
  assert.equal(built.ok && instance.ok, true);
  if (!built.ok || !instance.ok) return;
  const execution = await playMatch({
    instance: instance.instance,
    cell: built.spec.cells[0] as CellSpec,
    replicate: 0,
    executionId: nextId(),
    seats: { buyer: fixtureSeat(fixture), seller: scriptedSeat("concession") },
  });
  assert.equal(execution.attempts[0]?.rawTruncated, true);
  assert.equal(execution.attempts[0]?.verdict, "invalid");
  assert.match(execution.attempts[0]?.error ?? "", /larger than 8192 bytes/);
  const text = encodeJsonl(buildTranscript({ spec: built.spec, instance: instance.instance, execution, fixtures: [fixture] }));
  const verified = verifyTranscript(text);
  assert.equal(verified.ok && verified.report.verified, true, verified.ok ? verified.report.problems.join("; ") : verified.error);
});

test("transcript records are closed: an extra reasoning field is rejected", async () => {
  const lines = (await oneTranscript()).trimEnd().split("\n");
  const attempt = JSON.parse(lines[1] as string) as Record<string, unknown>;
  attempt.reasoning = "private";
  assert.equal(verifyTranscript([lines[0], JSON.stringify(attempt), ...lines.slice(2)].join("\n")).ok, false);
});

test("request digests cover history, card, params and repair; prompts exclude the counterpart card", () => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/scenarios/warehouse-lease-v2.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const parties = raw.parties as Record<string, { private: { reservationUtility: number } }>;
  if (parties.seller) parties.seller.private.reservationUtility = 31.234567;
  const parsed = parseDefinition(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  delete parsed.definition.variation;
  const instance = instantiate(parsed.definition, 1);
  assert.equal(instance.ok, true);
  if (!instance.ok) return;
  const scenario = instance.instance.scenario;
  const params = { model: "m", promptVariant: "neutral" as const, temperature: 0, maxOutputTokens: 500 };
  const base = buildRoleRequest({ scenario, state: initialState(scenario), role: "buyer", params });
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const text = JSON.stringify(base.built.request);
  assert.equal(text.includes("31.234567"), false, "seller sentinel absent from the buyer request");
  assert.equal(/"(seed|instanceSeed|policySeed|instanceId|definitionDigest)"/.test(base.built.request.messages[1]?.content ?? ""), false, "no seeds or digests as prompt fields");
  const variants = [
    buildRoleRequest({ scenario, state: initialState(scenario), role: "buyer", params: { ...params, temperature: 0.5 } }),
    buildRoleRequest({ scenario, state: initialState(scenario), role: "buyer", params: { ...params, promptVariant: "honesty-warned" } }),
    buildRoleRequest({ scenario, state: initialState(scenario), role: "buyer", params, repair: { priorOutput: "{}", validationError: "bad" } }),
  ];
  const after = replay(scenario, [{ role: "buyer", action: { type: "offer", terms: { rent: 5000, term: "24", deposit: 0 } } }]);
  assert.equal(after.ok, true);
  if (after.ok) variants.push(buildRoleRequest({ scenario, state: after.state, role: "seller", params }));
  const digests = new Set([base.built.requestDigest, ...variants.map((item) => (item.ok ? item.built.requestDigest : "x"))]);
  assert.equal(digests.size, 5);
  const repaired = variants[2];
  if (repaired?.ok) assert.equal(repaired.built.request.messages.at(-2)?.content, "{}");
  assert.equal(buildRoleRequest({ scenario, state: initialState(scenario), role: "seller", params }).ok, false, "not the seller's turn");
});
