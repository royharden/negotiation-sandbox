import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scriptedAction } from "../supabase/functions/_shared/agents.ts";
import { bootstrapMean, summarizePairings } from "../supabase/functions/_shared/bootstrap.ts";
import { analyzeDeception } from "../supabase/functions/_shared/deception.ts";
import { buildModelPrompt } from "../supabase/functions/_shared/prompt.ts";
import { applyAction, buildView, initialState, parseActionJson } from "../supabase/functions/_shared/referee.ts";
import { ModelBlocked, playGame, runBatch, scriptedDecide } from "../supabase/functions/_shared/runner.ts";
import { parseScenario } from "../supabase/functions/_shared/scenario.ts";
import { scoreGame } from "../supabase/functions/_shared/score.ts";
import { issueUtility } from "../supabase/functions/_shared/utility.ts";
import { miniScenario } from "./mini.ts";

test("shipped scenario files parse", () => {
  for (const name of ["warehouse-lease.json", "design-retainer.json"]) {
    const raw = JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as unknown;
    const parsed = parseScenario(raw);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  }
});

test("parser rejects a card that does not match its issue", () => {
  const scenario = miniScenario();
  const broken = structuredClone(scenario) as unknown as { parties: { buyer: { private: { scores: { price: { kind: string } } } } } };
  broken.parties.buyer.private.scores.price.kind = "choice";
  const parsed = parseScenario(broken);
  assert.equal(parsed.ok, false);
});

test("utility is linear between the endpoints", () => {
  const scenario = miniScenario();
  const price = scenario.issues[0];
  const score = scenario.parties.buyer.private.scores.price;
  if (!price || price.kind !== "number" || !score || score.kind !== "number") throw new Error("fixture shape");
  assert.equal(issueUtility(price, score, 0), 100);
  assert.equal(issueUtility(price, score, 100), 0);
  assert.equal(issueUtility(price, score, 50), 50);
});

test("referee rejects illegal moves and keeps the prior state", () => {
  const scenario = miniScenario();
  const start = initialState(scenario);
  const outOfTurn = applyAction(scenario, start, "seller", { type: "walk" });
  assert.equal(outOfTurn.ok, false);
  assert.equal(start.history.length, 0);

  const opened = applyAction(scenario, start, "buyer", { type: "offer", terms: { price: 0, color: "blue" } });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const ownAccept = applyAction(scenario, { ...opened.state, nextRole: "buyer", standing: { role: "buyer", terms: { price: 0, color: "blue" } } }, "buyer", { type: "accept" });
  assert.equal(ownAccept.ok, false);
  if (!ownAccept.ok) assert.match(ownAccept.error, /standing offer/);

  const offStep = applyAction(scenario, start, "buyer", { type: "offer", terms: { price: 5, color: "red" } });
  assert.equal(offStep.ok, false);
  const partial = applyAction(scenario, start, "buyer", { type: "offer", terms: { price: 0 } });
  assert.equal(partial.ok, false);
  const control = applyAction(scenario, start, "buyer", { type: "walk", note: "bad\u0007note" });
  assert.equal(control.ok, false);
});

test("a hand-built accept scores utilities and individual rationality", () => {
  const scenario = miniScenario();
  const offered = applyAction(scenario, initialState(scenario), "buyer", {
    type: "offer",
    terms: { price: 0, color: "blue" },
  });
  assert.equal(offered.ok, true);
  if (!offered.ok) return;
  const accepted = applyAction(scenario, offered.state, "seller", { type: "accept" });
  assert.equal(accepted.ok, true);
  if (!accepted.ok || !accepted.state.terminal || accepted.state.terminal.kind !== "agreement") return;
  assert.deepEqual(accepted.state.terminal.terms, { price: 0, color: "blue" });
  const scores = scoreGame(scenario, accepted.state);
  assert.equal(scores.outcome, "agreement");
  assert.equal(scores.buyerUtility, 110);
  assert.equal(scores.sellerUtility, 0);
  assert.equal(scores.buyerIndividuallyRational, true);
  assert.equal(scores.sellerIndividuallyRational, false);
});

test("walk and the round cap end without a deal", async () => {
  const scenario = miniScenario();
  const walked = applyAction(scenario, initialState(scenario), "buyer", { type: "walk" });
  assert.equal(walked.ok, true);
  if (!walked.ok || walked.state.terminal?.kind !== "disagreement") throw new Error("walk did not end");
  assert.equal(walked.state.terminal.reason, "walk");

  const firm = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "firm",
    sellerAgent: "firm",
    decide: scriptedDecide({ buyer: "firm", seller: "firm" }),
  });
  assert.equal(firm.status, "complete");
  assert.equal(firm.scores?.outcome, "disagreement");
  assert.equal(firm.scores?.terminalReason, "cap");
  assert.equal(firm.history.length, 8);
});

test("deception flags false claims, drift, and private numbers in notes", () => {
  const scenario = miniScenario();
  const report = analyzeDeception(scenario, [
    { role: "buyer", action: { type: "offer", terms: { price: 0, color: "blue" }, claims: [{ about: "reservation", stated: 20 }] } },
    { role: "seller", action: { type: "offer", terms: { price: 100, color: "red" }, note: "100 is the public max" } },
    { role: "buyer", action: { type: "offer", terms: { price: 20, color: "blue" }, note: "My hidden line is 20", claims: [{ about: "reservation", stated: 70 }] } },
  ]);
  assert.equal(report.turns[0]?.violations.length, 0);
  assert.equal(report.turns[0]?.leakages.length, 0);
  assert.equal(report.turns[1]?.leakages.length, 0);
  assert.equal(report.turns[2]?.violations.length, 1);
  assert.equal(report.turns[2]?.drifts.length, 1);
  assert.equal(report.turns[2]?.leakages.length, 1);
  assert.equal(report.buyer.violations, 1);
  assert.equal(report.buyer.drifts, 1);
  assert.equal(report.buyer.leakages, 1);
});

test("concession agrees on the traced package and bluff is caught", async () => {
  const scenario = miniScenario();
  const agreed = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "concession",
    sellerAgent: "concession",
    decide: scriptedDecide({ buyer: "concession", seller: "concession" }),
  });
  const again = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "concession",
    sellerAgent: "concession",
    decide: scriptedDecide({ buyer: "concession", seller: "concession" }),
  });
  assert.deepEqual(agreed.history, again.history);
  assert.equal(agreed.scores?.outcome, "agreement");
  assert.deepEqual(agreed.scores?.agreedTerms, { price: 70, color: "red" });
  assert.ok(Math.abs((agreed.scores?.buyerUtility ?? 0) - 30) < 1e-6);
  assert.ok(Math.abs((agreed.scores?.sellerUtility ?? 0) - 80) < 1e-6);
  assert.equal(agreed.scores?.buyer.violations, 0);
  assert.equal(agreed.scores?.seller.violations, 0);
  assert.equal(agreed.history.every((turn) => !/\d/.test(turn.action.note ?? "")), true);

  const bluff = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "bluff",
    sellerAgent: "concession",
    decide: scriptedDecide({ buyer: "bluff", seller: "concession" }),
  });
  const otherSeed = await playGame({
    scenario,
    seed: 2,
    buyerAgent: "bluff",
    sellerAgent: "concession",
    decide: scriptedDecide({ buyer: "bluff", seller: "concession" }),
  });
  assert.equal(bluff.scores?.outcome, "agreement");
  assert.ok((bluff.scores?.buyer.violations ?? 0) >= 1);
  assert.equal(bluff.scores?.seller.violations, 0);
  assert.notEqual(bluff.history[0]?.action.claims?.[0]?.stated, otherSeed.history[0]?.action.claims?.[0]?.stated);
});

test("an agent view does not carry the counterpart card", () => {
  const scenario = miniScenario(21);
  const view = buildView(scenario, initialState(scenario), "buyer", 1);
  const encoded = JSON.stringify(view);
  assert.match(encoded, /"reservationUtility":20/);
  assert.equal(encoded.includes("21"), false);
  const action = scriptedAction("concession", view);
  assert.equal(action.type, "offer");
});

test("the model prompt keeps the counterpart card out", () => {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/warehouse-lease.json", import.meta.url), "utf8")) as unknown;
  const parsed = parseScenario(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prompt = buildModelPrompt({ scenario: parsed.scenario, role: "buyer", history: [], seed: 1 });
  assert.equal(prompt.ok, true);
  if (!prompt.ok) return;
  assert.match(prompt.user, /"reservationUtility":42/);
  assert.equal(prompt.user.includes('"reservationUtility":37'), false);
  assert.equal(/\b28\b/.test(prompt.user), false);
  assert.equal(/\b28\b/.test(prompt.system), false);
});

test("illegal model text becomes a format failure and a blocked caller stores no score", async () => {
  const scenario = miniScenario();
  const failed = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "concession",
    sellerAgent: "concession",
    decide: () => ({ type: "offer", terms: { price: 5, color: "red" } }),
  });
  assert.equal(failed.status, "format_failure");
  assert.equal(failed.history.length, 0);
  assert.equal(failed.scores?.outcome, "format_failure");

  const blocked = await playGame({
    scenario,
    seed: 1,
    buyerAgent: "model",
    sellerAgent: "concession",
    decide: () => {
      throw new ModelBlocked("Set LLM_API_KEY in server secrets.");
    },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.scores, null);

  const fenced = parseActionJson('```json\n{"type":"walk"}\n```');
  assert.equal(fenced.ok, true);
  if (fenced.ok) assert.equal(fenced.action.type, "walk");
});

test("a batch grid and the bootstrap interval stay ordered", async () => {
  const rows = await runBatch({
    scenario: miniScenario(),
    seeds: [1, 2],
    pairings: [
      { buyer: "concession", seller: "concession" },
      { buyer: "firm", seller: "firm" },
    ],
  });
  assert.equal(rows.length, 4);
  const summary = summarizePairings(rows, 1);
  assert.equal(summary.length, 2);
  assert.equal(summary[0]?.agreements, 2);
  assert.equal(summary[1]?.disagreements, 2);
  assert.equal(summary[0]?.welfareLow === null, false);
  assert.ok((summary[0]?.welfareLow ?? 0) <= (summary[0]?.meanWelfare ?? 0));
  assert.ok((summary[0]?.meanWelfare ?? 0) <= (summary[0]?.welfareHigh ?? 0));
  const once = bootstrapMean([10], 1);
  assert.equal(once, null);
  const interval = bootstrapMean([1, 2, 3], 7, 40);
  assert.ok(interval);
  assert.ok((interval?.low ?? 0) <= (interval?.mean ?? 0));
  assert.ok((interval?.mean ?? 0) <= (interval?.high ?? 0));
  assert.deepEqual(interval, bootstrapMean([1, 2, 3], 7, 40));
});

