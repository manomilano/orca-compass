import { describe, expect, it } from 'vitest';
import { axisScore, rescale } from '../../src/evidence/scoring.js';
import type { SnapshotResult } from '../../src/evidence/snapshot.js';

const opus: Pick<SnapshotResult, 'benchmark' | 'value' | 'kind'>[] = [
  { benchmark: 'tbench_4_0', value: 65.15, kind: 'measured' },
  { benchmark: 'vibe_code_bench', value: 90.29, kind: 'measured' },
  { benchmark: 'livebench_coding', value: 87.1, kind: 'measured' },
  { benchmark: 'frontiercode', value: 54.64, kind: 'measured' },
  { benchmark: 'webdev_arena', value: 1817.7, kind: 'measured' },
];

describe('axis scoring', () => {
  it('recomputes Opus 5.5 coding as LLMBenchmark does', () => {
    expect(axisScore(opus, 'coding')).toEqual({ score: expect.closeTo(87.4, 0), benchmarks: 5 });
  });
  it('needs two benchmarks', () => {
    expect(axisScore(opus.slice(0, 1), 'coding')).toBeUndefined();
  });
  it('keeps the best run per benchmark and ignores vendor rows', () => {
    expect(axisScore([...opus, { benchmark: 'tbench_4_0', value: 70, kind: 'measured' }], 'coding')!.score).toBeGreaterThan(axisScore(opus, 'coding')!.score);
    expect(axisScore([...opus, { benchmark: 'swe_bench_vals', value: 99, kind: 'vendor' }], 'coding')).toEqual(axisScore(opus, 'coding'));
  });
  it('clamps outside the range', () => {
    expect(rescale(80, [0, 75])).toBe(100);
    expect(rescale(1100, [1200, 1900])).toBe(0);
  });
});
