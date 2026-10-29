import { canonicalJson, digestOf, sha256Hex, utf8Length } from "./hash.ts";
import { promptTemplate, roleObservation, templateDigest } from "./prompt.ts";
import type { GameState, PromptVariant, Role, Scenario } from "./types.ts";
import { PROMPT_VERSION_V2 } from "./types.ts";

/** Proposed initial bounds (PLAN 7.1). They bound request size and output allowance, not dollars. */
export const REQUEST_LIMITS = {
  maxOutputTokens: 500,
  maxRequestBytes: 24_000,
  maxRawOutputBytes: 8 * 1024,
  maxUpstreamBytes: 64 * 1024,
  maxBodyBytes: 100 * 1024,
  providerTimeoutMs: 20_000,
} as const;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The exact provider request body (OpenAI-compatible chat completions). Hashed canonically. */
export type CanonicalRequest = {
  model: string;
  temperature: number;
  max_tokens: number;
  messages: ChatMessage[];
};

export type RepairFeedback = { priorOutput: string; validationError: string };

export type BuiltRequest = {
  request: CanonicalRequest;
  requestDigest: string;
  templateDigest: string;
  promptVersion: string;
  promptVariant: PromptVariant;
  bytes: number;
};

export type ModelParams = { model: string; promptVariant: PromptVariant; temperature: number; maxOutputTokens: number };

/**
 * Build the full canonical request for one role attempt. The same function runs in the browser
 * (prompt inspection, replay) and in negotiate-turn (the server-computed digest is authoritative).
 * A repair adds only the acting role's own invalid output and its validation error.
 */
export function buildRoleRequest(input: {
  scenario: Scenario;
  state: GameState;
  role: Role;
  params: ModelParams;
  repair?: RepairFeedback | null;
}): { ok: true; built: BuiltRequest } | { ok: false; error: string } {
  let observation;
  try {
    observation = roleObservation(input.scenario, input.state, input.role);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "cannot observe this turn" };
  }
  if (!Number.isInteger(input.params.maxOutputTokens) || input.params.maxOutputTokens < 1 || input.params.maxOutputTokens > REQUEST_LIMITS.maxOutputTokens) {
    return { ok: false, error: `maxOutputTokens must be 1 to ${REQUEST_LIMITS.maxOutputTokens}` };
  }
  if (!Number.isFinite(input.params.temperature) || input.params.temperature < 0 || input.params.temperature > 2) {
    return { ok: false, error: "temperature must be from 0 to 2" };
  }
  const template = promptTemplate(input.params.promptVariant);
  const messages: ChatMessage[] = [
    { role: "system", content: template.system },
    { role: "user", content: canonicalJson(observation) },
  ];
  if (input.repair) {
    if (utf8Length(input.repair.priorOutput) > REQUEST_LIMITS.maxRawOutputBytes) {
      return { ok: false, error: "repair output is larger than the raw output bound" };
    }
    messages.push(
      { role: "assistant", content: input.repair.priorOutput },
      {
        role: "user",
        content: canonicalJson({
          validationError: input.repair.validationError,
          instruction: "Your previous reply was not a legal action. Reply again with one corrected JSON action object.",
        }),
      },
    );
  }
  const request: CanonicalRequest = {
    model: input.params.model,
    temperature: input.params.temperature,
    max_tokens: input.params.maxOutputTokens,
    messages,
  };
  const encoded = canonicalJson(request);
  const bytes = utf8Length(encoded);
  if (bytes > REQUEST_LIMITS.maxRequestBytes) {
    return { ok: false, error: `rendered request is ${bytes} bytes; the limit is ${REQUEST_LIMITS.maxRequestBytes}` };
  }
  return {
    ok: true,
    built: {
      request,
      requestDigest: sha256Hex(encoded),
      templateDigest: templateDigest(input.params.promptVariant),
      promptVersion: PROMPT_VERSION_V2,
      promptVariant: input.params.promptVariant,
      bytes,
    },
  };
}

/** Legal-prefix digest used in server turn keys: canonical legal history only. */
export function legalPrefixDigest(state: GameState): string {
  return digestOf(state.history);
}
