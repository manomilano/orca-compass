import { AXES, type Axis } from '../evidence/snapshot.js';
import { TIERS, type Tier } from '../types.js';

/** `top` sits above `high` for the rare job only the strongest models should take; `--tier` stops at `high`. */
export type Need = 'min' | 'low' | 'mid' | 'high' | 'top';
export const NEEDS: readonly Need[] = ['min', 'low', 'mid', 'high', 'top'];
export type Needs = Record<Axis, Need>;

/** Strict CLI syntax: every axis exactly once, with no normalization hiding mistakes. */
export function parseNeeds(text: string): Needs {
  const result: Partial<Needs> = {};
  const invalid = () => new Error('--need must name all three axes, e.g. --need coding=high,agentic=mid,reasoning=low (levels: min, low, mid, high, top)');
  for (const entry of text.split(',')) {
    const parts = entry.split('=');
    const axis = parts[0] as Axis;
    const need = parts[1] as Need;
    if (parts.length !== 2 || !AXES.includes(axis) || !NEEDS.includes(need) || Object.hasOwn(result, axis)) throw invalid();
    result[axis] = need;
  }
  if (!AXES.every((axis) => result[axis] !== undefined)) throw invalid();
  return result as Needs;
}

export function needsFromTier(tier: Tier): Needs {
  const need = NEEDS[TIERS.indexOf(tier)];
  return { coding: need, agentic: need, reasoning: need };
}

export function tierOfNeeds(needs: Needs): Tier {
  return TIERS[Math.min(TIERS.length - 1, Math.max(...AXES.map((axis) => NEEDS.indexOf(needs[axis]))))];
}
