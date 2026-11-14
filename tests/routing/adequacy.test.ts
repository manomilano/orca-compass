import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { parseSnapshot } from '../../src/evidence/snapshot.js';
import { buildProfile } from '../../src/placements/profiles.js';
import { coverage, cutFor, jobEvidence, needWeightedScore } from '../../src/routing/adequacy.js';
import { needsFromTier } from '../../src/routing/needs.js';
import { fixture } from '../helpers/fakes.js';

const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
const profile = (id: string) => buildProfile(id, undefined, undefined, snapshot, DEFAULT_CONFIG);
const needs = { coding: 'high', agentic: 'mid', reasoning: 'low' } as const;

describe('adequacy', () => {
  it('uses the axis cuts and no cut for min', () => {
    expect(['min', 'low', 'mid', 'high'].map((n) => cutFor(n as 'min' | 'low' | 'mid' | 'high', [60, 70, 80]))).toEqual([null, 60, 70, 80]);
  });
  it('counts shortfall on each needed axis without compensating with stronger axes', () => {
    // Sol misses only the coding high cut; Haiku misses only the agentic low cut on raw evidence.
    expect(coverage(profile('gpt-6-1-sol'), needs, snapshot.bands)).toMatchObject({ covers: false, shortfall: 1, below: [{ axis: 'coding', score: 82.2, cut: 84 }] });
    expect(coverage(profile('claude-fable-5-2'), needs)).toMatchObject({ covers: true, shortfall: 0, overshoot: 3 });
    expect(coverage(profile('claude-haiku-5-5'), needsFromTier('daily')).shortfall).toBe(1);
  });
  it('ignores an unranked axis only for min', () => {
    const composer = profile('composer-2-5');
    expect(coverage(composer, { coding: 'low', agentic: 'min', reasoning: 'min' })).toMatchObject({ covers: true, shortfall: 0 });
    expect(coverage(composer, { coding: 'low', agentic: 'low', reasoning: 'min' })).toMatchObject({ covers: false, shortfall: 2, below: [{ axis: 'agentic', score: null, cut: 60 }] });
  });
  it('uses the weakest evidence only among needed axes', () => {
    const p = profile('claude-fable-5-2');
    p.axes.agentic.label = 'estimated';
    p.axes.reasoning.label = 'assumed';
    expect(jobEvidence(p, needs)).toBe('assumed');
    expect(jobEvidence(p, { coding: 'high', agentic: 'low', reasoning: 'min' })).toBe('estimated');
    expect(jobEvidence(p, needsFromTier('light'))).toBe('measured');
    expect(jobEvidence(profile('composer-2-5'), needs)).toBe('unranked');
  });
  it('weights raw scores only for tie-breaking', () => {
    // High needs weight each raw axis by 3: Fable (82.8+81.1+88.1)*3; Opus (87.4+82+90.6)*3.
    expect(needWeightedScore(profile('claude-fable-5-1'), needsFromTier('frontier'))).toBeCloseTo(756);
    expect(needWeightedScore(profile('claude-opus-5-5'), needsFromTier('frontier'))).toBeCloseTo(780);
    expect(needWeightedScore(profile('composer-2-5'), needsFromTier('light'))).toBe(0);
  });
  it('reports custom snapshot cuts and respects overridden bands', () => {
    const p = profile('gpt-6-1-sol');
    expect(coverage(p, needs, { ...snapshot.bands, coding: [70, 80, 90] }).below[0].cut).toBe(90);
    p.axes.coding.band = 'frontier';
    expect(coverage(p, needs).covers).toBe(true);
  });
});
