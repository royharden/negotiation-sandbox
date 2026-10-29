import { digestOf } from "./hash.ts";
import { drawInt, instanceStreamParts, streamFromParts } from "./rng.ts";
import { isRecord, parseScenario, parseScenarioV2, variationKey } from "./scenario.ts";
import type { Instance, Scenario, ScenarioDefinition } from "./types.ts";
import { GENERATOR_FIXED, GENERATOR_V1, LIMITS } from "./types.ts";

export function isInstanceSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= LIMITS.maxSeed;
}

/** SHA-256 of the canonical definition as parsed (v1 file or v2 definition with its variation). */
export function definitionDigest(definition: ScenarioDefinition): string {
  return digestOf(definition);
}

export function instanceIdOf(generator: Instance["generator"], digest: string, scenario: Scenario): string {
  return digestOf({ generator, definitionDigest: digest, scenario });
}

/**
 * Build the full immutable instance before play.
 * v1: fixed cards, generator "fixed-v1"; the seed is only a policy seed and never relabels valuations.
 * v2: nsb-instance-v1 adds a sampled whole-unit offset per typed target (targets sorted by canonical key),
 * then re-validates the concrete scenario. Infeasible (empty-ZOPA) instances are kept as data.
 */
export function instantiate(definition: ScenarioDefinition, instanceSeed: number): { ok: true; instance: Instance } | { ok: false; error: string } {
  if (!isInstanceSeed(instanceSeed)) return { ok: false, error: `instance seed must be a whole number from 0 to ${LIMITS.maxSeed}` };
  const digest = definitionDigest(definition);

  if (definition.schemaVersion === 1) {
    const scenario = structuredClone(definition) as Scenario & { variation?: unknown };
    delete scenario.variation;
    return {
      ok: true,
      instance: { generator: GENERATOR_FIXED, definitionDigest: digest, instanceSeed, scenario, instanceId: instanceIdOf(GENERATOR_FIXED, digest, scenario) },
    };
  }

  const concrete = structuredClone(definition) as ScenarioDefinition;
  const targets = [...(concrete.variation ?? [])].sort((left, right) => compareKeys(variationKey(left), variationKey(right)));
  delete concrete.variation;
  for (const target of targets) {
    const stream = streamFromParts(instanceStreamParts(GENERATOR_V1, digest, instanceSeed, variationKey(target)));
    const offset = drawInt(stream, target.jitterMin, target.jitterMax);
    const card = concrete.parties[target.role].private;
    if (target.field === "reservation") {
      card.reservationUtility = addOffset(card.reservationUtility, offset);
      continue;
    }
    const score = target.issueId === undefined ? undefined : card.scores[target.issueId];
    if (!score) return { ok: false, error: `variation ${variationKey(target)} has no card field` };
    if (target.field === "choice-score") {
      if (score.kind !== "choice" || target.option === undefined || !Object.prototype.hasOwnProperty.call(score.options, target.option)) {
        return { ok: false, error: `variation ${variationKey(target)} has no option` };
      }
      score.options[target.option] = addOffset(score.options[target.option] ?? 0, offset);
    } else if (score.kind === "number") {
      if (target.field === "number-min-score") score.atMin = addOffset(score.atMin, offset);
      else score.atMax = addOffset(score.atMax, offset);
    } else {
      return { ok: false, error: `variation ${variationKey(target)} does not match a number score` };
    }
  }

  const recheck = parseScenarioV2(concrete as unknown as Record<string, unknown>);
  if (!recheck.ok) return { ok: false, error: `sampled instance is invalid: ${recheck.error}` };
  const scenario = recheck.value as Scenario;
  return {
    ok: true,
    instance: { generator: GENERATOR_V1, definitionDigest: digest, instanceSeed, scenario, instanceId: instanceIdOf(GENERATOR_V1, digest, scenario) },
  };
}

/** Re-validate an instance snapshot from an artifact: same definition + seed must reproduce it exactly. */
export function verifyInstance(definition: ScenarioDefinition, snapshot: unknown): { ok: true; instance: Instance } | { ok: false; error: string } {
  if (!isRecord(snapshot)) return { ok: false, error: "instance snapshot must be an object" };
  const seed = snapshot.instanceSeed;
  if (!isInstanceSeed(seed)) return { ok: false, error: "instance snapshot has no valid seed" };
  const rebuilt = instantiate(definition, seed);
  if (!rebuilt.ok) return rebuilt;
  if (digestOf(rebuilt.instance) !== digestOf(snapshot)) {
    return { ok: false, error: "instance snapshot does not match the definition and seed" };
  }
  return rebuilt;
}

/** Concrete scenario re-parse for v1 snapshots (used by legacy adapters). */
export function parseConcreteV1(value: unknown): Scenario | null {
  const parsed = parseScenario(value);
  return parsed.ok ? parsed.scenario : null;
}

function addOffset(base: number, offset: number): number {
  // Base has at most 6 decimals; offset is an integer. Round away float noise at that precision.
  return Number((base + offset).toFixed(LIMITS.maxDecimals));
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
