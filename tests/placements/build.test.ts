import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { readTextFile } from '../../src/placements/agents/deps.js';
import { parseSnapshot } from '../../src/evidence/snapshot.js';
import { buildPlacements } from '../../src/placements/build.js';
import { profileModels } from '../../src/placements/profiles.js';
import { MODEL_INDEX_URL } from '../../src/placements/sources/modelindex.js';
import { MODELS_DEV_URL } from '../../src/placements/sources/modelsdev.js';
import { builtWith, readTable } from '../../src/placements/table.js';
import { AGENT_IDS, type AgentDiscovery, type LaunchModel } from '../../src/types.js';
import { VERSION } from '../../src/version.js';
import { machineEnv } from '../helpers/env.js';
import { fakeDeps, fixture, NOW } from '../helpers/fakes.js';

describe('profileModels integration', () => {
  const discoveries: AgentDiscovery[] = machineEnv().discoveries;
  const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;

  it('keeps every model and stores its hint and class beside the profile', () => {
    const placed = profileModels(discoveries, snapshot, DEFAULT_CONFIG);
    expect(placed.map((a) => [a.agent, a.models.length])).toEqual(discoveries.map((d) => [d.agent, d.models.length]));
    const claude = placed.find((a) => a.agent === 'claude')!;
    const fable = claude.models.find((m) => m.modelId === 'claude-fable-5-1')!;
    expect(fable.tiers).toEqual(['frontier']);
    expect(fable.placements).toEqual([{ tier: 'frontier', source: 'family' }]);
    const opus5 = claude.models.find((m) => m.modelId === 'claude-opus-5')!;
    expect(opus5.placements).toEqual([{ tier: 'advanced', source: 'family' }]);
    expect(opus5.tiers).toEqual(['advanced']);
    expect(fable.launch).toEqual({ kind: 'flag', model: 'claude-fable-5-1' });
  });

  it('stores an unclassified model with empty placements', () => {
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'variant', ids: {} }, poolNames: [] };
    const placed = profileModels([{ agent: 'cursor', installed: true, models: [mystery] }], snapshot, DEFAULT_CONFIG);
    expect(placed[0].models[0]).toMatchObject({ modelId: 'mystery-9', placements: [], tiers: [] });
  });

  it('keeps discovery notes and the signed-out flag', () => {
    const placed = profileModels([{ agent: 'grok', installed: true, models: [], note: 'grok models failed', signedOut: true }], snapshot, DEFAULT_CONFIG);
    expect(placed[0]).toEqual({ agent: 'grok', installed: true, models: [], note: 'grok models failed', signedOut: true });
  });
});

describe('buildPlacements', () => {
  const savedHome = process.env.ORCACOMPASS_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'oc-build-'));
    process.env.ORCACOMPASS_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.ORCACOMPASS_HOME;
    else process.env.ORCACOMPASS_HOME = savedHome;
  });

  it('builds from the fixtures and writes placements.json', async () => {
    const { table, saveError } = await buildPlacements(DEFAULT_CONFIG, fakeDeps);
    expect(saveError).toBeUndefined();
    expect(table).toMatchObject({ schemaVersion: 2, version: VERSION, builtAt: NOW, builtWith: builtWith(DEFAULT_CONFIG) });
    expect(table.sources.catalog.source).toBe('snapshot');
    expect(table.sources.scores?.source).toBe('snapshot');
    expect(table.sources.scoreScale).toBeNull();
    expect(table.agents.map((a) => a.agent)).toEqual([...AGENT_IDS]);
    const codex = table.agents.find((a) => a.agent === 'codex')!;
    expect(codex.models.find((m) => m.modelId === 'gpt-6-astra')).toMatchObject({ tiers: ['frontier'], placements: [{ tier: 'frontier', source: 'family' }], profile: { class: 'frontier' } });
    expect(table.agents.find((a) => a.agent === 'grok')).toMatchObject({ installed: false, models: [] });
    expect(readTable(readTextFile, join(home, 'cache'))).toEqual({ table, present: true });
  });

  it('fetches only Models.dev and the repository Model Index snapshot', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
    const { table } = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl });
    expect(urls.sort()).toEqual([MODELS_DEV_URL, MODEL_INDEX_URL].sort());
    expect(Object.keys(table.sources).sort()).toEqual(['catalog', 'scoreScale', 'scores']);
  });

  it('reports an unwritable cache directory and still returns the table', async () => {
    const cacheDir = join(home, 'cache');
    writeFileSync(cacheDir, 'a file where the cache folder should be');
    const { table, saveError } = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, cacheDir });
    expect(saveError).toBeDefined();
    expect(table.agents).toHaveLength(AGENT_IDS.length);
  });

  it('forwards refresh to the metadata sources', async () => {
    // A fresh Models.dev cache is reused by a plain build and refetched by a refresh.
    const cacheDir = join(home, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const snapshot = JSON.parse(readFileSync(new URL('../../data/models-snapshot.json', import.meta.url), 'utf8'));
    writeFileSync(join(cacheDir, 'modelsdev.json'), JSON.stringify({ ...snapshot, fetchedAt: NOW }));
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return fakeDeps.fetchImpl!(input);
    };
    const plain = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl });
    expect(plain.table.sources.catalog.source).toBe('cache');
    expect(urls.some((u) => u.includes('models.dev'))).toBe(false);
    await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl, refresh: true });
    expect(urls.some((u) => u.includes('models.dev'))).toBe(true);
  });
});
