import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, calibrationChecks, DEFAULT_BANDS, diffSnapshots, displayName, estimateScores, familyOfSlug, hintPointsOf, mergeCurated } from '../../src/evidence/refresh.js';
import { BENCHMARKS } from '../../src/evidence/scoring.js';
import { parseSnapshot, type SnapshotModel, type SnapshotResult } from '../../src/evidence/snapshot.js';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/llmb-dataset-mini.json', import.meta.url), 'utf8'));
const opts = { now: '2026-11-10T04:00:00Z', bands: DEFAULT_BANDS, sourceFetchedAt: '2026-11-10' };
const built = buildSnapshot(dataset, opts);
const model = (id: string) => built.models.find((m) => m.id === id)!;

describe('snapshot builder', () => {
  it('keeps every dataset model as a catalog entry', () => {
    expect(built.models).toHaveLength(dataset.models.length);
    expect(built.models.map((m) => m.id)).toContain('gpt-6-luna');
    expect(model('claude-opus-5-5')).toMatchObject({ aliases: ['anthropic/claude-opus-5.5'], provider: 'anthropic', family: 'claude-opus', name: 'Claude Opus 5.5', releasedAt: '2026-09-22' });
    const sparse = buildSnapshot({ ...dataset, scores: [] }, opts);
    expect(sparse.models).toHaveLength(11);
    expect(sparse.models.every((m) => m.results.length === 0 && Object.keys(m.scores).length === 0)).toBe(true);
  });

  it('recomputes the coding index within half a point of LLMBenchmark', () => {
    expect(model('claude-opus-5-5').scores.coding).toMatchObject({ score: expect.closeTo(87.4, 0), benchmarks: 5, kind: 'measured' });
    expect(model('claude-sonnet-5-5').scores.coding!.score).toBeCloseTo(84.3, 0);
    expect(model('claude-haiku-5-5').scores.coding!.score).toBeCloseTo(68.5, 0);
    expect(model('claude-fable-5-1').scores.coding!.score).toBeCloseTo(82.8, 0);
    expect(model('claude-opus-5-5').scores.agentic!.score).toBeCloseTo(82.0, 0);
    expect(model('claude-opus-5-5').scores.reasoning!.score).toBeCloseTo(90.6, 0);
  });

  it('uses one GPQA and one HLE source by priority, falling back when absent', () => {
    const results = model('claude-opus-5-5').results;
    expect(results.filter((r) => r.benchmark === 'gpqa_diamond')).toMatchObject([{ source: 'epoch' }]);
    expect(results.filter((r) => r.benchmark === 'hle').every((r) => r.source === 'aa-api')).toBe(true);
    expect(results.filter((r) => r.benchmark === 'hle')).toHaveLength(5);
    const fallback = structuredClone(dataset);
    fallback.scores = fallback.scores.filter((s: { metric: string }) => !['epoch_gpqa_diamond', 'aa_hle'].includes(s.metric));
    const rows = buildSnapshot(fallback, opts).models.find((m) => m.id === 'claude-opus-5-5')!.results;
    expect(rows.find((r) => r.benchmark === 'hle')!.source).toBe('scale-seal');
  });

  it('keeps only axis rows in results, converts ratios, and retains provenance and settings', () => {
    expect(model('claude-opus-5-5').results.every((r) => r.benchmark in BENCHMARKS)).toBe(true);
    expect(model('claude-opus-5-5').results.find((r) => r.benchmark === 'tbench_4_0')).toMatchObject({ value: expect.closeTo(65.15, 1), unit: 'percent', kind: 'measured', url: 'https://www.vals.ai/benchmarks/terminal-bench-4', observedAt: '2026-11-10', setting: 'Mini-SWE-agent' });
    expect(model('claude-opus-5-5').results.find((r) => r.benchmark === 'webdev_arena')).toMatchObject({ value: expect.closeTo(1817.702, 2), unit: 'elo' });
    expect(model('claude-opus-5-5').results.find((r) => r.benchmark === 'arc_agi_2' && r.setting === 'High')!.value).toBeCloseTo(93.333, 2);
    const extended = structuredClone(dataset);
    extended.scores.push({ ...extended.scores[0], metric: 'irrelevant_metric' });
    expect(buildSnapshot(extended, opts)).toEqual(built);
  });

  it('preserves dataset attribution, dates and snapshot configuration', () => {
    expect(built).toMatchObject({ schemaVersion: 1, generatedAt: opts.now, bands: DEFAULT_BANDS, sources: [{ id: 'llmbenchmark', label: 'LLMBenchmark.ai', url: 'https://llmbenchmark.ai', license: 'CC BY 4.0', fetchedAt: opts.sourceFetchedAt, dataDate: dataset.generatedAt }] });
    expect(parseSnapshot(JSON.stringify(built))).toEqual(built);
  });

  it('accepts null release dates and unrelated count or currency metrics in the full dataset', () => {
    const fullShape = structuredClone(dataset);
    fullShape.models[0].releasedAt = null;
    fullShape.scores.push({ ...fullShape.scores[0], metric: 'other_count', unit: 'count', value: 12 });
    fullShape.scores.push({ ...fullShape.scores[0], metric: 'other_cost', unit: 'usd', value: 0.12 });
    const snapshot = buildSnapshot(fullShape, opts);
    expect(snapshot.models[0].releasedAt).toBeUndefined();
    expect(snapshot.models[0].scores).toEqual(built.models[0].scores);
    expect(snapshot.models.flatMap((m) => m.results).some((r) => r.benchmark.startsWith('other_'))).toBe(false);
  });

  it.each(['models', 'scores', 'vendorReports'])('rejects a dataset without a %s array', (field) => {
    expect(() => buildSnapshot({ ...dataset, [field]: undefined }, opts)).toThrow(/^dataset:/);
  });
  it('rejects a dataset without scores', () => {
    expect(() => buildSnapshot({ models: [] }, opts)).toThrow(/^dataset:/);
  });
  it.each([NaN, Infinity, -Infinity, '0.5'])('rejects a non-finite or non-numeric score %s', (value) => {
    const bad = structuredClone(dataset);
    bad.scores[0].value = value;
    expect(() => buildSnapshot(bad, opts)).toThrow(/dataset:.*value/i);
  });
  it('rejects duplicate model, metric and setting rows', () => {
    expect(() => buildSnapshot({ ...dataset, scores: [...dataset.scores, dataset.scores[0]] }, opts)).toThrow(/dataset:.*duplicate/i);
  });
  it('does not mutate the input dataset', () => {
    const input = structuredClone(dataset);
    buildSnapshot(input, opts);
    expect(input).toEqual(dataset);
  });
});

const result = (benchmark: string, value: number, kind: SnapshotResult['kind'] = 'vendor', unit: SnapshotResult['unit'] = 'percent'): SnapshotResult => ({
  benchmark, value, kind, unit, source: 'test', url: 'https://example.com/benchmark', observedAt: '2026-11-10',
});
const entry = (id: string, results: SnapshotResult[], scores: SnapshotModel['scores'] = {}): SnapshotModel => ({
  id, aliases: [], provider: 'test', name: id, results, scores,
});

describe('vendor estimates', () => {
  it('estimates Fable 5.2 from its vendor rows against measured neighbours', () => {
    const stripped = structuredClone(dataset);
    stripped.scores = stripped.scores.filter((s: { modelId: string }) => s.modelId !== 'anthropic/claude-fable-5.2');
    const snapshot = buildSnapshot(stripped, opts);
    const fable = snapshot.models.find((m) => m.id === 'claude-fable-5-2')!;
    expect(fable.scores.reasoning).toMatchObject({ kind: 'estimated', benchmarks: 2 });
    expect(fable.scores.reasoning!.score).toBeGreaterThan(snapshot.models.find((m) => m.id === 'claude-opus-5-5')!.scores.reasoning!.score - 5);
    expect(fable.results.find((r) => r.benchmark === 'hle')).toMatchObject({ value: 74.2, unit: 'percent', kind: 'vendor', source: 'anthropic', observedAt: '2026-11-09', url: 'https://www.anthropic.com/claude/fable', setting: 'with tools' });
    expect(fable.results.map((r) => r.benchmark).sort()).toEqual(['epoch_frontierswe', 'hle']);
    expect(parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('needs two distinct shared benchmarks, even with several reference models and settings', () => {
    const reference = entry('reference', [result('gpqa_diamond', 70, 'measured'), result('gpqa_diamond', 80, 'measured')], { reasoning: { score: 80, benchmarks: 2, kind: 'measured' } });
    const target = entry('target', [result('gpqa_diamond', 90), result('gpqa_diamond', 95)]);
    expect(estimateScores([reference, { ...reference, id: 'other' }, target], BENCHMARKS).at(-1)!.scores.reasoning).toBeUndefined();
    const stripped = structuredClone(dataset);
    stripped.scores = stripped.scores.filter((s: { modelId: string }) => s.modelId !== 'anthropic/claude-fable-5.2');
    stripped.vendorReports = stripped.vendorReports.filter((r: { benchmark: string }) => r.benchmark === 'epoch-hle');
    expect(buildSnapshot(stripped, opts).models.find((m) => m.id === 'claude-fable-5-2')!.scores.reasoning).toBeUndefined();
  });

  it('takes the median of all reference pairs and prefers measured reference rows', () => {
    const target = entry('target', [result('gpqa_diamond', 90), result('hle', 56)]);
    const first = entry('first', [result('gpqa_diamond', 80, 'measured'), result('gpqa_diamond', 0), result('hle', 49, 'reported')], { reasoning: { score: 70, benchmarks: 2, kind: 'measured' } });
    const second = entry('second', [result('gpqa_diamond', 50, 'reported'), result('hle', 7)], { reasoning: { score: 50, benchmarks: 2, kind: 'measured' } });
    // Candidates are 80, 80, 90 and 120; the middle pair averages to 85.
    expect(estimateScores([target, first, second], BENCHMARKS)[0].scores.reasoning).toEqual({ score: 85, benchmarks: 2, kind: 'estimated' });
  });

  it('uses an odd median and clamps the final estimate to the score range', () => {
    const target = entry('target', [result('gpqa_diamond', 90), result('hle', 56)]);
    const first = entry('first', [result('gpqa_diamond', 80, 'measured'), result('hle', 49, 'measured')], { reasoning: { score: 70, benchmarks: 2, kind: 'measured' } });
    const second = entry('second', [result('gpqa_diamond', 50, 'measured')], { reasoning: { score: 50, benchmarks: 2, kind: 'measured' } });
    expect(estimateScores([target, first, second], BENCHMARKS)[0].scores.reasoning!.score).toBe(80);
    first.scores.reasoning!.score = 100;
    second.scores.reasoning!.score = 100;
    expect(estimateScores([target, first, second], BENCHMARKS)[0].scores.reasoning!.score).toBe(100);
    target.results = [result('gpqa_diamond', 0), result('hle', 0)];
    first.scores.reasoning!.score = 0;
    second.scores.reasoning!.score = 0;
    expect(estimateScores([target, first, second], BENCHMARKS)[0].scores.reasoning!.score).toBe(0);
  });

  it('rescales axis ranges and shared percent benchmarks, skipping unknown scales', () => {
    const target = entry('target', [result('tbench_4_0', 60), result('webdev_arena', 1900, 'vendor', 'elo'), result('unknown-points', 90, 'vendor', 'points'), result('unknown-elo', 1900, 'vendor', 'elo')]);
    const reference = entry('reference', [result('tbench_4_0', 45, 'measured'), result('webdev_arena', 1830, 'measured', 'elo'), result('unknown-points', 10, 'reported', 'points'), result('unknown-elo', 1200, 'reported', 'elo')], { coding: { score: 70, benchmarks: 2, kind: 'measured' } });
    expect(estimateScores([target, reference], BENCHMARKS)[0].scores.coding).toEqual({ score: 85, benchmarks: 2, kind: 'estimated' });
  });

  it('does not borrow unknown scales or mismatched units as percentage evidence', () => {
    const target = entry('target', [result('shared', 60), result('other', 80)]);
    const reference = entry('reference', [result('shared', 50, 'reported'), result('other', 70, 'reported', 'points')], { coding: { score: 70, benchmarks: 2, kind: 'measured' } });
    expect(estimateScores([target, reference], BENCHMARKS)[0].scores.coding).toBeUndefined();
  });

  it('preserves measured scores and never chains estimates or uses measured target rows', () => {
    const rows = [result('shared', 60), result('other', 80)];
    const measured = entry('measured', rows, { coding: { score: 70, benchmarks: 2, kind: 'measured' } });
    const estimated = entry('estimated', rows, { reasoning: { score: 90, benchmarks: 2, kind: 'estimated' } });
    const target = entry('target', rows);
    const input = structuredClone([measured, estimated, target]);
    const output = estimateScores(input, BENCHMARKS);
    expect(output[0].scores.coding).toEqual({ score: 70, benchmarks: 2, kind: 'measured' });
    expect(output[2].scores.coding).toEqual({ score: 70, benchmarks: 2, kind: 'estimated' });
    expect(output[2].scores.reasoning).toBeUndefined();
    expect(input).toEqual([measured, estimated, target]);
    expect(estimateScores([measured, entry('independent', rows.map((r) => ({ ...r, kind: 'measured' })))], BENCHMARKS)[1].scores.coding).toBeUndefined();
  });

  it('merges the curated Composer 2.5 near Opus 4.7 on coding', () => {
    const curated = JSON.parse(readFileSync(new URL('../../data/evidence-curated.json', import.meta.url), 'utf8'));
    const snapshot = buildSnapshot(dataset, { ...opts, curated });
    const composer = snapshot.models.find((m) => m.id === 'composer-2-5')!;
    expect(composer.scores.coding).toMatchObject({ kind: 'estimated', benchmarks: 2 });
    expect(Math.abs(composer.scores.coding!.score - snapshot.models.find((m) => m.id === 'claude-opus-4-7')!.scores.coding!.score)).toBeLessThan(3);
    expect(snapshot.models).toHaveLength(dataset.models.length + 1);
    expect(composer.results).toHaveLength(2);
    expect(snapshot.models.find((m) => m.id === 'claude-opus-4-7')!.scores).toEqual(model('claude-opus-4-7').scores);
  });

  it('retains vendor rows only when a successful estimate uses them', () => {
    const stripped = structuredClone(dataset);
    stripped.scores = stripped.scores.filter((s: { modelId: string }) => s.modelId !== 'anthropic/claude-fable-5.2');
    stripped.vendorReports.push({ ...stripped.vendorReports[0], benchmark: 'unused-benchmark' });
    const snapshot = buildSnapshot(stripped, opts);
    expect(snapshot.models.flatMap((m) => m.results).some((r) => r.benchmark === 'unused-benchmark')).toBe(false);
    expect(snapshot.models.find((m) => m.id === 'claude-opus-5-5')!.results.some((r) => r.benchmark === 'epoch_frontierswe' && r.kind === 'vendor')).toBe(true);
    expect(built.models.flatMap((m) => m.results).every((r) => r.kind === 'measured')).toBe(true);
  });
});

describe('curated results', () => {
  const curatedModel = { id: 'new-model', provider: 'test', name: 'New model', aliases: ['test/new-model'], family: 'new', releasedAt: '2026-11-10', results: [result('gpqa_diamond', 90)] };

  it('appends new models and existing rows without changing catalog metadata or input', () => {
    const existing = entry('new-model', [result('hle', 49, 'measured')], { reasoning: { score: 80, benchmarks: 2, kind: 'measured' } });
    const before = structuredClone(existing);
    expect(mergeCurated([], { models: [curatedModel] })).toEqual([{ ...curatedModel, scores: {} }]);
    expect(mergeCurated([existing], { models: [curatedModel] })).toEqual([{ ...existing, results: [...existing.results, ...curatedModel.results] }]);
    expect(existing).toEqual(before);
    expect(mergeCurated([existing], undefined)).toEqual([existing]);
  });

  it('rejects a curated row without a url', () => {
    expect(() => mergeCurated([], { models: [{ ...curatedModel, results: [{ ...curatedModel.results[0], url: undefined }] }] })).toThrow(/^curated:/);
  });

  it.each([
    { kind: 'measured' }, { kind: 'unknown' }, { observedAt: '' }, { source: '' }, { benchmark: '' },
    { value: NaN }, { value: Infinity }, { value: '90' }, { unit: 'ratio' }, { setting: 4 },
  ])('rejects invalid curated row fields %j', (change) => {
    expect(() => mergeCurated([], { models: [{ ...curatedModel, results: [{ ...curatedModel.results[0], ...change }] }] })).toThrow(/^curated:/);
  });

  it.each([null, {}, { models: null }, { models: [null] }, { models: [{ ...curatedModel, id: '' }] }, { models: [{ ...curatedModel, results: undefined }] }, { models: [{ ...curatedModel, aliases: [1] }] }])('rejects an invalid curated document %j', (curated) => {
    expect(() => mergeCurated([], curated)).toThrow(/^curated:/);
  });
});

describe('model hints', () => {
  it.each([['claude-opus-5-5', 'claude-opus'], ['gpt-6-1-terra', 'gpt-terra'], ['grok-4-7', 'grok'], ['gemini-3-1-pro', 'gemini'], ['composer-2-5', 'composer'], ['new-family', 'new-family'], ['123-model', undefined]])('derives the family of %s', (slug, want) => {
    expect(familyOfSlug(slug)).toBe(want);
  });
  it('removes only the leading provider label', () => {
    expect(displayName('Anthropic: Claude Opus 5.5')).toBe('Claude Opus 5.5');
    expect(displayName('Claude Opus 5.5')).toBe('Claude Opus 5.5');
    expect(displayName('Provider: Model: Variant')).toBe('Model: Variant');
  });
  it('uses family points, then model lines, and leaves unknown models without a hint', () => {
    expect(hintPointsOf(model('claude-haiku-5-5'))).toBe(25);
    expect(hintPointsOf(model('claude-sonnet-5-5'))).toBe(50);
    expect(hintPointsOf(model('claude-opus-5-5'))).toBe(75);
    expect(hintPointsOf(model('claude-fable-5-1'))).toBe(100);
    expect(hintPointsOf({ ...model('gpt-6-luna'), id: 'grok-4-7', family: 'grok' })).toBe(75);
    expect(hintPointsOf({ ...model('gpt-6-luna'), id: 'unknown', family: 'unknown' })).toBeUndefined();
  });
});

describe('calibration and diffs', () => {
  it('passes the calibration checks on the real numbers', () => {
    expect(calibrationChecks(built, 0.1)).toEqual([]);
  });
  it.each(['coding', 'agentic', 'reasoning'] as const)('reports a Sonnet above Fable on %s as a failure', (axis) => {
    const bad = structuredClone(built);
    bad.models.find((m) => m.id === 'claude-fable-5-1')!.scores[axis]!.score = 60;
    expect(calibrationChecks(bad, 0.1).join('\n')).toMatch(new RegExp(`fable-5-1.*sonnet-5-5.*${axis}|${axis}.*fable-5-1.*sonnet-5-5`, 'i'));
  });
  it.each(['claude-fable-5-1', 'gpt-6-astra', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])('reports missing calibration model %s', (id) => {
    expect(calibrationChecks({ ...built, models: built.models.filter((m) => m.id !== id) }, 0.1).join('\n')).toContain(id);
  });
  it('checks the expected coding bands and missing evidence', () => {
    const bad = structuredClone(built);
    bad.models.find((m) => m.id === 'gpt-6-astra')!.scores.coding!.score = 50;
    bad.models.find((m) => m.id === 'claude-haiku-5-5')!.scores.coding!.score = 95;
    delete bad.models.find((m) => m.id === 'claude-opus-5-5')!.scores.coding;
    const failures = calibrationChecks(bad, 0.1).join('\n');
    expect(failures).toMatch(/gpt-6-astra.*frontier/i);
    expect(failures).toMatch(/claude-haiku-5-5.*light/i);
    expect(failures).toContain('claude-opus-5-5');
  });
  it('allows measured cross-axis gaps and reports gaps without partial evidence on both axes', () => {
    const extra: SnapshotModel = { id: 'extra', aliases: [], provider: 'test', name: 'Extra', results: [], scores: { coding: { score: 90, benchmarks: 2, kind: 'measured' }, agentic: { score: 40, benchmarks: 3, kind: 'measured' } } };
    expect(calibrationChecks({ ...built, models: [...built.models, extra] }, 0.1)).toEqual([]);
    extra.scores.agentic!.kind = 'estimated';
    expect(calibrationChecks({ ...built, models: [...built.models, extra] }, 0.1).join('\n')).toMatch(/extra.*coding.*agentic/);
  });
  it('diffs bands and scores using the family-adjusted score', () => {
    const next = structuredClone(built);
    next.models.find((m) => m.id === 'claude-haiku-5-5')!.scores.coding!.score = 80;
    expect(diffSnapshots(built, next, 0.1).join('\n')).toMatch(/claude-haiku-5-5.*coding.*light.*daily/i);
    expect(diffSnapshots(undefined, built, 0.1)[0]).toMatch(/added/i);
    expect(diffSnapshots(built, built, 0.1)).toEqual([]);
    next.models = next.models.filter((m) => m.id !== 'gpt-6-luna');
    expect(diffSnapshots(built, next, 0.1).join('\n')).toMatch(/removed.*gpt-6-luna/i);
  });
  it('reports score movements of at least one point, band changes, and newly ranked axes', () => {
    const next = structuredClone(built);
    const haiku = next.models.find((m) => m.id === 'claude-haiku-5-5')!;
    haiku.scores.coding!.score += 1;
    expect(diffSnapshots(built, next, 0.1)).toEqual([]);
    haiku.scores.coding!.score += 1;
    expect(diffSnapshots(built, next, 0.1).join('\n')).toMatch(/claude-haiku-5-5.*coding/);
    delete haiku.scores.reasoning;
    expect(diffSnapshots(built, next, 0.1).join('\n')).toMatch(/claude-haiku-5-5.*reasoning.*unranked/i);
    expect(diffSnapshots(next, built, 0.1).join('\n')).toMatch(/claude-haiku-5-5.*reasoning/);
    const edge = structuredClone(built);
    edge.models.find((m) => m.id === 'claude-fable-5-1')!.scores.coding!.score = 82.1;
    expect(diffSnapshots(built, edge, 0.1).join('\n')).toMatch(/claude-fable-5-1.*coding.*frontier.*advanced/i);
  });
  it('includes exact one-point movements despite floating-point rounding', () => {
    const extra: SnapshotModel = { id: 'unknown', aliases: [], provider: 'test', name: 'Unknown', results: [], scores: { coding: { score: 0.4, benchmarks: 2, kind: 'measured' } } };
    const previous = { ...built, models: [...built.models, extra] };
    const next = structuredClone(previous);
    next.models.find((m) => m.id === 'unknown')!.scores.coding!.score = 1.4;
    expect(diffSnapshots(previous, next, 0.1).join('\n')).toMatch(/unknown.*coding.*0\.4.*1\.4/);
    expect(diffSnapshots(next, previous, 0.1).join('\n')).toMatch(/unknown.*coding.*1\.4.*0\.4/);
  });
});
