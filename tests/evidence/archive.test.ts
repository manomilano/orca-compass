import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { archiveSummary, mergeArchive, parseArchive, serializeArchive, STALE_DAYS, type EvidenceArchive } from '../../src/evidence/archive.js';
import { buildProfile } from '../../src/placements/profiles.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { buildSnapshot, DEFAULT_BANDS, METRIC_MAP } from '../../src/evidence/refresh.js';

interface Score { modelId: string; metric: string; value: number; observedAt: string; setting?: string }
const dataset = JSON.parse(readFileSync(new URL('../fixtures/llmb-dataset-mini.json', import.meta.url), 'utf8'));
const mapped = (dataset.scores as Score[]).filter((row) => Object.hasOwn(METRIC_MAP, row.metric)).length;

/** The fixture on a later date, with the AA agentic index rows removed, as LLMBenchmark did in November 2026. */
function later(date: string, keep: (row: Score) => boolean = (row) => row.metric !== 'aa_agentic_index') {
  const next = structuredClone(dataset);
  next.generatedAt = `${date}T04:00:00.000Z`;
  next.scores = (next.scores as Score[]).filter(keep).map((row) => ({ ...row, observedAt: date }));
  return next;
}
const scores = (value: unknown): Score[] => (value as { scores: Score[] }).scores;
const first = mergeArchive(undefined, dataset).archive;

describe('evidence archive', () => {
  it('records every axis score row once, dated by the dataset', () => {
    const merge = mergeArchive(undefined, dataset);
    expect(merge.archive).toMatchObject({ schemaVersion: 1, dataDate: '2026-11-10' });
    expect(merge.archive.rows).toHaveLength(mapped);
    expect(merge.archive.rows.every((row) => Object.hasOwn(METRIC_MAP, row.metric) && row.lastSeen === undefined)).toBe(true);
    expect(merge.retained).toEqual([]);
    expect(scores(merge.dataset)).toHaveLength(dataset.scores.length);
  });

  it('puts back a dropped row with the date it was last seen, so its axis stays measured', () => {
    const merge = mergeArchive(first, later('2026-11-25'));
    expect(merge.retained.length).toBeGreaterThan(0);
    expect(merge.retained.every((row) => row.metric === 'aa_agentic_index' && row.lastSeen === '2026-11-10')).toBe(true);
    const back = scores(merge.dataset).filter((row) => row.metric === 'aa_agentic_index');
    expect(back).toHaveLength(merge.retained.length);
    expect(back.every((row) => row.observedAt === '2026-11-10')).toBe(true);
    const opts = { now: '2026-11-25T05:00:00Z', bands: DEFAULT_BANDS, sourceFetchedAt: '2026-11-25' };
    const withArchive = buildSnapshot(merge.dataset, opts).models.find((m) => m.id === 'gpt-6-astra')!;
    expect(withArchive.results.find((row) => row.benchmark === 'aa_agentic_index')).toMatchObject({ value: 51, observedAt: '2026-11-10', kind: 'measured' });
    expect(withArchive.scores.agentic).toEqual(buildSnapshot(dataset, opts).models.find((m) => m.id === 'gpt-6-astra')!.scores.agentic);
  });

  it(`keeps counting a row after ${STALE_DAYS} days and calls it out only in the refresh summary`, () => {
    const dropped = mergeArchive(first, later('2026-11-11')).archive;
    const opts = (now: string) => ({ now: `${now}T05:00:00Z`, bands: DEFAULT_BANDS, sourceFetchedAt: now });
    const merge = (date: string) => mergeArchive(dropped, later(date));
    const agentic = (date: string) => buildProfile('gpt-6-astra', undefined, undefined, buildSnapshot(merge(date).dataset, opts(date)), DEFAULT_CONFIG).axes.agentic;
    const original = buildProfile('gpt-6-astra', undefined, undefined, buildSnapshot(dataset, opts('2026-11-10')), DEFAULT_CONFIG).axes.agentic;
    expect(agentic('2027-05-10')).toEqual(original);
    // The metric has no live rows left, so the summary says it is no longer published.
    const fresh = archiveSummary(merge('2027-05-09'));
    expect(fresh[0]).toMatch(/^Kept \d+ score rows for \d+ models from the evidence archive/);
    expect(fresh).toContainEqual(expect.stringMatching(/^- aa_agentic_index: \d+ rows, last seen 2026-11-10 or later; the dataset no longer publishes this metric at all$/));
    expect(fresh.some((line) => line.includes(`older than ${STALE_DAYS} days`))).toBe(false);
    expect(archiveSummary(merge('2027-05-10')).some((line) => line.includes(`older than ${STALE_DAYS} days and still count`))).toBe(true);
    expect(archiveSummary(mergeArchive(first, dataset))).toEqual([]);
  });

  it('does not add back a source of a benchmark that another source still reports', () => {
    const lost = 'openai/gpt-6-astra';
    // Epoch (priority 1) drops the model while AA (priority 2) still reports its GPQA. The archived Epoch row
    // would win on priority and freeze the score, so it stays archived only.
    const next = later('2026-11-25', (row) => !(row.modelId === lost && row.metric === 'epoch_gpqa_diamond'));
    expect(next.scores.some((row: Score) => row.modelId === lost && row.metric === 'aa_gpqa')).toBe(true);
    const merge = mergeArchive(first, next);
    expect(merge.retained.some((row) => row.modelId === lost && row.metric === 'epoch_gpqa_diamond')).toBe(false);
    const gpqa = buildSnapshot(merge.dataset, { now: '2026-11-25T05:00:00Z', bands: DEFAULT_BANDS, sourceFetchedAt: '2026-11-25' })
      .models.find((m) => m.id === 'gpt-6-astra')!.results.filter((r) => r.benchmark === 'gpqa_diamond');
    expect(gpqa.every((r) => r.source !== 'epoch')).toBe(true);
    // Once every GPQA source is gone, the archived rows come back.
    const none = later('2026-11-25', (row) => !(row.modelId === lost && ['epoch_gpqa_diamond', 'aa_gpqa', 'gpqa_accuracy'].includes(row.metric)));
    expect(mergeArchive(first, none).retained.some((row) => row.modelId === lost && row.metric === 'epoch_gpqa_diamond')).toBe(true);
  });

  it('adds back a metric a model lost entirely, not a setting it dropped beside others', () => {
    const row = first.rows.find((r) => r.metric === 'aa_hle')!;
    const archive = structuredClone(first);
    // A low-effort setting the source no longer reports, while it still reports the model's other aa_hle row.
    archive.rows.push({ ...row, setting: 'Retired', value: 0.05 });
    const merge = mergeArchive(archive, later('2026-11-25', () => true));
    expect(merge.retained).toEqual([]);
    expect(merge.archive.rows.find((r) => r.modelId === row.modelId && r.metric === 'aa_hle' && r.setting === 'Retired')).toMatchObject({ lastSeen: '2026-11-10' });
  });

  it('clears the missing date when a row returns and keeps its first date until the value changes', () => {
    const dropped = mergeArchive(first, later('2026-11-11')).archive;
    const back = mergeArchive(dropped, later('2026-11-12', () => true)).archive;
    expect(back.rows).toEqual(first.rows);
    const changed = later('2026-11-13', () => true);
    const row = scores(changed).find((s) => s.metric === 'aa_agentic_index' && s.modelId === 'openai/gpt-6-astra')!;
    row.value = 52;
    const updated = mergeArchive(back, changed).archive.rows.find((s) => s.metric === 'aa_agentic_index' && s.modelId === 'openai/gpt-6-astra');
    expect(updated).toMatchObject({ value: 52, observedAt: '2026-11-13' });
    expect(updated!.lastSeen).toBeUndefined();
  });

  it('changes nothing when the same dataset is merged again', () => {
    const once = mergeArchive(first, later('2026-11-25'));
    const twice = mergeArchive(once.archive, later('2026-11-25'));
    expect(serializeArchive(twice.archive)).toBe(serializeArchive(once.archive));
    expect(twice.retained).toEqual(once.retained);
  });

  it('refuses a dataset older than the archive', () => {
    const archive = mergeArchive(first, later('2026-11-25')).archive;
    expect(() => mergeArchive(archive, dataset)).toThrow('older than the evidence archive');
  });

  it('round-trips through its file format and rejects invalid or duplicate rows', () => {
    const archive = mergeArchive(first, later('2026-11-25')).archive;
    const text = serializeArchive(archive);
    expect(parseArchive(text)).toEqual(archive);
    expect(text.split('\n')).toHaveLength(archive.rows.length + 7);
    expect(parseArchive(undefined)).toBeUndefined();
    const broken = (change: (a: EvidenceArchive) => void) => {
      const copy = structuredClone(archive);
      change(copy);
      return () => parseArchive(JSON.stringify(copy));
    };
    expect(broken((a) => { a.dataDate = 'today'; })).toThrow('invalid header');
    expect(broken((a) => { a.rows[0].value = Number.NaN; })).toThrow('invalid row');
    expect(broken((a) => { a.rows[0].lastSeen = 'yesterday'; })).toThrow('invalid row');
    expect(broken((a) => { a.rows.push({ ...a.rows[0] }); })).toThrow('duplicate row');
  });

  it('keeps a metric the refresh no longer reads archived without adding it back as a duplicate', () => {
    const archive = structuredClone(first);
    const row = archive.rows.find((r) => r.metric === 'aa_agentic_index')!;
    // An archived row of a metric that is no longer mapped, which the dataset still carries.
    archive.rows.push({ ...row, metric: 'retired_metric', lastSeen: undefined });
    const next = later('2026-11-25', () => true);
    next.scores.push({ ...next.scores[0], modelId: row.modelId, metric: 'retired_metric', value: 1, unit: 'ratio' });
    const merge = mergeArchive(archive, next);
    expect(merge.retained.some((r) => r.metric === 'retired_metric')).toBe(false);
    expect(merge.archive.rows.some((r) => r.metric === 'retired_metric')).toBe(true);
    expect(() => buildSnapshot(merge.dataset, { now: '2026-11-25T05:00:00Z', bands: DEFAULT_BANDS, sourceFetchedAt: '2026-11-25' })).not.toThrow();
  });

  it('stores an empty setting or a timestamp in a form the next refresh can read', () => {
    const next = later('2026-11-25', () => true);
    const odd = next.scores.find((r: Score) => r.metric === 'aa_agentic_index')!;
    odd.setting = '';
    odd.observedAt = '2026-11-25T04:00:00.000Z';
    const bad = next.scores.find((r: Score) => r.metric === 'vals_terminal_bench_4')!;
    bad.observedAt = 'yesterday';
    const merge = mergeArchive(first, next);
    const text = serializeArchive(merge.archive);
    expect(() => parseArchive(text)).not.toThrow();
    const stored = merge.archive.rows.find((r) => r.modelId === odd.modelId && r.metric === 'aa_agentic_index')!;
    expect(stored.setting).toBeUndefined();
    // Same value as in the first archive, so the first date it was seen is kept.
    expect(stored.observedAt).toBe('2026-11-10');
    // The empty setting is the same row as the archived one without a setting, so nothing is reported missing.
    expect(merge.retained).toEqual([]);
    expect(merge.archive.rows.find((r) => r.modelId === bad.modelId && r.metric === 'vals_terminal_bench_4')!.observedAt).toMatch(/^2026-11-(10|25)$/);
  });

  it('rejects impossible calendar dates', () => {
    const text = serializeArchive({ ...first, dataDate: '2026-02-31' });
    expect(() => parseArchive(text)).toThrow('invalid header');
    expect(() => mergeArchive(undefined, { ...dataset, generatedAt: '2026-13-01T00:00:00Z' })).toThrow('expected generatedAt');
  });

  it('does not add back or count rows of a model the dataset no longer lists', () => {
    const gone = 'openai/gpt-6-astra';
    const next = later('2026-11-25', (row) => row.modelId !== gone);
    next.models = next.models.filter((m: { id: string }) => m.id !== gone);
    const merge = mergeArchive(first, next);
    expect(merge.retained.some((r) => r.modelId === gone)).toBe(false);
    expect(merge.archive.rows.some((r) => r.modelId === gone)).toBe(true);
  });
});
