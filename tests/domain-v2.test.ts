import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scriptedAction } from "../supabase/functions/_shared/agents.ts";
import { analyzeClaims, claimIsTrue, ownNumberCandidate } from "../supabase/functions/_shared/deception.ts";
import { analyzeGrid, isParetoDominated } from "../supabase/functions/_shared/enumerateGrid.ts";
import { canonicalJson, fnv1a32, sha256Hex, utf8 } from "../supabase/functions/_shared/hash.ts";
import { instantiate } from "../supabase/functions/_shared/instantiate.ts";
import { parseJsonStrict, parseWholeJsonOutput } from "../supabase/functions/_shared/json.ts";
import { applyAction, buildView, initialState, parseAction, parseActionText, replay } from "../supabase/functions/_shared/referee.ts";
import { drawInt, policySeedFor, xorshift32 } from "../supabase/functions/_shared/rng.ts";
import { parseDefinition, parseScenarioText } from "../supabase/functions/_shared/scenario.ts";
import { scoreMatch } from "../supabase/functions/_shared/score.ts";
import type { GameState, PublicTurn, Scenario, ScenarioDefinition } from "../supabase/functions/_shared/types.ts";
import { gridValues, numberOnGrid } from "../supabase/functions/_shared/utility.ts";
import { miniV2Definition } from "./mini.ts";

function fixtureText(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
}

function miniV2(maxRounds = 2): ScenarioDefinition {
  const parsed = parseDefinition(miniV2Definition(maxRounds));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.definition;
}

function concrete(definition: ScenarioDefinition, seed = 1): Scenario {
  const built = instantiate(definition, seed);
  if (!built.ok) throw new Error(built.error);
  return built.instance.scenario;
}

function play(scenario: Scenario, turns: PublicTurn[]): GameState {
  const result = replay(scenario, turns);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

test("hash primitives match published known answers", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(fnv1a32(utf8("")), 0x811c9dc5);
  assert.equal(fnv1a32(utf8("a")), 0xe40c292c);
  assert.equal(xorshift32(1), 270369);
});

test("rejection sampling discards the biased tail instead of using modulo alone", () => {
  // range 3: limit = floor(2^32 / 3) * 3 = 4294967295, so 4294967295 itself is rejected.
  const values = [4294967295, 7];
  const stream = { next: () => values.shift() ?? 0 };
  assert.equal(drawInt(stream, 10, 12), 11);
  assert.equal(drawInt({ next: () => 99 }, 5, 5), 5);
});

test("canonical JSON sorts keys, keeps array order and normalizes -0", () => {
  assert.equal(canonicalJson({ b: [2, 1], a: { d: -0, c: "x" }, z: undefined }), '{"a":{"c":"x","d":0},"b":[2,1]}');
  assert.throws(() => canonicalJson({ bad: Number.NaN }));
});

test("strict JSON rejects duplicate keys and keeps __proto__ as data", () => {
  assert.equal(parseJsonStrict('{"a":1,"a":2}').ok, false);
  assert.equal(parseJsonStrict('{"a":1} trailing').ok, false);
  const proto = parseJsonStrict('{"__proto__":{"polluted":true}}');
  assert.equal(proto.ok, true);
  if (proto.ok) {
    assert.equal(Object.getPrototypeOf(proto.value), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(proto.value, "__proto__"), true);
  }
  assert.equal(parseWholeJsonOutput('```json\n{"type":"walk"}\n```').ok, true);
  assert.equal(parseWholeJsonOutput('Sure! {"type":"walk"}').ok, false);
  assert.equal(parseWholeJsonOutput('{"type":"walk"}{"type":"walk"}').ok, false);
  assert.equal(parseWholeJsonOutput('```json\n{"type":"walk"}\n``` thanks').ok, false);
});

test("numeric grid uses the fractional origin and rejects excess precision", () => {
  const issue = { id: "q", label: "Q", kind: "number" as const, min: 0.5, max: 2.5, step: 1 };
  assert.deepEqual(gridValues(issue), [0.5, 1.5, 2.5]);
  for (const legal of [0.5, 1.5, 2.5, 1.5e0]) assert.equal(numberOnGrid(issue, legal), true, String(legal));
  for (const illegal of [0, 1, 2, 3, 0.25, 2.5000001, Number.NaN]) assert.equal(numberOnGrid(issue, illegal), false, String(illegal));
  const tenths = { id: "t", label: "T", kind: "number" as const, min: 0, max: 0.3, step: 0.1 };
  assert.equal(numberOnGrid(tenths, 0.3), true);
  assert.equal(numberOnGrid(tenths, 0.1 + 0.2), false, "0.30000000000000004 has more than 6 decimals");
});

test("v2 fixtures parse, and v1 files still parse through the versioned entry point", () => {
  for (const name of ["scenarios/warehouse-lease-v2.json", "scenarios/design-retainer-v2.json", "scenarios/no-zopa.json", "warehouse-lease.json", "design-retainer.json"]) {
    const parsed = parseScenarioText(fixtureText(name));
    assert.equal(parsed.ok, true, parsed.ok ? "" : `${name}: ${parsed.error}`);
  }
});

test("v2 parser rejects unknown keys, bad references, duplicate targets and oversize grids", () => {
  const base = miniV2Definition();
  const reject = (mutate: (value: Record<string, unknown>) => void, why: string) => {
    const copy = structuredClone(base);
    mutate(copy);
    assert.equal(parseDefinition(copy).ok, false, why);
  };
  reject((value) => { value.extra = 1; }, "unknown top-level key");
  reject((value) => { (value.rules as Record<string, unknown>).disagreementUtility = 0; }, "v2 rules have no shared payoff");
  reject((value) => { value.variation = [{ role: "buyer", field: "choice-score", issueId: "c", option: "zzz", jitterMin: 0, jitterMax: 1 }]; }, "unknown option");
  reject((value) => { value.variation = [{ role: "buyer", field: "number-min-score", issueId: "c", jitterMin: 0, jitterMax: 1 }]; }, "field/kind mismatch");
  reject((value) => { value.variation = [{ role: "buyer", field: "reservation", jitterMin: 0, jitterMax: 1 }, { role: "buyer", field: "reservation", jitterMin: -1, jitterMax: 0 }]; }, "duplicate target");
  reject((value) => { value.variation = [{ role: "buyer", field: "reservation", jitterMin: 0, jitterMax: 10_001 }]; }, "jitter bound");
  reject((value) => { value.variation = [{ role: "buyer", field: "reservation", jitterMin: 0.5, jitterMax: 1 }]; }, "non-integer jitter");
  reject((value) => {
    value.issues = [0, 1, 2].map((index) => ({ id: `n${index}`, label: "N", kind: "number", min: 0, max: 100, step: 1 }));
  }, "101^3 packages > 20000");
  reject((value) => { ((value.issues as Array<Record<string, unknown>>)[0] as Record<string, unknown>).step = 0.7; }, "range not whole steps");
  assert.equal(parseScenarioText('{"schemaVersion":2,"schemaVersion":2}').ok, false);
});

test("instances are deterministic, bounded, and keep the opening role", () => {
  const definition = parseScenarioText(fixtureText("scenarios/warehouse-lease-v2.json"));
  assert.equal(definition.ok, true);
  if (!definition.ok) return;
  const first = instantiate(definition.definition, 7);
  const again = instantiate(definition.definition, 7);
  assert.equal(first.ok && again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(first.instance.instanceId, again.instance.instanceId);
  assert.equal(first.instance.generator, "nsb-instance-v1");
  assert.equal(first.instance.scenario.rules.openingRole, "buyer");
  for (let seed = 0; seed <= 20; seed += 1) {
    const sampled = instantiate(definition.definition, seed);
    assert.equal(sampled.ok, true);
    if (!sampled.ok) continue;
    const buyer = sampled.instance.scenario.parties.buyer.private.reservationUtility;
    assert.ok(buyer >= 39 && buyer <= 45 && Number.isInteger(buyer), `seed ${seed} buyer reservation ${buyer}`);
    assert.equal("variation" in sampled.instance.scenario, false);
  }
  assert.equal(instantiate(definition.definition, -1).ok, false);
  assert.equal(instantiate(definition.definition, 1_000_000_001).ok, false);
});

test("v1 files are fixed instances and policy seeds are separate streams in v2", () => {
  const v1 = parseScenarioText(fixtureText("warehouse-lease.json"));
  assert.equal(v1.ok, true);
  if (!v1.ok) return;
  const a = instantiate(v1.definition, 1);
  const b = instantiate(v1.definition, 2);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.instance.generator, "fixed-v1");
  assert.equal(a.instance.instanceId, b.instance.instanceId, "v1 seeds never relabel valuations");
  assert.equal(policySeedFor({ ruleset: 1, definitionDigest: "d", instanceSeed: 9, replicate: 0, role: "buyer" }), 9);
  const buyer = policySeedFor({ ruleset: 2, definitionDigest: "d", instanceSeed: 9, replicate: 0, role: "buyer" });
  const seller = policySeedFor({ ruleset: 2, definitionDigest: "d", instanceSeed: 9, replicate: 0, role: "seller" });
  assert.notEqual(buyer, seller);
  assert.equal(buyer, policySeedFor({ ruleset: 2, definitionDigest: "d", instanceSeed: 9, replicate: 0, role: "buyer" }));
});

test("hand-worked grid: max IR joint gain and Pareto domination", () => {
  const scenario = concrete(miniV2());
  const grid = analyzeGrid(scenario);
  assert.equal(grid.packageCount, 6);
  assert.equal(grid.zopaEmpty, false);
  assert.equal(grid.maxJointGain, 5);
  assert.equal(isParetoDominated(grid, 4, 2, 1e-6), true);
  assert.equal(isParetoDominated(grid, 6, 0, 1e-6), false);
  assert.equal(isParetoDominated(grid, 0, 7, 1e-6), false);
  const noZopa = parseScenarioText(fixtureText("scenarios/no-zopa.json"));
  assert.equal(noZopa.ok, true);
  if (noZopa.ok) {
    const empty = analyzeGrid(concrete(noZopa.definition));
    assert.equal(empty.zopaEmpty, true);
    assert.equal(empty.maxJointGain, null);
  }
});

test("canonical cap: final-turn offer closes as cap; final-turn accept/walk take precedence", () => {
  const scenario = concrete(miniV2(1));
  const capped = play(scenario, [
    { role: "buyer", action: { type: "offer", terms: { x: 0, c: "b" } } },
    { role: "seller", action: { type: "offer", terms: { x: 2, c: "a" } } },
  ]);
  assert.deepEqual(capped.terminal, { kind: "disagreement", reason: "cap" });
  assert.equal(capped.standing, null);
  const accepted = play(scenario, [
    { role: "buyer", action: { type: "offer", terms: { x: 1, c: "b" } } },
    { role: "seller", action: { type: "accept" } },
  ]);
  assert.equal(accepted.terminal?.kind, "agreement");
  const after = applyAction(scenario, accepted, "buyer", { type: "walk" });
  assert.equal(after.ok, false, "terminal state is immutable");
  const prefix = play(scenario, [{ role: "buyer", action: { type: "offer", terms: { x: 1, c: "b" } } }]);
  assert.equal(prefix.terminal, null, "an unfinished prefix is not cap");
});

test("referee: superseded offers, own offers and exact issue sets", () => {
  const scenario = concrete(miniV2(3));
  const opened = play(scenario, [
    { role: "buyer", action: { type: "offer", terms: { x: 0, c: "b" } } },
    { role: "seller", action: { type: "offer", terms: { x: 2, c: "a" } } },
  ]);
  const accept = applyAction(scenario, opened, "buyer", { type: "accept" });
  assert.equal(accept.ok, true);
  if (accept.ok && accept.state.terminal?.kind === "agreement") assert.deepEqual(accept.state.terminal.terms, { x: 2, c: "a" });
  assert.equal(applyAction(scenario, opened, "seller", { type: "accept" }).ok, false, "out of turn");
  assert.equal(applyAction(scenario, opened, "buyer", { type: "offer", terms: { x: 1 } }).ok, false, "missing issue");
  assert.equal(applyAction(scenario, opened, "buyer", { type: "offer", terms: { x: 1, c: "a", y: 1 } }).ok, false, "extra issue");
  assert.equal(applyAction(scenario, initialState(scenario), "buyer", { type: "accept" }).ok, false, "nothing to accept");
});

test("v2 actions need a claim relation; v1 actions refuse one", () => {
  const claim = { type: "walk", claims: [{ about: "reservation", stated: 3 }] };
  assert.equal(parseAction(claim, 2).ok, false);
  assert.equal(parseAction(claim, 1).ok, true);
  const related = { type: "walk", claims: [{ about: "reservation", relation: "at_least", stated: 3 }] };
  assert.equal(parseAction(related, 2).ok, true);
  assert.equal(parseAction(related, 1).ok, false);
  assert.equal(parseActionText('{"type":"walk","thought":"x"}', 2).ok, false, "no private-reasoning or unknown fields");
  assert.equal(parseActionText('{"type":"walk","type":"accept"}', 2).ok, false);
});

test("metrics: efficiency, IR violation, Pareto and v2 no-deal payoffs", () => {
  const scenario = concrete(miniV2());
  const at = (terms: Record<string, number | string>) => scoreMatch({
    scenario,
    state: play(scenario, [{ role: "buyer", action: { type: "offer", terms } }, { role: "seller", action: { type: "accept" } }]),
    status: "complete",
    attempts: [],
  });
  const dominated = at({ x: 1, c: "b" });
  assert.equal(dominated.outcome, "agreement");
  assert.equal(dominated.roles.buyer.gain, 3);
  assert.equal(dominated.roles.seller.gain, 1);
  assert.equal(dominated.efficiency, 0.8);
  assert.equal(dominated.paretoDominated, true);
  const violation = at({ x: 0, c: "b" });
  assert.equal(violation.roles.seller.individuallyRational, false);
  assert.equal(violation.efficiency, null);
  assert.equal(violation.efficiencyNullReason, "ir_violation");

  const walked = scoreMatch({ scenario, state: play(scenario, [{ role: "buyer", action: { type: "walk" } }]), status: "complete", attempts: [] });
  assert.equal(walked.outcome, "walk");
  assert.equal(walked.roles.buyer.utility, 1);
  assert.equal(walked.roles.buyer.gain, 0);
  assert.equal(walked.missedDeal, true);
  assert.equal(walked.efficiencyNullReason, "no_agreement");

  const failed = scoreMatch({ scenario, state: initialState(scenario), status: "format_failure", failureRole: "buyer", failureReason: "x", attempts: [] });
  assert.equal(failed.outcome, null);
  assert.equal(failed.roles.buyer.utility, null);
  assert.equal(failed.welfare, null);
  assert.equal(failed.missedDeal, null);
});

test("claims: relations at the tolerance boundary, eq-only misstatement, changes and acceptance consistency", () => {
  const scenario = concrete(miniV2(3));
  const r = (relation: "eq" | "at_least" | "at_most", stated: number) => ({ about: "reservation" as const, relation, stated });
  assert.equal(claimIsTrue(scenario, "buyer", r("eq", 1 + 1e-7)), true);
  assert.equal(claimIsTrue(scenario, "buyer", r("eq", 1 + 1e-5)), false);
  assert.equal(claimIsTrue(scenario, "buyer", r("at_least", 1 + 1e-7)), true, "actual 1 >= 1.0000001 within tolerance");
  assert.equal(claimIsTrue(scenario, "buyer", r("at_least", 2)), false);
  assert.equal(claimIsTrue(scenario, "buyer", r("at_most", 0.5)), false);
  assert.equal(claimIsTrue(scenario, "buyer", r("at_most", 1)), true);
  assert.equal(claimIsTrue(scenario, "seller", { about: "choice-score", issueId: "c", option: "a", stated: 3 }), true);
  assert.equal(claimIsTrue(scenario, "seller", { about: "number-score", issueId: "x", endpoint: "max", stated: 3 }), false);

  const analysis = analyzeClaims(scenario, [
    { role: "buyer", action: { type: "offer", terms: { x: 0, c: "b" }, claims: [r("eq", 5)] } },
    { role: "seller", action: { type: "offer", terms: { x: 1, c: "b" }, note: "Fine." } },
    { role: "buyer", action: { type: "offer", terms: { x: 0, c: "a" }, claims: [r("eq", 4), r("at_most", 9)] } },
    { role: "seller", action: { type: "offer", terms: { x: 1, c: "b" } } },
    { role: "buyer", action: { type: "accept" } },
  ]);
  const buyer = analysis.roles.buyer;
  assert.equal(buyer.legalTurns, 3);
  assert.equal(buyer.turnsWithClaims, 2);
  assert.equal(buyer.claimsEvaluated, 3);
  assert.equal(buyer.claimsFalse, 2);
  assert.deepEqual(buyer.reservationMisstatements, [4, 3]);
  assert.equal(buyer.claimChangeCount, 1, "eq 5 -> eq 4; at_most is a different relation");
  assert.equal(buyer.acceptanceChecks, 1);
  assert.equal(buyer.acceptanceInconsistent, 0, "accepted (1,b) is worth 4 >= latest eq claim 4");
  assert.equal(analysis.roles.seller.claimsEvaluated, 0, "no claims: rate is N/A, not zero-of-zero");
  assert.equal(analysis.roles.seller.notesNonEmpty, 1);
});

test("own-number disclosure excludes public fields and own offered terms", () => {
  const scenario = concrete(miniV2());
  assert.equal(ownNumberCandidate(scenario, "seller", "My floor is 3 on colour."), true, "3 is on the seller card");
  assert.equal(ownNumberCandidate(scenario, "buyer", "We have 2 rounds"), false, "2 is on the buyer card but also public (x max, maxRounds)");
  assert.equal(ownNumberCandidate(scenario, "buyer", "I think 3 is fair"), false, "3 is only on the other card; never accuse from it");
  assert.equal(ownNumberCandidate(scenario, "buyer", "No numbers here"), false);
  const noZopa = parseScenarioText(fixtureText("scenarios/no-zopa.json"));
  assert.equal(noZopa.ok, true);
  if (!noZopa.ok) return;
  const tiny = concrete(noZopa.definition);
  assert.equal(ownNumberCandidate(tiny, "seller", "8 works for me"), true, "8 is the seller reservation, not public");
  assert.equal(ownNumberCandidate(tiny, "seller", "8 works for me", { price: 8 }), false, "own offered term on that turn is excluded");
});

test("privacy: a v2 role view carries no counterpart sentinel", () => {
  const raw = miniV2Definition();
  const parties = raw.parties as Record<string, { private: { reservationUtility: number } }>;
  if (parties.seller) parties.seller.private.reservationUtility = 777.123456;
  const parsed = parseDefinition(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const scenario = concrete(parsed.definition);
  const view = buildView(scenario, initialState(scenario), "buyer", 1);
  assert.equal(JSON.stringify(view).includes("777.123456"), false);
  assert.equal(scriptedAction("bluff", view).claims?.[0]?.about, "reservation");
});
