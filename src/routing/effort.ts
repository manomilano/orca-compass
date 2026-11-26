import type { Demand, Effort, EffortPolicy } from '../types.js';

export const EFFORT_LADDER: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const rank = (e: Effort): number => EFFORT_LADDER.indexOf(e);

/** Target if supported, else the nearest lower supported effort, else the lowest higher one. */
export function snapEffort(target: Effort, supported: Effort[]): Effort | null {
  if (supported.length === 0) return null;
  if (supported.includes(target)) return target;
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  const lower = sorted.filter((e) => rank(e) < rank(target));
  if (lower.length > 0) return lower[lower.length - 1];
  return sorted[0];
}

/**
 * Effort per effort demand. A starting heuristic, not a measured optimum: `balanced` gives each demand its
 * own effort, low to xhigh; `quality` also gives high work xhigh; `efficient` saves effort on moderate and high
 * work and keeps exceptional work at high. Nothing maps to max; that takes an explicit --effort.
 */
export const DEMAND_EFFORT: Record<EffortPolicy, Record<Demand, Effort>> = {
  efficient: { low: 'low', moderate: 'low', high: 'medium', exceptional: 'high' },
  balanced: { low: 'low', moderate: 'medium', high: 'high', exceptional: 'xhigh' },
  quality: { low: 'low', moderate: 'medium', high: 'xhigh', exceptional: 'xhigh' },
};

/** Accepts provider spellings such as "extra-high". "ultra" (Codex auto-delegation) is not an effort. */
export function parseEffort(s: string): Effort | undefined {
  const v = s.trim().toLowerCase();
  if (v === 'extra-high' || v === 'extra_high') return 'xhigh';
  return (EFFORT_LADDER as readonly string[]).includes(v) ? (v as Effort) : undefined;
}
