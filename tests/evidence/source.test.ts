import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheDir } from '../../src/paths.js';
import { EVIDENCE_MANIFEST_URL, EVIDENCE_SNAPSHOT_URL, loadEvidence, parseManifest } from '../../src/evidence/source.js';

const mini = JSON.parse(readFileSync(new URL('../fixtures/evidence-mini.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3_600_000;
const newer = { ...mini, generatedAt: '2099-01-01T00:00:00Z' };
const text = JSON.stringify(newer);
const manifestFor = (body: string, generatedAt = newer.generatedAt) => ({
  generatedAt, schemaVersion: 1, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body),
});
const offline = async (): Promise<Response> => { throw new Error('offline'); };
const savedHome = process.env.ORCACOMPASS_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-evidence-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function seedCache(checkedAt = NOW, snapshot = mini) {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(join(cacheDir(), 'evidence-snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(cacheDir(), 'evidence-check.json'), JSON.stringify({ checkedAt, generatedAt: snapshot.generatedAt }));
}

function repository(body = text, manifest: unknown = manifestFor(body)) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === EVIDENCE_MANIFEST_URL) return new Response(JSON.stringify(manifest));
    if (url === EVIDENCE_SNAPSHOT_URL) return new Response(body);
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { urls, fetchImpl };
}

describe('parseManifest', () => {
  it('accepts the repository manifest', () => {
    expect(parseManifest(manifestFor(text))).toEqual(manifestFor(text));
  });
  it.each([
    null, '{', {}, { ...manifestFor(text), schemaVersion: 2 },
    { ...manifestFor(text), generatedAt: 'yesterday' }, { ...manifestFor(text), sha256: 'bad' },
    { ...manifestFor(text), bytes: -1 }, { ...manifestFor(text), bytes: 1.5 },
  ])('rejects invalid manifest fields: %j', (raw) => {
    expect(parseManifest(raw)).toBeUndefined();
  });
});

describe('loadEvidence', () => {
  it('uses the bundled snapshot offline', async () => {
    const evidence = await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: offline });
    expect(evidence.source).toBe('snapshot');
    expect(evidence.snapshot.models.length).toBeGreaterThan(50);
    expect(evidence.fetchedAt).toBe(Date.parse(evidence.snapshot.generatedAt));
  });

  it('downloads when the manifest is newer and caches the original file bytes', async () => {
    seedCache();
    const body = JSON.stringify(newer, null, 2) + '\n';
    const repo = repository(body);
    const evidence = await loadEvidence({ ttlHours: 24, now: NOW, refresh: true, fetchImpl: repo.fetchImpl });
    expect(evidence).toEqual({ snapshot: newer, source: 'network', fetchedAt: NOW });
    expect(repo.urls).toEqual([EVIDENCE_MANIFEST_URL, EVIDENCE_SNAPSHOT_URL]);
    expect(readFileSync(join(cacheDir(), 'evidence-snapshot.json'), 'utf8')).toBe(body);
    expect(JSON.parse(readFileSync(join(cacheDir(), 'evidence-check.json'), 'utf8'))).toEqual({ checkedAt: NOW, generatedAt: newer.generatedAt });
    const cached = await loadEvidence({ ttlHours: 24, now: NOW + HOUR, fetchImpl: repo.fetchImpl });
    expect(cached).toEqual({ snapshot: newer, source: 'cache', fetchedAt: NOW });
    expect(repo.urls).toHaveLength(2);
  });

  it('confirms an unchanged snapshot without downloading it', async () => {
    seedCache(NOW - 24 * HOUR);
    const repo = repository(JSON.stringify(mini), manifestFor(JSON.stringify(mini), mini.generatedAt));
    expect(await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: repo.fetchImpl })).toEqual({ snapshot: mini, source: 'network', fetchedAt: NOW });
    expect(repo.urls).toEqual([EVIDENCE_MANIFEST_URL]);
    expect(JSON.parse(readFileSync(join(cacheDir(), 'evidence-check.json'), 'utf8')).checkedAt).toBe(NOW);
  });

  it('accepts a fresh check at the epoch', async () => {
    seedCache(0);
    const repo = repository();
    expect(await loadEvidence({ ttlHours: 24, now: HOUR, fetchImpl: repo.fetchImpl })).toEqual({ snapshot: mini, source: 'cache', fetchedAt: 0 });
    expect(repo.urls).toEqual([]);
  });

  it.each([['not JSON', '{'], ['schema 2', JSON.stringify({ ...newer, schemaVersion: 2 })], ['truncated JSON', '{"schemaVersion":1']])('falls back when the downloaded snapshot is unusable: %s', async (_, body) => {
    const repo = repository(body);
    expect((await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: repo.fetchImpl })).source).toBe('snapshot');
    seedCache(NOW - 48 * HOUR);
    expect(await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: repo.fetchImpl })).toEqual({ snapshot: mini, source: 'cache', fetchedAt: NOW - 48 * HOUR });
    expect(readFileSync(join(cacheDir(), 'evidence-snapshot.json'), 'utf8')).toBe(JSON.stringify(mini));
    expect(JSON.parse(readFileSync(join(cacheDir(), 'evidence-check.json'), 'utf8')).checkedAt).toBe(NOW - 48 * HOUR);
  });

  it.each([
    { ...manifestFor(text), sha256: '0'.repeat(64) },
    { ...manifestFor(text), bytes: Buffer.byteLength(text) + 1 },
    { ...manifestFor(text), generatedAt: '2098-01-01' },
  ])('falls back when snapshot integrity or identity differs from the manifest: %j', async (manifest) => {
    expect((await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: repository(text, manifest).fetchImpl })).source).toBe('snapshot');
  });

  it.each([
    async () => new Response('{'),
    async () => new Response('{}'),
    async () => new Response('error', { status: 500 }),
    async (url: unknown) => url === EVIDENCE_MANIFEST_URL ? new Response(JSON.stringify(manifestFor(text))) : new Response('error', { status: 503 }),
  ])('preserves the stale cache on manifest or HTTP failure', async (fetchImpl) => {
    seedCache(NOW - 48 * HOUR);
    expect(await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl })).toEqual({ snapshot: mini, source: 'cache', fetchedAt: NOW - 48 * HOUR });
  });

  it('ignores a malformed cached snapshot even with a fresh check', async () => {
    seedCache();
    writeFileSync(join(cacheDir(), 'evidence-snapshot.json'), '{');
    expect((await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: offline })).source).toBe('snapshot');
  });

  it.each(['{', JSON.stringify({ checkedAt: NOW, generatedAt: 'different' }), JSON.stringify({ checkedAt: NOW + HOUR, generatedAt: mini.generatedAt })])('does not treat an invalid check as fresh: %s', async (check) => {
    seedCache();
    writeFileSync(join(cacheDir(), 'evidence-check.json'), check);
    const repo = repository();
    expect((await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: repo.fetchImpl })).source).toBe('network');
    expect(repo.urls).toHaveLength(2);
  });

  it('uses an explicit cache directory and tolerates an unwritable cache', async () => {
    const custom = join(home, 'custom');
    expect((await loadEvidence({ ttlHours: 24, now: NOW, cacheDir: custom, fetchImpl: repository().fetchImpl })).source).toBe('network');
    expect(readFileSync(join(custom, 'evidence-snapshot.json'), 'utf8')).toBe(text);
    const blocked = join(home, 'file');
    writeFileSync(blocked, 'cannot be a directory');
    expect((await loadEvidence({ ttlHours: 24, now: NOW, cacheDir: blocked, fetchImpl: repository().fetchImpl })).source).toBe('network');
  });
});
