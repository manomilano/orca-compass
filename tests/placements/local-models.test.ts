import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { discoverCodex } from '../../src/placements/agents/codex.js';
import { hintFor } from '../../src/placements/profiles.js';
import { MODEL_INDEX_URL, toRatings } from '../../src/placements/sources/modelindex.js';
import { MODELS_DEV_URL } from '../../src/placements/sources/modelsdev.js';
import { gather } from '../../src/routing/environment.js';
import { route } from '../../src/routing/router.js';
import type { LaunchModel } from '../../src/types.js';
import { fakeDeps, fixture, NOW } from '../helpers/fakes.js';
import { machineEnv, placed } from '../helpers/env.js';

const HOUR = 3_600_000;
const saved = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'oc-local-models-')); process.env.ORCACOMPASS_HOME = home; });
afterEach(() => {
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
const launch = (modelId: string, lineup?: string): LaunchModel => ({
  agent: 'claude', modelId, lineup, efforts: ['high'], launch: { kind: 'flag', model: modelId }, poolNames: ['weekly'],
});

it('discovers a new local Fable after five hours while reusing 24-hour metadata and routes the newer version', async () => {
  let models = ['claude-fable-5-1'];
  let requests = 0;
  const deps = {
    ...fakeDeps,
    find: (name: string) => name === 'claude' ? '/fake/claude' : undefined,
    listDir: () => ['account-cc.json'],
    readFile: (path: string) => path.endsWith('account-cc.json')
      ? JSON.stringify({ fetchedAt: NOW, catalog: { config: { models: models.map((id) => ({ id, thinking: { effort_options: [{ id: 'high' }] } })) } } })
      : fakeDeps.readFile!(path),
    fetchImpl: async (input: string | URL | Request) => {
      requests++;
      if (String(input) === MODELS_DEV_URL) return new Response(JSON.stringify({ anthropic: { models: {
        'claude-fable-5-1': { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', family: 'claude-fable', release_date: '2026-09-01' },
      } } }));
      if (String(input) === MODEL_INDEX_URL) return new Response(JSON.stringify({ fetchedAt: NOW, ratings: toRatings(JSON.parse(fixture('modelindex-mini.json'))) }));
      throw new Error('Unexpected source');
    },
  };
  const first = await gather(DEFAULT_CONFIG, deps);
  expect(route({ tier: 'frontier', agents: ['claude'] }, first.env, DEFAULT_CONFIG).route?.model).toBe('claude-fable-5-1');
  models = ['claude-fable-5-1', 'claude-fable-5-5'];
  const fresh = await gather(DEFAULT_CONFIG, { ...deps, now: NOW + 4 * HOUR });
  expect(fresh.rebuilt).toBeUndefined();
  expect(fresh.env.discoveries[0].models.map((m) => m.modelId)).not.toContain('claude-fable-5-5');
  const updated = await gather(DEFAULT_CONFIG, { ...deps, now: NOW + 5 * HOUR });
  expect(updated.rebuilt).toBe('expired');
  expect(requests).toBe(2);
  const added = updated.env.discoveries.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-fable-5-5')!;
  expect(added.meta).toBeUndefined();
  expect(added.poolNames).toEqual(['session', 'weekly', 'fableWeekly']);
  expect(added.placements).toEqual([{ tier: 'frontier', source: 'family' }]);
  const decision = route({ tier: 'frontier', agents: ['claude'] }, updated.env, DEFAULT_CONFIG);
  expect(decision.route?.model).toBe('claude-fable-5-5');
  expect(decision.alternatives.map((a) => a.model)).not.toContain('claude-fable-5-1');
  const bannedNew = route({ tier: 'frontier', agents: ['claude'] }, updated.env, { ...DEFAULT_CONFIG, banModels: ['claude-fable-5-5'] });
  expect(bannedNew.route?.model).toBe('claude-fable-5-1');
});

it.each([
  ['claude-fable-5-9', 'claude-fable-5-10', 'claude-fable'],
  ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-astra'],
])('compares numeric versions within %s family even when the new release has no catalog date', (older, newer, family) => {
  const old = { ...launch(older), meta: { id: older, name: older, provider: 'test', family, releaseDate: '2026-11-01' } };
  const env = placed({ ...machineEnv(), discoveries: [{ agent: 'claude', installed: true, models: [old, launch(newer, 'Frontier intelligence for the most demanding work.')] }] });
  expect(route({ tier: 'frontier', agents: ['claude'] }, env, DEFAULT_CONFIG).route?.model).toBe(newer);
});

it('applies family bans and overrides to newly discovered versions without metadata', () => {
  const model = launch('claude-fable-5-5', 'Frontier intelligence for the most demanding work.');
  const config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-fable': 'daily' as const } };
  expect(hintFor(model.modelId, model.meta, model.lineup, config)).toEqual({ tier: 'daily', source: 'override' });
  expect(hintFor(model.modelId, model.meta, model.lineup, { ...config, tierOverrides: { ...config.tierOverrides, 'claude-fable-5-5': 'light' } })).toEqual({ tier: 'light', source: 'override' });
  const env = placed({ ...machineEnv(), discoveries: [{ agent: 'claude', installed: true, models: [model] }] });
  const blocked = route({ tier: 'frontier', agents: ['claude'] }, env, { ...DEFAULT_CONFIG, banModels: ['claude-fable'] });
  expect(blocked.status).toBe('none');
  expect(blocked.skipped).toContainEqual({ agent: 'claude', model: 'claude-fable-5-5', reason: 'banned by you' });
});

it.each(['provider', 'orca'])('routes an arbitrarily named new Codex model using its %s description', async (source) => {
  const id = 'aurora-workbench';
  const readFile = (path: string) => {
    if (source === 'provider' && path.endsWith('models_cache.json')) return JSON.stringify({ models: [{ slug: id, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }], description: 'For your toughest challenges' }] });
    if (source === 'orca' && path.endsWith('agent-model-catalog.json')) return JSON.stringify({ entries: [{ agent: 'codex', discovered: { models: [{ id, efforts: [{ value: 'high' }], description: 'For your toughest challenges' }] } }] });
    return undefined;
  };
  const discovery = await discoverCodex({ ...fakeDeps, index: {}, readFile, cacheDir: join(home, 'cache'), listDir: () => [], find: () => '/fake/codex', run: fakeDeps.run!, env: fakeDeps.env!, now: NOW });
  expect(discovery.models[0]).toMatchObject({ modelId: id, lineup: 'For your toughest challenges' });
  expect(discovery.models[0].meta).toBeUndefined();
  const env = placed({ ...machineEnv(), discoveries: [discovery] });
  expect(route({ tier: 'frontier', agents: ['codex'] }, env, DEFAULT_CONFIG).route?.model).toBe(id);
});

it('does not infer capability or a known family from arbitrary names', () => {
  for (const id of ['claude-mystery-9', 'claude-fable-preview', 'gpt-unfamiliar-99', 'aurora-workbench', 'claude-fable-999999999999999999']) {
    expect(hintFor(id, undefined, undefined, DEFAULT_CONFIG)).toBeUndefined();
  }
});

it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])('selects the newest numeric family release regardless of provider order %s,%s,%s', (a, b, c) => {
  const metadata = (id: string, releaseDate: string) => ({ id, name: id, provider: 'anthropic', family: 'claude-fable', releaseDate });
  const models = [
    { ...launch('claude-fable-5-1'), meta: metadata('claude-fable-5-1', '2026-11-01') },
    launch('claude-fable-5-5'),
    { ...launch('claude-fable-latest'), meta: metadata('claude-fable-latest', '2026-10-01') },
  ];
  const env = placed({ ...machineEnv(), discoveries: [{ agent: 'claude', installed: true, models: [models[a], models[b], models[c]] }] });
  expect(route({ tier: 'frontier', agents: ['claude'] }, env, DEFAULT_CONFIG).route?.model).toBe('claude-fable-5-5');
});
it('keeps an unclassified family name alias in its own identity group', () => {
  const older = { ...launch('claude-fable-5-1'), meta: { id: 'claude-fable-5-1', name: 'Older', provider: 'anthropic', family: 'claude-fable', releaseDate: '2026-11-01' } };
  const newer = launch('claude-fable-5-5');
  const alias = { ...launch('claude-fable', 'For your toughest challenges'), meta: { id: 'claude-fable', name: 'Alias', provider: 'anthropic', releaseDate: '2026-10-01' } };
  const env = placed({ ...machineEnv(), discoveries: [{ agent: 'claude', installed: true, models: [older, newer, alias] }] });
  const decision = route({ tier: 'frontier', agents: ['claude'] }, env, DEFAULT_CONFIG);
  // Without the removed ladder-vendor tie-break, the alias's explicit date wins this usage tie.
  expect(decision.route?.model).toBe('claude-fable');
  expect(decision.alternatives.map((a) => a.model)).toEqual(['claude-fable-5-5']);
});
