import type { RunSpec } from "./runspec.ts";
import type { PublicTurn, Role } from "./types.ts";

/**
 * Wire contract between the browser (src/lib/modelTurn.ts) and supabase/functions/negotiate-turn.
 * negotiate-turn is the sole model endpoint. Seam owner: S16-INT. Both sides import these types.
 *
 * Every request needs a user JWT (gateway verify_jwt plus handler auth.getUser). The verified owner
 * comes only from auth.getUser, never from this body.
 */

export const LIVE_CONTRACT_VERSION = "nsb-live-v1";

/** Safe preflight: no secrets, no cards. */
export type ConfigRequest = { op: "config" };

export type ConfigResponse = {
  contractVersion: typeof LIVE_CONTRACT_VERSION;
  liveEnabled: boolean;
  /** Actionable reason when Live is disabled (missing LLM_API_KEY, empty allowlist, bad host ...). */
  disabledReason: string | null;
  allowedModels: string[];
  defaultModel: string | null;
  dailyLimit: number;
  usedToday: number | null;
  remainingToday: number | null;
  limits: { maxOutputTokens: number; maxRequestBytes: number; providerTimeoutMs: number };
};

/**
 * One model attempt for one legal turn. The function re-validates the spec, re-instantiates the
 * instance, replays the legal history, checks the cell/role config is a model seat with an allowlisted
 * model, refuses terminal/capped/illegal histories, builds the canonical request with
 * buildRoleRequest (repair feedback is read from the server ledger, not from this body), then claims.
 */
export type TurnRequest = {
  op: "turn";
  runSpec: RunSpec;
  executionId: string;
  cellId: string;
  instanceSeed: number;
  replicate: number;
  role: Role;
  /** Compact legal public history only; never raw invalid attempts. */
  legalHistory: PublicTurn[];
  attemptNo: 1 | 2;
  /** Client-generated UUID; idempotency key for this exact request. */
  operationId: string;
  /** For attemptNo 2: the model_calls id of the OWNED invalid first attempt of the same turn. */
  repairOf: string | null;
};

export type Disposition = "acquired_new" | "existing_pending" | "existing_finished" | "existing_uncertain";

/** 200: the attempt finished (now or earlier). The verdict is the server's strict parse + referee result. */
export type TurnResponse = {
  contractVersion: typeof LIVE_CONTRACT_VERSION;
  disposition: "acquired_new" | "existing_finished";
  modelCallId: string;
  operationId: string;
  requestDigest: string;
  templateDigest: string;
  selectedModel: string;
  providerModel: string | null;
  /** Bounded raw public action output (<= 8 KiB). */
  content: string;
  outputDigest: string;
  verdict: "legal" | "invalid";
  validationError: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
  remainingToday: number | null;
};

export type ProviderCategory =
  | "authentication"
  | "model_not_found"
  | "rate_limited"
  | "context_too_long"
  | "timeout"
  | "malformed_response"
  | "server"
  | "generic_upstream";

/**
 * Error body for every non-200 status. Never echoes provider message/code text, tokens or keys.
 *  400 bad_request | bad_spec | bad_history | illegal_turn | terminal | not_model_seat | model_not_allowed | request_too_large
 *  401 unauthorized
 *  202 pending (existing_pending: a matching request is in flight; no dispatch)
 *  409 conflict (same operation id with a different digest/turn/config, or that turn ordinal already claimed,
 *      or a repair whose parent is not an owned invalid first attempt of the same turn)
 *  413 body_too_large
 *  429 daily_turn_limit
 *  502 provider_error (category + upstreamStatus; uncertain=true when dispatch happened but the result is unknown)
 *  503 missing_secret | live_disabled | platform_configuration (before any claim)
 */
export type ErrorResponse = {
  contractVersion: typeof LIVE_CONTRACT_VERSION;
  error: string;
  message: string;
  disposition?: Disposition;
  modelCallId?: string | null;
  category?: ProviderCategory;
  upstreamStatus?: number | null;
  uncertain?: boolean;
};
