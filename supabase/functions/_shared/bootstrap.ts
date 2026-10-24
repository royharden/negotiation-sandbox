import type { AgentId, PairingSummary, PlayResult } from "./types.ts";

export function bootstrapMean(
  values: number[],
  seed: number,
  samples = 200,
): { mean: number; low: number; high: number } | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const random = mulberry32(seed >>> 0);
  const stats: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] ?? 0;
    }
    stats.push(sum / values.length);
  }
  stats.sort((left, right) => left - right);
  return { mean, low: percentile(stats, 0.025), high: percentile(stats, 0.975) };
}

export function summarizePairings(rows: PlayResult[], seed = 1): PairingSummary[] {
  const groups = new Map<string, PlayResult[]>();
  for (const row of rows) {
    const key = `${row.buyerAgent}|${row.sellerAgent}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [buyerAgent, sellerAgent] = key.split("|") as [AgentId, AgentId];
    const scored = group.filter((row) => row.status === "complete" && row.scores);
    const welfare = scored
      .map((row) => row.scores?.welfare)
      .filter((value): value is number => typeof value === "number");
    const interval = bootstrapMean(welfare, seed);
    return {
      buyerAgent,
      sellerAgent,
      played: group.length,
      agreements: scored.filter((row) => row.scores?.outcome === "agreement").length,
      disagreements: scored.filter((row) => row.scores?.outcome === "disagreement").length,
      failures: group.filter((row) => row.status === "format_failure").length,
      blocked: group.filter((row) => row.status === "blocked").length,
      meanWelfare: welfare.length ? welfare.reduce((sum, value) => sum + value, 0) / welfare.length : null,
      welfareLow: interval?.low ?? null,
      welfareHigh: interval?.high ?? null,
      buyerViolations: scored.reduce((sum, row) => sum + (row.scores?.buyer.violations ?? 0), 0),
      sellerViolations: scored.reduce((sum, row) => sum + (row.scores?.seller.violations ?? 0), 0),
    };
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  if (lower === upper) return low;
  const weight = index - lower;
  return low * (1 - weight) + high * weight;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
