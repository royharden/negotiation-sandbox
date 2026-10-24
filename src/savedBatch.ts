import type { AgentId, PlayResult, PublicTurn, Scenario } from "./engine.ts";
import { parseScenario, replay } from "./engine.ts";
import type { SavedRun } from "./lib/repository.ts";

export type SessionBatch = {
  label: string;
  scenario: Scenario;
  rows: PlayResult[];
};

/** Dedicated read-only adapter for historical v1 rows; it never rewrites them as v2. */
export function savedToBatch(run: SavedRun): { ok: true; batch: SessionBatch } | { ok: false; error: string } {
  if (run.artifactVersion !== null) return { ok: false, error: "This row is a v2 artifact; open it through artifact verification." };
  if (run.status !== "complete" && run.status !== "format_failure") return { ok: false, error: `Legacy rows are complete or format_failure, not ${run.status}.` };
  const scenario = parseScenario(run.scenario);
  if (!scenario.ok) return scenario;
  if (!isAgent(run.buyerAgent) || !isAgent(run.sellerAgent)) {
    return { ok: false, error: "The saved run names an unknown agent." };
  }
  if (!isHistory(run.transcript)) {
    return { ok: false, error: "The saved transcript is not a list of turns." };
  }
  // A completed legacy record must replay to a terminal state (accept, walk, or a full cap-length history).
  const replayed = replay(scenario.scenario, run.transcript);
  if (!replayed.ok) return { ok: false, error: `The saved legacy history does not replay: ${replayed.error}` };
  if (run.status === "complete" && !replayed.state.terminal) {
    return { ok: false, error: "The saved row says complete, but its history is an unfinished prefix." };
  }
  return {
    ok: true,
    batch: {
      label: run.batchLabel ?? run.scenarioSlug,
      scenario: scenario.scenario,
      rows: [{
        seed: run.seed,
        buyerAgent: run.buyerAgent,
        sellerAgent: run.sellerAgent,
        status: run.status as "complete" | "format_failure",
        history: run.transcript,
        scores: run.scores,
        promptHash: run.promptHash,
      }],
    },
  };
}

function isAgent(value: string): value is AgentId {
  return value === "concession" || value === "firm" || value === "bluff" || value === "model";
}

function isHistory(value: unknown): value is PublicTurn[] {
  if (!Array.isArray(value)) return false;
  return value.every((turn) => {
    if (!turn || typeof turn !== "object") return false;
    const row = turn as { role?: unknown; action?: unknown };
    return (row.role === "buyer" || row.role === "seller") && !!row.action && typeof row.action === "object";
  });
}
