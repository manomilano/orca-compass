import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { calibrationChecks } from '../../src/evidence/refresh.js';
import { AXES, parseSnapshot } from '../../src/evidence/snapshot.js';
import { bandOf, buildProfile, findSnapshotModel, profileModels, vendorOfFamily } from '../../src/placements/profiles.js';
import type { AgentDiscovery, LaunchModel } from '../../src/types.js';
import { fixture } from '../helpers/fakes.js';

const snap = parseSnapshot(fixture('evidence-mini.json'))!;
const p = (id: string, lineup?: string, config = DEFAULT_CONFIG) => buildProfile(id, undefined, lineup, snap, config);
const launch = (agent: string, modelId: string, lineup?: string): LaunchModel => ({
  agent, modelId, lineup, efforts: ['high'], launch: { kind: 'flag', model: modelId }, poolNames: ['weekly'],
});

describe('profiles', () => {
  it('keeps the bundled snapshot calibrated with the same profile calculation', () => {
    const bundled = parseSnapshot(readFileSync(new URL('../../data/evidence-snapshot.json', import.meta.url), 'utf8'))!;
    expect(calibrationChecks(bundled, DEFAULT_CONFIG.classWeight)).toEqual([]);
  });

  it('keeps the bundled model classes aligned with the calibrated reasoning bands', () => {
    const bundled = parseSnapshot(readFileSync(new URL('../../data/evidence-snapshot.json', import.meta.url), 'utf8'))!;
    const expected = {
      'claude-haiku-5-5': 'light', 'gpt-6-luna': 'light', 'gpt-6-1-terra': 'daily',
      'claude-sonnet-5-5': 'advanced', 'gpt-6-1-sol': 'advanced', 'claude-opus-5-5': 'frontier',
      'gpt-6-astra': 'frontier', 'claude-fable-5-1': 'frontier', 'claude-fable-5-2': 'frontier',
    };
    const classes = Object.fromEntries(Object.keys(expected).map((id) => [id, buildProfile(id, undefined, undefined, bundled, DEFAULT_CONFIG).class]));
    expect(classes).toEqual(expected);
  });

  it('scores Sonnet as Advanced on every axis and below Fable everywhere', () => {
    const sonnet = p('claude-sonnet-5-5');
    expect(sonnet.axes.coding).toMatchObject({ score: 80.9, evidence: 84.3, band: 'advanced', label: 'measured', benchmarks: 5 });
    expect(sonnet.class).toBe('advanced');
    for (const axis of AXES) {
      expect(sonnet.axes[axis].band).toBe('advanced');
      expect(p('claude-fable-5-1').axes[axis].score!).toBeGreaterThan(sonnet.axes[axis].score!);
    }
  });

  it('ranks Opus above Fable on coding, both Frontier', () => {
    expect(p('claude-opus-5-5').axes.coding.score).toBe(86.2);
    expect(p('claude-fable-5-1').axes.coding.score).toBe(84.5);
    expect(p('claude-opus-5-5').class).toBe('frontier');
  });

  it('labels estimates and leaves missing axes unranked without a hint', () => {
    const composer = p('composer-2-5');
    expect(composer.axes.coding).toMatchObject({ score: 80, evidence: 80, label: 'estimated', band: 'advanced', benchmarks: 2 });
    expect(composer.axes.agentic).toEqual({ score: null, evidence: null, benchmarks: 0, label: 'unranked', band: null });
    expect(composer.class).toBe('advanced');
  });

  it('labels two independent benchmarks partial', () => {
    const snapshot = structuredClone(snap);
    snapshot.models[0].scores.coding!.benchmarks = 2;
    expect(buildProfile(snapshot.models[0].id, undefined, undefined, snapshot, DEFAULT_CONFIG).axes.coding.label).toBe('partial');
  });

  it('keeps family hints ahead of lineup words', () => {
    expect(p('claude-sonnet-5-5', 'For complex work and everyday tasks').hint).toEqual({ tier: 'daily', source: 'family' });
  });

  it('forces override bands on every axis while keeping the evidence and weighted score', () => {
    const profile = p('claude-haiku-5-5', undefined, { ...DEFAULT_CONFIG, tierOverrides: { 'claude-haiku-5-5': 'frontier' } });
    expect(AXES.map((axis) => profile.axes[axis].band)).toEqual(['frontier', 'frontier', 'frontier']);
    expect(profile.axes.coding).toMatchObject({ score: 71.7, evidence: 68.5, label: 'measured' });
    expect(profile.hint?.source).toBe('override');
  });

  it('allows an override without evidence while leaving its score explicitly unknown', () => {
    const profile = p('mystery-9', undefined, { ...DEFAULT_CONFIG, tierOverrides: { 'mystery-9': 'daily' } });
    expect(profile.class).toBe('daily');
    for (const axis of AXES) expect(profile.axes[axis]).toEqual({ score: null, evidence: null, benchmarks: 0, label: 'unranked', band: 'daily' });
  });

  it('uses the highest axis band as class', () => {
    const snapshot = structuredClone(snap);
    const composer = snapshot.models.find((model) => model.id === 'composer-2-5')!;
    composer.scores.reasoning = { score: 90, benchmarks: 3, kind: 'measured' };
    expect(buildProfile(composer.id, undefined, undefined, snapshot, DEFAULT_CONFIG).class).toBe('frontier');
  });

  it('supports zero and full class weight', () => {
    expect(p('claude-sonnet-5-5', undefined, { ...DEFAULT_CONFIG, classWeight: 0 }).axes.coding.score).toBe(84.3);
    expect(p('claude-sonnet-5-5', undefined, { ...DEFAULT_CONFIG, classWeight: 1 }).axes.coding.score).toBe(50);
  });

  it('leaves a model without a hint or evidence unranked', () => {
    expect(p('mystery-9')).toMatchObject({ class: null, hint: null });
    for (const axis of AXES) expect(p('mystery-9').axes[axis].label).toBe('unranked');
  });
});

describe('snapshot identity', () => {
  it.each(['gpt-6.1-terra', 'openai/gpt-6.1-terra', 'gpt-6-1-terra-20261026', 'GPT-6.1-Terra', 'gpt61terra'])('matches %s', (id) => {
    expect(findSnapshotModel(id, snap)?.id).toBe('gpt-6-1-terra');
    expect(p(id).axes.coding.score).toBe(74.8);
  });

  it('matches aliases, Cursor spelling, version-zero differences and dated aliases', () => {
    const snapshot = structuredClone(snap);
    snapshot.models[0].aliases.push('vendor/friendly-name');
    snapshot.models.push({ ...snapshot.models[1], id: 'claude-sonnet-4-6', aliases: ['claude-4.6-sonnet'] });
    expect(findSnapshotModel('claude-4.6-sonnet', snapshot)?.id).toBe('claude-sonnet-4-6');
    expect(findSnapshotModel('friendly-name-20261010', snapshot)?.id).toBe('claude-haiku-5-5');
    expect(findSnapshotModel('composer-2-5-0', snapshot)?.id).toBe('composer-2-5');
    expect(findSnapshotModel('claude-sonnet-5-5-20260928', snap)?.id).toBe('claude-sonnet-5-5');
    expect(findSnapshotModel('mystery-9', snapshot)).toBeUndefined();
  });

  it('prefers an exact id over an earlier model alias', () => {
    const snapshot = structuredClone(snap);
    snapshot.models[0].aliases.push('claude-sonnet-5-5');
    expect(findSnapshotModel('claude-sonnet-5-5', snapshot)?.id).toBe('claude-sonnet-5-5');
  });
});

describe('assumed inheritance', () => {
  it('takes the vendor best score at or below the hinted class on each axis', () => {
    const profile = p('claude-fable-5-3');
    expect(profile.axes.coding).toMatchObject({ label: 'assumed', inheritedFrom: 'claude-opus-5-5', evidence: 87.4, score: 88.7, benchmarks: 5 });
    expect(profile.axes.agentic).toMatchObject({ inheritedFrom: 'claude-fable-5-2', evidence: 85.4 });
    expect(profile.class).toBe('frontier');
  });

  it('keeps a new Sonnet below Opus inheritance', () => {
    expect(p('claude-sonnet-5-6').axes.coding.inheritedFrom).toBe('claude-sonnet-5-5');
    expect(p('claude-haiku-5-6').axes.coding.inheritedFrom).toBe('claude-haiku-5-5');
  });

  it('breaks equal evidence scores by newest release and accepts estimated references', () => {
    const snapshot = structuredClone(snap);
    const old = snapshot.models.find((model) => model.id === 'claude-opus-5-5')!;
    snapshot.models.push({ ...old, id: 'claude-opus-5-6', releasedAt: '2026-11-10', scores: { coding: { score: 87.4, benchmarks: 2, kind: 'estimated' } } });
    expect(buildProfile('claude-fable-5-3', undefined, undefined, snapshot, DEFAULT_CONFIG).axes.coding).toMatchObject({ inheritedFrom: 'claude-opus-5-6', label: 'assumed', benchmarks: 2 });
  });

  it('does not inherit from other vendors or invent a vendor from lineup words', () => {
    const meta = { id: 'new-model', name: 'New', provider: 'unknown' };
    expect(buildProfile(meta.id, meta, 'For your toughest challenges', snap, DEFAULT_CONFIG).class).toBeNull();
    expect(p('new-model', 'For your toughest challenges').class).toBeNull();
    expect(buildProfile(meta.id, { ...meta, provider: 'openai' }, 'For your toughest challenges', snap, DEFAULT_CONFIG).axes.coding.inheritedFrom).toBe('gpt-6-astra');
  });

  it('uses same-family references regardless of their hint class', () => {
    const config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-opus-5-6': 'light' as const } };
    expect(buildProfile('claude-opus-5-6', undefined, undefined, snap, config).axes.coding.inheritedFrom).toBe('claude-opus-5-5');
  });
});

describe('profileModels', () => {
  it('shares the first non-empty lineup across routes and excludes Cursor auto even with an override', () => {
    const model = { ...launch('codex', 'new-model'), meta: { id: 'new-model', name: 'New', provider: 'openai' } };
    const discoveries: AgentDiscovery[] = [
      { agent: 'codex', installed: true, models: [model] },
      { agent: 'cursor', installed: true, note: 'catalog', signedOut: false, models: [{ ...model, agent: 'cursor', lineup: 'For your toughest challenges' }, launch('cursor', 'auto', 'For your toughest challenges')] },
      { agent: 'other', installed: true, models: [{ ...model, agent: 'other', lineup: 'Fastest for quick answers' }] },
    ];
    const placed = profileModels(discoveries, snap, { ...DEFAULT_CONFIG, tierOverrides: { auto: 'frontier' } });
    expect(placed[0].models[0].profile.hint).toEqual({ tier: 'frontier', source: 'lineup', detail: 'the provider\'s lineup ("For your toughest challenges")' });
    expect(placed[0].models[0].profile).toBe(placed[1].models[0].profile);
    expect(placed[2].models[0].profile).toBe(placed[0].models[0].profile);
    expect(placed[1]).toMatchObject({ note: 'catalog', signedOut: false });
    expect(placed[1].models[1].profile).toMatchObject({ class: null, hint: null });
    expect(placed[1].models[1]).not.toHaveProperty('tiers');
    expect(placed[1].models[1]).not.toHaveProperty('placements');
    expect(discoveries[0].models[0]).not.toHaveProperty('profile');
  });
});

it.each([[0, 'light'], [67.9, 'light'], [68, 'daily'], [75.9, 'daily'], [76, 'advanced'], [83.9, 'advanced'], [84, 'frontier'], [100, 'frontier']] as const)('bands score %s at inclusive cuts', (score, band) => {
  expect(bandOf(score, [68, 76, 84])).toBe(band);
});

it.each([['claude-sonnet', 'anthropic'], ['gpt-terra', 'openai'], ['gemini-flash-lite', 'google'], ['grok', 'xai'], ['other', undefined], [undefined, undefined]])('identifies vendor for %s', (family, vendor) => {
  expect(vendorOfFamily(family)).toBe(vendor);
});
