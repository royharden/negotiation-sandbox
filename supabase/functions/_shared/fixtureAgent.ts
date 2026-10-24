import { canonicalJson, digestOf } from "./hash.ts";
import { isRecord } from "./scenario.ts";
import type { AgentConfig, Role, ScenarioDefinition } from "./types.ts";
import { MAX_ATTEMPTS_PER_TURN } from "./types.ts";

/**
 * Hand-authored synthetic attempt list (NOT recorded LLM output). Every attempt goes through the same
 * strict parser and referee. Selectable only in its declared compatible cell; any other path yields
 * fixture_not_applicable with no fabricated continuation.
 */
export type FixtureStep = {
  legalTurn: number;
  attemptNo: 1 | 2;
  /** Legal-prefix precondition: who holds the standing offer before this attempt (null = none). */
  expectStandingRole: Role | null;
  raw: string;
};

export type SyntheticFixture = {
  fixtureVersion: 1;
  id: string;
  label: string;
  compatible: {
    definitionId: string;
    schemaVersion: 1 | 2;
    instanceSeeds: number[];
    role: Role;
    opponent: AgentConfig;
  };
  steps: FixtureStep[];
};

export class FixtureNotApplicable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureNotApplicable";
  }
}

export function fixtureDigest(fixture: SyntheticFixture): string {
  return digestOf(fixture);
}

export function parseFixture(value: unknown): { ok: true; fixture: SyntheticFixture } | { ok: false; error: string } {
  if (!isRecord(value) || value.fixtureVersion !== 1) return { ok: false, error: "fixtureVersion must be 1" };
  if (typeof value.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.id)) return { ok: false, error: "fixture id must be a slug" };
  if (typeof value.label !== "string" || value.label.length > 200) return { ok: false, error: "fixture label must be text" };
  const compatible = value.compatible;
  if (!isRecord(compatible) || typeof compatible.definitionId !== "string"
    || (compatible.schemaVersion !== 1 && compatible.schemaVersion !== 2)
    || !Array.isArray(compatible.instanceSeeds) || !compatible.instanceSeeds.every((seed) => Number.isInteger(seed))
    || (compatible.role !== "buyer" && compatible.role !== "seller") || !isRecord(compatible.opponent)) {
    return { ok: false, error: "fixture compatibility block is invalid" };
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 80) return { ok: false, error: "fixture needs 1 to 80 steps" };
  let previous: { legalTurn: number; attemptNo: number } | null = null;
  for (const step of value.steps) {
    if (!isRecord(step) || !Number.isInteger(step.legalTurn) || (step.attemptNo !== 1 && step.attemptNo !== 2)
      || (step.expectStandingRole !== null && step.expectStandingRole !== "buyer" && step.expectStandingRole !== "seller")
      || typeof step.raw !== "string" || step.raw.length > 8192) {
      return { ok: false, error: "fixture step is invalid" };
    }
    const turn = step.legalTurn as number;
    const attempt = step.attemptNo as number;
    if (attempt > MAX_ATTEMPTS_PER_TURN) return { ok: false, error: "fixture step exceeds the repair limit" };
    if (previous && (turn < previous.legalTurn || (turn === previous.legalTurn && attempt !== previous.attemptNo + 1))) {
      return { ok: false, error: "fixture steps must be ordered by legal turn and attempt" };
    }
    if (attempt === 2 && (!previous || previous.legalTurn !== turn)) return { ok: false, error: "a repair step must follow its first attempt" };
    previous = { legalTurn: turn, attemptNo: attempt };
  }
  return { ok: true, fixture: value as unknown as SyntheticFixture };
}

export function fixtureConfig(fixture: SyntheticFixture): AgentConfig {
  return { kind: "fixture", fixtureId: fixture.id, fixtureDigest: fixtureDigest(fixture) };
}

/** Declared-cell compatibility check used before a fixture seat can be selected. */
export function fixtureCompatible(fixture: SyntheticFixture, definition: ScenarioDefinition, instanceSeed: number, role: Role, opponent: AgentConfig): boolean {
  return definition.id === fixture.compatible.definitionId
    && definition.schemaVersion === fixture.compatible.schemaVersion
    && fixture.compatible.instanceSeeds.includes(instanceSeed)
    && role === fixture.compatible.role
    && canonicalJson(opponent) === canonicalJson(fixture.compatible.opponent);
}

/** Fresh cursor per match. Returns the next authored raw output or throws FixtureNotApplicable. */
export function createFixtureCursor(fixture: SyntheticFixture): (at: { legalTurn: number; attemptNo: 1 | 2; standingRole: Role | null }) => string {
  let cursor = 0;
  return (at) => {
    const step = fixture.steps[cursor];
    if (!step) throw new FixtureNotApplicable(`fixture ${fixture.id} has no authored attempt for legal turn ${at.legalTurn}`);
    if (step.legalTurn !== at.legalTurn || step.attemptNo !== at.attemptNo || step.expectStandingRole !== at.standingRole) {
      throw new FixtureNotApplicable(
        `fixture ${fixture.id} expected legal turn ${step.legalTurn} attempt ${step.attemptNo} with standing ${step.expectStandingRole ?? "none"}; `
        + `the match is at legal turn ${at.legalTurn} attempt ${at.attemptNo} with standing ${at.standingRole ?? "none"}`,
      );
    }
    cursor += 1;
    return step.raw;
  };
}
