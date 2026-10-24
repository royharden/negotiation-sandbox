import assert from "node:assert/strict";
import test from "node:test";
import { parseSeeds } from "../src/seeds.ts";

test("seed text accepts a short list and rejects junk", () => {
  const parsed = parseSeeds("1, 2 3");
  assert.deepEqual(parsed, { ok: true, seeds: [1, 2, 3] });
  assert.equal(parseSeeds("").ok, false);
  assert.equal(parseSeeds("1, two").ok, false);
  assert.equal(parseSeeds(Array.from({ length: 21 }, (_, index) => String(index)).join(",")).ok, false);
});
