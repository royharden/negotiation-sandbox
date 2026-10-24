export function parseSeeds(text: string): { ok: true; seeds: number[] } | { ok: false; error: string } {
  const parts = text.split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, error: "Enter at least one seed." };
  if (parts.length > 20) return { ok: false, error: "Use at most 20 seeds in one batch." };
  const seeds: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { ok: false, error: `Seed "${part}" is not a whole number.` };
    const value = Number(part);
    if (value > 1_000_000_000) return { ok: false, error: "Seeds must be at most 1000000000." };
    seeds.push(value);
  }
  return { ok: true, seeds };
}
