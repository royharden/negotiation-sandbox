import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { buildModelPrompt } from "../_shared/prompt.ts";
import { parseAction } from "../_shared/referee.ts";
import { isRecord, parseScenario } from "../_shared/scenario.ts";
import type { PublicTurn } from "../_shared/types.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "Use POST." });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 100_000) {
    return json(413, { error: "body_too_large", message: "The turn request is larger than 100000 bytes." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "unauthorized", message: "Sign in. The function requires a user JWT." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) {
    return json(500, {
      error: "platform_configuration",
      message: "The function is missing SUPABASE_URL or SUPABASE_ANON_KEY.",
    });
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authHeader.slice(7).trim();
  const userResult = await supabase.auth.getUser(token);
  if (userResult.error || !userResult.data.user) {
    return json(401, { error: "unauthorized", message: "The session is missing or expired." });
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 100_000) {
      return json(413, { error: "body_too_large", message: "The turn request is larger than 100000 bytes." });
    }
    body = JSON.parse(text) as unknown;
  } catch {
    return json(400, { error: "bad_json", message: "The request body is not JSON." });
  }
  if (!isRecord(body)) {
    return json(400, { error: "bad_request", message: "The request body must be an object." });
  }

  const scenarioResult = parseScenario(body.scenario);
  if (!scenarioResult.ok) {
    return json(400, { error: "bad_scenario", message: scenarioResult.error });
  }
  if (body.role !== "buyer" && body.role !== "seller") {
    return json(400, { error: "bad_role", message: "role must be buyer or seller." });
  }
  if (!isSeed(body.seed)) {
    return json(400, { error: "bad_seed", message: "seed must be a whole number from 0 through 1000000000." });
  }
  const history = parseHistory(body.history);
  if (!history.ok) return json(400, { error: "bad_history", message: history.error });

  const apiKey = (Deno.env.get("LLM_API_KEY") ?? "").trim();
  if (!apiKey) {
    return json(503, {
      error: "missing_secret",
      message: "Set LLM_API_KEY in server secrets. Scripted pairings run without it.",
    });
  }

  let endpoint: URL;
  try {
    const base = (Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1").trim();
    endpoint = new URL("chat/completions", base.endsWith("/") ? base : `${base}/`);
    assertPublicHttps(endpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM_BASE_URL is not usable.";
    return json(400, { error: "bad_model_url", message });
  }

  const model = cleanModel(body.model) ?? cleanModel(Deno.env.get("LLM_MODEL") ?? "") ?? "gpt-4o-mini";
  const prompt = buildModelPrompt({
    scenario: scenarioResult.scenario,
    role: body.role,
    history: history.history,
    seed: body.seed,
  });
  if (!prompt.ok) return json(400, { error: "illegal_history", message: prompt.error });

  const reserved = await supabase.rpc("reserve_llm_turn");
  if (reserved.error || typeof reserved.data !== "number") {
    const detail = reserved.error?.message ?? "";
    if (detail.includes("daily_turn_limit")) {
      return json(429, {
        error: "daily_turn_limit",
        message: "The daily model-turn limit is 40. Scripted pairings do not use it.",
      });
    }
    if (detail.includes("not_authenticated")) {
      return json(401, { error: "unauthorized", message: "Sign in again. The turn reserve did not see a user." });
    }
    return json(500, { error: "quota_failed", message: "Could not reserve a model turn." });
  }

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    });
  } catch {
    return json(502, { error: "upstream_failed", message: "The model endpoint did not answer in time." });
  }

  if (!upstream.ok) {
    const snippet = await safeSnippet(upstream, apiKey);
    return json(502, {
      error: "upstream_failed",
      message: `The model endpoint returned ${upstream.status}. ${snippet}`.trim(),
    });
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return json(502, { error: "upstream_failed", message: "The model endpoint did not return JSON." });
  }
  const content = readContent(payload);
  if (!content) {
    return json(502, { error: "empty_model_output", message: "The model returned no text. No action was invented." });
  }

  return json(200, {
    content,
    model,
    turnCount: reserved.data,
    promptHash: prompt.promptHash,
  });
});

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

function isSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function cleanModel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : null;
}

function parseHistory(value: unknown): { ok: true; history: PublicTurn[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "history must be an array" };
  if (value.length > 40) return { ok: false, error: "history is longer than 40 turns" };
  const history: PublicTurn[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, error: "history turn must be an object" };
    if (item.role !== "buyer" && item.role !== "seller") return { ok: false, error: "history role is invalid" };
    const action = parseAction(item.action);
    if (!action.ok) return action;
    history.push({ role: item.role, action: action.action });
  }
  return { ok: true, history };
}

function assertPublicHttps(url: URL): void {
  if (url.protocol !== "https:") throw new Error("LLM_BASE_URL must use https.");
  if (url.username || url.password) throw new Error("LLM_BASE_URL must not include credentials.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost"
    || host.endsWith(".local")
    || host.endsWith(".localhost")
    || host === "metadata.google.internal"
  ) {
    throw new Error("LLM_BASE_URL must be a public https host.");
  }
  if (host.includes(":")) {
    const simple = host.split("%")[0] ?? host;
    if (simple === "::1" || simple.startsWith("fc") || simple.startsWith("fd") || simple.startsWith("fe80")) {
      throw new Error("LLM_BASE_URL must be a public https host.");
    }
    return;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) throw new Error("LLM_BASE_URL host is not a valid address.");
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const blocked = a === 10 || a === 127 || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
  if (blocked) throw new Error("LLM_BASE_URL must be a public https host.");
}

function readContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return "";
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return "";
  const content = first.message.content;
  return typeof content === "string" ? content.trim() : "";
}

async function safeSnippet(response: Response, secret: string): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 240);
    if (secret && text.includes(secret)) return "The upstream error was omitted.";
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

