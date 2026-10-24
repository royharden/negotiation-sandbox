import type { AgentId, PlayResult, PublicTurn, Scenario } from "./engine.ts";
import { parseScenario } from "./engine.ts";
import type { SavedRun } from "./lib/repository.ts";

export type SessionBatch = {
  label: string;
  scenario: Scenario;
  rows: PlayResult[];
};

export function savedToBatch(run: SavedRun): { ok: true; batch: SessionBatch } | { ok: false; error: string } {
  const scenario = parseScenario(run.scenario);
  if (!scenario.ok) return scenario;
  if (!isAgent(run.buyerAgent) || !isAgent(run.sellerAgent)) {
    return { ok: false, error: "The saved run names an unknown agent." };
  }
  if (!isHistory(run.transcript)) {
    return { ok: false, error: "The saved transcript is not a list of turns." };
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
        status: run.status,
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
