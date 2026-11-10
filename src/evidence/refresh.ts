import { FAMILY_TIERS, knownModelVersion, MODEL_LINE_TIERS } from '../placements/tiers.js';
import type { Tier } from '../types.js';
import { AXIS_WEIGHTS, axisScore, BENCHMARKS, MIN_BENCHMARKS, rescale } from './scoring.js';
import { AXES, SNAPSHOT_SCHEMA, type Axis, type EvidenceSnapshot, type SnapshotModel, type SnapshotResult } from './snapshot.js';

export const DEFAULT_BANDS: EvidenceSnapshot['bands'] = {
  coding: [68, 76, 84], agentic: [60, 70, 80], reasoning: [70, 78, 86],
};

export const METRIC_MAP: Record<string, { benchmark: string; priority: number }> = {
  vals_terminal_bench_4: { benchmark: 'tbench_4_0', priority: 1 },
  vals_vibe_code: { benchmark: 'vibe_code_bench', priority: 1 },
  livebench_coding: { benchmark: 'livebench_coding', priority: 1 },
  vals_swe_bench: { benchmark: 'swe_bench_vals', priority: 1 },
  epoch_frontiercode: { benchmark: 'frontiercode', priority: 1 },
  webdev_elo: { benchmark: 'webdev_arena', priority: 1 },
  livebench_long_agentic: { benchmark: 'livebench_long_agentic', priority: 1 },
  livebench_browser: { benchmark: 'livebench_browser', priority: 1 },
  aa_agentic_index: { benchmark: 'aa_agentic_index', priority: 1 },
  epoch_gpqa_diamond: { benchmark: 'gpqa_diamond', priority: 1 },
  aa_gpqa: { benchmark: 'gpqa_diamond', priority: 2 },
  gpqa_accuracy: { benchmark: 'gpqa_diamond', priority: 3 },
  aa_hle: { benchmark: 'hle', priority: 1 },
  scale_hle: { benchmark: 'hle', priority: 2 },
  livebench_reasoning: { benchmark: 'livebench_reasoning', priority: 1 },
  epoch_arc_agi_2: { benchmark: 'arc_agi_2', priority: 1 },
};

export const VENDOR_BRIDGE: Record<string, string> = {
  'terminal-bench-4-0': 'tbench_4_0',
  'swe-bench-verified': 'swe_bench_vals',
  gpqa: 'gpqa_diamond',
  'epoch-hle': 'hle',
  hle: 'hle',
  'arc-agi-2': 'arc_agi_2',
  'frontierswe-v2': 'epoch_frontierswe',
};

export function familyOfSlug(slug: string): string | undefined {
  if (/^\d/.test(slug)) return undefined;
  return knownModelVersion(slug)?.family ?? (slug.split(/-\d/)[0] || undefined);
}

export function displayName(raw: string): string {
  return raw.replace(/^[^:]+: /, '');
}

interface DatasetModel { id: string; slug: string; provider: string; name: string; releasedAt?: string | null }
interface DatasetScore {
  modelId: string; metric: string; value: number; unit: string;
  source: string; observedAt: string; sourceUrl: string; setting?: string | null;
}
interface DatasetVendorReport {
  modelId: string; benchmark: string; value: number; unit: string;
  reportedBy: string; observedAt: string; announcementUrl: string; setting?: string | null;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]): boolean => keys.every((key) => typeof value[key] === 'string' && value[key] !== '');

function readDataset(dataset: unknown): { generatedAt: string; models: DatasetModel[]; scores: DatasetScore[]; vendorReports: DatasetVendorReport[] } {
  if (!object(dataset)) throw new Error('dataset: expected an object');
  for (const key of ['models', 'scores', 'vendorReports']) {
    if (!Array.isArray(dataset[key])) throw new Error(`dataset: ${key} must be an array`);
  }
  if (typeof dataset.generatedAt !== 'string') throw new Error('dataset: missing generatedAt');
  const models = dataset.models as unknown[];
  for (const model of models) {
    if (!object(model) || !strings(model, ['id', 'slug', 'provider', 'name']) ||
      (model.releasedAt != null && typeof model.releasedAt !== 'string')) throw new Error('dataset: invalid model');
  }
  const scores = dataset.scores as unknown[];
  const seen = new Set<string>();
  for (const row of scores) {
    if (!object(row) || typeof row.value !== 'number' || !Number.isFinite(row.value)) throw new Error('dataset: score value must be finite');
    if (!strings(row, ['modelId', 'metric', 'unit', 'source', 'observedAt', 'sourceUrl']) ||
      (row.setting != null && typeof row.setting !== 'string')) throw new Error('dataset: invalid score row');
    const key = JSON.stringify([row.modelId, row.metric, row.setting ?? null]);
    if (seen.has(key)) throw new Error(`dataset: duplicate score ${key}`);
    seen.add(key);
  }
  const vendorReports = dataset.vendorReports as unknown[];
  for (const row of vendorReports) {
    if (!object(row) || typeof row.value !== 'number' || !Number.isFinite(row.value)) throw new Error('dataset: vendor value must be finite');
    if (!strings(row, ['modelId', 'benchmark', 'unit', 'reportedBy', 'observedAt', 'announcementUrl']) ||
      (row.setting != null && typeof row.setting !== 'string')) throw new Error('dataset: invalid vendor row');
  }
  return { generatedAt: dataset.generatedAt, models: models as DatasetModel[], scores: scores as DatasetScore[], vendorReports: vendorReports as DatasetVendorReport[] };
}

export interface BuildSnapshotOptions {
  now: string;
  bands: EvidenceSnapshot['bands'];
  curated?: unknown;
  sourceFetchedAt: string;
}

export function buildSnapshot(dataset: unknown, opts: BuildSnapshotOptions): EvidenceSnapshot {
  const data = readDataset(dataset);
  const rowsByModel = new Map<string, DatasetScore[]>();
  for (const row of data.scores) {
    if (!Object.hasOwn(METRIC_MAP, row.metric)) continue;
    const rows = rowsByModel.get(row.modelId) ?? [];
    rows.push(row);
    rowsByModel.set(row.modelId, rows);
  }
  const vendorByModel = new Map<string, DatasetVendorReport[]>();
  for (const row of data.vendorReports) {
    const rows = vendorByModel.get(row.modelId) ?? [];
    rows.push(row);
    vendorByModel.set(row.modelId, rows);
  }
  const models = data.models.map((raw): SnapshotModel => {
    const rows = rowsByModel.get(raw.id) ?? [];
    const priorities = new Map<string, number>();
    for (const row of rows) {
      const { benchmark, priority } = METRIC_MAP[row.metric];
      priorities.set(benchmark, Math.min(priorities.get(benchmark) ?? Infinity, priority));
    }
    const results: SnapshotResult[] = rows.filter((row) => {
      const { benchmark, priority } = METRIC_MAP[row.metric];
      return priority === priorities.get(benchmark);
    }).map((row) => {
      const unit = row.unit === 'ratio' ? 'percent' : row.unit;
      if (unit !== 'percent' && unit !== 'points' && unit !== 'elo') throw new Error(`dataset: unsupported axis unit ${unit}`);
      return {
        benchmark: METRIC_MAP[row.metric].benchmark,
        value: row.unit === 'ratio' ? row.value * 100 : row.value, unit,
        ...(row.setting != null ? { setting: row.setting } : {}),
        kind: 'measured', source: row.source, observedAt: row.observedAt, url: row.sourceUrl,
      };
    });
    const scores: SnapshotModel['scores'] = {};
    for (const axis of AXES) {
      const score = axisScore(results, axis);
      if (score) scores[axis] = { ...score, kind: 'measured' };
    }
    for (const row of vendorByModel.get(raw.id) ?? []) {
      const unit = row.unit === 'ratio' ? 'percent' : row.unit;
      if (unit !== 'percent' && unit !== 'points' && unit !== 'elo') continue;
      results.push({
        benchmark: Object.hasOwn(VENDOR_BRIDGE, row.benchmark) ? VENDOR_BRIDGE[row.benchmark] : row.benchmark,
        value: row.unit === 'ratio' ? row.value * 100 : row.value, unit,
        ...(row.setting != null ? { setting: row.setting } : {}),
        kind: row.reportedBy === raw.provider ? 'vendor' : 'reported',
        source: row.reportedBy, observedAt: row.observedAt, url: row.announcementUrl,
      });
    }
    return {
      id: raw.slug, aliases: [raw.id], provider: raw.provider, name: displayName(raw.name),
      family: familyOfSlug(raw.slug), ...(raw.releasedAt ? { releasedAt: raw.releasedAt } : {}), results, scores,
    };
  });
  return {
    schemaVersion: SNAPSHOT_SCHEMA, generatedAt: opts.now,
    sources: [{ id: 'llmbenchmark', label: 'LLMBenchmark.ai', url: 'https://llmbenchmark.ai', license: 'CC BY 4.0', fetchedAt: opts.sourceFetchedAt, dataDate: data.generatedAt }],
    benchmarks: structuredClone(BENCHMARKS),
    axes: { coding: { weights: { ...AXIS_WEIGHTS.coding } }, agentic: { weights: { ...AXIS_WEIGHTS.agentic } }, reasoning: { weights: { ...AXIS_WEIGHTS.reasoning } } },
    bands: structuredClone(opts.bands), models: estimateScores(mergeCurated(models, opts.curated), BENCHMARKS),
  };
}

export function mergeCurated(models: SnapshotModel[], curated: unknown): SnapshotModel[] {
  if (curated === undefined) return models;
  if (!object(curated) || !Array.isArray(curated.models)) throw new Error('curated: models must be an array');
  const merged = models.map((model) => ({ ...model, results: [...model.results] }));
  const byId = new Map(merged.map((model) => [model.id, model]));
  for (const raw of curated.models as unknown[]) {
    if (!object(raw) || !strings(raw, ['id', 'provider', 'name']) || !Array.isArray(raw.results) ||
      (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || !raw.aliases.every((alias) => typeof alias === 'string'))) ||
      (raw.family !== undefined && typeof raw.family !== 'string') ||
      (raw.releasedAt !== undefined && typeof raw.releasedAt !== 'string')) throw new Error('curated: invalid model');
    const results: SnapshotResult[] = raw.results.map((row: unknown) => {
      if (!object(row) || !strings(row, ['benchmark', 'source', 'url', 'observedAt']) ||
        typeof row.value !== 'number' || !Number.isFinite(row.value) ||
        (row.kind !== 'vendor' && row.kind !== 'reported') ||
        (row.unit !== 'percent' && row.unit !== 'points' && row.unit !== 'elo') ||
        (row.setting !== undefined && typeof row.setting !== 'string')) throw new Error('curated: invalid result; expected vendor/reported evidence with url and observedAt');
      return {
        benchmark: Object.hasOwn(VENDOR_BRIDGE, row.benchmark as string) ? VENDOR_BRIDGE[row.benchmark as string] : row.benchmark as string,
        value: row.value, unit: row.unit, kind: row.kind,
        source: row.source as string, url: row.url as string, observedAt: row.observedAt as string,
        ...(row.setting !== undefined ? { setting: row.setting as string } : {}),
      };
    });
    const existing = byId.get(raw.id as string);
    if (existing) existing.results.push(...results);
    else {
      const model: SnapshotModel = {
        id: raw.id as string, provider: raw.provider as string, name: raw.name as string,
        aliases: raw.aliases === undefined ? [] : [...raw.aliases as string[]],
        ...(raw.family !== undefined ? { family: raw.family as string } : {}),
        ...(raw.releasedAt !== undefined ? { releasedAt: raw.releasedAt as string } : {}),
        results, scores: {},
      };
      merged.push(model);
      byId.set(model.id, model);
    }
  }
  return merged;
}

export function estimateScores(models: SnapshotModel[], benchmarks: EvidenceSnapshot['benchmarks']): SnapshotModel[] {
  const used = new Set<SnapshotResult>();
  const estimated = models.map((model): SnapshotModel => {
    const scores = { ...model.scores };
    for (const axis of AXES) {
      if (scores[axis]?.kind === 'measured') continue;
      for (const samePublication of [true, false]) {
        const candidates: number[] = [];
        const shared = new Set<string>();
        const rows = new Set<SnapshotResult>();
        for (const target of model.results) {
          if (target.kind !== 'vendor' && target.kind !== 'reported') continue;
          const benchmark = Object.hasOwn(benchmarks, target.benchmark) ? benchmarks[target.benchmark] : undefined;
          if (benchmark ? target.unit !== benchmark.unit : target.unit !== 'percent') continue;
          const range: [number, number] = benchmark?.range ?? [0, 100];
          for (const reference of models) {
            if (reference.id === model.id || reference.scores[axis]?.kind !== 'measured') continue;
            const matching = reference.results.filter((row) => row.benchmark === target.benchmark && row.unit === target.unit &&
              (!samePublication || row.source === target.source));
            const measured = matching.filter((row) => row.kind === 'measured');
            const preferred = measured.length ? measured : matching.filter((row) => row.kind === 'vendor' || row.kind === 'reported');
            for (const row of preferred) {
              candidates.push(reference.scores[axis]!.score + rescale(target.value, range) - rescale(row.value, range));
              shared.add(target.benchmark);
              rows.add(target);
              rows.add(row);
            }
          }
        }
        if (shared.size < MIN_BENCHMARKS) continue;
        candidates.sort((a, b) => a - b);
        const mid = Math.floor(candidates.length / 2);
        const median = candidates.length % 2 ? candidates[mid] : (candidates[mid - 1] + candidates[mid]) / 2;
        scores[axis] = { score: Math.round(Math.max(0, Math.min(100, median)) * 10) / 10, benchmarks: shared.size, kind: 'estimated' };
        for (const row of rows) used.add(row);
        break;
      }
    }
    return { ...model, scores };
  });
  return estimated.map((model) => ({ ...model, results: model.results.filter((row) => row.kind === 'measured' || used.has(row)) }));
}

const CLASS_POINTS: Record<Tier, number> = { light: 25, daily: 50, advanced: 75, frontier: 100 };
const BANDS: readonly Tier[] = ['light', 'daily', 'advanced', 'frontier'];

/** Family-only hints for the refresh builder; local lineup descriptions are unavailable. */
export function hintPointsOf(model: SnapshotModel): number | undefined {
  const family = model.family ?? knownModelVersion(model.id)?.family;
  const tier = family && Object.hasOwn(FAMILY_TIERS, family) ? FAMILY_TIERS[family] : MODEL_LINE_TIERS.find((line) => line.pattern.test(model.id))?.tier;
  return tier === undefined ? undefined : CLASS_POINTS[tier];
}

function placement(model: SnapshotModel, axis: Axis, snapshot: EvidenceSnapshot, classWeight: number): { score: number; band: Tier } | undefined {
  const evidence = model.scores[axis];
  if (!evidence) return undefined;
  const points = hintPointsOf(model);
  const score = Math.round((points === undefined ? evidence.score : (1 - classWeight) * evidence.score + classWeight * points) * 10) / 10;
  const band = BANDS[snapshot.bands[axis].filter((cut) => score >= cut).length];
  return { score, band };
}

export function diffSnapshots(previous: EvidenceSnapshot | undefined, next: EvidenceSnapshot, classWeight: number): string[] {
  const before = new Map(previous?.models.map((model) => [model.id, model]));
  const after = new Map(next.models.map((model) => [model.id, model]));
  const lines: string[] = [];
  for (const model of next.models) {
    const old = before.get(model.id);
    if (!old || !previous) { lines.push(`- Added model: ${model.id}`); continue; }
    for (const axis of AXES) {
      const from = placement(old, axis, previous, classWeight);
      const to = placement(model, axis, next, classWeight);
      if (from?.band !== to?.band || (from && to && Math.abs(Math.round(to.score * 10) - Math.round(from.score * 10)) >= 10)) {
        const describe = (value: typeof from): string => value ? `${value.band} (${value.score.toFixed(1)})` : 'unranked';
        lines.push(`- ${model.id} ${axis}: ${describe(from)} → ${describe(to)}`);
      }
    }
  }
  for (const model of previous?.models ?? []) {
    if (!after.has(model.id)) lines.push(`- Removed model: ${model.id}`);
  }
  return lines;
}

export function calibrationChecks(snapshot: EvidenceSnapshot, classWeight: number): string[] {
  const failures: string[] = [];
  const models = new Map(snapshot.models.map((model) => [model.id, model]));
  for (const [id, want] of [ ['claude-fable-5-1', 'frontier'], ['gpt-6-astra', 'frontier'], ['claude-opus-5-5', 'frontier'], ['claude-haiku-5-5', 'light'] ] as const) {
    const model = models.get(id);
    const actual = model && placement(model, 'coding', snapshot, classWeight);
    if (actual?.band !== want) failures.push(`${id} coding: expected ${want}, got ${actual?.band ?? 'missing model or score'}`);
  }
  const fable = models.get('claude-fable-5-1'), sonnet = models.get('claude-sonnet-5-5');
  for (const axis of AXES) {
    const higher = fable && placement(fable, axis, snapshot, classWeight);
    const lower = sonnet && placement(sonnet, axis, snapshot, classWeight);
    if (!higher || !lower || higher.score <= lower.score) failures.push(`claude-fable-5-1 must rank above claude-sonnet-5-5 on ${axis}${!higher || !lower ? ' (missing model or score)' : ''}`);
  }
  for (const model of snapshot.models) {
    const ranked = AXES.filter((axis) => model.scores[axis] !== undefined);
    const hasPartialEvidence = (axis: Axis): boolean => model.scores[axis]?.kind === 'measured' && model.scores[axis]!.benchmarks >= MIN_BENCHMARKS;
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const a = ranked[i], b = ranked[j];
        // Design 7.4 permits a large gap when both axes have independent evidence.
        if (hasPartialEvidence(a) && hasPartialEvidence(b)) continue;
        const first = placement(model, a, snapshot, classWeight)!, second = placement(model, b, snapshot, classWeight)!;
        if (Math.abs(BANDS.indexOf(first.band) - BANDS.indexOf(second.band)) > 1) failures.push(`${model.id}: ${a} ${first.band} and ${b} ${second.band} differ by more than one band`);
      }
    }
  }
  return failures;
}
