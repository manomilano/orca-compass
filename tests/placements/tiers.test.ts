import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { combinedScore } from '../../src/placements/score.js';
import { classifyLaunch, classifyModel, FAMILY_TIERS, findAnchors, lineupTier, scoreScale } from '../../src/placements/tiers.js';
import { TIERS, type Config, type LaunchModel, type ModelMeta, type RatedModel } from '../../src/types.js';
import { toRatings } from '../../src/placements/sources/modelindex.js';

const m = (family: string | undefined, outputCost?: number): ModelMeta & { outputCost?: number } => ({ id: 'x', provider: 'p', name: 'x', family, outputCost });

// Model Index numbers as of 2026-10-30 (scores and OpenRouter output prices).
const ratings = toRatings(JSON.parse(readFileSync(new URL('../fixtures/modelindex-mini.json', import.meta.url), 'utf8')));
const scale = scoreScale(ratings, 0.4)!;
const tierOf = (id: string) => classifyModel(id, undefined, DEFAULT_CONFIG, scale)?.tier;

describe('classifyModel', () => {
  it('uses the built-in family map', () => {
    expect(classifyModel('claude-haiku-5-5', m('claude-haiku', 0.5), DEFAULT_CONFIG)).toEqual({ tier: 'light', source: 'family' });
    expect(classifyModel('gpt-6-astra', m('gpt-astra', 50), DEFAULT_CONFIG)?.tier).toBe('frontier');
    expect(FAMILY_TIERS['claude-fable']).toBe('frontier');
  });

  it('places the Google and xAI flagships by ladder', () => {
    expect(classifyModel('gemini-4-argon', m('gemini', 10), DEFAULT_CONFIG, scale)).toEqual({ tier: 'frontier', source: 'family' });
    expect(classifyModel('google/gemini-4.1-argon-preview', undefined, DEFAULT_CONFIG)?.tier).toBe('frontier');
    expect(classifyModel('gemini-embedding-2', m('gemini'), DEFAULT_CONFIG)).toBeUndefined();
    expect(classifyModel('grok-4.7', m('grok', 6), DEFAULT_CONFIG, scale)).toEqual({ tier: 'advanced', source: 'family' });
    expect(classifyModel('grok-5', m('grok'), DEFAULT_CONFIG)?.tier).toBe('advanced');
    expect(classifyModel('grok-4.6', m('grok', 6), DEFAULT_CONFIG, scale)?.source).toBe('score');
    expect(classifyModel('grok-4.20', m('grok'), DEFAULT_CONFIG)).toBeUndefined();
    expect(classifyModel('grok-build-0.1', m('grok-build', 2), DEFAULT_CONFIG, scale)?.source).not.toBe('family');
  });

  it('lets a mapped family beat its score', () => {
    expect(classifyModel('gpt-5.6-sol', m('gpt-sol', 20), DEFAULT_CONFIG, scale)).toEqual({ tier: 'advanced', source: 'family' });
  });

  it('never falls back to price alone', () => {
    expect(classifyModel('kimi-k3', m('kimi', 15), DEFAULT_CONFIG)).toBeUndefined();
    expect(classifyModel('d', m(undefined, 0), DEFAULT_CONFIG, scale)).toBeUndefined();
  });

  it('returns undefined when nothing applies', () => {
    expect(classifyModel('mystery', undefined, DEFAULT_CONFIG, scale)).toBeUndefined();
    expect(classifyModel('mystery', m('unmapped'), DEFAULT_CONFIG)).toBeUndefined();
    expect(classifyModel('auto', undefined, DEFAULT_CONFIG, scale)).toBeUndefined();
    expect(classifyModel('composer-2.5', undefined, DEFAULT_CONFIG, scale)).toBeUndefined();
  });

  it('applies user overrides by model id, then by family', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, tierOverrides: { mystery: 'light', 'claude-opus': 'frontier', 'claude-opus-4-1': 'daily', 'grok-4.6': 'advanced' } };
    expect(classifyModel('mystery', undefined, cfg)).toEqual({ tier: 'light', source: 'override' });
    expect(classifyModel('claude-opus-5-5', m('claude-opus', 20), cfg)).toEqual({ tier: 'frontier', source: 'override' });
    expect(classifyModel('claude-opus-4-1', m('claude-opus', 75), cfg)?.tier).toBe('daily');
    expect(classifyModel('grok-4.6', undefined, cfg, scale)).toEqual({ tier: 'advanced', source: 'override' });
  });

  it('places other models by capability score with a readable reason', () => {
    expect(classifyModel('muse-wonder-1.0', undefined, DEFAULT_CONFIG, scale)).toEqual({
      tier: 'daily',
      source: 'score',
      detail: 'capability score (Model Index 180.3, $20/M → 0.66; cuts 0.34/0.72/0.90)',
    });
  });
});

describe('classifyLaunch', () => {
  const launch = (agent: string, modelId: string): LaunchModel => ({
    agent, modelId, efforts: [], launch: { kind: 'variant', ids: {}, defaultId: modelId }, poolNames: [],
  });

  it('places Cursor auto in Light and Daily unless cursorAuto is false', () => {
    expect(classifyLaunch(launch('cursor', 'auto'), DEFAULT_CONFIG, { score: scale })).toEqual([
      { tier: 'light', source: 'auto' },
      { tier: 'daily', source: 'auto' },
    ]);
    expect(classifyLaunch(launch('cursor', 'auto'), { ...DEFAULT_CONFIG, cursorAuto: false }, { score: scale })).toEqual([]);
    expect(classifyLaunch(launch('other', 'auto'), DEFAULT_CONFIG, { score: scale })).toEqual([]);
  });

  it('lets a tierOverride for auto win', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, tierOverrides: { auto: 'advanced' } };
    expect(classifyLaunch(launch('cursor', 'auto'), cfg, { score: scale })).toEqual([{ tier: 'advanced', source: 'override' }]);
  });

  it('wraps classifyModel for every other model', () => {
    expect(classifyLaunch(launch('cursor', 'muse-wonder-1.0'), DEFAULT_CONFIG, { score: scale })).toEqual([classifyModel('muse-wonder-1.0', undefined, DEFAULT_CONFIG, scale)]);
    expect(classifyLaunch(launch('cursor', 'mystery'), DEFAULT_CONFIG, { score: scale })).toEqual([]);
  });
});

describe('lineupTier', () => {
  it('reads the tier a provider gives a model in its own words', () => {
    expect(lineupTier('For your toughest challenges')).toBe('frontier');
    expect(lineupTier('Frontier intelligence for the most demanding work.')).toBe('frontier');
    expect(lineupTier('For complex work and everyday tasks')).toBe('advanced');
    expect(lineupTier('Latest workhorse model for coding and everyday work.')).toBe('advanced');
    expect(lineupTier('Previous generation workhorse model.')).toBe('advanced');
    expect(lineupTier('Most efficient for simpler tasks')).toBe('daily');
    expect(lineupTier('Older balanced model for straightforward work.')).toBe('daily');
    expect(lineupTier('Fastest for quick answers')).toBe('light');
    expect(lineupTier('Fast and affordable model for easier tasks.')).toBe('light');
    expect(lineupTier('Older fast and efficient model.')).toBe('light');
    expect(lineupTier('GPT-6.1 Terra Codex model.')).toBeUndefined();
    expect(lineupTier('')).toBeUndefined();
    expect(lineupTier(undefined)).toBeUndefined();
  });
});

describe('classifyLaunch with provider descriptions', () => {
  const launch = (modelId: string, family?: string, lineup?: string): LaunchModel => ({
    agent: 'claude', modelId, meta: family ? m(family) : undefined, efforts: [], launch: { kind: 'flag', model: modelId }, poolNames: [],
    ...(lineup ? { lineup } : {}),
  });
  const scales = { score: scale };

  it('uses one provider tier even when the family or score would give another tier', () => {
    expect(classifyLaunch(launch('gpt-6.1-terra', 'gpt-terra', 'Fastest for quick answers'), DEFAULT_CONFIG, scales)).toEqual([
      { tier: 'light', source: 'lineup', detail: `the provider's lineup ("Fastest for quick answers")` },
    ]);
    expect(classifyLaunch(launch('muse-wonder-1.0', 'muse', 'For your toughest challenges'), DEFAULT_CONFIG, scales)).toEqual([
      { tier: 'frontier', source: 'lineup', detail: `the provider's lineup ("For your toughest challenges")` },
    ]);
  });

  it('uses family then Model Index when the provider description does not identify a tier', () => {
    expect(classifyLaunch(launch('gpt-6.1-terra', 'gpt-terra', 'GPT-6.1 Terra Codex model.'), DEFAULT_CONFIG, scales)).toEqual([{ tier: 'daily', source: 'family' }]);
    expect(classifyLaunch(launch('grok-4.7', 'grok'), DEFAULT_CONFIG, scales)).toEqual([{ tier: 'advanced', source: 'family' }]);
    expect(classifyLaunch(launch('grok-4.6', 'grok'), DEFAULT_CONFIG, scales)).toEqual([{ tier: 'daily', source: 'score', detail: expect.stringContaining('Model Index') }]);
    expect(classifyLaunch(launch('mystery'), DEFAULT_CONFIG, scales)).toEqual([]);
  });

  it('keeps manual overrides ahead of provider descriptions and preserves Cursor Auto', () => {
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-opus-5-5': 'light', 'claude-haiku': 'frontier' } };
    expect(classifyLaunch(launch('claude-opus-5-5', 'claude-opus', 'For complex work'), config, scales)).toEqual([{ tier: 'light', source: 'override' }]);
    expect(classifyLaunch(launch('claude-haiku-5-5', 'claude-haiku', 'Fastest for quick answers'), config, scales)).toEqual([{ tier: 'frontier', source: 'override' }]);
    expect(classifyLaunch({ ...launch('auto'), agent: 'cursor' }, config, scales)).toEqual([{ tier: 'light', source: 'auto' }, { tier: 'daily', source: 'auto' }]);
  });
});

describe('capability score', () => {
  it('anchors on the newest Model Index entry of each Claude/GPT family', () => {
    const anchors = Object.fromEntries(findAnchors(ratings).map((a) => [a.rating.id, a.tier]));
    expect(anchors).toEqual({
      'claude-haiku-5-5': 'light',
      'claude-sonnet-5-5': 'daily',
      'claude-opus-5-5': 'advanced',
      'claude-fable-5-1': 'frontier',
      'gpt-6-luna': 'light',
      'gpt-6-1-terra': 'daily',
      'gpt-6-1-sol': 'advanced',
      'gpt-6-astra': 'frontier',
    });
  });

  it('orders all 24 cross-tier anchor pairs like the family table (w = 0.4)', () => {
    const anchors = findAnchors(ratings);
    let pairs = 0;
    for (const a of anchors) {
      for (const b of anchors) {
        if (TIERS.indexOf(a.tier) >= TIERS.indexOf(b.tier)) continue;
        pairs++;
        expect(combinedScore(scale, a.rating), `${a.rating.id} < ${b.rating.id}`).toBeLessThan(combinedScore(scale, b.rating));
      }
    }
    expect(pairs).toBe(24);
    expect(scale.cuts.map((c) => c.toFixed(2))).toEqual(['0.34', '0.72', '0.90']);
  });

  it('places the non-table models', () => {
    for (const id of ['muse-wonder-1.0', 'kimi-k3', 'grok-4.6', 'gemini-3.1-pro']) expect(tierOf(id), id).toBe('daily');
    for (const id of ['muse-spark-1.3', 'deepseek-v41-flash-1017', 'glm-5.2', 'gemini-3-flash', 'kimi-k2.7-code']) {
      expect(tierOf(id), id).toBe('light');
    }
  });

  it('weights intelligence 0.4 by default: at 0.6 Fable would fall below Opus', () => {
    const c = (s: typeof scale, id: string) => combinedScore(s, ratings.find((r) => r.id === id)!);
    expect(c(scale, 'claude-fable-5-1')).toBeGreaterThan(c(scale, 'claude-opus-5-5'));
    const heavy = scoreScale(ratings, 0.6)!;
    expect(c(heavy, 'claude-fable-5-1')).toBeLessThan(c(heavy, 'claude-opus-5-5'));
  });

  it('never places a model above Advanced', () => {
    const top: RatedModel = { id: 'mega-1', name: 'Mega 1', date: '2026-10-01', score: 205, out: 60 };
    const big = scoreScale([...ratings, top], 0.4)!;
    expect(combinedScore(big, top)).toBeGreaterThan(big.cuts[2]);
    expect(classifyModel('mega-1', undefined, DEFAULT_CONFIG, big)?.tier).toBe('advanced');
  });

  it('is unavailable without data or without an anchor in every tier', () => {
    expect(scoreScale(undefined, 0.4)).toBeUndefined();
    expect(scoreScale([], 0.4)).toBeUndefined();
    expect(scoreScale(ratings.filter((r) => !r.id.startsWith('claude-haiku') && !r.id.includes('luna')), 0.4)).toBeUndefined();
  });
});
