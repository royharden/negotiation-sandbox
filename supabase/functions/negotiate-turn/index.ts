/**
 * negotiate-turn Deno entry (thin). All logic lives in handler.ts so Node tests can inject fakes.
 *
 * Identity: the user's JWT is verified with an anon client carrying that user's Authorization header
 * (auth.getUser). Ledger and quota go through a SEPARATE service-role client that calls the
 * service-only SQL functions with the verified owner id. The service client never decides identity.
 *
 * Server env NAMES: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, LLM_API_KEY,
 * LLM_BASE_URL (optional), LLM_MODEL, LLM_ALLOWED_MODELS, LLM_ALLOWED_HOSTS, APP_ORIGIN.
 * Never log tokens, key values or raw upstream bodies.
 */
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.1";
import { createHandler, parseClaimResult } from "./handler.ts";
import type { ClaimArgs, ClaimResult, FinishArgs, LedgerRow } from "./handler.ts";

const env = (name: string): string | undefined => Deno.env.get(name) ?? undefined;

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let serviceClient: SupabaseClient | null = null;

function service(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = (env("SUPABASE_URL") ?? "").trim();
  const key = (env("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!url || !key) throw new Error("platform_configuration");
  serviceClient = createClient(url, key, clientOptions);
  return serviceClient;
}

async function getUser(token: string): Promise<{ id: string } | null> {
  const url = (env("SUPABASE_URL") ?? "").trim();
  const anonKey = (env("SUPABASE_ANON_KEY") ?? "").trim();
  if (!url || !anonKey) throw new Error("platform_configuration");
  const userClient = createClient(url, anonKey, { ...clientOptions, global: { headers: { Authorization: `Bearer ${token}` } } });
  const result = await userClient.auth.getUser(token);
  if (result.error || !result.data.user) return null;
  return { id: result.data.user.id };
}

async function claim(args: ClaimArgs): Promise<ClaimResult> {
  const result = await service().rpc("claim_model_attempt", {
    p_owner: args.owner,
    p_operation_id: args.operationId,
    p_turn_key: args.turnKey,
    p_attempt_no: args.attemptNo,
    p_request_digest: args.requestDigest,
    p_model_config: args.modelConfig,
    p_selected_model: args.selectedModel,
    p_reserved_output: args.reservedOutput,
    p_repair_of: args.repairOf,
  });
  if (result.error) throw new Error("claim_failed");
  const parsed = parseClaimResult(result.data);
  if (!parsed) throw new Error("claim_unreadable");
  return parsed;
}

async function finish(args: FinishArgs): Promise<boolean> {
  const result = await service().rpc("finish_model_attempt", {
    p_owner: args.owner,
    p_id: args.id,
    p_status: args.status,
    p_verdict: args.verdict,
    p_error_category: args.errorCategory,
    p_response: args.response,
    p_output_digest: args.outputDigest,
    p_provider_model: args.providerModel,
    p_usage: args.usage,
    p_latency_ms: args.latencyMs,
  });
  if (result.error) return false;
  return result.data === true;
}

async function loadCall(owner: string, id: string): Promise<LedgerRow | null> {
  const result = await service()
    .from("model_calls")
    .select("id, owner_id, attempt_no, status, turn_key, response_json")
    .eq("owner_id", owner)
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new Error("ledger_read_failed");
  return (result.data as LedgerRow | null) ?? null;
}

async function usage(owner: string): Promise<number | null> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await service()
    .from("llm_turn_usage")
    .select("turn_count")
    .eq("owner_id", owner)
    .eq("usage_day", day)
    .maybeSingle();
  if (result.error) return null;
  const row = result.data as { turn_count?: unknown } | null;
  return row && typeof row.turn_count === "number" ? row.turn_count : 0;
}

const handler = createHandler({
  env,
  getUser,
  claim,
  finish,
  loadCall,
  usage,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

Deno.serve(handler);
