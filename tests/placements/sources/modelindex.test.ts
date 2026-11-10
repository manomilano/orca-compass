import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRatings, fetchUpstreamRatings, loadRatings, MODEL_INDEX_URL, MODEL_INDEX_UPSTREAM_URL, toRatings } from '../../../src/placements/sources/modelindex.js';
import { cacheDir } from '../../../src/paths.js';

const mini = JSON.parse(readFileSync(new URL('../../fixtures/modelindex-mini.json', import.meta.url), 'utf8'));
const snapshot = { fetchedAt: 123, ratings: toRatings(mini) };
const ok = async () => new Response(JSON.stringify(snapshot));
const offline = async (): Promise<Response> => {
  throw new Error('offline');
};
const HOUR = 3_600_000;

const saved = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-modelindex-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('toRatings', () => {
  it('keeps the maintainer import pointed at the upstream provider', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(mini)));
    expect(await fetchUpstreamRatings(fetchImpl)).toEqual(snapshot.ratings);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(MODEL_INDEX_UPSTREAM_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(MODEL_INDEX_UPSTREAM_URL).toBe('https://themodelindex.org/data/models.json');
  });
  it('keeps scored, priced entries trimmed to the fields we use', () => {
    const ratings = toRatings(mini);
    expect(ratings.find((r) => r.id === 'glm-5-2')).toEqual({
      id: 'glm-5-2', name: 'GLM-5.2', date: '2026-06-16', score: 156.4, out: 7, orId: 'z-ai/glm-5.2', hf: 'zai-org/GLM-5.2', open: true,
    });
    expect(ratings.find((r) => r.id === 'muse-wonder')).toEqual({
      id: 'muse-wonder', name: 'Muse Wonder', date: '2026-10-12', score: 180.3, out: 20, orId: 'meta/muse-wonder', open: false,
    });
  });

  it('drops entries without a score or a positive price, and tolerates garbage', () => {
    const ids = toRatings(mini).map((r) => r.id);
    expect(ids).not.toContain('chatgpt');
    expect(ids).not.toContain('unscored');
    expect(ids).not.toContain('free-model');
    expect(toRatings(null)).toEqual([]);
    expect(toRatings({ models: 'nope' })).toEqual([]);
    expect(toRatings({ models: [null, 3, { id: 'x', index: { score: '1' }, api: { out: 1 } }] })).toEqual([]);
  });
});

describe('loadRatings', () => {
  it('fetches maintained scores from the public repository, then serves a stale cache when offline', async () => {
    const now = Date.now();
    const spy = vi.fn(ok);
    const net = await loadRatings({ ttlHours: 24, now, fetchImpl: spy });
    expect(net).toMatchObject({ source: 'network', fetchedAt: now });
    expect(spy.mock.calls[0][0]).toBe(MODEL_INDEX_URL);
    expect(MODEL_INDEX_URL).toBe('https://raw.githubusercontent.com/manomilano/orca-compass/main/data/modelindex-snapshot.json');
    expect(((spy.mock.calls[0] as unknown[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const stale = await loadRatings({ ttlHours: 24, now: now + 48 * HOUR, fetchImpl: offline });
    expect(stale).toMatchObject({ source: 'cache', fetchedAt: now });
    expect(stale!.ratings.find((r) => r.id === 'kimi-k3')).toBeDefined();
  });

  it('refresh picks up changed scores from the repository without contacting the upstream provider', async () => {
    await loadRatings({ ttlHours: 24, now: 1000, fetchImpl: ok });
    const changed = structuredClone(snapshot);
    changed.ratings.find(r => r.id === 'kimi-k3')!.score = 199;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(changed)));
    const result = await loadRatings({ ttlHours: 24, now: 2000, refresh: true, fetchImpl });
    expect(result?.source).toBe('network');
    expect(result?.ratings.find(r => r.id === 'kimi-k3')?.score).toBe(199);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(MODEL_INDEX_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('rejects malformed repository scores and preserves the last valid cache', async () => {
    await loadRatings({ ttlHours: 24, now: 1000, fetchImpl: ok });
    const changed = structuredClone(snapshot);
    changed.ratings[0].out = -1;
    const before = readFileSync(join(cacheDir(), 'modelindex.json'), 'utf8');
    const fetchImpl = async () => new Response(JSON.stringify(changed));
    await expect(fetchRatings(fetchImpl)).rejects.toThrow(/invalid/);
    expect((await loadRatings({ ttlHours: 24, now: 2000, refresh: true, fetchImpl }))?.source).toBe('cache');
    expect(readFileSync(join(cacheDir(), 'modelindex.json'), 'utf8')).toBe(before);
  });

  it('writes {fetchedAt, ratings} to <cacheDir>/modelindex.json', async () => {
    await loadRatings({ ttlHours: 24, now: 123, fetchImpl: ok });
    const cached = JSON.parse(readFileSync(join(cacheDir(), 'modelindex.json'), 'utf8'));
    expect(cached.fetchedAt).toBe(123);
    expect(cached.ratings.find((r: { id: string }) => r.id === 'grok-4-6').score).toBe(169.7);
  });

  it('uses a fresh cache without fetching, unless refresh is set', async () => {
    const now = Date.now();
    await loadRatings({ ttlHours: 24, now, fetchImpl: ok });
    const spy = vi.fn(ok);
    expect((await loadRatings({ ttlHours: 24, now: now + HOUR, fetchImpl: spy }))?.source).toBe('cache');
    expect(spy).not.toHaveBeenCalled();
    expect((await loadRatings({ ttlHours: 24, now: now + HOUR, fetchImpl: spy, refresh: true }))?.source).toBe('network');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to the bundled snapshot on HTTP errors, empty data or a malformed cache', async () => {
    expect((await loadRatings({ ttlHours: 24, fetchImpl: offline }))?.source).toBe('snapshot');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: async () => new Response('boom', { status: 500 }) }))?.source).toBe('snapshot');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: async () => new Response('{"models":[]}') }))?.source).toBe('snapshot');
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), 'modelindex.json'), '{not json');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: offline }))?.source).toBe('snapshot');
  });
});
