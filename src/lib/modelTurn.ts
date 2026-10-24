import { ModelBlocked, ProviderFailure } from "../engine.ts";
import type { ConfigResponse, ErrorResponse, LiveCallInfo, PlannedMatch, RunSpec, Seat, TurnRequest, TurnResponse } from "../engine.ts";
import { newId } from "../runState.ts";
import { supabase } from "./supabase.ts";

/**
 * Browser side of the Live seam (contract: supabase/functions/_shared/liveContract.ts).
 * No blind retries: every attempt uses a fresh operation id exactly once, and an uncertain or pending
 * result stops the match as incomplete instead of re-sending a possibly paid request.
 */

async function requireSession(): Promise<void> {
  if (!supabase) throw new ModelBlocked("Live needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. No scripted move was substituted.");
  const session = await supabase.auth.getSession();
  if (session.error) throw new ModelBlocked(session.error.message);
  if (!session.data.session) throw new ModelBlocked("Sign in before running a Live cell. No scripted move was substituted.");
}

async function errorBody(error: unknown): Promise<{ status: number | null; body: Partial<ErrorResponse> }> {
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        return { status: context.status, body: await context.clone().json() as Partial<ErrorResponse> };
      } catch {
        return { status: context.status, body: {} };
      }
    }
  }
  return { status: null, body: { message: error instanceof Error ? error.message : "The model call failed." } };
}

/** Safe preflight: allowlisted models and today's remaining allowance. Never secrets or cards. */
export async function fetchLiveConfig(): Promise<{ ok: true; config: ConfigResponse } | { ok: false; error: string }> {
  try {
    await requireSession();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Live is unavailable." };
  }
  const invoked = await supabase!.functions.invoke("negotiate-turn", { body: { op: "config" } });
  if (invoked.error) {
    const { body } = await errorBody(invoked.error);
    return { ok: false, error: body.message ?? body.error ?? "The Live preflight failed." };
  }
  return { ok: true, config: invoked.data as ConfigResponse };
}

/** A Live seat for one planned match. The server builds and hashes the request; the browser never sees secrets. */
export function liveSeat(spec: RunSpec, planned: PlannedMatch): Seat {
  return async (context) => {
    await requireSession();
    const body: TurnRequest = {
      op: "turn",
      runSpec: spec,
      executionId: context.executionId,
      cellId: planned.cellId,
      instanceSeed: planned.instanceSeed,
      replicate: planned.replicate,
      role: context.role,
      legalHistory: context.state.history,
      attemptNo: context.attemptNo,
      operationId: newId(),
      repairOf: context.attemptNo === 2 ? context.repairOf : null,
    };
    if (body.attemptNo === 2 && !body.repairOf) {
      throw new ProviderFailure("The first attempt has no server call id, so a repair cannot be linked.", "generic_upstream");
    }
    let invoked;
    try {
      invoked = await supabase!.functions.invoke("negotiate-turn", { body });
    } catch {
      throw new ProviderFailure("The request may have reached the server; its result is unknown.", "generic_upstream", null, true);
    }
    if (invoked.error) {
      const { status, body: failure } = await errorBody(invoked.error);
      const message = failure.message ?? failure.error ?? "The model call failed.";
      if (status === 401 || status === 400 || status === 413 || status === 429 || status === 503) throw new ModelBlocked(message);
      const live: LiveCallInfo | null = failure.modelCallId
        ? { operationId: body.operationId, modelCallId: failure.modelCallId, requestDigest: null, providerModel: null, status: failure.error ?? "error", usage: null, latencyMs: null, outputDigest: null }
        : null;
      throw new ProviderFailure(message, failure.category ?? failure.error ?? "generic_upstream", live, failure.uncertain === true || status === null);
    }
    const data = invoked.data as Partial<TurnResponse> & Partial<ErrorResponse>;
    if (data.error === "pending" || data.disposition === "existing_pending") {
      throw new ProviderFailure("A matching request is still pending on the server; nothing was re-sent.", "generic_upstream", null, true);
    }
    if (typeof data.content !== "string" || typeof data.modelCallId !== "string") {
      throw new ProviderFailure("The function response was malformed.", "malformed_response", null, true);
    }
    return {
      raw: data.content,
      live: {
        operationId: body.operationId,
        modelCallId: data.modelCallId,
        requestDigest: data.requestDigest ?? null,
        providerModel: data.providerModel ?? null,
        status: data.disposition ?? "acquired_new",
        usage: data.usage ?? null,
        latencyMs: data.latencyMs ?? null,
        outputDigest: data.outputDigest ?? null,
      },
    };
  };
}
