import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { buildPlacements } from '../../src/placements/build.js';
import { gather, gatherEnvironment, loadPlacements } from '../../src/routing/environment.js';
import type { Runner } from '../../src/system/run.js';
import { AGENT_IDS, type Config } from '../../src/types.js';
import { fakeDeps, NOW, runner } from '../helpers/fakes.js';

const HOUR = 3_600_000;
const savedHome = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'oc-env-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = savedHome;
});

/** A runner that records the first argument of every command it is asked to run. */
const recording = (calls: string[]): Runner => async (cmd, args) => (calls.push(args[0]), runner(cmd, args));

describe('loadPlacements', () => {
  it('builds the table on first use and reuses it on the next call', async () => {
    const calls: string[] = [];
    const first = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, run: recording(calls) });
    expect(first.rebuilt).toBe('missing');
    expect(calls).toContain('models');
    calls.length = 0;
    const second = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, run: recording(calls), now: NOW + HOUR });
    expect(second.rebuilt).toBeUndefined();
    expect(calls).toEqual([]);
    expect(second.table.builtAt).toBe(first.table.builtAt);
  });

  it.each<[string, Config | undefined, Partial<typeof fakeDeps>]>([
    ['config', { ...DEFAULT_CONFIG, tierOverrides: { 'claude-haiku-5-5': 'frontier' } }, {}],
    ['expired', undefined, { now: NOW + 5 * HOUR }],
    ['version', undefined, { version: '9.9.9' }],
    ['refresh', undefined, { refresh: true }],
  ])('rebuilds when %s', async (expected, config, patch) => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    const again = await loadPlacements(config ?? DEFAULT_CONFIG, { ...fakeDeps, ...patch });
    expect(again.rebuilt).toBe(expected);
  });

  it('applies a changed tierOverride in the rebuilt table', async () => {
    const deps = { ...fakeDeps, bundled: new URL('../fixtures/evidence-mini.json', import.meta.url) };
    await loadPlacements(DEFAULT_CONFIG, deps);
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-haiku-5-5': 'frontier' } };
    const { table } = await loadPlacements(config, deps);
    const haiku = table.agents.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-haiku-5-5')!;
    // The mini fixture keeps its own bands; the override affects cost only, leaving evidence Daily.
    expect(haiku.profile.class).toBe('daily');
    expect(haiku.profile.cost).toEqual({ tier: 'frontier', blended: 0.2, source: 'override' });
    expect(haiku.profile.hint).toEqual({ tier: 'frontier', source: 'override' });
  });

  it('rebuilds when an agent appears on PATH', async () => {
    const first = await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    expect(first.table.agents.find((a) => a.agent === 'grok')).toMatchObject({ installed: false });
    const grokToo = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, find: (name) => (name === 'agy' ? undefined : `/fake/bin/${name}`) });
    expect(grokToo.rebuilt).toBe('agent-appeared');
  });

  it('does not rebuild when an installed agent leaves PATH', async () => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    const fewer = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, find: () => undefined, now: NOW + HOUR });
    expect(fewer.rebuilt).toBeUndefined();
  });

  it('looks for each agent exactly where discovery looks (name and extra directories)', async () => {
    type Lookup = [string, string[] | undefined];
    const recorder = (into: Lookup[]) => (name: string, dirs?: string[]) => (into.push([name, dirs]), fakeDeps.find!(name, dirs));
    const discovery: Lookup[] = [];
    await buildPlacements(DEFAULT_CONFIG, { ...fakeDeps, find: recorder(discovery) });
    const freshness: Lookup[] = [];
    const r = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, find: recorder(freshness), now: NOW + HOUR });
    expect(r.rebuilt).toBeUndefined();
    const key = ([name, dirs]: Lookup) => `${name} ${JSON.stringify(dirs ?? [])}`;
    expect(new Set(freshness.map(key))).toEqual(new Set(discovery.map(key)));
    expect(freshness.some(([, dirs]) => dirs?.some((d) => d.endsWith('bin')))).toBe(true);
  });

  it('rebuilds a hand-edited file', async () => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    writeFileSync(join(home, 'cache', 'placements.json'), '{"schemaVersion":1,"oops":true}');
    expect((await loadPlacements(DEFAULT_CONFIG, fakeDeps)).rebuilt).toBe('invalid');
  });

  it('rebuilds a fresh schema-2 placement cache before old classifications can route', async () => {
    const first = await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    const legacy = { ...first.table, schemaVersion: 2 };
    writeFileSync(join(home, 'cache', 'placements.json'), JSON.stringify(legacy));
    const rebuilt = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, now: NOW + HOUR });
    expect(rebuilt.rebuilt).toBe('invalid');
    expect(rebuilt.table.schemaVersion).toBe(4);
    expect(rebuilt.table.agents.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-opus-5-5')!).toMatchObject({ profile: { class: 'frontier', hint: { tier: 'advanced', source: 'family' } } });
  });

  it.each([undefined, '{', JSON.stringify({ generatedAt: 'invalid' })])('ignores missing or corrupt evidence metadata without fetching: %s', async (metadata) => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    let fetches = 0;
    const result = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps,
      readFile: (path) => path.endsWith('evidence-check.json') ? metadata : fakeDeps.readFile!(path),
      fetchImpl: async () => { fetches++; throw new Error('offline'); },
    });
    expect(result.rebuilt).toBeUndefined();
    expect(fetches).toBe(0);
  });

  it('invalidates a fresh table when cached evidence metadata changes', async () => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    const paths: string[] = [];
    const next = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, readFile: (path) => {
      paths.push(path);
      return path.endsWith('evidence-check.json') ? JSON.stringify({ generatedAt: '2026-11-11T04:00:00Z', checkedAt: NOW }) : fakeDeps.readFile!(path);
    } });
    expect(next.rebuilt).toBe('evidence');
    expect(paths).toContain(join(home, 'cache', 'evidence-check.json'));
  });

  it('keeps going when the table cannot be saved', async () => {
    const cacheDir = join(home, 'cache');
    writeFileSync(cacheDir, 'a file');
    const r = await loadPlacements(DEFAULT_CONFIG, { ...fakeDeps, cacheDir });
    expect(r.saveError).toBeDefined();
    expect(r.table.agents).toHaveLength(AGENT_IDS.length);
  });
});

describe('gather', () => {
  it('runs only orca account list when the table is fresh', async () => {
    await loadPlacements(DEFAULT_CONFIG, fakeDeps);
    const calls: string[] = [];
    const { env, rebuilt } = await gather(DEFAULT_CONFIG, { ...fakeDeps, run: recording(calls), now: NOW + HOUR });
    expect(rebuilt).toBeUndefined();
    expect(calls).toEqual(['account']);
    expect(env.placementsBuiltAt).toBe(NOW);
    expect(env.now).toBe(NOW + HOUR);
  });

  it('combines the table, usage and the Orca agent switches', async () => {
    const env = await gatherEnvironment(DEFAULT_CONFIG, fakeDeps);
    expect(env.now).toBe(NOW);
    expect(env.catalogSource).toBe('snapshot');
    expect(env.evidenceSource).toBe('snapshot');
    expect(env.scoreSource).toBe(env.evidenceSource);
    expect(env.evidenceGeneratedAt).toBeDefined();
    expect(env.discoveries.map((d) => d.agent)).toEqual([...AGENT_IDS]);
    expect(env.discoveries.find((d) => d.agent === 'muse')).toMatchObject({ installed: true, models: [] });
    expect(env.usage.grok.status).toBe('unavailable');
    expect(env.usage.claude.status).toBe('ok');
    expect(env.orcaAgents).toEqual({ known: true, disabled: [], source: '/fake/orca/profile-state.db' });
    const cursor = env.discoveries.find((d) => d.agent === 'cursor')!;
    expect(cursor.models.length).toBeGreaterThan(0);
    expect(cursor.models.every((m) => m.profile !== undefined)).toBe(true);
  });
});
