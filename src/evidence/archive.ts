import { METRIC_MAP } from './refresh.js';

/**
 * The evidence archive keeps the last known value of every axis score row LLMBenchmark has
 * published, so a row the dataset later drops is not lost. The refresh never deletes rows: the archive
 * is also the record to recover from. A refresh puts a dropped row back into the dataset only when the
 * model has no live row of that benchmark left, dated to the last dataset that had it, and it keeps
 * counting however old it gets. The refresh summary (in the update pull request) reports them.
 */
export const ARCHIVE_SCHEMA = 1;
/** Restored rows last seen longer ago than this are called out in the refresh summary. */
export const STALE_DAYS = 180;

export interface ArchiveRow {
  modelId: string; metric: string; setting?: string;
  value: number; unit: string; source: string; sourceUrl: string;
  /** The dataset date on which this value was first seen. */
  observedAt: string;
  /** Set once the row is missing from the dataset: the date of the last dataset that had it. */
  lastSeen?: string;
}

export interface EvidenceArchive { schemaVersion: 1; dataDate: string; rows: ArchiveRow[] }

interface ScoreRow { modelId: string; metric: string; value: number; unit: string; source: string; observedAt: string; sourceUrl: string; setting?: string | null }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
/** An empty setting is no setting, so the dataset and the archive name the same row the same way. */
const key = (row: { modelId: string; metric: string; setting?: string | null }): string => JSON.stringify([row.modelId, row.metric, row.setting || null]);
const days = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
/** A real calendar day as YYYY-MM-DD; Date.parse would roll 2026-02-31 over to March. */
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && DATE.test(value) && Number.isFinite(days(value)) && new Date(days(value) * 86_400_000).toISOString().slice(0, 10) === value;

export function parseArchive(source: string | undefined): EvidenceArchive | undefined {
  if (source === undefined) return undefined;
  const value: unknown = JSON.parse(source);
  if (!object(value) || value.schemaVersion !== ARCHIVE_SCHEMA || !validDate(value.dataDate) ||
    !Array.isArray(value.rows)) throw new Error('evidence archive: invalid header');
  const seen = new Set<string>();
  for (const row of value.rows as unknown[]) {
    if (!object(row) || !text(row.modelId) || !text(row.metric) || !text(row.unit) || !text(row.source) || !text(row.sourceUrl) ||
      typeof row.value !== 'number' || !Number.isFinite(row.value) ||
      !validDate(row.observedAt) ||
      (row.setting !== undefined && !text(row.setting)) ||
      (row.lastSeen !== undefined && !validDate(row.lastSeen))) throw new Error('evidence archive: invalid row');
    const id = key(row as unknown as ArchiveRow);
    if (seen.has(id)) throw new Error(`evidence archive: duplicate row ${id}`);
    seen.add(id);
  }
  return value as unknown as EvidenceArchive;
}

/** One row per line, sorted, so the archive diff shows exactly which rows changed. */
export function serializeArchive(archive: EvidenceArchive): string {
  const { rows, ...header } = archive;
  const start = JSON.stringify(header, null, 2).slice(0, -2);
  return `${start},\n  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}

export interface ArchiveMerge {
  archive: EvidenceArchive;
  /** The dataset with the retained rows added to its scores. */
  dataset: unknown;
  /** Archived rows added back: benchmarks a listed model no longer has any live row of. */
  retained: ArchiveRow[];
}

/**
 * Records the dataset's axis score rows in the archive, then adds back the archived rows of every benchmark
 * a model has lost entirely. A setting the source stopped reporting while it kept others (a low-effort
 * run beside the high-effort one), or a source of a benchmark another source still reports (the lower
 * priority one would be overridden by a frozen value), stays archived only. Dates come from the dataset, not the clock, so
 * running it again on the same dataset and archive changes nothing.
 */
export function mergeArchive(previous: EvidenceArchive | undefined, dataset: unknown): ArchiveMerge {
  if (!object(dataset) || typeof dataset.generatedAt !== 'string' || !validDate(dataset.generatedAt.slice(0, 10)) ||
    !Array.isArray(dataset.scores)) throw new Error('dataset: expected generatedAt and scores');
  const date = dataset.generatedAt.slice(0, 10);
  // Rows of models the dataset no longer lists are kept in the archive but not added back: nothing would use them.
  const listed = Array.isArray(dataset.models)
    ? new Set((dataset.models as unknown[]).filter(object).map((model) => model.id).filter((id): id is string => typeof id === 'string'))
    : undefined;
  if (previous && date < previous.dataDate) throw new Error(`dataset from ${date} is older than the evidence archive (${previous.dataDate})`);
  const rows = new Map((previous?.rows ?? []).map((row) => [key(row), row]));
  const present = new Set<string>();
  const measured = new Set<string>();
  for (const raw of dataset.scores as ScoreRow[]) {
    if (!object(raw) || !Object.hasOwn(METRIC_MAP, raw.metric)) continue;
    const id = key(raw);
    present.add(id);
    measured.add(JSON.stringify([raw.modelId, METRIC_MAP[raw.metric].benchmark]));
    const old = rows.get(id);
    const same = old && old.value === raw.value && old.unit === raw.unit && old.source === raw.source && old.sourceUrl === raw.sourceUrl;
    // Store only what parseArchive accepts, so one odd dataset row cannot make the next refresh refuse the archive.
    const observed = typeof raw.observedAt === 'string' ? raw.observedAt.slice(0, 10) : '';
    rows.set(id, {
      modelId: raw.modelId, metric: raw.metric, ...(raw.setting ? { setting: raw.setting } : {}),
      value: raw.value, unit: raw.unit, source: raw.source, sourceUrl: raw.sourceUrl,
      observedAt: same ? old.observedAt : validDate(observed) ? observed : date,
    });
  }
  const retained: ArchiveRow[] = [];
  for (const [id, row] of rows) {
    if (present.has(id)) continue;
    const missing = row.lastSeen === undefined ? { ...row, lastSeen: previous!.dataDate } : row;
    rows.set(id, missing);
    // A metric the refresh no longer reads stays archived; adding it back would duplicate the dataset's own row.
    if (!Object.hasOwn(METRIC_MAP, row.metric) || (listed && !listed.has(row.modelId))) continue;
    if (!measured.has(JSON.stringify([row.modelId, METRIC_MAP[row.metric].benchmark]))) retained.push(missing);
  }
  const sorted = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  const added: ScoreRow[] = retained.map((row) => ({
    modelId: row.modelId, metric: row.metric, value: row.value, unit: row.unit, source: row.source,
    observedAt: row.lastSeen!, sourceUrl: row.sourceUrl, ...(row.setting !== undefined ? { setting: row.setting } : {}),
  }));
  return {
    archive: { schemaVersion: ARCHIVE_SCHEMA, dataDate: date, rows: sorted },
    dataset: { ...dataset, scores: [...dataset.scores, ...added] },
    retained,
  };
}

/**
 * Lines for the refresh summary in the update pull request: restored rows per metric, metrics the dataset
 * no longer publishes at all, and restored rows older than STALE_DAYS. Empty when nothing was restored.
 */
export function archiveSummary(merge: ArchiveMerge): string[] {
  if (!merge.retained.length) return [];
  const dataset = merge.dataset as { generatedAt: string; scores: ScoreRow[] };
  const restored = new Set(merge.retained.map(key));
  const live = new Set(dataset.scores.filter((row) => !restored.has(key(row))).map((row) => row.metric));
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const byMetric = new Map<string, ArchiveRow[]>();
  for (const row of merge.retained) byMetric.set(row.metric, [...(byMetric.get(row.metric) ?? []), row]);
  const models = new Set(merge.retained.map((row) => row.modelId)).size;
  const lines = [`Kept ${plural(merge.retained.length, 'score row')} for ${plural(models, 'model')} from the evidence archive (the dataset no longer has them):`, ''];
  for (const [metric, rows] of [...byMetric].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const oldest = rows.map((row) => row.lastSeen!).sort()[0];
    const retired = live.has(metric) ? '' : '; the dataset no longer publishes this metric at all';
    lines.push(`- ${metric}: ${plural(rows.length, 'row')}, last seen ${oldest} or later${retired}`);
  }
  const date = dataset.generatedAt.slice(0, 10);
  const old = merge.retained.filter((row) => days(date) - days(row.lastSeen!) > STALE_DAYS);
  if (old.length) lines.push('', `${plural(old.length, 'restored row')} ${old.length === 1 ? 'is' : 'are'} older than ${STALE_DAYS} days and still count${old.length === 1 ? 's' : ''}; consider replacing ${old.length === 1 ? 'it' : 'them'}.`);
  return [...lines, ''];
}
