import { agentKey } from "../engine.ts";
import type { MatchExecution, PlayResult, Scenario, ScenarioDefinition, Scores } from "../engine.ts";
import { verifiedExecution } from "../runState.ts";
import type { RunRecord } from "../runState.ts";
import { supabase } from "./supabase.ts";

export type SavedRun = {
  id: string;
  scenarioSlug: string;
  scenario: unknown;
  seed: number;
  buyerAgent: string;
  sellerAgent: string;
  batchLabel: string | null;
  status: string;
  transcript: unknown;
  scores: Scores | null;
  promptHash: string;
  createdAt: string;
  /** v2 rows carry the canonical JSONL artifact; null for historical v1 rows. */
  artifactVersion: number | null;
  artifactJsonl: string | null;
  executionId: string | null;
};

export async function saveScenario(userId: string, scenario: Scenario | ScenarioDefinition): Promise<string | null> {
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
    .select("id, scenario_slug, scenario_document, seed, buyer_agent, seller_agent, batch_label, status, transcript, scores, prompt_hash, created_at, artifact_version, artifact_jsonl, execution_id")
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
  if (typeof row.status !== "string") return null;
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
    artifactVersion: typeof row.artifact_version === "number" ? row.artifact_version : null,
    artifactJsonl: typeof row.artifact_jsonl === "string" ? row.artifact_jsonl : null,
    executionId: typeof row.execution_id === "string" ? row.execution_id : null,
  };
}

/**
 * Save one execution as an immutable v2 row. The JSONL artifact is canonical; the legacy NOT NULL columns
 * are filled as compatibility caches and are recomputed from the artifact on every reload.
 * A save failure never discards the in-memory artifact.
 */
export async function saveExecution(userId: string, run: RunRecord, execution: MatchExecution): Promise<string | null> {
  if (!supabase) return "Saving needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.";
  if (execution.status === "not_started" || execution.status === "running") return "Only finished or stopped executions can be saved.";
  const built = verifiedExecution(run, execution);
  if ("error" in built) return built.error;
  if (!built.report.verified) return `The artifact does not verify: ${built.report.problems.join("; ")}`;
  const header = built.report.document.header;
  const footer = built.report.document.footer;
  const { error } = await supabase.from("runs").insert({
    owner_id: userId,
    scenario_slug: header.definition.id,
    scenario_document: header.instance.scenario,
    seed: header.instanceSeed,
    buyer_agent: agentKey(header.roles.buyer),
    seller_agent: agentKey(header.roles.seller),
    batch_label: run.label,
    status: execution.status,
    transcript: execution.state.history,
    scores: execution.metrics,
    prompt_hash: header.templateDigests.neutral,
    artifact_version: 2,
    artifact_jsonl: built.text,
    run_spec_sha256: header.runSpecDigest,
    definition_sha256: header.definitionDigest,
    instance_id: header.instance.instanceId,
    execution_id: header.executionId,
    cell_id: header.cellId,
    replicate: header.replicate,
    content_sha256: footer?.contentSha256 ?? built.report.recomputed.contentSha256,
  });
  if (!error) return null;
  if (error.code === "23505") return "This execution is already saved. Saved executions are immutable; run the cell again for a new execution id.";
  return error.message;
}
