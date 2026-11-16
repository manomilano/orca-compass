import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDir as defaultCacheDir } from '../paths.js';
import type { DataSource } from '../types.js';
import { parseSnapshot, SNAPSHOT_SCHEMA, type EvidenceSnapshot } from './snapshot.js';

export const EVIDENCE_MANIFEST_URL = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/data/evidence-manifest.json';
export const EVIDENCE_SNAPSHOT_URL = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/data/evidence-snapshot.json';
export const BUNDLED_URL = new URL('../../data/evidence-snapshot.json', import.meta.url);
export const BUNDLED_MANIFEST_URL = new URL('../../data/evidence-manifest.json', import.meta.url);
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

function manifestTime(text: string | undefined): number | undefined {
  try {
    const manifest = parseManifest(JSON.parse(text ?? ''));
    return manifest && Date.parse(manifest.generatedAt);
  } catch { return undefined; }
}

/**
 * When the packaged snapshot was generated, from its small manifest, so commands can tell evidence older than the
 * installed release without parsing the large snapshot. Undefined when the manifest is missing or invalid.
 */
export function bundledEvidenceTime(manifest: string | URL = BUNDLED_MANIFEST_URL): number | undefined {
  let text: string | undefined;
  try { text = readFileSync(manifest, 'utf8'); } catch { /* treated as unknown */ }
  return manifestTime(text);
}

/**
 * Newest of cache → repository manifest/snapshot → bundled snapshot. A fresh cache is used without a check unless
 * it is older than the bundled snapshot, which happens right after an upgrade; no path returns a snapshot older
 * than the bundled one while that one is readable.
 */
export async function loadEvidence(opts: {
  ttlHours: number;
  now?: number;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
  cacheDir?: string;
  /** The last-resort snapshot; the one shipped in the package unless a test supplies its own. */
  bundled?: string | URL;
  /** The bundled snapshot's manifest; read instead of the snapshot to date it cheaply. A supplied `bundled` has none by default. */
  bundledManifest?: string | URL;
}): Promise<Evidence> {
  const now = opts.now ?? Date.now();
  const directory = opts.cacheDir ?? defaultCacheDir();
  const snapshotFile = join(directory, 'evidence-snapshot.json');
  const checkFile = join(directory, 'evidence-check.json');
  const cached = parseSnapshot(await readText(snapshotFile));
  const fetchedAt = cached ? checkedAt(await readText(checkFile), cached.generatedAt) : undefined;

  let bundledRead: Promise<{ text: string; snapshot: EvidenceSnapshot } | undefined> | undefined;
  const readBundled = () => bundledRead ??= (async () => {
    const text = await readText(opts.bundled ?? BUNDLED_URL);
    const snapshot = parseSnapshot(text);
    return text !== undefined && snapshot ? { text, snapshot } : undefined;
  })();
  const manifestFile = opts.bundledManifest ?? (opts.bundled === undefined ? BUNDLED_MANIFEST_URL : undefined);
  let bundledAt = manifestFile === undefined ? undefined : manifestTime(await readText(manifestFile));
  if (bundledAt === undefined) {
    // Without a manifest (a test fixture or a damaged install), date the bundled snapshot by parsing it.
    const bundled = await readBundled();
    bundledAt = bundled && Date.parse(bundled.snapshot.generatedAt);
  }
  const olderThanBundled = (generatedAt: string) => bundledAt !== undefined && Date.parse(generatedAt) < bundledAt;

  // A cache older than the bundled snapshot predates an upgrade: it is never used while the bundled one is readable.
  const cacheCurrent = cached !== undefined && !olderThanBundled(cached.generatedAt);
  if (cached && cacheCurrent && fetchedAt !== undefined && !opts.refresh && now >= fetchedAt && now - fetchedAt < opts.ttlHours * 3_600_000) {
    return { snapshot: cached, source: 'cache', fetchedAt };
  }
  const bundled = cacheCurrent ? undefined : await readBundled();
  // An unreadable bundled snapshot cannot outrank anything.
  if (!cacheCurrent && !bundled) bundledAt = undefined;
  // The newest snapshot already on disk.
  const local = bundled ? { snapshot: bundled.snapshot, text: bundled.text } : cached && { snapshot: cached, text: undefined };

  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const get = async (url: string): Promise<Response> => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
      if (!response.ok) throw new Error(`repository evidence: HTTP ${response.status}`);
      return response;
    };
    const manifest = parseManifest(await (await get(EVIDENCE_MANIFEST_URL)).json());
    if (!manifest) throw new Error('repository evidence: invalid manifest');
    let snapshot = local?.snapshot;
    // Bundled bytes are copied into the cache, so the next call finds them fresh and skips this check.
    let bytes: Buffer | string | undefined = local?.text;
    // The repository can lag the release (a release built before its evidence reached main): never step below the bundled snapshot.
    if (!snapshot || (snapshot.generatedAt !== manifest.generatedAt && !olderThanBundled(manifest.generatedAt))) {
      bytes = Buffer.from(await (await get(EVIDENCE_SNAPSHOT_URL)).arrayBuffer());
      if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
        throw new Error('repository evidence: snapshot integrity mismatch');
      }
      snapshot = parseSnapshot(bytes.toString('utf8'));
      if (!snapshot || snapshot.generatedAt !== manifest.generatedAt) throw new Error('repository evidence: invalid snapshot');
    }
    try {
      await mkdir(directory, { recursive: true });
      if (bytes !== undefined) await writeFile(snapshotFile, bytes);
      await writeFile(checkFile, JSON.stringify({ checkedAt: now, generatedAt: snapshot.generatedAt }));
    } catch { /* An unwritable cache only costs another manifest check next time. */ }
    // 'network' means the repository was checked now, also when it had nothing newer than what is on disk.
    return { snapshot, source: 'network', fetchedAt: now };
  } catch {
    if (bundled) return { snapshot: bundled.snapshot, source: 'snapshot', fetchedAt: Date.parse(bundled.snapshot.generatedAt) };
    if (cached) return { snapshot: cached, source: 'cache', fetchedAt: fetchedAt ?? 0 };
  }
  throw new Error('bundled evidence snapshot unreadable');
}
