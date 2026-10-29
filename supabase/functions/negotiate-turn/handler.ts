/**
 * negotiate-turn logic (PLAN 7). No Deno globals and no npm:/jsr: imports, so Node tests can import
 * this module and inject fakes. index.ts wires the real Supabase clients, the Deno environment and fetch.
 *
 * Sequence: method/CORS -> bearer -> capped body -> verified user (getUser only) -> op.
 * turn: validate + instantiate + replay -> secret/config preflight -> repair parent (owned ledger row)
 * -> canonical request + digest -> service-only claim -> provider I/O ONLY for acquired_new
 * -> strict parse + referee -> finish (validation before storing) -> respond.
 */
import { canonicalJson, sha256Hex } from "../_shared/hash.ts";
import { instantiate } from "../_shared/instantiate.ts";
import { parseJsonStrict } from "../_shared/json.ts";
import { LIVE_CONTRACT_VERSION } from "../_shared/liveContract.ts";
import type { ConfigResponse, Disposition, ErrorResponse, ProviderCategory, TurnResponse } from "../_shared/liveContract.ts";
import { maxTurns, parseAction, replay } from "../_shared/referee.ts";
import { buildRoleRequest, legalPrefixDigest, REQUEST_LIMITS } from "../_shared/request.ts";
import type { CanonicalRequest, RepairFeedback } from "../_shared/request.ts";
import { boundRaw, judgeAttempt, RAW_TOO_LONG_ERROR } from "../_shared/runner.ts";
import { agentKey, findCell, runSpecDigest, validateRunSpec } from "../_shared/runspec.ts";
import type { RunSpec } from "../_shared/runspec.ts";
import { isRecord } from "../_shared/scenario.ts";
import type { AgentConfig, GameState, PublicTurn, Role, Scenario } from "../_shared/types.ts";
import { DAILY_TURN_LIMIT } from "../_shared/types.ts";
import { rulesetOf } from "../_shared/utility.ts";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export type ModelConfig = Extract<AgentConfig, { kind: "model" }>;

export type ClaimArgs = {
  owner: string;
  operationId: string;
  turnKey: string;
  attemptNo: 1 | 2;
  requestDigest: string;
  modelConfig: ModelConfig;
  selectedModel: string;
  reservedOutput: number;
  repairOf: string | null;
};

export type ClaimResult =
  | { disposition: "acquired_new"; modelCallId: string; turnCount: number }
  | { disposition: "existing_pending"; modelCallId: string }
  | { disposition: "existing_finished"; modelCallId: string; status: string; response: unknown }
  | { disposition: "existing_uncertain"; modelCallId: string; response: unknown }
  | { disposition: "conflict"; reason: string }
  | { disposition: "quota_exhausted" };

export type FinishStatus = "completed" | "invalid_action" | "error" | "uncertain";

export type FinishArgs = {
  owner: string;
  id: string;
  status: FinishStatus;
  verdict: "legal" | "invalid" | null;
  errorCategory: ProviderCategory | null;
  response: TurnResponse | ErrorResponse;
  outputDigest: string | null;
  providerModel: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
};

/** The subset of a public.model_calls row the handler reads (service-role select). */
export type LedgerRow = {
  id: string;
  owner_id: string;
  attempt_no: number;
  status: string;
  turn_key: string;
  response_json: unknown;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HandlerDeps = {
  env: (name: string) => string | undefined;
  /** Wraps auth.getUser(token). Throws on platform misconfiguration; null for an invalid session. */
  getUser: (token: string) => Promise<{ id: string } | null>;
  /** Wraps the service-role RPC public.claim_model_attempt. */
  claim: (args: ClaimArgs) => Promise<ClaimResult>;
  /** Wraps the service-role RPC public.finish_model_attempt. */
  finish: (args: FinishArgs) => Promise<boolean>;
  /** Service-role select of one model_calls row scoped to owner + id. */
  loadCall: (owner: string, id: string) => Promise<LedgerRow | null>;
  /** Today's (UTC) reserved turn count for owner, or null when unknown. */
  usage: (owner: string) => Promise<number | null>;
  fetch: FetchLike;
  now: () => number;
};

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const TURN_KEYS = ["op", "runSpec", "executionId", "cellId", "instanceSeed", "replicate", "role", "legalHistory", "attemptNo", "operationId", "repairOf"];

type Cors = Record<string, string>;

function corsHeaders(req: Request, env: HandlerDeps["env"]): Cors {
  const headers: Cors = {
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  const allowed = (env("APP_ORIGIN") ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const origin = req.headers.get("Origin");
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function respond(status: number, body: unknown, cors: Cors): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function errorBody(error: string, message: string, extra: Partial<ErrorResponse> = {}): ErrorResponse {
  return { contractVersion: LIVE_CONTRACT_VERSION, error, message, ...extra };
}

type Fail = { ok: false; status: number; body: ErrorResponse };
function fail(status: number, error: string, message: string, extra: Partial<ErrorResponse> = {}): Fail {
  return { ok: false, status, body: errorBody(error, message, extra) };
}

/** Read a stream incrementally up to cap bytes; never trusts Content-Length. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        // ignore: the body is already rejected
      }
      return { ok: false };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server configuration preflight (no secrets are ever returned)
// ---------------------------------------------------------------------------

export type LiveSettings = {
  liveEnabled: boolean;
  disabledError: "missing_secret" | "live_disabled" | null;
  disabledReason: string | null;
  allowedModels: string[];
  modelsUsable: boolean;
  defaultModel: string | null;
  endpoint: string | null;
};

export function readLiveSettings(env: HandlerDeps["env"]): LiveSettings & { apiKey: string } {
  const apiKey = (env("LLM_API_KEY") ?? "").trim();

  const rawModels = (env("LLM_ALLOWED_MODELS") ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  const modelsValid = rawModels.length > 0 && rawModels.every((item) => MODEL_RE.test(item));
  const allowedModels = modelsValid ? [...new Set(rawModels)] : [];
  const modelReason = rawModels.length === 0
    ? "Set LLM_ALLOWED_MODELS to a comma-separated list of model IDs. An empty allowlist disables Live."
    : modelsValid ? null : "LLM_ALLOWED_MODELS has an entry that is not a valid model ID.";

  const endpointResult = resolveEndpoint(env);
  const configuredDefault = (env("LLM_MODEL") ?? "").trim();
  const defaultModel = allowedModels.includes(configuredDefault) ? configuredDefault : null;

  let disabledError: LiveSettings["disabledError"] = null;
  let disabledReason: string | null = null;
  if (!apiKey) {
    disabledError = "missing_secret";
    disabledReason = "Set LLM_API_KEY in server secrets. Scripted and fixture pairings run without it.";
  } else if (modelReason) {
    disabledError = "live_disabled";
    disabledReason = modelReason;
  } else if (!endpointResult.ok) {
    disabledError = "live_disabled";
    disabledReason = endpointResult.error;
  }
  return {
    apiKey,
    liveEnabled: disabledError === null,
    disabledError,
    disabledReason,
    allowedModels,
    modelsUsable: modelsValid,
    defaultModel,
    endpoint: endpointResult.ok ? endpointResult.endpoint : null,
  };
}

/** One fixed endpoint: `${LLM_BASE_URL}/chat/completions`, https, exact host allowlist, no private hosts. */
export function resolveEndpoint(env: HandlerDeps["env"]): { ok: true; endpoint: string } | { ok: false; error: string } {
  const hosts = (env("LLM_ALLOWED_HOSTS") ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  if (hosts.length === 0) {
    return { ok: false, error: "Set LLM_ALLOWED_HOSTS to the exact provider host (for example api.openai.com). An empty host allowlist disables Live." };
  }
  if (!hosts.every((host) => HOST_RE.test(host))) return { ok: false, error: "LLM_ALLOWED_HOSTS has an entry that is not a host name." };
  const base = ((env("LLM_BASE_URL") ?? "").trim() || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${base}/chat/completions`);
  } catch {
    return { ok: false, error: "LLM_BASE_URL is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "LLM_BASE_URL must use https." };
  if (url.username || url.password) return { ok: false, error: "LLM_BASE_URL must not include credentials." };
  if (url.search || url.hash) return { ok: false, error: "LLM_BASE_URL must not include a query or fragment." };
  if (!hosts.includes(url.host.toLowerCase())) return { ok: false, error: "The LLM_BASE_URL host is not listed in LLM_ALLOWED_HOSTS." };
  if (isPrivateHost(url.hostname)) return { ok: false, error: "LLM_BASE_URL must be a public https host." };
  return { ok: true, endpoint: url.toString() };
}

/** Partial private-address filter. The host allowlist is the real control; this is not SSRF proof. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host === "metadata.google.internal") return true;
  if (host.includes(":")) {
    const simple = host.split("%")[0] ?? host;
    return simple === "::" || simple === "::1" || simple.startsWith("fc") || simple.startsWith("fd") || simple.startsWith("fe80") || simple.startsWith("::ffff:");
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  return a === 10 || a === 127 || a === 0 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

// ---------------------------------------------------------------------------
// Turn request validation (all before quota or provider I/O)
// ---------------------------------------------------------------------------

type ValidTurn = {
  spec: RunSpec;
  executionId: string;
  cellId: string;
  instanceSeed: number;
  replicate: number;
  role: Role;
  attemptNo: 1 | 2;
  operationId: string;
  repairOf: string | null;
  config: ModelConfig;
  instanceId: string;
  scenario: Scenario;
  state: GameState;
};

function validateTurn(body: Record<string, unknown>, settings: LiveSettings): { ok: true; turn: ValidTurn } | Fail {
  // 1. body shape
  for (const key of Object.keys(body)) {
    if (!TURN_KEYS.includes(key)) return fail(400, "bad_request", `unknown field ${key.slice(0, 40)}`);
  }
  if (typeof body.executionId !== "string" || !SAFE_ID_RE.test(body.executionId)) return fail(400, "bad_request", "executionId must be 1 to 128 safe characters.");
  if (typeof body.cellId !== "string") return fail(400, "bad_request", "cellId must be a string.");
  if (typeof body.instanceSeed !== "number" || !Number.isInteger(body.instanceSeed)) return fail(400, "bad_request", "instanceSeed must be an integer.");
  if (typeof body.replicate !== "number" || !Number.isInteger(body.replicate)) return fail(400, "bad_request", "replicate must be an integer.");
  if (body.role !== "buyer" && body.role !== "seller") return fail(400, "bad_request", "role must be buyer or seller.");
  if (!Array.isArray(body.legalHistory)) return fail(400, "bad_request", "legalHistory must be an array.");
  if (body.attemptNo !== 1 && body.attemptNo !== 2) return fail(400, "bad_request", "attemptNo must be 1 or 2.");
  if (typeof body.operationId !== "string") return fail(400, "bad_request", "operationId must be a UUID.");
  if (body.repairOf !== null && typeof body.repairOf !== "string") return fail(400, "bad_request", "repairOf must be a UUID or null.");
  const role: Role = body.role;
  const attemptNo: 1 | 2 = body.attemptNo;

  // 2. spec, cell, seat, model allowlist, instance, replicate
  const checked = validateRunSpec(body.runSpec);
  if (!checked.ok) return fail(400, "bad_spec", checked.error);
  const spec = checked.spec;
  const cell = findCell(spec, body.cellId);
  if (!cell) return fail(400, "bad_spec", "cellId is not a cell of this run spec.");
  const config = cell.roles[role];
  if (config.kind !== "model") return fail(400, "not_model_seat", `the ${role} seat of this cell is not a model seat.`);
  // An unusable allowlist is a server setup failure (503 live_disabled at preflight), not a client error.
  if (settings.modelsUsable && !settings.allowedModels.includes(config.model)) {
    return fail(400, "model_not_allowed", "That model ID is not in the server's LLM_ALLOWED_MODELS.");
  }
  if (!spec.instanceSeeds.includes(body.instanceSeed)) return fail(400, "bad_spec", "instanceSeed is not one of the run spec's instance seeds.");
  if (body.replicate < 0 || body.replicate >= spec.replicates) return fail(400, "bad_spec", "replicate is outside the run spec's replicates.");
  const built = instantiate(spec.definition, body.instanceSeed);
  if (!built.ok) return fail(400, "bad_spec", built.error);
  const scenario = built.instance.scenario;
  const ruleset = rulesetOf(scenario);

  // 3. legal history: strict parse + canonical replay
  const cap = maxTurns(scenario);
  if (body.legalHistory.length >= cap) return fail(400, "terminal", "the legal history already reached the turn cap.");
  const history: PublicTurn[] = [];
  for (const item of body.legalHistory as unknown[]) {
    if (!isRecord(item) || !Object.keys(item).every((key) => key === "role" || key === "action")) {
      return fail(400, "bad_history", "each history turn must be {role, action}.");
    }
    if (item.role !== "buyer" && item.role !== "seller") return fail(400, "bad_history", "history role must be buyer or seller.");
    const action = parseAction(item.action, ruleset);
    if (!action.ok) return fail(400, "bad_history", action.error);
    history.push({ role: item.role, action: action.action });
  }
  const replayed = replay(scenario, history);
  if (!replayed.ok) return fail(400, "illegal_turn", `history is not legal: ${replayed.error}`);
  const state = replayed.state;
  if (state.terminal) return fail(400, "terminal", "the match is already over.");
  if (state.history.length >= cap) return fail(400, "terminal", "the legal history already reached the turn cap.");
  if (state.nextRole !== role) return fail(400, "illegal_turn", `it is the ${state.nextRole}'s turn.`);

  // 4. attempt / repair / operation identity
  if (attemptNo === 1 && body.repairOf !== null) return fail(400, "bad_request", "a first attempt must have repairOf null.");
  if (attemptNo === 2 && body.repairOf === null) return fail(400, "bad_request", "a repair (attemptNo 2) must name repairOf.");
  if (typeof body.repairOf === "string" && !UUID_RE.test(body.repairOf)) return fail(400, "bad_request", "repairOf must be a UUID.");
  if (!UUID_RE.test(body.operationId)) return fail(400, "bad_request", "operationId must be a UUID.");

  return {
    ok: true,
    turn: {
      spec,
      executionId: body.executionId,
      cellId: body.cellId,
      instanceSeed: body.instanceSeed,
      replicate: body.replicate,
      role,
      attemptNo,
      operationId: body.operationId.toLowerCase(),
      repairOf: typeof body.repairOf === "string" ? body.repairOf.toLowerCase() : null,
      config,
      instanceId: built.instance.instanceId,
      scenario,
      state,
    },
  };
}

/** Server-derived logical turn identity (PLAN 7.2). */
export function turnKeyOf(input: {
  owner: string;
  executionId: string;
  spec: RunSpec;
  instanceId: string;
  cellId: string;
  role: Role;
  config: AgentConfig;
  replicate: number;
  state: GameState;
}): string {
  return sha256Hex(canonicalJson({
    owner: input.owner,
    executionId: input.executionId,
    runSpecDigest: runSpecDigest(input.spec),
    instanceId: input.instanceId,
    cellId: input.cellId,
    role: input.role,
    roleConfig: agentKey(input.config),
    replicate: input.replicate,
    prefixDigest: legalPrefixDigest(input.state),
  }));
}

// ---------------------------------------------------------------------------
// Claim result parsing (used by index.ts on the RPC's jsonb)
// ---------------------------------------------------------------------------

export function parseClaimResult(data: unknown): ClaimResult | null {
  if (!isRecord(data) || typeof data.disposition !== "string") return null;
  const id = typeof data.model_call_id === "string" ? data.model_call_id : null;
  switch (data.disposition) {
    case "acquired_new":
      return id && typeof data.turn_count === "number" ? { disposition: "acquired_new", modelCallId: id, turnCount: data.turn_count } : null;
    case "existing_pending":
      return id ? { disposition: "existing_pending", modelCallId: id } : null;
    case "existing_finished":
      return id && typeof data.status === "string" ? { disposition: "existing_finished", modelCallId: id, status: data.status, response: data.response ?? null } : null;
    case "existing_uncertain":
      return id ? { disposition: "existing_uncertain", modelCallId: id, response: data.response ?? null } : null;
    case "conflict":
      return { disposition: "conflict", reason: typeof data.reason === "string" ? data.reason.slice(0, 64) : "conflict" };
    case "quota_exhausted":
      return { disposition: "quota_exhausted" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Provider I/O
// ---------------------------------------------------------------------------

type ProviderOutcome =
  | { kind: "answer"; content: string; providerModel: string | null; usage: FinishArgs["usage"] }
  | { kind: "error"; category: ProviderCategory; upstreamStatus: number | null; uncertain: boolean };

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return isRecord(error) && (error.name === "AbortError" || error.name === "TimeoutError");
}

function categorize(status: number, bodyText: string | null): ProviderCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  if ((status === 400 || status === 413 || status === 422) && bodyText !== null && mentionsContextLength(bodyText)) return "context_too_long";
  return "generic_upstream";
}

/** Internal inspection only; the matched text is never echoed. */
function mentionsContextLength(text: string): boolean {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.error)) return false;
  const code = parsed.value.error.code;
  const type = parsed.value.error.type;
  return (typeof code === "string" && /context_length/i.test(code)) || (typeof type === "string" && /context_length/i.test(type));
}

function cleanProviderModel(value: unknown): string | null {
  return typeof value === "string" && MODEL_RE.test(value) ? value : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function callProvider(deps: HandlerDeps, endpoint: string, apiKey: string, request: CanonicalRequest): Promise<ProviderOutcome> {
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), REQUEST_LIMITS.providerTimeoutMs);
  try {
    let upstream: Response;
    try {
      upstream = await deps.fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Exactly the bytes that were hashed into requestDigest.
        body: canonicalJson(request),
      });
    } catch (error) {
      // The request may have reached the provider; its result is unknown. Never auto-retried.
      return { kind: "error", category: isAbort(error, controller.signal) ? "timeout" : "generic_upstream", upstreamStatus: null, uncertain: true };
    }
    let read: Awaited<ReturnType<typeof readCapped>>;
    try {
      read = await readCapped(upstream.body, REQUEST_LIMITS.maxUpstreamBytes);
    } catch (error) {
      if (isAbort(error, controller.signal)) return { kind: "error", category: "timeout", upstreamStatus: upstream.status, uncertain: true };
      return { kind: "error", category: "malformed_response", upstreamStatus: upstream.status, uncertain: false };
    }
    const text = read.ok ? decodeUtf8(read.bytes) : null;
    if (!upstream.ok) {
      return { kind: "error", category: categorize(upstream.status, text), upstreamStatus: upstream.status, uncertain: false };
    }
    if (text === null) return { kind: "error", category: "malformed_response", upstreamStatus: upstream.status, uncertain: false };
    const parsed = parseJsonStrict(text);
    if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.choices)) {
      return { kind: "error", category: "malformed_response", upstreamStatus: upstream.status, uncertain: false };
    }
    const first: unknown = parsed.value.choices[0];
    if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
      return { kind: "error", category: "malformed_response", upstreamStatus: upstream.status, uncertain: false };
    }
    const usageRaw = parsed.value.usage;
    const usage = isRecord(usageRaw) ? { inputTokens: tokenCount(usageRaw.prompt_tokens), outputTokens: tokenCount(usageRaw.completion_tokens) } : null;
    return { kind: "answer", content: first.message.content, providerModel: cleanProviderModel(parsed.value.model), usage };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req, deps.env);
    try {
      return await handle(req, deps, cors);
    } catch {
      // Never echo internal error text (it could carry provider or platform details).
      return respond(500, errorBody("internal_error", "The function failed unexpectedly. No result was invented."), cors);
    }
  };
}

async function handle(req: Request, deps: HandlerDeps, cors: Cors): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return respond(405, errorBody("method_not_allowed", "Use POST."), cors);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!bearer || !bearer[1]) return respond(401, errorBody("unauthorized", "Sign in. The function requires a user JWT."), cors);
  const token = bearer[1];

  const read = await readCapped(req.body, REQUEST_LIMITS.maxBodyBytes);
  if (!read.ok) return respond(413, errorBody("body_too_large", `The request body is larger than ${REQUEST_LIMITS.maxBodyBytes} bytes.`), cors);

  let user: { id: string } | null;
  try {
    user = await deps.getUser(token);
  } catch {
    return respond(503, errorBody("platform_configuration", "The function cannot verify sessions (SUPABASE_URL / SUPABASE_ANON_KEY)."), cors);
  }
  if (!user || typeof user.id !== "string" || !UUID_RE.test(user.id)) {
    return respond(401, errorBody("unauthorized", "The session is missing or expired."), cors);
  }
  const owner = user.id.toLowerCase();

  const text = decodeUtf8(read.bytes);
  if (text === null) return respond(400, errorBody("bad_request", "The request body is not UTF-8."), cors);
  const parsed = parseJsonStrict(text);
  if (!parsed.ok || !isRecord(parsed.value)) return respond(400, errorBody("bad_request", "The request body must be one JSON object."), cors);
  const body = parsed.value;

  if (body.op === "config") {
    if (Object.keys(body).length !== 1) return respond(400, errorBody("bad_request", "config takes no other fields."), cors);
    return respond(200, await configResponse(deps, owner), cors);
  }
  if (body.op !== "turn") return respond(400, errorBody("bad_request", "op must be config or turn."), cors);
  const result = await turn(deps, owner, body);
  return respond(result.status, result.body, cors);
}

async function configResponse(deps: HandlerDeps, owner: string): Promise<ConfigResponse> {
  const settings = readLiveSettings(deps.env);
  let used: number | null = null;
  try {
    used = await deps.usage(owner);
  } catch {
    used = null;
  }
  const usedToday = typeof used === "number" && Number.isInteger(used) && used >= 0 ? used : null;
  return {
    contractVersion: LIVE_CONTRACT_VERSION,
    liveEnabled: settings.liveEnabled,
    disabledReason: settings.disabledReason,
    allowedModels: settings.allowedModels,
    defaultModel: settings.defaultModel,
    dailyLimit: DAILY_TURN_LIMIT,
    usedToday,
    remainingToday: usedToday === null ? null : Math.max(0, DAILY_TURN_LIMIT - usedToday),
    limits: {
      maxOutputTokens: REQUEST_LIMITS.maxOutputTokens,
      maxRequestBytes: REQUEST_LIMITS.maxRequestBytes,
      providerTimeoutMs: REQUEST_LIMITS.providerTimeoutMs,
    },
  };
}

type Outcome = { status: number; body: TurnResponse | ErrorResponse };

async function turn(deps: HandlerDeps, owner: string, body: Record<string, unknown>): Promise<Outcome> {
  const settings = readLiveSettings(deps.env);

  // Validate everything before any ledger, quota or provider I/O.
  const validated = validateTurn(body, settings);
  if (!validated.ok) return validated;
  const t = validated.turn;

  // Secret / server-config preflight BEFORE claiming quota.
  if (!settings.apiKey) {
    return { status: 503, body: errorBody("missing_secret", settings.disabledReason ?? "Set LLM_API_KEY in server secrets.") };
  }
  if (!settings.liveEnabled || settings.endpoint === null) {
    return { status: 503, body: errorBody("live_disabled", settings.disabledReason ?? "Live is disabled by server configuration.") };
  }
  const endpoint = settings.endpoint;

  const turnKey = turnKeyOf({
    owner,
    executionId: t.executionId,
    spec: t.spec,
    instanceId: t.instanceId,
    cellId: t.cellId,
    role: t.role,
    config: t.config,
    replicate: t.replicate,
    state: t.state,
  });

  // Repair feedback comes only from the OWNED invalid first attempt in the ledger, never from the body.
  let repair: RepairFeedback | null = null;
  if (t.attemptNo === 2 && t.repairOf !== null) {
    let parent: LedgerRow | null;
    try {
      parent = await deps.loadCall(owner, t.repairOf);
    } catch {
      return { status: 503, body: errorBody("platform_configuration", "The model-call ledger could not be read. No provider call was made.") };
    }
    const cached = parent && isRecord(parent.response_json) ? parent.response_json : null;
    if (
      !parent
      || parent.owner_id.toLowerCase() !== owner
      || parent.id.toLowerCase() !== t.repairOf
      || parent.attempt_no !== 1
      || parent.status !== "invalid_action"
      || parent.turn_key !== turnKey
      || !cached
      || typeof cached.content !== "string"
      || typeof cached.validationError !== "string"
    ) {
      return { status: 409, body: errorBody("conflict", "repairOf must be your own invalid first attempt of this same turn.", { modelCallId: null }) };
    }
    repair = { priorOutput: cached.content, validationError: cached.validationError };
  }

  const built = buildRoleRequest({
    scenario: t.scenario,
    state: t.state,
    role: t.role,
    params: { model: t.config.model, promptVariant: t.config.promptVariant, temperature: t.config.temperature, maxOutputTokens: t.config.maxOutputTokens },
    repair,
  });
  if (!built.ok) return { status: 400, body: errorBody("request_too_large", built.error) };
  const request = built.built.request;
  const requestDigest = built.built.requestDigest;

  let claim: ClaimResult;
  try {
    claim = await deps.claim({
      owner,
      operationId: t.operationId,
      turnKey,
      attemptNo: t.attemptNo,
      requestDigest,
      modelConfig: t.config,
      selectedModel: t.config.model,
      reservedOutput: t.config.maxOutputTokens,
      repairOf: t.repairOf,
    });
  } catch {
    return { status: 503, body: errorBody("platform_configuration", "The quota claim could not be completed. No provider call was made.") };
  }

  switch (claim.disposition) {
    case "quota_exhausted":
      return { status: 429, body: errorBody("daily_turn_limit", `The daily model-attempt limit is ${DAILY_TURN_LIMIT}. Scripted and fixture pairings do not use it.`) };
    case "conflict":
      return { status: 409, body: errorBody("conflict", conflictMessage(claim.reason)) };
    case "existing_pending":
      return { status: 202, body: errorBody("pending", "A matching request is already in flight. It was not dispatched again.", { disposition: "existing_pending", modelCallId: claim.modelCallId }) };
    case "existing_uncertain":
      return { status: 502, body: uncertainReplay(claim.modelCallId, claim.response) };
    case "existing_finished":
      return cachedOutcome(claim.modelCallId, claim.status, claim.response);
    case "acquired_new":
      return dispatch(deps, owner, t, endpoint, settings.apiKey, request, requestDigest, built.built.templateDigest, claim.modelCallId, claim.turnCount);
    default:
      return { status: 503, body: errorBody("platform_configuration", "The quota claim returned an unknown disposition. No provider call was made.") };
  }
}

function conflictMessage(reason: string): string {
  switch (reason) {
    case "operation_mismatch":
      return "This operationId was already used with a different request, turn or config.";
    case "turn_already_claimed":
      return "This turn's attempt number was already claimed under another operationId.";
    case "repair_parent":
      return "repairOf must be your own invalid first attempt of this same turn.";
    default:
      return "The request conflicts with an existing model call.";
  }
}

function uncertainReplay(modelCallId: string, cached: unknown): ErrorResponse {
  const category = isRecord(cached) && typeof cached.category === "string" && isCategory(cached.category) ? cached.category : undefined;
  return errorBody("provider_error", "An earlier dispatch of this request has an unknown result. It was not dispatched again; recover explicitly.", {
    disposition: "existing_uncertain",
    modelCallId,
    ...(category ? { category } : {}),
    upstreamStatus: null,
    uncertain: true,
  });
}

const CATEGORIES: readonly ProviderCategory[] = ["authentication", "model_not_found", "rate_limited", "context_too_long", "timeout", "malformed_response", "server", "generic_upstream"];
function isCategory(value: string): value is ProviderCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

function cachedOutcome(modelCallId: string, status: string, cached: unknown): Outcome {
  if (!isRecord(cached) || cached.contractVersion !== LIVE_CONTRACT_VERSION) {
    return { status: 502, body: uncertainReplay(modelCallId, null) };
  }
  if (status === "completed" || status === "invalid_action") {
    const response = { ...(cached as unknown as TurnResponse), disposition: "existing_finished" as const };
    return { status: 200, body: response };
  }
  // status error: replay the stored safe error body.
  const stored = cached as unknown as ErrorResponse;
  const disposition: Disposition = "existing_finished";
  return { status: 502, body: { ...stored, disposition, modelCallId } };
}

async function dispatch(
  deps: HandlerDeps,
  owner: string,
  t: ValidTurn,
  endpoint: string,
  apiKey: string,
  request: CanonicalRequest,
  requestDigest: string,
  templateDigest: string,
  modelCallId: string,
  turnCount: number,
): Promise<Outcome> {
  const remainingToday = Math.max(0, DAILY_TURN_LIMIT - turnCount);
  const started = deps.now();
  const outcome = await callProvider(deps, endpoint, apiKey, request);
  const latencyMs = Math.max(0, Math.round(deps.now() - started));

  if (outcome.kind === "error") {
    const body = errorBody(
      "provider_error",
      outcome.uncertain
        ? "The provider request was sent but its result is unknown. It is recorded as uncertain and is not retried."
        : `The provider returned a ${outcome.category} error.`,
      { disposition: "acquired_new", modelCallId, category: outcome.category, upstreamStatus: outcome.upstreamStatus, uncertain: outcome.uncertain },
    );
    await safeFinish(deps, {
      owner,
      id: modelCallId,
      status: outcome.uncertain ? "uncertain" : "error",
      verdict: null,
      errorCategory: outcome.category,
      response: body,
      outputDigest: null,
      providerModel: null,
      usage: null,
      latencyMs,
    });
    return { status: 502, body };
  }

  // Strict parse + referee BEFORE storing a reusable result.
  const bounded = boundRaw(outcome.content);
  const judged = bounded.tooLong
    ? { ok: false as const, error: RAW_TOO_LONG_ERROR }
    : judgeAttempt(t.scenario, t.state, t.role, bounded.raw);
  const verdict: "legal" | "invalid" = judged.ok ? "legal" : "invalid";
  const outputDigest = sha256Hex(bounded.raw);
  const response: TurnResponse = {
    contractVersion: LIVE_CONTRACT_VERSION,
    disposition: "acquired_new",
    modelCallId,
    operationId: t.operationId,
    requestDigest,
    templateDigest,
    selectedModel: t.config.model,
    providerModel: outcome.providerModel,
    content: bounded.raw,
    outputDigest,
    verdict,
    validationError: judged.ok ? null : judged.error,
    usage: outcome.usage,
    latencyMs,
    remainingToday,
  };
  const stored = await safeFinish(deps, {
    owner,
    id: modelCallId,
    status: judged.ok ? "completed" : "invalid_action",
    verdict,
    errorCategory: null,
    response,
    outputDigest,
    providerModel: outcome.providerModel,
    usage: outcome.usage,
    latencyMs,
  });
  if (!stored) {
    // The answer exists but the ledger did not record it: a repair could not reference it and a
    // duplicate would stay pending, so do not present it as a reusable result.
    return {
      status: 503,
      body: errorBody("platform_configuration", "The model answered but the ledger could not record the result. The call is pending; recover explicitly.", {
        disposition: "acquired_new",
        modelCallId,
        uncertain: true,
      }),
    };
  }
  return { status: 200, body: response };
}

async function safeFinish(deps: HandlerDeps, args: FinishArgs): Promise<boolean> {
  try {
    return (await deps.finish(args)) === true;
  } catch {
    return false;
  }
}
