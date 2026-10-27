/** Percent of a window at full quota. */
const FULL = 100;

/** Bar colour by percent left: red when empty, amber halfway, green when full. Theme colours, so every palette applies. */
const STOPS = [
  { left: 0, color: 'var(--color-red)' },
  { left: FULL / 2, color: 'var(--color-amber)' },
  { left: FULL, color: 'var(--color-green)' },
] as const;

/** True when a window has nothing left: the proxy rejected it, or it is fully used. */
export const isExhausted = (usedPercent: number | null, rejected: boolean) => rejected || (usedPercent !== null && usedPercent >= FULL);

/** CSS colour for a limit bar, blended linearly between the two stops around its percent left. */
export function quotaColor(usedPercent: number | null, rejected: boolean): string {
  const left = isExhausted(usedPercent, rejected) ? 0 : Math.min(FULL, Math.max(0, FULL - (usedPercent ?? 0)));
  let from: (typeof STOPS)[number] = STOPS[0];
  if (left <= from.left) return from.color;
  for (const to of STOPS.slice(1)) {
    if (left <= to.left) {
      const toShare = Math.round(((left - from.left) / (to.left - from.left)) * FULL);
      return `color-mix(in oklch, ${to.color} ${toShare}%, ${from.color})`;
    }
    from = to;
  }
  return from.color;
}
