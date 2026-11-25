import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeArchive, parseArchive, RETAIN_DAYS, serializeArchive, type EvidenceArchive } from '../../src/evidence/archive.js';
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

  it(`stops using a row ${RETAIN_DAYS} days after it was last seen but keeps it in the archive`, () => {
    const dropped = mergeArchive(first, later('2026-11-11')).archive;
    const edge = mergeArchive(dropped, later('2027-05-09'));
    expect(edge.retained.length).toBeGreaterThan(0);
    const expired = mergeArchive(edge.archive, later('2027-05-10'));
    expect(expired.retained).toEqual([]);
    expect(scores(expired.dataset).some((row) => row.metric === 'aa_agentic_index')).toBe(false);
    expect(expired.archive.rows.filter((row) => row.metric === 'aa_agentic_index')).toEqual(
      first.rows.filter((row) => row.metric === 'aa_agentic_index').map((row) => ({ ...row, lastSeen: '2026-11-10' })));
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
});
