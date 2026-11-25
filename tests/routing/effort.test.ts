import { describe, expect, it } from 'vitest';
import { DEMAND_EFFORT, parseEffort, snapEffort } from '../../src/routing/effort.js';

describe('effort', () => {
  it('snaps to the target, then nearest lower, then lowest higher', () => {
    expect(snapEffort('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('xhigh');
    expect(snapEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(snapEffort('low', ['high', 'max'])).toBe('high');
    expect(snapEffort('medium', [])).toBeNull();
  });

  it('maps reasoning demand to effort per policy, never to max', () => {
    expect(DEMAND_EFFORT.balanced).toEqual({ low: 'low', moderate: 'medium', high: 'high', exceptional: 'xhigh' });
    expect(DEMAND_EFFORT.quality).toEqual({ low: 'low', moderate: 'medium', high: 'xhigh', exceptional: 'xhigh' });
    expect(DEMAND_EFFORT.efficient).toEqual({ low: 'low', moderate: 'low', high: 'medium', exceptional: 'high' });
    for (const policy of Object.values(DEMAND_EFFORT)) expect(Object.values(policy)).not.toContain('max');
  });

  it('parses provider spellings and rejects ultra', () => {
    expect(parseEffort('extra-high')).toBe('xhigh');
    expect(parseEffort('HIGH')).toBe('high');
    expect(parseEffort('ultra')).toBeUndefined();
    expect(parseEffort('bogus')).toBeUndefined();
  });
});
