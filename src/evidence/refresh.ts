import { DEFAULT_CONFIG } from '../config.js';
import { buildProfile, hintFor, type Profile } from '../placements/profiles.js';
import { knownModelVersion } from '../placements/tiers.js';
import { TIERS } from '../types.js';
import { AXIS_WEIGHTS, axisScore, BENCHMARKS, MIN_BENCHMARKS, rescale } from './scoring.js';
import { AXES, SNAPSHOT_SCHEMA, type Axis, type EvidenceSnapshot, type SnapshotModel, type SnapshotPricing, type SnapshotResult } from './snapshot.js';

export const DEFAULT_BANDS: EvidenceSnapshot['bands'] = {
  coding: [70, 78, 82], agentic: [60, 72, 80], reasoning: [76, 84, 89],
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

interface DatasetModel { id: string; slug: string; provider: string; name: string; releasedAt?: string | null; pricing?: { inputPerM?: unknown; outputPerM?: unknown; basis?: unknown } | null }
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

function validPricing(raw: unknown): SnapshotPricing | undefined {
  if (!object(raw) || typeof raw.inputPerM !== 'number' || !Number.isFinite(raw.inputPerM) || raw.inputPerM < 0 ||
    typeof raw.outputPerM !== 'number' || !Number.isFinite(raw.outputPerM) || raw.outputPerM < 0) return undefined;
  return { inputPerM: raw.inputPerM, outputPerM: raw.outputPerM, ...(typeof raw.basis === 'string' ? { basis: raw.basis } : {}) };
}

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
    const pricing = validPricing(raw.pricing);
    return {
      ...(pricing ? { pricing } : {}),
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
    const pricing = validPricing(raw.pricing);
    if (existing) {
      existing.results.push(...results);
      if (pricing) existing.pricing = pricing;
    }
    else {
      const model: SnapshotModel = {
        id: raw.id as string, provider: raw.provider as string, name: raw.name as string,
        aliases: raw.aliases === undefined ? [] : [...raw.aliases as string[]],
        ...(raw.family !== undefined ? { family: raw.family as string } : {}),
        ...(raw.releasedAt !== undefined ? { releasedAt: raw.releasedAt as string } : {}),
        results, scores: {}, ...(pricing ? { pricing } : {}),
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

const snapshotProfile = (model: SnapshotModel, snapshot: EvidenceSnapshot): Profile =>
  buildProfile(model.id, model, undefined, snapshot, DEFAULT_CONFIG);

export function diffSnapshots(previous: EvidenceSnapshot | undefined, next: EvidenceSnapshot): string[] {
  const before = new Map(previous?.models.map((model) => [model.id, model]));
  const after = new Map(next.models.map((model) => [model.id, model]));
  const lines: string[] = [];
  for (const model of next.models) {
    const old = before.get(model.id);
    if (!old || !previous) { lines.push(`- Added model: ${model.id}`); continue; }
    const oldProfile = snapshotProfile(old, previous);
    const newProfile = snapshotProfile(model, next);
    for (const axis of AXES) {
      const from = oldProfile.axes[axis];
      const to = newProfile.axes[axis];
      if (from.band !== to.band || (from.score !== null && to.score !== null && Math.abs(Math.round(to.score * 10) - Math.round(from.score * 10)) >= 10)) {
        const describe = (value: typeof from): string => value.score !== null ? `${value.band} (${value.score.toFixed(1)})` : 'unranked';
        lines.push(`- ${model.id} ${axis}: ${describe(from)} → ${describe(to)}`);
      }
    }
  }
  for (const model of previous?.models ?? []) {
    if (!after.has(model.id)) lines.push(`- Removed model: ${model.id}`);
  }
  return lines;
}

export function calibrationChecks(snapshot: EvidenceSnapshot): string[] {
  const failures: string[] = [];
  const models = new Map(snapshot.models.map((model) => [model.id, model]));
  for (const [id, want] of [ ['claude-haiku-5-5', 'light'], ['gpt-6-1-terra', 'daily'], ['claude-opus-5-5', 'frontier'], ['claude-fable-5-1', 'frontier'], ['gpt-6-astra', 'frontier'] ] as const) {
    const model = models.get(id);
    const actual = model?.scores.coding && snapshotProfile(model, snapshot).axes.coding;
    if (actual?.band !== want) failures.push(`${id} coding: expected ${want}, got ${actual?.band ?? 'missing model or score'}`);
  }
  return [...failures, ...crossAxisFindings(snapshot, true)];
}

export function calibrationWarnings(snapshot: EvidenceSnapshot): string[] {
  return crossAxisFindings(snapshot, false);
}

function crossAxisFindings(snapshot: EvidenceSnapshot, hinted: boolean): string[] {
  const findings: string[] = [];
  for (const model of snapshot.models) {
    if ((hintFor(model.id, model, undefined, DEFAULT_CONFIG) !== undefined) !== hinted) continue;
    const profile = snapshotProfile(model, snapshot);
    const ranked = AXES.filter((axis) => model.scores[axis] !== undefined);
    const hasPartialEvidence = (axis: Axis): boolean => model.scores[axis]?.kind === 'measured' && model.scores[axis]!.benchmarks >= MIN_BENCHMARKS;
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const a = ranked[i], b = ranked[j];
        // Design 7.4 permits a large gap when both axes have independent evidence.
        if (hasPartialEvidence(a) && hasPartialEvidence(b)) continue;
        const first = profile.axes[a].band!, second = profile.axes[b].band!;
        if (Math.abs(TIERS.indexOf(first) - TIERS.indexOf(second)) > 1) findings.push(`${model.id}: ${a} ${first} and ${b} ${second} differ by more than one band`);
      }
    }
  }
  return findings;
}
