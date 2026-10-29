import { fnv1a32, utf8 } from "./hash.ts";

/**
 * Field streams for sampler nsb-instance-v1 and scripted policy seeds.
 *
 * Stream encoding (exact, versioned): the UTF-8 bytes of the parts joined with "\n" (U+000A).
 * Initial state = FNV-1a 32-bit of those bytes; a zero state is replaced by 0x6d2b79f5.
 * Each draw first advances unsigned xorshift32 (x ^= x << 13; x ^= x >>> 17; x ^= x << 5) and
 * returns the new state. Changing any of this requires a new generator/policy version.
 */
export const ZERO_STATE_REPLACEMENT = 0x6d2b79f5;

export type Stream = { next: () => number };

export function streamFromParts(parts: readonly string[]): Stream {
  let state = fnv1a32(utf8(parts.join("\n")));
  if (state === 0) state = ZERO_STATE_REPLACEMENT;
  return {
    next() {
      state = xorshift32(state);
      return state;
    },
  };
}

export function xorshift32(state: number): number {
  let x = state >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Uniform integer in [low, high] by rejection sampling (no modulo bias). */
export function drawInt(stream: Stream, low: number, high: number): number {
  if (!Number.isInteger(low) || !Number.isInteger(high) || high < low) throw new Error("drawInt needs integer low <= high");
  const range = high - low + 1;
  if (range > 0x100000000) throw new Error("drawInt range is too large");
  if (range === 1) return low;
  const limit = Math.floor(0x100000000 / range) * range;
  for (;;) {
    const value = stream.next();
    if (value < limit) return low + (value % range);
  }
}

/** Instance field stream encoding for nsb-instance-v1. */
export function instanceStreamParts(generator: string, definitionDigest: string, instanceSeed: number, targetKey: string): string[] {
  return [generator, definitionDigest, String(instanceSeed), targetKey];
}

export const POLICY_STREAM_VERSION = "nsb-policy-seed-v1";

/**
 * Per-role scripted-policy seed, separate from the instance stream. Model attempts never consume it.
 * v1 legacy fixed instances keep the historical rule (policy seed = batch seed) so old oracles still hold.
 */
export function policySeedFor(input: {
  ruleset: 1 | 2;
  definitionDigest: string;
  instanceSeed: number;
  replicate: number;
  role: "buyer" | "seller";
}): number {
  if (input.ruleset === 1) return input.instanceSeed;
  const stream = streamFromParts([
    POLICY_STREAM_VERSION,
    input.definitionDigest,
    String(input.instanceSeed),
    String(input.replicate),
    input.role,
  ]);
  return stream.next() % 1_000_000_001;
}
