import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEffort } from '../../routing/effort.js';
import type { Effort, ModelIndex, ModelMeta } from '../../types.js';
import { cacheDir } from '../../paths.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Lookup priority: the first provider wins when two share a model id. */
export const PROVIDERS = ['anthropic', 'openai', 'google', 'xai'] as const;

export type CatalogSource = 'network' | 'cache' | 'snapshot';

export interface Catalog {
  index: ModelIndex;
  source: CatalogSource;
  fetchedAt: number;
}

interface Stored {
  fetchedAt: number;
  index: ModelIndex;
}

const FETCH_TIMEOUT_MS = 10_000;
// Same relative path from src/placements/sources/ (Vitest) and dist/placements/sources/ (built).
const SNAPSHOT_URL = new URL('../../../data/models-snapshot.json', import.meta.url);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function toEfforts(options: unknown): Effort[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const opt = options.find((o) => isObject(o) && o.type === 'effort');
  if (!isObject(opt) || !Array.isArray(opt.values)) return undefined;
  const efforts: Effort[] = [];
  for (const v of opt.values) {
    const e = typeof v === 'string' ? parseEffort(v) : undefined;
    if (e && !efforts.includes(e)) efforts.push(e);
  }
  return efforts.length > 0 ? efforts : undefined;
}

function toMeta(key: string, raw: Record<string, unknown>, provider: string): ModelMeta {
  const id = str(raw.id) ?? key;
  const meta: ModelMeta & { outputCost?: number; efforts?: Effort[] } = { id, provider, name: str(raw.name) ?? id };
  const family = str(raw.family);
  if (family) meta.family = family;
  const releaseDate = str(raw.release_date);
  if (releaseDate) meta.releaseDate = releaseDate;
  const output = isObject(raw.cost) ? raw.cost.output : undefined;
  if (typeof output === 'number' && Number.isFinite(output)) meta.outputCost = output;
  const efforts = toEfforts(raw.reasoning_options);
  if (efforts) meta.efforts = efforts;
  return meta;
}

/** Trims a Models.dev api.json payload down to the providers and fields we route on. */
export function toModelIndex(raw: unknown): ModelIndex {
  const index: ModelIndex = {};
  if (!isObject(raw)) return index;
  for (const provider of PROVIDERS) {
    const p = raw[provider];
    if (!isObject(p) || !isObject(p.models)) continue;
    for (const [key, m] of Object.entries(p.models)) {
      if (!isObject(m)) continue;
      const meta = toMeta(key, m, provider);
      if (!(meta.id in index)) index[meta.id] = meta;
    }
  }
  return index;
}

/** Fetches and trims Models.dev; throws on network/HTTP errors or an empty result. */
export async function fetchModelIndex(fetchImpl: typeof fetch = fetch): Promise<ModelIndex> {
  const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev: HTTP ${res.status}`);
  const index = toModelIndex(await res.json());
  if (Object.keys(index).length === 0) throw new Error('models.dev: no models for known providers');
  return index;
}

async function readStored(path: string | URL): Promise<Stored | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(data) && typeof data.fetchedAt === 'number' && isObject(data.index)) {
      return { fetchedAt: data.fetchedAt, index: data.index as ModelIndex };
    }
  } catch {
    // missing or unreadable: treated as absent
  }
  return undefined;
}

/** Fresh cache → network (then cache it) → stale cache → bundled snapshot. */
export async function loadCatalog(opts: {
  ttlHours: number;
  now?: number;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}): Promise<Catalog> {
  const now = opts.now ?? Date.now();
  const cacheFile = join(cacheDir(), 'modelsdev.json');
  const cached = await readStored(cacheFile);
  if (cached && !opts.refresh && now - cached.fetchedAt < opts.ttlHours * 3_600_000) {
    return { ...cached, source: 'cache' };
  }

  try {
    const index = await fetchModelIndex(opts.fetchImpl);
    try {
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ fetchedAt: now, index } satisfies Stored));
    } catch {
      // an unwritable cache only costs a refetch next time
    }
    return { index, source: 'network', fetchedAt: now };
  } catch {
    if (cached) return { ...cached, source: 'cache' };
  }

  const snapshot = await readStored(SNAPSHOT_URL);
  if (!snapshot) throw new Error(`bundled Models.dev snapshot missing or invalid: ${fileURLToPath(SNAPSHOT_URL)}`);
  return { ...snapshot, source: 'snapshot' };
}
