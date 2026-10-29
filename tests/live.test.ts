import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHandler, parseClaimResult, turnKeyOf } from "../supabase/functions/negotiate-turn/handler.ts";
import type { ClaimArgs, ClaimResult, FinishArgs, HandlerDeps, LedgerRow } from "../supabase/functions/negotiate-turn/handler.ts";
import { canonicalJson, sha256Hex } from "../supabase/functions/_shared/hash.ts";
import { instantiate } from "../supabase/functions/_shared/instantiate.ts";
import { LIVE_CONTRACT_VERSION } from "../supabase/functions/_shared/liveContract.ts";
import type { ConfigResponse, ErrorResponse, TurnResponse } from "../supabase/functions/_shared/liveContract.ts";
import { replay } from "../supabase/functions/_shared/referee.ts";
import { buildRunSpec, liveExecutionDefinition, modelConfig, scriptedConfig } from "../supabase/functions/_shared/runspec.ts";
import type { RunSpec } from "../supabase/functions/_shared/runspec.ts";
import { parseDefinition } from "../supabase/functions/_shared/scenario.ts";
import type { PublicTurn, ScenarioDefinition } from "../supabase/functions/_shared/types.ts";

// ---------------------------------------------------------------------------
// Fixture run spec (real definition, real builder) and fake dependencies. No network.
// ---------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const CALL_ID = "33333333-3333-4333-8333-333333333333";
const OP_1 = "44444444-4444-4444-8444-444444444444";
const OP_2 = "55555555-5555-4555-8555-555555555555";
const SECRET = "sk-test-NEVER-ECHO-THIS-KEY";
const MODEL = "test-model-1";
const SEED = 7;

function warehouse(): ScenarioDefinition {
  const raw = JSON.parse(readFileSync(new URL("../fixtures/scenarios/warehouse-lease-v2.json", import.meta.url), "utf8")) as unknown;
  const parsed = parseDefinition(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.definition;
}

function makeSpec(definition: ScenarioDefinition = warehouse()): RunSpec {
  const built = buildRunSpec({
    label: "live handler test",
    definition,
    instanceSeeds: [SEED],
    replicates: 1,
    cells: [{ cellId: "model-vs-firm", roles: { buyer: modelConfig(MODEL), seller: scriptedConfig("firm") } }],
  });
  if (!built.ok) throw new Error(built.error);
  return built.spec;
}

const SPEC = makeSpec();
const OPENING: PublicTurn = { role: "buyer", action: { type: "offer", terms: { rent: 6000, term: "24", deposit: 1 } } };
const LEGAL_REPLY = canonicalJson({ type: "offer", terms: { rent: 7000, term: "36", deposit: 2 } });

const BASE_ENV: Record<string, string> = {
  LLM_API_KEY: SECRET,
  LLM_ALLOWED_MODELS: `${MODEL},other-model`,
  LLM_ALLOWED_HOSTS: "api.openai.com",
  LLM_MODEL: MODEL,
  APP_ORIGIN: "https://app.example",
};

type Recorder = {
  claims: ClaimArgs[];
  finishes: FinishArgs[];
  fetches: Array<{ url: string; init: RequestInit }>;
  loads: Array<{ owner: string; id: string }>;
};

function setup(options: {
  env?: Record<string, string | undefined>;
  user?: { id: string } | null;
  claim?: (args: ClaimArgs) => ClaimResult;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  loadCall?: (owner: string, id: string) => LedgerRow | null;
  finish?: boolean;
  usage?: number | null;
} = {}): { handler: (req: Request) => Promise<Response>; rec: Recorder } {
  const rec: Recorder = { claims: [], finishes: [], fetches: [], loads: [] };
  const env = { ...BASE_ENV, ...(options.env ?? {}) };
  const deps: HandlerDeps = {
    env: (name) => env[name],
    getUser: async (token) => (token === "good-token" ? (options.user === undefined ? { id: OWNER } : options.user) : null),
    claim: async (args) => {
      rec.claims.push(args);
      return options.claim ? options.claim(args) : { disposition: "acquired_new", modelCallId: CALL_ID, turnCount: 5 };
    },
    finish: async (args) => {
      rec.finishes.push(args);
      return options.finish ?? true;
    },
    loadCall: async (owner, id) => {
      rec.loads.push({ owner, id });
      return options.loadCall ? options.loadCall(owner, id) : null;
    },
    usage: async () => (options.usage === undefined ? 3 : options.usage),
    fetch: async (url, init) => {
      rec.fetches.push({ url, init });
      return options.fetch ? options.fetch(url, init) : providerAnswer(LEGAL_REPLY);
    },
    now: (() => {
      let t = 1_000;
      return () => (t += 250);
    })(),
  };
  return { handler: createHandler(deps), rec };
}

function providerAnswer(content: string | null, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: "test-model-1-2026",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 812, completion_tokens: 37 },
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function turnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "turn",
    runSpec: SPEC,
    executionId: "exec-1",
    cellId: "model-vs-firm",
    instanceSeed: SEED,
    replicate: 0,
    role: "buyer",
    legalHistory: [],
    attemptNo: 1,
    operationId: OP_1,
    repairOf: null,
    ...overrides,
  };
}

function post(body: unknown, init: { token?: string | null; method?: string; raw?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? "good-token"}`;
  if (init.origin) headers.Origin = init.origin;
  const method = init.method ?? "POST";
  return new Request("https://project.functions.example/negotiate-turn", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: init.raw ?? JSON.stringify(body) }),
  });
}

async function json<T>(response: Response): Promise<{ status: number; body: T; text: string }> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T, text };
}

// ---------------------------------------------------------------------------
// HTTP boundary: method, CORS, body and auth
// ---------------------------------------------------------------------------

test("only POST and OPTIONS are accepted; CORS allows only APP_ORIGIN entries", async () => {
  const { handler, rec } = setup();
  const options = await handler(post(null, { method: "OPTIONS", origin: "https://app.example", raw: "" }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "https://app.example");

  const foreign = await handler(post(null, { method: "OPTIONS", origin: "https://evil.example", raw: "" }));
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), null);

  const get = await handler(post(null, { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(rec.claims.length + rec.fetches.length, 0);
});

test("APP_ORIGIN unset sends no Access-Control-Allow-Origin header", async () => {
  const { handler } = setup({ env: { APP_ORIGIN: undefined } });
  const response = await handler(post({ op: "config" }, { origin: "https://app.example" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("missing or invalid JWT is 401 and never claims", async () => {
  const { handler, rec } = setup();
  assert.equal((await handler(post(turnBody(), { token: null }))).status, 401);
  assert.equal((await handler(post(turnBody(), { token: "expired-token" }))).status, 401);
  assert.equal(rec.claims.length, 0);
  assert.equal(rec.fetches.length, 0);
});

test("a body over 100 KiB is 413 even without trusting Content-Length", async () => {
  const { handler, rec } = setup();
  const response = await handler(post(null, { raw: `{"op":"turn","pad":"${"x".repeat(100 * 1024)}"}` }));
  assert.equal(response.status, 413);
  assert.equal(rec.claims.length, 0);
});

test("non-JSON, duplicate-key and unknown-op bodies are 400 bad_request", async () => {
  const { handler, rec } = setup();
  for (const raw of ["not json", '{"op":"config","op":"turn"}', '{"op":"other"}', "[]"]) {
    const result = await json<ErrorResponse>(await handler(post(null, { raw })));
    assert.equal(result.status, 400, raw);
    assert.equal(result.body.error, "bad_request");
  }
  assert.equal(rec.claims.length, 0);
});

// ---------------------------------------------------------------------------
// config preflight
// ---------------------------------------------------------------------------

test("config returns safe settings and today's usage, never the key", async () => {
  const { handler } = setup({ usage: 12 });
  const result = await json<ConfigResponse>(await handler(post({ op: "config" })));
  assert.equal(result.status, 200);
  assert.equal(result.body.contractVersion, LIVE_CONTRACT_VERSION);
  assert.equal(result.body.liveEnabled, true);
  assert.equal(result.body.disabledReason, null);
  assert.deepEqual(result.body.allowedModels, [MODEL, "other-model"]);
  assert.equal(result.body.defaultModel, MODEL);
  assert.equal(result.body.dailyLimit, 40);
  assert.equal(result.body.usedToday, 12);
  assert.equal(result.body.remainingToday, 28);
  assert.deepEqual(result.body.limits, { maxOutputTokens: 500, maxRequestBytes: 24_000, providerTimeoutMs: 20_000 });
  assert.equal(result.text.includes(SECRET), false);
});

test("config explains why Live is disabled", async () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ LLM_API_KEY: undefined }, /LLM_API_KEY/],
    [{ LLM_ALLOWED_MODELS: "" }, /LLM_ALLOWED_MODELS/],
    [{ LLM_ALLOWED_MODELS: "bad model id" }, /LLM_ALLOWED_MODELS/],
    [{ LLM_ALLOWED_HOSTS: "" }, /LLM_ALLOWED_HOSTS/],
    [{ LLM_BASE_URL: "http://api.openai.com/v1" }, /https/],
    [{ LLM_BASE_URL: "https://proxy.example/v1" }, /LLM_ALLOWED_HOSTS/],
    [{ LLM_BASE_URL: "https://127.0.0.1/v1", LLM_ALLOWED_HOSTS: "127.0.0.1" }, /public/],
  ];
  for (const [env, reason] of cases) {
    const { handler } = setup({ env });
    const result = await json<ConfigResponse>(await handler(post({ op: "config" })));
    assert.equal(result.body.liveEnabled, false, JSON.stringify(env));
    assert.match(result.body.disabledReason ?? "", reason);
  }
  const unlisted = await json<ConfigResponse>(await setup({ env: { LLM_MODEL: "not-listed" } }).handler(post({ op: "config" })));
  assert.equal(unlisted.body.defaultModel, null);
});

// ---------------------------------------------------------------------------
// turn: validation before claim
// ---------------------------------------------------------------------------

test("missing LLM_API_KEY is 503 missing_secret before any claim", async () => {
  const { handler, rec } = setup({ env: { LLM_API_KEY: undefined } });
  const result = await json<ErrorResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "missing_secret");
  assert.equal(rec.claims.length, 0);
  assert.equal(rec.fetches.length, 0);
});

test("an empty model allowlist is 503 live_disabled before any claim", async () => {
  const { handler, rec } = setup({ env: { LLM_ALLOWED_MODELS: "" } });
  const result = await json<ErrorResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "live_disabled");
  assert.equal(rec.claims.length, 0);
});

test("terminal and illegal histories are 400 before any claim", async () => {
  const { handler, rec } = setup();
  const terminal = await json<ErrorResponse>(await handler(post(turnBody({
    legalHistory: [OPENING, { role: "seller", action: { type: "accept" } }],
  }))));
  assert.equal(terminal.status, 400);
  assert.equal(terminal.body.error, "terminal");

  const outOfTurn = await json<ErrorResponse>(await handler(post(turnBody({ legalHistory: [{ role: "seller", action: { type: "walk" } }] }))));
  assert.equal(outOfTurn.status, 400);
  assert.equal(outOfTurn.body.error, "illegal_turn");

  const offGrid = await json<ErrorResponse>(await handler(post(turnBody({
    legalHistory: [{ role: "buyer", action: { type: "offer", terms: { rent: 6050, term: "24", deposit: 1 } } }],
  }))));
  assert.equal(offGrid.status, 400);
  assert.equal(offGrid.body.error, "illegal_turn");

  const unknownField = await json<ErrorResponse>(await handler(post(turnBody({ legalHistory: [{ role: "buyer", action: { type: "walk", extra: 1 } }] }))));
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.error, "bad_history");

  const wrongRole = await json<ErrorResponse>(await handler(post(turnBody({ legalHistory: [OPENING], role: "buyer" }))));
  assert.equal(wrongRole.status, 400);
  assert.equal(wrongRole.body.error, "illegal_turn");

  assert.equal(rec.claims.length, 0);
  assert.equal(rec.fetches.length, 0);
});

test("a seat that is not a model, an unlisted model, a foreign seed or replicate is 400", async () => {
  const scripted = await json<ErrorResponse>(await setup().handler(post(turnBody({ legalHistory: [OPENING], role: "seller" }))));
  assert.equal(scripted.body.error, "not_model_seat");

  const { handler, rec } = setup({ env: { LLM_ALLOWED_MODELS: "other-model" } });
  const unlisted = await json<ErrorResponse>(await handler(post(turnBody())));
  assert.equal(unlisted.status, 400);
  assert.equal(unlisted.body.error, "model_not_allowed");
  assert.equal(rec.claims.length, 0);

  const seed = await json<ErrorResponse>(await setup().handler(post(turnBody({ instanceSeed: SEED + 1 }))));
  assert.equal(seed.body.error, "bad_spec");
  const replicate = await json<ErrorResponse>(await setup().handler(post(turnBody({ replicate: 1 }))));
  assert.equal(replicate.body.error, "bad_spec");

  const tampered = { ...SPEC, definitionDigest: "0".repeat(64) };
  const badSpec = await json<ErrorResponse>(await setup().handler(post(turnBody({ runSpec: tampered }))));
  assert.equal(badSpec.body.error, "bad_spec");
});

test("attempt/repair shape and operation id are checked before claim", async () => {
  const { handler, rec } = setup();
  const noParent = await json<ErrorResponse>(await handler(post(turnBody({ attemptNo: 2, repairOf: null }))));
  assert.equal(noParent.status, 400);
  const firstWithParent = await json<ErrorResponse>(await handler(post(turnBody({ attemptNo: 1, repairOf: CALL_ID }))));
  assert.equal(firstWithParent.status, 400);
  const third = await json<ErrorResponse>(await handler(post(turnBody({ attemptNo: 3 }))));
  assert.equal(third.status, 400);
  const badOp = await json<ErrorResponse>(await handler(post(turnBody({ operationId: "not-a-uuid" }))));
  assert.equal(badOp.status, 400);
  assert.equal(rec.claims.length, 0);
  assert.equal(rec.loads.length, 0);
});

test("a rendered request over 24,000 bytes is 400 request_too_large with no claim", async () => {
  // maxRounds 20 => 40 legal turns. 30 offers each with a 280-char note of U+20AC (3 UTF-8 bytes):
  // 30 * 840 = 25,200 note bytes alone exceed 24,000. The body stays under 100 KiB.
  const definition = liveExecutionDefinition(warehouse(), 20);
  const spec = makeSpec(definition);
  const note = "€".repeat(280);
  const history: PublicTurn[] = [];
  for (let index = 0; index < 30; index += 1) {
    history.push({ role: index % 2 === 0 ? "buyer" : "seller", action: { type: "offer", terms: { rent: 6000, term: "24", deposit: 1 }, note } });
  }
  const scenario = instantiate(definition, SEED);
  assert.equal(scenario.ok, true);
  if (scenario.ok) assert.equal(replay(scenario.instance.scenario, history).ok, true);

  const { handler, rec } = setup();
  const result = await json<ErrorResponse>(await handler(post(turnBody({ runSpec: spec, legalHistory: history }))));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "request_too_large");
  assert.equal(rec.claims.length, 0);
  assert.equal(rec.fetches.length, 0);
});

// ---------------------------------------------------------------------------
// turn: claim dispositions
// ---------------------------------------------------------------------------

test("acquired_new dispatches exactly once with the hashed canonical request and returns a legal verdict", async () => {
  const { handler, rec } = setup();
  const result = await json<TurnResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 200);
  assert.equal(rec.claims.length, 1);
  assert.equal(rec.fetches.length, 1);
  const sent = rec.fetches[0]!;
  assert.equal(sent.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent.init.redirect, "error");
  assert.equal(sha256Hex(String(sent.init.body)), rec.claims[0]!.requestDigest);
  assert.equal(result.body.requestDigest, rec.claims[0]!.requestDigest);
  assert.equal(rec.claims[0]!.owner, OWNER);
  assert.equal(rec.claims[0]!.reservedOutput, 500);
  assert.equal(result.body.verdict, "legal");
  assert.equal(result.body.validationError, null);
  assert.equal(result.body.content, LEGAL_REPLY);
  assert.equal(result.body.outputDigest, sha256Hex(LEGAL_REPLY));
  assert.deepEqual(result.body.usage, { inputTokens: 812, outputTokens: 37 });
  assert.equal(result.body.providerModel, "test-model-1-2026");
  assert.equal(result.body.remainingToday, 35);
  assert.equal(rec.finishes.length, 1);
  assert.equal(rec.finishes[0]!.status, "completed");
  assert.equal(rec.finishes[0]!.verdict, "legal");
  assert.equal(result.text.includes(SECRET), false);
});

test("the turn key binds owner, execution and legal prefix", async () => {
  const first = setup();
  await first.handler(post(turnBody()));
  const other = setup({ user: { id: OTHER_OWNER } });
  await other.handler(post(turnBody()));
  const otherExec = setup();
  await otherExec.handler(post(turnBody({ executionId: "exec-2" })));
  const keys = [first.rec.claims[0]!.turnKey, other.rec.claims[0]!.turnKey, otherExec.rec.claims[0]!.turnKey];
  assert.equal(new Set(keys).size, 3);
  assert.match(keys[0]!, /^[0-9a-f]{64}$/);
});

test("an invalid model action is finished as invalid_action before any repair", async () => {
  const { handler, rec } = setup({ fetch: async () => providerAnswer("I accept that package.") });
  const result = await json<TurnResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 200);
  assert.equal(result.body.verdict, "invalid");
  assert.ok(result.body.validationError);
  assert.equal(rec.finishes.length, 1);
  assert.equal(rec.finishes[0]!.status, "invalid_action");
  assert.equal(rec.finishes[0]!.verdict, "invalid");
  assert.equal((rec.finishes[0]!.response as TurnResponse).content, "I accept that package.");
});

test("an oversized answer is invalid with the raw-too-long error", async () => {
  const { handler, rec } = setup({ fetch: async () => providerAnswer(`{"type":"walk","note":"${"y".repeat(9000)}"}`) });
  const result = await json<TurnResponse>(await handler(post(turnBody())));
  assert.equal(result.body.verdict, "invalid");
  assert.match(result.body.validationError ?? "", /larger than 8192 bytes/);
  assert.equal(rec.finishes[0]!.status, "invalid_action");
});

test("a repair uses the ledger's stored output and error, never the body", async () => {
  // Attempt 1 is invalid; capture its server turn key and cached response.
  const first = setup({ fetch: async () => providerAnswer("I accept that package.") });
  const firstResult = await json<TurnResponse>(await first.handler(post(turnBody())));
  const turnKey = first.rec.claims[0]!.turnKey;
  const parent: LedgerRow = { id: CALL_ID, owner_id: OWNER, attempt_no: 1, status: "invalid_action", turn_key: turnKey, response_json: firstResult.body };

  const repair = setup({ loadCall: () => parent });
  const result = await json<TurnResponse>(await repair.handler(post(turnBody({ attemptNo: 2, repairOf: CALL_ID, operationId: OP_2 }))));
  assert.equal(result.status, 200);
  assert.equal(repair.rec.claims[0]!.attemptNo, 2);
  assert.equal(repair.rec.claims[0]!.repairOf, CALL_ID);
  assert.equal(repair.rec.claims[0]!.turnKey, turnKey);
  const sent = JSON.parse(String(repair.rec.fetches[0]!.init.body)) as { messages: Array<{ role: string; content: string }> };
  assert.equal(sent.messages.length, 4);
  assert.equal(sent.messages[2]!.role, "assistant");
  assert.equal(sent.messages[2]!.content, "I accept that package.");
  const feedback = JSON.parse(sent.messages[3]!.content) as { validationError: string };
  assert.equal(feedback.validationError, firstResult.body.validationError);
});

test("a repair whose parent is missing, foreign, not invalid or another turn is 409 with no provider call", async () => {
  const first = setup({ fetch: async () => providerAnswer("I accept that package.") });
  const firstResult = await json<TurnResponse>(await first.handler(post(turnBody())));
  const good: LedgerRow = { id: CALL_ID, owner_id: OWNER, attempt_no: 1, status: "invalid_action", turn_key: first.rec.claims[0]!.turnKey, response_json: firstResult.body };
  const parents: Array<LedgerRow | null> = [
    null,
    { ...good, owner_id: OTHER_OWNER },
    { ...good, status: "completed" },
    { ...good, attempt_no: 2 },
    { ...good, turn_key: "f".repeat(64) },
  ];
  for (const parent of parents) {
    const { handler, rec } = setup({ loadCall: () => parent });
    const result = await json<ErrorResponse>(await handler(post(turnBody({ attemptNo: 2, repairOf: CALL_ID, operationId: OP_2 }))));
    assert.equal(result.status, 409, JSON.stringify(parent));
    assert.equal(result.body.error, "conflict");
    assert.equal(rec.claims.length, 0);
    assert.equal(rec.fetches.length, 0);
  }
});

test("provider errors are categorized without echoing provider text", async () => {
  const leak = "LEAKY-PROVIDER-TEXT-9731";
  const cases: Array<[number, Record<string, unknown>, string]> = [
    [401, { error: { message: leak, code: "invalid_api_key" } }, "authentication"],
    [404, { error: { message: leak, code: "model_not_found" } }, "model_not_found"],
    [429, { error: { message: leak } }, "rate_limited"],
    [400, { error: { message: leak, code: "context_length_exceeded" } }, "context_too_long"],
    [400, { error: { message: leak } }, "generic_upstream"],
    [503, { error: { message: leak } }, "server"],
  ];
  for (const [status, payload, category] of cases) {
    const { handler, rec } = setup({ fetch: async () => new Response(JSON.stringify(payload), { status }) });
    const result = await json<ErrorResponse>(await handler(post(turnBody())));
    assert.equal(result.status, 502);
    assert.equal(result.body.error, "provider_error");
    assert.equal(result.body.category, category);
    assert.equal(result.body.upstreamStatus, status);
    assert.equal(result.body.uncertain, false);
    assert.equal(result.text.includes(leak), false);
    assert.equal(result.text.includes("context_length_exceeded"), false);
    assert.equal(rec.fetches.length, 1);
    assert.equal(rec.finishes[0]!.status, "error");
    assert.equal(rec.finishes[0]!.errorCategory, category);
    assert.equal(JSON.stringify(rec.finishes[0]!.response).includes(leak), false);
  }
});

test("an unparseable or contentless answer is malformed_response", async () => {
  for (const response of [new Response("<html>oops</html>", { status: 200 }), providerAnswer(null)]) {
    const { handler } = setup({ fetch: async () => response });
    const result = await json<ErrorResponse>(await handler(post(turnBody())));
    assert.equal(result.status, 502);
    assert.equal(result.body.category, "malformed_response");
  }
});

test("a timeout after dispatch is uncertain, finished as uncertain, and never retried", async () => {
  const { handler, rec } = setup({
    fetch: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  const result = await json<ErrorResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 502);
  assert.equal(result.body.category, "timeout");
  assert.equal(result.body.uncertain, true);
  assert.equal(result.body.modelCallId, CALL_ID);
  assert.equal(rec.fetches.length, 1);
  assert.equal(rec.finishes.length, 1);
  assert.equal(rec.finishes[0]!.status, "uncertain");
});

test("quota_exhausted is 429 with zero provider calls", async () => {
  const { handler, rec } = setup({ claim: () => ({ disposition: "quota_exhausted" }) });
  const result = await json<ErrorResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 429);
  assert.equal(result.body.error, "daily_turn_limit");
  assert.equal(rec.fetches.length, 0);
  assert.equal(rec.finishes.length, 0);
});

test("existing_finished returns the cached response with zero provider calls", async () => {
  const cached: TurnResponse = {
    contractVersion: LIVE_CONTRACT_VERSION,
    disposition: "acquired_new",
    modelCallId: CALL_ID,
    operationId: OP_1,
    requestDigest: "a".repeat(64),
    templateDigest: "b".repeat(64),
    selectedModel: MODEL,
    providerModel: "test-model-1-2026",
    content: LEGAL_REPLY,
    outputDigest: sha256Hex(LEGAL_REPLY),
    verdict: "legal",
    validationError: null,
    usage: { inputTokens: 1, outputTokens: 2 },
    latencyMs: 10,
    remainingToday: 30,
  };
  const { handler, rec } = setup({ claim: () => ({ disposition: "existing_finished", modelCallId: CALL_ID, status: "completed", response: cached }) });
  const result = await json<TurnResponse>(await handler(post(turnBody())));
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, "existing_finished");
  assert.equal(result.body.content, LEGAL_REPLY);
  assert.equal(result.body.outputDigest, cached.outputDigest);
  assert.equal(rec.fetches.length, 0);
  assert.equal(rec.finishes.length, 0);
});

test("existing_pending is 202, existing_uncertain is 502 uncertain, conflict is 409; none dispatch", async () => {
  const pending = setup({ claim: () => ({ disposition: "existing_pending", modelCallId: CALL_ID }) });
  const p = await json<ErrorResponse>(await pending.handler(post(turnBody())));
  assert.equal(p.status, 202);
  assert.equal(p.body.disposition, "existing_pending");

  const uncertain = setup({ claim: () => ({ disposition: "existing_uncertain", modelCallId: CALL_ID, response: null }) });
  const u = await json<ErrorResponse>(await uncertain.handler(post(turnBody())));
  assert.equal(u.status, 502);
  assert.equal(u.body.uncertain, true);

  const conflict = setup({ claim: () => ({ disposition: "conflict", reason: "operation_mismatch" }) });
  const c = await json<ErrorResponse>(await conflict.handler(post(turnBody())));
  assert.equal(c.status, 409);

  assert.equal(pending.rec.fetches.length + uncertain.rec.fetches.length + conflict.rec.fetches.length, 0);
});

test("parseClaimResult reads the SQL jsonb dispositions and rejects unknown shapes", () => {
  assert.deepEqual(parseClaimResult({ disposition: "acquired_new", model_call_id: CALL_ID, turn_count: 4 }), { disposition: "acquired_new", modelCallId: CALL_ID, turnCount: 4 });
  assert.deepEqual(parseClaimResult({ disposition: "quota_exhausted" }), { disposition: "quota_exhausted" });
  assert.equal(parseClaimResult({ disposition: "acquired_new" }), null);
  assert.equal(parseClaimResult({ disposition: "granted" }), null);
  assert.equal(parseClaimResult(null), null);
});

test("turnKeyOf is a hex digest that changes with the legal prefix", () => {
  const built = instantiate(SPEC.definition, SEED);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const empty = replay(built.instance.scenario, []);
  const one = replay(built.instance.scenario, [OPENING]);
  assert.ok(empty.ok && one.ok);
  if (!empty.ok || !one.ok) return;
  const base = { owner: OWNER, executionId: "exec-1", spec: SPEC, instanceId: built.instance.instanceId, cellId: "model-vs-firm", role: "buyer" as const, config: modelConfig(MODEL), replicate: 0 };
  const a = turnKeyOf({ ...base, state: empty.state });
  const b = turnKeyOf({ ...base, state: one.state });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
