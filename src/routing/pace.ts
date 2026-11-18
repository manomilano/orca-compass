import type { Risk, UsagePool } from '../types.js';

export interface PoolState {
  expired: boolean;
  blocked: boolean;
  /**
   * Share of the window's capacity expected to be left unused at reset, 0..1 (negative: on pace to run out).
   * Higher means routing work here is less likely to cost anything.
   */
  headroom: number;
  /** fraction of the window already elapsed, 0..1 */
  elapsed: number;
}

/** Below this elapsed fraction a projection is mostly noise, so usage is not extrapolated. */
export const MIN_ELAPSED_TO_PROJECT = 0.1;

/**
 * Weight, as a fraction of the window, of the even-pace assumption in the headroom estimate. Early in a
 * window there is little history, so the window is assumed to be used up evenly; the observed pace takes
 * over as the window progresses.
 */
export const EVEN_PACE_WEIGHT = 0.1;

/**
 * Expected used fraction at reset: what is used so far plus the rest of the window at the estimated pace.
 * The pace (fraction of the window's capacity per window) blends the observed pace with an even pace of 1
 * weighted as EVEN_PACE_WEIGHT of a window of history. The observed pace is measured over at least that
 * much of the window, so a burst right after a reset (some windows start on first use) is not extrapolated.
 */
export function expectedUse(used: number, elapsed: number): number {
  const observed = used / Math.max(elapsed, EVEN_PACE_WEIGHT);
  const weight = elapsed / (elapsed + EVEN_PACE_WEIGHT);
  const pace = weight * observed + (1 - weight);
  return used + pace * (1 - elapsed);
}

/**
 * Spare capacity counts in full only when it resets within this horizon. Spare capacity that resets later
 * is less urgent to use (and its forecast less certain), so it counts in proportion: half at two weeks.
 */
export const URGENCY_HORIZON_MS = 7 * 86_400_000;

/** The headroom a route ranks by: positive headroom scaled down when its reset is beyond the urgency horizon. */
export function rankHeadroom(headroom: number, resetsAt: number, now: number): number {
  const remaining = resetsAt - now;
  return headroom > 0 && remaining > URGENCY_HORIZON_MS ? headroom * (URGENCY_HORIZON_MS / remaining) : headroom;
}

export function poolState(pool: UsagePool, now: number): PoolState {
  const expired = pool.resetsAt <= now;
  const windowMs = pool.windowMinutes * 60_000;
  const elapsed = windowMs > 0 ? Math.min(1, Math.max(0, 1 - (pool.resetsAt - now) / windowMs)) : 0;
  const headroom = 1 - expectedUse(pool.usedPercent / 100, elapsed);
  const reported = pool.reportedUsedPercent ?? pool.usedPercent;
  return { expired, blocked: !expired && reported >= 100, headroom, elapsed };
}

/** Usage at the window's reset if the current pace holds: used% / elapsed fraction. */
export function projectPool(pool: UsagePool, now: number): Risk {
  const { elapsed } = poolState(pool, now);
  const tooEarly = elapsed < MIN_ELAPSED_TO_PROJECT;
  const projected = tooEarly ? pool.usedPercent : pool.usedPercent / elapsed;
  return {
    pool: pool.name,
    usedPercent: pool.usedPercent,
    elapsedPercent: Math.round(elapsed * 100),
    projectedPercent: Math.round(projected * 10) / 10,
    tooEarly,
    resetsAt: pool.resetsAt,
  };
}
