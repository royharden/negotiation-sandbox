import {
  applyAction,
  FormatFailure,
  ModelBlocked,
  parseActionJson,
  replay,
  scriptedAction,
  type Action,
  type AgentId,
  type AgentView,
  type Scenario,
  type ScriptedId,
} from "../engine.ts";
import { supabase } from "./supabase.ts";

export function modelDecide(scenario: Scenario) {
  return async (pairing: { buyer: AgentId; seller: AgentId }, view: AgentView): Promise<Action> => {
    const agent = pairing[view.role];
    if (isScripted(agent)) return scriptedAction(agent, view);
    if (!supabase) {
      throw new ModelBlocked("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before using a model.");
    }
    const session = await supabase.auth.getSession();
    if (session.error) throw new ModelBlocked(session.error.message);
    if (!session.data.session) throw new ModelBlocked("Sign in before using a model.");

    let lastError = "The model did not return a legal action.";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invoked = await supabase.functions.invoke("negotiate-turn", {
        body: { scenario, role: view.role, history: view.history, seed: view.seed },
      });
      if (invoked.error) throw new ModelBlocked(await invokeMessage(invoked.error));
      const content = readContent(invoked.data);
      if (!content) {
        lastError = "The model response did not include content.";
        continue;
      }
      const parsed = parseActionJson(content);
      if (!parsed.ok) {
        lastError = parsed.error;
        continue;
      }
      const current = replay(scenario, view.history);
      if (!current.ok) throw new FormatFailure(current.error);
      const trial = applyAction(scenario, current.state, view.role, parsed.action);
      if (!trial.ok) {
        lastError = trial.error;
        continue;
      }
      return parsed.action;
    }
    throw new FormatFailure(lastError);
  };
}

function isScripted(agent: AgentId): agent is ScriptedId {
  return agent !== "model";
}

function readContent(data: unknown): string {
  if (!data || typeof data !== "object" || !("content" in data)) return "";
  const content = (data as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

async function invokeMessage(error: unknown): Promise<string> {
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const body = await context.clone().json() as { message?: unknown; error?: unknown };
        if (typeof body.message === "string" && body.message.trim()) return body.message;
        if (typeof body.error === "string") return body.error;
      } catch {
        // The body was not JSON.
      }
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The model call failed.";
}
