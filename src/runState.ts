import { buildTranscript, encodeJsonl, fixtureSeat, resultRows, scriptedSeat, verifyTranscript } from "./engine.ts";
import type {
  AgentConfig,
  CellSpec,
  Instance,
  MatchExecution,
  PlannedMatch,
  ResultRow,
  Role,
  RunSpec,
  Seat,
  SyntheticFixture,
  VerificationReport,
} from "./engine.ts";

export type RunSource = "sandbox" | "fixture" | "live";

/** One planned matrix held in this tab. Device-local: closing the tab stops progress (no server job). */
export type RunRecord = {
  runId: string;
  label: string;
  source: RunSource;
  spec: RunSpec;
  planned: PlannedMatch[];
  executions: Array<MatchExecution & { planIndex: number }>;
  instances: Map<number, Instance>;
  fixtures: SyntheticFixture[];
  state: "running" | "done" | "cancelled";
  startedAt: string;
};

export type ImportedTranscript = { id: string; name: string; text: string; report: VerificationReport };

export function rowsOf(run: RunRecord): ResultRow[] {
  const ids = new Map<number, string>();
  for (const [seed, instance] of run.instances) ids.set(seed, instance.instanceId);
  return resultRows(run.spec, run.planned, run.executions, ids);
}

export function executionAt(run: RunRecord, planIndex: number): (MatchExecution & { planIndex: number }) | null {
  return run.executions.find((execution) => execution.planIndex === planIndex) ?? null;
}

export function transcriptText(run: RunRecord, execution: MatchExecution): string {
  const instance = run.instances.get(execution.instanceSeed);
  if (!instance) throw new Error(`instance ${execution.instanceSeed} is not loaded`);
  return encodeJsonl(buildTranscript({ spec: run.spec, instance, execution, fixtures: run.fixtures }));
}

/** Every displayed artifact goes through the same verification as an import. */
export function verifiedExecution(run: RunRecord, execution: MatchExecution): { text: string; report: VerificationReport } | { error: string } {
  try {
    const text = transcriptText(run, execution);
    const verified = verifyTranscript(text);
    return verified.ok ? { text, report: verified.report } : { error: verified.error };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "could not build the transcript" };
  }
}

/** Scripted and fixture seats are built fresh for every match; model seats come from the caller. */
export function seatFor(config: AgentConfig, fixtures: SyntheticFixture[], live: (() => Seat) | null): Seat {
  if (config.kind === "scripted") return scriptedSeat(config.policy);
  if (config.kind === "fixture") {
    const fixture = fixtures.find((item) => item.id === config.fixtureId);
    if (!fixture) throw new Error(`fixture ${config.fixtureId} is not loaded`);
    return fixtureSeat(fixture);
  }
  if (!live) throw new Error("model seats need a Live caller");
  return live();
}

export function seatsFor(cell: CellSpec, fixtures: SyntheticFixture[], live: ((role: Role) => Seat) | null): Record<Role, Seat> {
  return {
    buyer: seatFor(cell.roles.buyer, fixtures, live ? () => live("buyer") : null),
    seller: seatFor(cell.roles.seller, fixtures, live ? () => live("seller") : null),
  };
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function downloadText(name: string, text: string, type = "text/plain"): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Yield to the browser between matches so the page stays responsive and Cancel is clickable. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
