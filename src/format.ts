export function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function pairingLabel(buyer: string, seller: string): string {
  return `${buyer} vs ${seller}`;
}
