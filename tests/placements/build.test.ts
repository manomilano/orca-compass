import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { readTextFile } from '../../src/placements/agents/deps.js';
import { parseSnapshot } from '../../src/evidence/snapshot.js';
import { buildPlacements } from '../../src/placements/build.js';
import { profileModels } from '../../src/placements/profiles.js';
import { EVIDENCE_MANIFEST_URL } from '../../src/evidence/source.js';
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
    expect(fable.profile.class).toBe('frontier');
    expect(fable).not.toHaveProperty('tiers');
    expect(fable).not.toHaveProperty('placements');
    expect(fable.profile.hint).toEqual({ tier: 'frontier', source: 'family' });
    const opus5 = claude.models.find((m) => m.modelId === 'claude-opus-5')!;
    expect(opus5.profile.hint).toEqual({ tier: 'advanced', source: 'family' });
    expect(opus5.profile.class).toBe('advanced');
    expect(fable.launch).toEqual({ kind: 'flag', model: 'claude-fable-5-1' });
  });

  it('stores an unclassified model with an unranked profile', () => {
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'variant', ids: {} }, poolNames: [] };
    const placed = profileModels([{ agent: 'cursor', installed: true, models: [mystery] }], snapshot, DEFAULT_CONFIG);
    expect(placed[0].models[0]).toMatchObject({ modelId: 'mystery-9', profile: { class: null } });
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
    expect(table).toMatchObject({ schemaVersion: 4, version: VERSION, builtAt: NOW, builtWith: builtWith(DEFAULT_CONFIG) });
    expect(table.sources.evidence.source).toBe('snapshot');
    expect(table.sources.evidence.generatedAt).toBeDefined();
    expect(table.bands.coding).toEqual([68, 76, 84]);
    expect(table.agents.find((a) => a.agent === 'claude')!.models.every((m) => m.profile)).toBe(true);
    expect(table.agents.map((a) => a.agent)).toEqual([...AGENT_IDS]);
    const codex = table.agents.find((a) => a.agent === 'codex')!;
    expect(codex.models.find((m) => m.modelId === 'gpt-6-astra')).toMatchObject({ profile: { class: 'frontier' } });
    expect(table.agents.find((a) => a.agent === 'grok')).toMatchObject({ installed: false, models: [] });
    expect(readTable(readTextFile, join(home, 'cache'))).toEqual({ table, present: true });
  });

  it('fetches only the repository evidence manifest while offline', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => { urls.push(String(url)); throw new Error('offline'); };
    const { table } = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl });
    expect(urls.sort()).toEqual([EVIDENCE_MANIFEST_URL]);
    expect(Object.keys(table.sources).sort()).toEqual(['evidence']);
  });

  it('reports an unwritable cache directory and still returns the table', async () => {
    const cacheDir = join(home, 'cache');
    writeFileSync(cacheDir, 'a file where the cache folder should be');
    const { table, saveError } = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, cacheDir });
    expect(saveError).toBeDefined();
    expect(table.agents).toHaveLength(AGENT_IDS.length);
  });

  it('forwards refresh to the evidence source', async () => {
    // Fresh evidence is reused by a plain build and checked again by a refresh.
    const cacheDir = join(home, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const snapshot = JSON.parse(fixture('evidence-mini.json'));
    writeFileSync(join(cacheDir, 'evidence-snapshot.json'), JSON.stringify(snapshot));
    writeFileSync(join(cacheDir, 'evidence-check.json'), JSON.stringify({ generatedAt: snapshot.generatedAt, checkedAt: NOW }));
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return fakeDeps.fetchImpl!(input);
    };
    const plain = await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl });
    expect(plain.table.sources.evidence.source).toBe('cache');
    expect(urls).toEqual([]);
    await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, fetchImpl, refresh: true });
    expect(urls).toEqual([EVIDENCE_MANIFEST_URL]);
  });
});
