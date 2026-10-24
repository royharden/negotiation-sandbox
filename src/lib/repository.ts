import type { PlayResult, Scenario, Scores } from "../engine.ts";
import { supabase } from "./supabase.ts";

export type SavedRun = {
  id: string;
  scenarioSlug: string;
  scenario: unknown;
  seed: number;
  buyerAgent: string;
  sellerAgent: string;
  batchLabel: string | null;
  status: "complete" | "format_failure";
  transcript: unknown;
  scores: Scores | null;
  promptHash: string;
  createdAt: string;
};

export async function saveScenario(userId: string, scenario: Scenario): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.from("scenarios").insert({
    owner_id: userId,
    slug: scenario.id,
    title: scenario.title,
    document: scenario,
    visibility: "private",
  });
  if (!error) return null;
  if (error.code === "23505") return `You already saved a scenario named ${scenario.id}. ${error.message}`;
  return error.message;
}

export async function saveRuns(userId: string, scenario: Scenario, rows: PlayResult[], batchLabel: string): Promise<{ saved: number; error: string | null }> {
  if (!supabase) return { saved: 0, error: "Supabase is not configured." };
  const payload = rows.flatMap((row) => {
    if (!row.scores || row.status === "blocked") return [];
    return [{
      owner_id: userId,
      scenario_slug: scenario.id,
      scenario_document: scenario,
      seed: row.seed,
      buyer_agent: row.buyerAgent,
      seller_agent: row.sellerAgent,
      batch_label: batchLabel,
      status: row.status,
      transcript: row.history,
      scores: row.scores,
      prompt_hash: row.promptHash,
    }];
  });
  if (payload.length === 0) return { saved: 0, error: "There are no scored runs to save." };
  const { error } = await supabase.from("runs").insert(payload);
  if (error) return { saved: 0, error: error.message };
  return { saved: payload.length, error: null };
}

export async function loadRuns(): Promise<{ rows: SavedRun[]; error: string | null }> {
  if (!supabase) return { rows: [], error: "Supabase is not configured." };
  const { data, error } = await supabase
    .from("runs")
    .select("id, scenario_slug, scenario_document, seed, buyer_agent, seller_agent, batch_label, status, transcript, scores, prompt_hash, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { rows: [], error: error.message };
  const rows: SavedRun[] = [];
  for (const entry of data ?? []) {
    const row = readRun(entry);
    if (row) rows.push(row);
  }
  return { rows, error: null };
}

export async function deleteRun(id: string): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.from("runs").delete().eq("id", id);
  return error?.message ?? null;
}

function readRun(value: unknown): SavedRun | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.scenario_slug !== "string") return null;
  if (typeof row.seed !== "number" || typeof row.buyer_agent !== "string" || typeof row.seller_agent !== "string") return null;
  if (row.status !== "complete" && row.status !== "format_failure") return null;
  if (typeof row.prompt_hash !== "string" || typeof row.created_at !== "string") return null;
  const scores = row.scores && typeof row.scores === "object" ? row.scores as Scores : null;
  return {
    id: row.id,
    scenarioSlug: row.scenario_slug,
    scenario: row.scenario_document,
    seed: row.seed,
    buyerAgent: row.buyer_agent,
    sellerAgent: row.seller_agent,
    batchLabel: typeof row.batch_label === "string" ? row.batch_label : null,
    status: row.status,
    transcript: row.transcript,
    scores,
    promptHash: row.prompt_hash,
    createdAt: row.created_at,
  };
}
