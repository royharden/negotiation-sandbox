import type { Instance, Role, Scenario, Terms } from "./types.ts";
import { LIMITS, V2_TOLERANCE } from "./types.ts";
import { gridValues, noDealUtility, roleUtility, rulesetOf } from "./utility.ts";

export type GridPackage = { terms: Terms; buyer: number; seller: number };

/**
 * Exact operator analysis over every legal package (<= 20,000). Gains use the role's no-deal baseline
 * (v2: sampled reservation; v1: reservation threshold, see legacy note in score.ts).
 */
export type GridAnalysis = {
  packageCount: number;
  packages: GridPackage[];
  /** No package is individually rational for both roles. */
  zopaEmpty: boolean;
  /** Max sum of gains over IR-for-both packages; null when there is none. */
  maxJointGain: number | null;
};

const cache = new Map<string, GridAnalysis>();
const CACHE_LIMIT = 64;

export function enumeratePackages(scenario: Scenario): GridPackage[] {
  let rows: Terms[] = [{}];
  for (const issue of scenario.issues) {
    const values: Array<number | string> = issue.kind === "number" ? gridValues(issue) : [...issue.options];
    const next: Terms[] = [];
    for (const row of rows) {
      for (const value of values) {
        const terms: Terms = { ...row };
        Object.defineProperty(terms, issue.id, { value, enumerable: true, writable: true, configurable: true });
        next.push(terms);
      }
    }
    if (next.length > LIMITS.maxPackages) throw new Error(`grid exceeds ${LIMITS.maxPackages} packages`);
    rows = next;
  }
  return rows.map((terms) => ({ terms, buyer: roleUtility(scenario, "buyer", terms), seller: roleUtility(scenario, "seller", terms) }));
}

export function tolerance(scenario: Scenario): number {
  return rulesetOf(scenario) === 2 ? V2_TOLERANCE : 1e-9;
}

/** IR threshold: the reservation utility in both rulesets. */
export function reservationOf(scenario: Scenario, role: Role): number {
  return scenario.parties[role].private.reservationUtility;
}

export function analyzeGrid(scenario: Scenario, cacheKey?: string): GridAnalysis {
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  const packages = enumeratePackages(scenario);
  const tol = tolerance(scenario);
  const buyerBase = reservationOf(scenario, "buyer");
  const sellerBase = reservationOf(scenario, "seller");
  let maxJointGain: number | null = null;
  for (const item of packages) {
    const gb = item.buyer - buyerBase;
    const gs = item.seller - sellerBase;
    if (gb >= -tol && gs >= -tol) {
      const joint = gb + gs;
      if (maxJointGain === null || joint > maxJointGain) maxJointGain = joint;
    }
  }
  const analysis: GridAnalysis = { packageCount: packages.length, packages, zopaEmpty: maxJointGain === null, maxJointGain };
  if (cacheKey) {
    if (cache.size >= CACHE_LIMIT) {
      const first = cache.keys().next();
      if (!first.done) cache.delete(first.value);
    }
    cache.set(cacheKey, analysis);
  }
  return analysis;
}

export function analyzeInstance(instance: Instance): GridAnalysis {
  return analyzeGrid(instance.scenario, instance.instanceId);
}

/**
 * Another legal package (IR or not) weakly improves both role utilities within tolerance
 * and strictly improves at least one beyond tolerance.
 */
export function isParetoDominated(analysis: GridAnalysis, buyer: number, seller: number, tol: number): boolean {
  return analysis.packages.some((item) =>
    item.buyer >= buyer - tol
    && item.seller >= seller - tol
    && (item.buyer > buyer + tol || item.seller > seller + tol));
}

export { noDealUtility };
