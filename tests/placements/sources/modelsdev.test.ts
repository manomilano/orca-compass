import type { ModelMeta, Effort } from '../../../src/types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCatalog, PROVIDERS, toModelIndex } from '../../../src/placements/sources/modelsdev.js';
import { cacheDir } from '../../../src/paths.js';

const mini = JSON.parse(readFileSync(new URL('../../fixtures/modelsdev-mini.json', import.meta.url), 'utf8'));
const ok = async () => new Response(JSON.stringify(mini));
const offline = async (): Promise<Response> => {
  throw new Error('offline');
};
const HOUR = 3_600_000;

const saved = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-modelsdev-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('toModelIndex', () => {
  it('maps the fields we use', () => {
    const idx = toModelIndex(mini);
    expect(idx['claude-opus-5-5']).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      provider: 'anthropic',
      family: 'claude-opus',
      outputCost: 20,
      releaseDate: '2026-09-22',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect((idx['claude-haiku-5-5'] as ModelMeta & { efforts: Effort[] }).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect((idx['gpt-6-luna'] as ModelMeta & { efforts: Effort[] }).efforts).toContain('none');
  });

  it('keeps only known providers', () => {
    const idx = toModelIndex(mini);
    expect(idx['mistral-small-2506']).toBeUndefined();
    expect(Object.values(idx).every((m) => (PROVIDERS as readonly string[]).includes(m.provider))).toBe(true);
  });

  it('lets the first provider in priority order win an id clash', () => {
    const raw = {
      xai: { models: { shared: { id: 'shared', name: 'From xAI' } } },
      anthropic: { models: { shared: { id: 'shared', name: 'From Anthropic' } } },
    };
    expect(toModelIndex(raw).shared).toMatchObject({ provider: 'anthropic', name: 'From Anthropic' });
  });

  it('tolerates garbage and drops unknown efforts', () => {
    expect(toModelIndex(null)).toEqual({});
    expect(toModelIndex({ openai: { models: 'nope' } })).toEqual({});
    const raw = {
      openai: {
        models: { m: { id: 'm', reasoning_options: [{ type: 'effort', values: ['ultra', 'Extra-High', 'low'] }] } },
      },
    };
    expect(toModelIndex(raw).m).toEqual({ id: 'm', name: 'm', provider: 'openai', efforts: ['xhigh', 'low'] });
  });
});

describe('loadCatalog', () => {
  it('falls back to the bundled snapshot on an offline first run', async () => {
    const r = await loadCatalog({ ttlHours: 24, fetchImpl: offline });
    expect(r.source).toBe('snapshot');
    expect(r.index['claude-opus-5-5']).toBeDefined();
  });

  it('fetches from the network, then serves a stale cache when offline', async () => {
    const now = Date.now();
    const net = await loadCatalog({ ttlHours: 24, now, fetchImpl: ok });
    expect(net.source).toBe('network');
    expect(net.fetchedAt).toBe(now);
    expect(net.index['gpt-6-luna']).toBeDefined();

    const stale = await loadCatalog({ ttlHours: 24, now: now + 48 * HOUR, fetchImpl: offline });
    expect(stale).toMatchObject({ source: 'cache', fetchedAt: now });
    expect(stale.index['gpt-6-luna']).toBeDefined();
  });

  it('writes {fetchedAt, index} to <cacheDir>/modelsdev.json', async () => {
    await loadCatalog({ ttlHours: 24, now: 123, fetchImpl: ok });
    const cached = JSON.parse(readFileSync(join(cacheDir(), 'modelsdev.json'), 'utf8'));
    expect(cached.fetchedAt).toBe(123);
    expect(cached.index['claude-opus-5-5'].provider).toBe('anthropic');
  });

  it('uses a fresh cache without fetching, unless refresh is set', async () => {
    const now = Date.now();
    await loadCatalog({ ttlHours: 24, now, fetchImpl: ok });
    const spy = vi.fn(ok);
    const fresh = await loadCatalog({ ttlHours: 24, now: now + HOUR, fetchImpl: spy });
    expect(fresh.source).toBe('cache');
    expect(spy).not.toHaveBeenCalled();

    const refreshed = await loadCatalog({ ttlHours: 24, now: now + HOUR, fetchImpl: spy, refresh: true });
    expect(refreshed.source).toBe('network');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('refetches once the cache is older than the TTL', async () => {
    const now = Date.now();
    await loadCatalog({ ttlHours: 24, now, fetchImpl: ok });
    const r = await loadCatalog({ ttlHours: 24, now: now + 25 * HOUR, fetchImpl: ok });
    expect(r).toMatchObject({ source: 'network', fetchedAt: now + 25 * HOUR });
  });

  it('passes a timeout signal to fetch', async () => {
    const spy = vi.fn(ok);
    await loadCatalog({ ttlHours: 24, fetchImpl: spy });
    const init = spy.mock.calls[0] as unknown[];
    expect((init[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('treats HTTP errors and empty catalogs as fetch failures', async () => {
    const http500 = async () => new Response('boom', { status: 500 });
    expect((await loadCatalog({ ttlHours: 24, fetchImpl: http500 })).source).toBe('snapshot');
    const empty = async () => new Response('{}');
    expect((await loadCatalog({ ttlHours: 24, fetchImpl: empty })).source).toBe('snapshot');
  });

  it('ignores a malformed cache file', async () => {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), 'modelsdev.json'), '{not json');
    expect((await loadCatalog({ ttlHours: 24, fetchImpl: offline })).source).toBe('snapshot');
  });
});

describe('bundled snapshot', () => {
  it('contains the current Claude and GPT models', async () => {
    const { index } = await loadCatalog({ ttlHours: 24, fetchImpl: offline });
    for (const id of [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]) {
      expect(index[id], id).toBeDefined();
    }
  });
});
