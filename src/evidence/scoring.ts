import type { Axis, EvidenceSnapshot, SnapshotResult } from './snapshot.js';

export const MIN_BENCHMARKS = 2;

export const AXIS_WEIGHTS: Record<Axis, Record<string, number>> = {
  coding: { tbench_4_0: 25, vibe_code_bench: 20, livebench_coding: 15, swe_bench_vals: 15, frontiercode: 15, webdev_arena: 10 },
  agentic: { tbench_4_0: 30, livebench_long_agentic: 30, livebench_browser: 20, aa_agentic_index: 20 },
  reasoning: { gpqa_diamond: 30, hle: 30, livebench_reasoning: 20, arc_agi_2: 20 },
};

export const BENCHMARKS: EvidenceSnapshot['benchmarks'] = {
  tbench_4_0: { name: 'Terminal-Bench 4', range: [0, 75], unit: 'percent', source: 'vals.ai' },
  vibe_code_bench: { name: 'Vibe Code Bench', range: [0, 100], unit: 'percent', source: 'vals.ai' },
  livebench_coding: { name: 'LiveBench coding', range: [0, 100], unit: 'percent', source: 'livebench.ai' },
  swe_bench_vals: { name: 'SWE-bench Verified', range: [0, 100], unit: 'percent', source: 'vals.ai' },
  frontiercode: { name: 'FrontierCode', range: [0, 65], unit: 'percent', source: 'epoch.ai' },
  webdev_arena: { name: 'LMArena WebDev', range: [1200, 1900], unit: 'elo', source: 'lmarena.ai' },
  livebench_long_agentic: { name: 'LiveBench Long Agentic', range: [0, 100], unit: 'percent', source: 'livebench.ai' },
  livebench_browser: { name: 'LiveBench Browser', range: [0, 100], unit: 'percent', source: 'livebench.ai' },
  aa_agentic_index: { name: 'AA Agentic Index', range: [0, 65], unit: 'points', source: 'artificialanalysis.ai' },
  gpqa_diamond: { name: 'GPQA Diamond', range: [0, 100], unit: 'percent', source: 'epoch.ai' },
  hle: { name: 'Humanity’s Last Exam', range: [0, 70], unit: 'percent', source: 'artificialanalysis.ai' },
  livebench_reasoning: { name: 'LiveBench Reasoning', range: [0, 100], unit: 'percent', source: 'livebench.ai' },
  arc_agi_2: { name: 'ARC-AGI-2', range: [0, 100], unit: 'percent', source: 'epoch.ai' },
};

export function rescale(value: number, range: [number, number]): number {
  return Math.max(0, Math.min(100, (value - range[0]) / (range[1] - range[0]) * 100));
}

export function axisScore(
  results: Pick<SnapshotResult, 'benchmark' | 'value' | 'kind'>[],
  axis: Axis,
  benchmarks: EvidenceSnapshot['benchmarks'] = BENCHMARKS,
  weights: Record<string, number> = AXIS_WEIGHTS[axis],
): { score: number; benchmarks: number } | undefined {
  const best = new Map<string, number>();
  for (const result of results) {
    if (result.kind !== 'measured' || !Object.hasOwn(weights, result.benchmark) || !Object.hasOwn(benchmarks, result.benchmark)) continue;
    const previous = best.get(result.benchmark);
    if (previous === undefined || result.value > previous) best.set(result.benchmark, result.value);
  }
  if (best.size < MIN_BENCHMARKS) return undefined;
  let total = 0;
  let weight = 0;
  for (const [benchmark, value] of best) {
    total += rescale(value, benchmarks[benchmark].range) * weights[benchmark];
    weight += weights[benchmark];
  }
  return { score: Math.round(total / weight * 10) / 10, benchmarks: best.size };
}
