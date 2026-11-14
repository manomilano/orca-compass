import { describe, expect, it } from 'vitest';
import { needsFromTier, parseNeeds, tierOfNeeds } from '../../src/routing/needs.js';
import { TIERS } from '../../src/types.js';

describe('needs', () => {
  it('accepts every axis in any order', () => {
    expect(parseNeeds('reasoning=low,coding=high,agentic=mid')).toEqual({ coding: 'high', agentic: 'mid', reasoning: 'low' });
    expect(tierOfNeeds({ coding: 'high', agentic: 'min', reasoning: 'low' })).toBe('frontier');
  });
  it.each(TIERS)('round-trips the %s shorthand', (tier) => {
    expect(tierOfNeeds(needsFromTier(tier))).toBe(tier);
    expect(parseNeeds(Object.entries(needsFromTier(tier)).map(([axis, need]) => `${axis}=${need}`).join(','))).toEqual(needsFromTier(tier));
  });
  it.each(['', 'coding=high', 'coding=high,coding=low,reasoning=mid', 'coding=high,agentic=mid,other=low',
    'coding=great,agentic=mid,reasoning=low', 'CODING=High,agentic=mid,reasoning=low',
    'coding=high, agentic=mid,reasoning=low', 'coding=high,agentic=mid,reasoning=low,',
    'coding=high=low,agentic=mid,reasoning=low'])('rejects malformed input %j with the expected form', (text) => {
    expect(() => parseNeeds(text)).toThrow('--need must name all three axes, e.g. --need coding=high,agentic=mid,reasoning=low (levels: min, low, mid, high)');
  });
});
