import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { hintFor } from '../../src/placements/profiles.js';
import { lineupTier } from '../../src/placements/tiers.js';
import type { ModelMeta } from '../../src/types.js';

const meta = (family?: string): ModelMeta => ({ id: 'x', provider: 'p', name: 'X', family });
const hint = (id: string, family?: string, lineup?: string) => hintFor(id, meta(family), lineup, DEFAULT_CONFIG);

describe('hintFor', () => {
  it('uses the built-in family hints', () => {
    expect(hint('claude-haiku-5-5', 'claude-haiku')).toEqual({ tier: 'light', source: 'family' });
    expect(hint('gpt-6-astra', 'gpt-astra')).toEqual({ tier: 'frontier', source: 'family' });
    expect(hint('gpt-5.6-sol', 'gpt-sol')).toEqual({ tier: 'advanced', source: 'family' });
  });

  it('recognizes model lines without inferring tiers for unrelated models', () => {
    expect(hint('gemini-4-argon', 'gemini')).toEqual({ tier: 'frontier', source: 'family' });
    expect(hint('google/gemini-4.1-argon-preview')).toEqual({ tier: 'frontier', source: 'family' });
    expect(hint('gemini-embedding-2', 'gemini')).toBeUndefined();
    expect(hint('grok-4.7', 'grok')).toEqual({ tier: 'advanced', source: 'family' });
    expect(hint('grok-5', 'grok')?.tier).toBe('advanced');
    for (const id of ['grok-4.6', 'grok-4.20', 'grok-build-0.1', 'mystery', 'composer-2.5', 'auto']) expect(hint(id)).toBeUndefined();
  });

  it('prefers model-line hints to broader family hints', () => {
    expect(hint('grok-4.7', 'claude-haiku')).toEqual({ tier: 'advanced', source: 'family' });
  });

  it('applies user overrides by model id before family', () => {
    const config = { ...DEFAULT_CONFIG, tierOverrides: { mystery: 'light' as const, 'claude-opus': 'frontier' as const, 'claude-opus-4-1': 'daily' as const, 'grok-4.6': 'advanced' as const } };
    expect(hintFor('mystery', undefined, undefined, config)).toEqual({ tier: 'light', source: 'override' });
    expect(hintFor('claude-opus-5-5', meta('claude-opus'), undefined, config)).toEqual({ tier: 'frontier', source: 'override' });
    expect(hintFor('claude-opus-4-1', meta('claude-opus'), undefined, config)).toEqual({ tier: 'daily', source: 'override' });
    expect(hintFor('grok-4.6', undefined, undefined, config)).toEqual({ tier: 'advanced', source: 'override' });
  });

  it('prefers family hints to provider descriptions', () => {
    expect(hint('gpt-6.1-terra', 'gpt-terra', 'Fastest for quick answers')).toEqual({ tier: 'daily', source: 'family' });
    expect(hint('claude-sonnet-5-5', undefined, 'For complex work and everyday tasks')).toEqual({ tier: 'daily', source: 'family' });
  });

  it('uses a quoted provider description when no family hint applies', () => {
    expect(hint('muse-wonder-1.0', 'muse', 'For your toughest challenges')).toEqual({ tier: 'frontier', source: 'lineup', detail: 'the provider\'s lineup ("For your toughest challenges")' });
    expect(hint('mystery', undefined, 'Model for tasks')).toBeUndefined();
  });

  it('keeps overrides ahead of descriptions', () => {
    expect(hintFor('claude-opus-5-5', undefined, 'For complex work', { ...DEFAULT_CONFIG, tierOverrides: { 'claude-opus-5-5': 'light' } })).toEqual({ tier: 'light', source: 'override' });
  });
});

describe('lineupTier', () => {
  it.each([
    ['For your toughest challenges', 'frontier'], ['Frontier intelligence for the most demanding work.', 'frontier'],
    ['For complex work and everyday tasks', 'advanced'], ['Latest workhorse model for coding and everyday work.', 'advanced'], ['Previous generation workhorse model.', 'advanced'],
    ['Most efficient for simpler tasks', 'daily'], ['Older balanced model for straightforward work.', 'daily'],
    ['Fastest for quick answers', 'light'], ['Fast and affordable model for easier tasks.', 'light'], ['Older fast and efficient model.', 'light'],
    ['GPT-6.1 Terra Codex model.', undefined], ['', undefined], [undefined, undefined],
  ])('reads %s', (description, tier) => expect(lineupTier(description)).toBe(tier));
});
