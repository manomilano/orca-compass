import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDir as defaultCacheDir } from '../paths.js';
import type { DataSource } from '../types.js';
import { parseSnapshot, SNAPSHOT_SCHEMA, type EvidenceSnapshot } from './snapshot.js';

export const EVIDENCE_MANIFEST_URL = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/data/evidence-manifest.json';
export const EVIDENCE_SNAPSHOT_URL = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/data/evidence-snapshot.json';
export const BUNDLED_URL = new URL('../../data/evidence-snapshot.json', import.meta.url);
const FETCH_TIMEOUT_MS = 10_000;

export interface Manifest { generatedAt: string; schemaVersion: number; sha256: string; bytes: number }
export interface Evidence { snapshot: EvidenceSnapshot; source: DataSource; fetchedAt: number }

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseManifest(raw: unknown): Manifest | undefined {
  if (!object(raw) || raw.schemaVersion !== SNAPSHOT_SCHEMA || typeof raw.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.generatedAt)) || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256) ||
    typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0) return undefined;
  return { generatedAt: raw.generatedAt, schemaVersion: raw.schemaVersion, sha256: raw.sha256, bytes: raw.bytes };
}

async function readText(path: string | URL): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}

function checkedAt(text: string | undefined, generatedAt: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(text ?? '');
    if (object(raw) && raw.generatedAt === generatedAt && typeof raw.checkedAt === 'number' &&
      Number.isFinite(raw.checkedAt) && raw.checkedAt >= 0) return raw.checkedAt;
  } catch { /* Missing or invalid check metadata must not make a cache fresh. */ }
  return undefined;
}

/** Fresh cache → repository manifest/snapshot → stale cache → bundled snapshot. */
export async function loadEvidence(opts: {
  ttlHours: number;
  now?: number;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
  cacheDir?: string;
  /** The last-resort snapshot; the one shipped in the package unless a test supplies its own. */
  bundled?: string | URL;
}): Promise<Evidence> {
  const now = opts.now ?? Date.now();
  const directory = opts.cacheDir ?? defaultCacheDir();
  const snapshotFile = join(directory, 'evidence-snapshot.json');
  const checkFile = join(directory, 'evidence-check.json');
  const cached = parseSnapshot(await readText(snapshotFile));
  const fetchedAt = cached ? checkedAt(await readText(checkFile), cached.generatedAt) : undefined;
  if (cached && fetchedAt !== undefined && !opts.refresh && now >= fetchedAt && now - fetchedAt < opts.ttlHours * 3_600_000) {
    return { snapshot: cached, source: 'cache', fetchedAt };
  }

  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const get = async (url: string): Promise<Response> => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
      if (!response.ok) throw new Error(`repository evidence: HTTP ${response.status}`);
      return response;
    };
    const manifest = parseManifest(await (await get(EVIDENCE_MANIFEST_URL)).json());
    if (!manifest) throw new Error('repository evidence: invalid manifest');
    let snapshot = cached;
    let bytes: Buffer | undefined;
    if (!snapshot || snapshot.generatedAt !== manifest.generatedAt) {
      bytes = Buffer.from(await (await get(EVIDENCE_SNAPSHOT_URL)).arrayBuffer());
      if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
        throw new Error('repository evidence: snapshot integrity mismatch');
      }
      snapshot = parseSnapshot(bytes.toString('utf8'));
      if (!snapshot || snapshot.generatedAt !== manifest.generatedAt) throw new Error('repository evidence: invalid snapshot');
    }
    try {
      await mkdir(directory, { recursive: true });
      if (bytes) await writeFile(snapshotFile, bytes);
      await writeFile(checkFile, JSON.stringify({ checkedAt: now, generatedAt: snapshot.generatedAt }));
    } catch { /* An unwritable cache only costs another manifest check next time. */ }
    return { snapshot, source: 'network', fetchedAt: now };
  } catch {
    if (cached) return { snapshot: cached, source: 'cache', fetchedAt: fetchedAt ?? 0 };
  }

  const snapshot = parseSnapshot(await readText(opts.bundled ?? BUNDLED_URL));
  if (!snapshot) throw new Error('bundled evidence snapshot unreadable');
  return { snapshot, source: 'snapshot', fetchedAt: Date.parse(snapshot.generatedAt) };
}
