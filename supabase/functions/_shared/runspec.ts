import { CANONICAL_VERSION, digestOf, HASH_VERSION } from "./hash.ts";
import { definitionDigest, isInstanceSeed } from "./instantiate.ts";
import { isRecord, parseDefinition } from "./scenario.ts";
import type { AgentConfig, PromptVariant, Role, ScenarioDefinition, ScriptedId } from "./types.ts";
import { ENGINE_VERSION, GENERATOR_FIXED, GENERATOR_V1, LIMITS, POLICY_VERSION, PROMPT_VERSION_V2, SCORING_VERSION } from "./types.ts";
import { REQUEST_LIMITS } from "./request.ts";
import { gridCount, rulesetOf } from "./utility.ts";

export const RUN_SPEC_VERSION = 1 as const;
export const MAX_SANDBOX_MATCHES = 180;
export const MAX_REPLICATES = 5;
export const MAX_CELLS = 16;

export type CellSpec = { cellId: string; roles: Record<Role, AgentConfig> };

export type RunVersions = {
  ruleset: 1 | 2;
  engine: string;
  scoring: string;
  prompt: string;
  generator: string;
  canonical: string;
  hash: string;
};

/** Immutable experiment specification (RunSpec v1). Its canonical SHA-256 is run_spec_sha256. */
export type RunSpec = {
  runSpecVersion: typeof RUN_SPEC_VERSION;
  label: string;
  definition: ScenarioDefinition;
  definitionDigest: string;
  instanceSeeds: number[];
  replicates: number;
  cells: CellSpec[];
  versions: RunVersions;
  /** Source git SHA when actually known; null means uncommitted/unknown source. */
  gitSha: string | null;
};

export type PlannedMatch = {
  planIndex: number;
  cellId: string;
  instanceSeed: number;
  replicate: number;
};

export const SCRIPTED_POLICIES: readonly ScriptedId[] = ["concession", "firm", "bluff"];

export function scriptedConfig(policy: ScriptedId): AgentConfig {
  return { kind: "scripted", policy, policyVersion: POLICY_VERSION };
}

export function modelConfig(model: string, promptVariant: PromptVariant = "neutral", temperature = 0, maxOutputTokens: number = REQUEST_LIMITS.maxOutputTokens): AgentConfig {
  return { kind: "model", model, promptVariant, temperature, maxOutputTokens };
}

/** Stable identity of one seat configuration. Never groups live seats under a generic "model". */
export function agentKey(config: AgentConfig): string {
  if (config.kind === "scripted") return `scripted:${config.policy}@${config.policyVersion}`;
  if (config.kind === "fixture") return `fixture:${config.fixtureId}@${config.fixtureDigest.slice(0, 16)}`;
  return `model:${config.model}|${config.promptVariant}|t${config.temperature}|o${config.maxOutputTokens}`;
}

/** Aggregation identity: definition, ruleset and exact per-role configuration (incl. prompt variant). */
export function cellKey(spec: Pick<RunSpec, "definitionDigest" | "versions">, cell: CellSpec): string {
  return `${spec.definitionDigest.slice(0, 16)}|r${spec.versions.ruleset}|buyer=${agentKey(cell.roles.buyer)}|seller=${agentKey(cell.roles.seller)}`;
}

export function agentClass(cell: CellSpec): "scripted" | "synthetic" | "live" {
  const kinds = [cell.roles.buyer.kind, cell.roles.seller.kind];
  if (kinds.includes("model")) return "live";
  if (kinds.includes("fixture")) return "synthetic";
  return "scripted";
}

export function currentVersions(definition: ScenarioDefinition): RunVersions {
  const ruleset = rulesetOf(definition);
  return {
    ruleset,
    engine: ENGINE_VERSION,
    scoring: SCORING_VERSION,
    prompt: PROMPT_VERSION_V2,
    generator: ruleset === 2 ? GENERATOR_V1 : GENERATOR_FIXED,
    canonical: CANONICAL_VERSION,
    hash: HASH_VERSION,
  };
}

export function runSpecDigest(spec: RunSpec): string {
  return digestOf(spec);
}

export function buildRunSpec(input: {
  label: string;
  definition: ScenarioDefinition;
  instanceSeeds: number[];
  replicates?: number;
  cells: CellSpec[];
  gitSha?: string | null;
}): { ok: true; spec: RunSpec } | { ok: false; error: string } {
  const spec: RunSpec = {
    runSpecVersion: RUN_SPEC_VERSION,
    label: input.label.slice(0, 80),
    definition: structuredClone(input.definition),
    definitionDigest: definitionDigest(input.definition),
    instanceSeeds: [...input.instanceSeeds],
    replicates: input.replicates ?? 1,
    cells: structuredClone(input.cells),
    versions: currentVersions(input.definition),
    gitSha: input.gitSha ?? null,
  };
  const check = validateRunSpec(spec);
  return check.ok ? { ok: true, spec } : check;
}

/** Shape and identity checks for a spec read from an artifact. Does not trust its digest field. */
export function validateRunSpec(value: unknown): { ok: true; spec: RunSpec } | { ok: false; error: string } {
  if (!isRecord(value) || value.runSpecVersion !== RUN_SPEC_VERSION) return { ok: false, error: "run spec version must be 1" };
  const definition = parseDefinition(value.definition);
  if (!definition.ok) return { ok: false, error: `run spec definition: ${definition.error}` };
  if (value.definitionDigest !== definitionDigest(definition.definition)) return { ok: false, error: "run spec definition digest does not match" };
  if (!Array.isArray(value.instanceSeeds) || value.instanceSeeds.length < 1 || value.instanceSeeds.length > 20 || !value.instanceSeeds.every(isInstanceSeed)) {
    return { ok: false, error: "run spec needs 1 to 20 valid instance seeds" };
  }
  if (new Set(value.instanceSeeds).size !== value.instanceSeeds.length) return { ok: false, error: "run spec repeats an instance seed" };
  if (!Number.isInteger(value.replicates) || (value.replicates as number) < 1 || (value.replicates as number) > MAX_REPLICATES) {
    return { ok: false, error: `replicates must be 1 to ${MAX_REPLICATES}` };
  }
  if (!Array.isArray(value.cells) || value.cells.length < 1 || value.cells.length > MAX_CELLS) {
    return { ok: false, error: `run spec needs 1 to ${MAX_CELLS} cells` };
  }
  const ids = new Set<string>();
  for (const cell of value.cells) {
    if (!isRecord(cell) || typeof cell.cellId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(cell.cellId)) {
      return { ok: false, error: "cell ids must be 1 to 64 safe characters" };
    }
    if (ids.has(cell.cellId)) return { ok: false, error: `duplicate cell ${cell.cellId}` };
    ids.add(cell.cellId);
    if (!isRecord(cell.roles) || !validConfig(cell.roles.buyer) || !validConfig(cell.roles.seller)) {
      return { ok: false, error: `cell ${cell.cellId} has an invalid role configuration` };
    }
  }
  let packages = 1;
  for (const issue of definition.definition.issues) {
    packages *= issue.kind === "number" ? gridCount(issue) ?? Infinity : issue.options.length;
  }
  if (packages > LIMITS.maxPackages) {
    return { ok: false, error: `the definition grid cannot be enumerated (more than ${LIMITS.maxPackages} packages or an inexact step)` };
  }
  if (!isRecord(value.versions) || value.versions.ruleset !== rulesetOf(definition.definition)) {
    return { ok: false, error: "run spec ruleset does not match its definition" };
  }
  if (value.gitSha !== null && (typeof value.gitSha !== "string" || !/^[0-9a-f]{7,64}$/.test(value.gitSha))) {
    return { ok: false, error: "gitSha must be a hex SHA or null" };
  }
  if (typeof value.label !== "string") return { ok: false, error: "run spec label must be a string" };
  return { ok: true, spec: value as unknown as RunSpec };
}

function validConfig(value: unknown): value is AgentConfig {
  if (!isRecord(value)) return false;
  if (value.kind === "scripted") {
    return SCRIPTED_POLICIES.includes(value.policy as ScriptedId) && value.policyVersion === POLICY_VERSION && Object.keys(value).length === 3;
  }
  if (value.kind === "fixture") {
    return typeof value.fixtureId === "string" && /^[a-z0-9-]{1,64}$/.test(value.fixtureId)
      && typeof value.fixtureDigest === "string" && /^[0-9a-f]{64}$/.test(value.fixtureDigest) && Object.keys(value).length === 3;
  }
  if (value.kind === "model") {
    return typeof value.model === "string" && /^[A-Za-z0-9._:/-]{1,64}$/.test(value.model)
      && (value.promptVariant === "neutral" || value.promptVariant === "honesty-warned")
      && typeof value.temperature === "number" && value.temperature >= 0 && value.temperature <= 2
      && Number.isInteger(value.maxOutputTokens) && (value.maxOutputTokens as number) >= 1 && (value.maxOutputTokens as number) <= REQUEST_LIMITS.maxOutputTokens
      && Object.keys(value).length === 5;
  }
  return false;
}

/** The whole matrix, planned before execution: seeds outer, replicates, then cells in declared order. */
export function planMatches(spec: RunSpec): PlannedMatch[] {
  const planned: PlannedMatch[] = [];
  for (const instanceSeed of spec.instanceSeeds) {
    for (let replicate = 0; replicate < spec.replicates; replicate += 1) {
      for (const cell of spec.cells) planned.push({ planIndex: planned.length, cellId: cell.cellId, instanceSeed, replicate });
    }
  }
  return planned;
}

/**
 * Worst-case paid attempts: per match, each model seat takes exactly maxRounds legal turns within the
 * hard cap of 2*maxRounds, times 2 attempts (one repair). Model/model at maxRounds 6 => 24; one model => 12.
 * Preflight only: it is not a reservation or a dollar budget.
 */
export function worstCaseModelCalls(spec: RunSpec): number {
  const perSeat = spec.definition.rules.maxRounds * 2;
  let total = 0;
  for (const match of planMatches(spec)) {
    const cell = spec.cells.find((item) => item.cellId === match.cellId);
    if (!cell) continue;
    for (const role of ["buyer", "seller"] as const) if (cell.roles[role].kind === "model") total += perSeat;
  }
  return total;
}

/**
 * Live default: one cell, one instance, one replicate, maxRounds explicitly captured as 6 in a new
 * execution snapshot before hashing. The original definition is not altered.
 */
export function liveExecutionDefinition(definition: ScenarioDefinition, maxRounds = 6): ScenarioDefinition {
  const copy = structuredClone(definition);
  copy.rules = { ...copy.rules, maxRounds };
  if (copy.schemaVersion === 2) copy.title = `${copy.title} [live maxRounds ${maxRounds}]`.slice(0, 120);
  return copy;
}

export function findCell(spec: RunSpec, cellId: string): CellSpec | null {
  return spec.cells.find((cell) => cell.cellId === cellId) ?? null;
}
