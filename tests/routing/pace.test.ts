import { describe, expect, it } from 'vitest';
import { expectedUse, poolState, rankHeadroom, URGENCY_HORIZON_MS } from '../../src/routing/pace.js';
import type { UsagePool } from '../../src/types.js';

// Synthetic usage windows with a fixed clock.
const now = 1793232000000;
const fable: UsagePool = { name: 'fableWeekly', kind: 'long', usedPercent: 75, windowMinutes: 10080, resetsAt: 1793282400000 };

describe('poolState', () => {
  it('computes headroom as the share of the window expected to be left unused at reset', () => {
    // Synthetic Fable window: 75% used, 11/12 elapsed; blended pace leaves about 18%.
    expect(poolState(fable, now).headroom).toBeCloseTo(0.1803, 3);
    expect(poolState(fable, now).blocked).toBe(false);
    const codexWeekly: UsagePool = { name: 'weekly', kind: 'long', usedPercent: 20, windowMinutes: 10080, resetsAt: 1793736000000 };
    expect(poolState(codexWeekly, now).headroom).toBeCloseTo(-0.1375, 3);
  });

  it('assumes an even pace early in a window and the observed pace later', () => {
    expect(expectedUse(0, 0)).toBeCloseTo(1, 6);
    expect(expectedUse(0.1, 0.1)).toBeCloseTo(1, 6);
    expect(expectedUse(0.2, 0.5)).toBeCloseTo(0.2 + (0.3 / 0.6) * 0.5, 6);
    expect(expectedUse(0.5, 1)).toBeCloseTo(0.5, 6);
  });

  it('counts headroom beyond the urgency horizon in proportion, never negative headroom', () => {
    expect(rankHeadroom(0.6, now + URGENCY_HORIZON_MS, now)).toBeCloseTo(0.6, 6);
    expect(rankHeadroom(0.6, now + 2 * URGENCY_HORIZON_MS, now)).toBeCloseTo(0.3, 6);
    expect(rankHeadroom(-0.2, now + 3 * URGENCY_HORIZON_MS, now)).toBeCloseTo(-0.2, 6);
  });

  it('blocks both pool kinds only at actual exhaustion', () => {
    expect(poolState({ ...fable, usedPercent: 99.99 }, now).blocked).toBe(false);
    const session: UsagePool = { name: 'session', kind: 'session', usedPercent: 90, windowMinutes: 300, resetsAt: 1793239200000 };
    expect(poolState(session, now).blocked).toBe(false);
    for (const pool of [fable, session]) expect(poolState({ ...pool, usedPercent: 100 }, now).blocked).toBe(true);
    expect(poolState({ ...session, usedPercent: 89 }, now).blocked).toBe(false);
  });

  it('treats a pool whose reset already passed as expired, never blocked', () => {
    expect(poolState({ ...fable, usedPercent: 99, resetsAt: now - 1 }, now)).toMatchObject({ expired: true, blocked: false });
  });
});
