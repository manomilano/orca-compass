import { DEFAULT_CONFIG } from '../../src/config.js';
import { parseSnapshot, type EvidenceSnapshot } from '../../src/evidence/snapshot.js';
import { profileModels } from '../../src/placements/profiles.js';
import type { AgentDiscovery, AgentUsage, Config, Effort, Environment, LaunchModel, ModelMeta, UsagePool } from '../../src/types.js';
import { fixture } from './fakes.js';

// Synthetic routing scenario with fixed usage and reset times; model metadata is public.
export const NOW = 1793232000000;

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const META: Record<string, ModelMeta> = {
  'claude-haiku-5-5': { id: 'claude-haiku-5-5', provider: 'anthropic', name: 'Claude Haiku 5.5', family: 'claude-haiku', releaseDate: '2026-10-07' },
  'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', provider: 'anthropic', name: 'Claude Sonnet 5.5', family: 'claude-sonnet', releaseDate: '2026-09-28' },
  'claude-opus-5-5': { id: 'claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5', family: 'claude-opus', releaseDate: '2026-09-22' },
  'claude-opus-5': { id: 'claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5', family: 'claude-opus', releaseDate: '2026-07-24' },
  'claude-fable-5-1': { id: 'claude-fable-5-1', provider: 'anthropic', name: 'Claude Fable 5.1', family: 'claude-fable', releaseDate: '2026-09-01' },
  'gpt-6-luna': { id: 'gpt-6-luna', provider: 'openai', name: 'GPT-6 Luna', family: 'gpt-luna', releaseDate: '2026-09-22' },
  'gpt-6.1-terra': { id: 'gpt-6.1-terra', provider: 'openai', name: 'GPT-6.1 Terra', family: 'gpt-terra', releaseDate: '2026-10-26' },
  'gpt-6.1-sol': { id: 'gpt-6.1-sol', provider: 'openai', name: 'GPT-6.1 Sol', family: 'gpt-sol', releaseDate: '2026-09-29' },
  'gpt-6-astra': { id: 'gpt-6-astra', provider: 'openai', name: 'GPT-6 Astra', family: 'gpt-astra', releaseDate: '2026-09-04' },
};

const pool = (name: string, kind: UsagePool['kind'], usedPercent: number, windowMinutes: number, resetsAt: number): UsagePool =>
  ({ name, kind, usedPercent, windowMinutes, resetsAt });

const flagModel = (agent: string, id: string, poolNames: string[]): LaunchModel => ({
  agent, modelId: id, meta: META[id], efforts: id === 'gpt-6-luna' || id === 'gpt-6.1-terra' ? ['none', ...EFFORTS] : EFFORTS, launch: { kind: 'flag', model: id }, poolNames,
});

const variantModel = (agent: string, id: string, poolNames: string[]): LaunchModel => ({
  agent, modelId: id, meta: META[id], efforts: EFFORTS,
  launch: { kind: 'variant', ids: Object.fromEntries(EFFORTS.map((e) => [e, `${id}-${e}`])) },
  poolNames,
});

/** An Environment whose models may still be raw LaunchModels; `placed` turns it into a routable one. */
export type RawEnv = Omit<Environment, 'discoveries' | 'bands'> & { discoveries: AgentDiscovery[]; bands?: Environment['bands'] };
export interface PlaceOpts { config?: Config; snapshot?: EvidenceSnapshot }

/** Profiles every model as the build does, using deterministic fixture evidence. */
export function placed(env: RawEnv, opts: PlaceOpts = {}): Environment {
  const config = opts.config ?? DEFAULT_CONFIG;
  const { discoveries, ...rest } = env;
  const snapshot = opts.snapshot ?? parseSnapshot(fixture('evidence-mini.json'))!;
  return {
    ...rest,
    bands: snapshot.bands,
    discoveries: profileModels(discoveries, snapshot, config),
  };
}

export function machineEnv(opts: PlaceOpts = {}): Environment {
  const claudePools = ['session', 'weekly'];
  const cursorPools = ['monthly', 'bucket:Other Models'];
  const discoveries: AgentDiscovery[] = [
    {
      agent: 'claude', installed: true, models: [
        flagModel('claude', 'claude-haiku-5-5', claudePools),
        flagModel('claude', 'claude-sonnet-5-5', claudePools),
        flagModel('claude', 'claude-opus-5-5', claudePools),
        flagModel('claude', 'claude-opus-5', claudePools),
        flagModel('claude', 'claude-fable-5-1', [...claudePools, 'fableWeekly']),
      ],
    },
    {
      agent: 'codex', installed: true, models: [
        flagModel('codex', 'gpt-6-luna', ['weekly']),
        flagModel('codex', 'gpt-6.1-terra', ['weekly']),
        flagModel('codex', 'gpt-6.1-sol', ['weekly']),
        flagModel('codex', 'gpt-6-astra', ['weekly']),
      ],
    },
    {
      agent: 'cursor', installed: true, models: [
        variantModel('cursor', 'claude-sonnet-5-5', cursorPools),
        variantModel('cursor', 'claude-opus-5-5', cursorPools),
        variantModel('cursor', 'claude-fable-5-1', cursorPools),
      ],
    },
    { agent: 'muse', installed: false, models: [] },
  ];
  const usage: Record<string, AgentUsage> = {
    claude: {
      agent: 'claude', status: 'ok', updatedAt: NOW, pools: {
        session: pool('session', 'session', 10, 300, 1793239200000),
        weekly: pool('weekly', 'long', 50, 10080, 1793282400000),
        fableWeekly: pool('fableWeekly', 'long', 75, 10080, 1793282400000),
      },
    },
    codex: {
      agent: 'codex', status: 'ok', updatedAt: NOW, pools: {
        weekly: pool('weekly', 'long', 20, 10080, 1793736000000),
      },
    },
    cursor: {
      agent: 'cursor', status: 'ok', updatedAt: NOW, pools: {
        monthly: pool('monthly', 'long', 2.5, 44640, 1795132800000),
        'bucket:Other Models': pool('bucket:Other Models', 'long', 6.25, 44640, 1795132800000),
      },
    },
  };
  return placed({ now: NOW, discoveries, usage, evidenceSource: 'snapshot', evidenceGeneratedAt: parseSnapshot(fixture('evidence-mini.json'))!.generatedAt, catalogSource: 'snapshot', scoreSource: 'snapshot', placementsBuiltAt: NOW }, opts);
}

/** Copy of env with one pool's fields overridden. */
export function withPool(env: Environment, agent: string, poolName: string, patch: Partial<UsagePool>): Environment {
  const u = env.usage[agent];
  return {
    ...env,
    usage: { ...env.usage, [agent]: { ...u, pools: { ...u.pools, [poolName]: { ...u.pools[poolName], ...patch } } } },
  };
}

/** Copy of env where one agent offers only the given model ids. */
export function onlyModels(env: Environment, agent: string, modelIds: string[]): Environment {
  return {
    ...env,
    discoveries: env.discoveries.map((d) => (d.agent === agent ? { ...d, models: d.models.filter((m) => modelIds.includes(m.modelId)) } : d)),
  };
}

/** Copy of env with the usage timestamp of the given agents (default: all) replaced. */
export function withUsageUpdatedAt(env: Environment, updatedAt: number, agents?: string[]): Environment {
  const usage = Object.fromEntries(Object.entries(env.usage).map(([agent, u]) =>
    [agent, agents && !agents.includes(agent) ? u : { ...u, updatedAt }]));
  return { ...env, usage };
}

/** Copy of env with every agent's usage status replaced (pools are kept so the router must ignore them). */
export function withUsageStatus(env: Environment, status: AgentUsage['status'], agents?: string[]): Environment {
  const usage = Object.fromEntries(Object.entries(env.usage).map(([agent, u]) =>
    [agent, agents && !agents.includes(agent) ? u : { ...u, status }]));
  return { ...env, usage };
}

/** Cursor's `auto` as the adapter discovers it: no effort variants, billed to the Cursor Models bucket. */
export const CURSOR_AUTO: LaunchModel = {
  agent: 'cursor', modelId: 'auto', efforts: [], launch: { kind: 'variant', ids: {}, defaultId: 'auto' },
  poolNames: ['monthly', 'bucket:Cursor Models'],
};

/** Copy of env where Cursor also lists the given models and has a Cursor Models bucket at usedPercent. */
export function withCursorModels(env: Environment, models: LaunchModel[], usedPercent = 0.5, config: Config = DEFAULT_CONFIG): Environment {
  const cursor = env.usage.cursor;
  const bucket = pool('bucket:Cursor Models', 'long', usedPercent, 44640, cursor.pools.monthly.resetsAt);
  return placed({
    ...env,
    discoveries: env.discoveries.map((d) => (d.agent === 'cursor' ? { ...d, models: [...d.models, ...models] } : d)),
    usage: { ...env.usage, cursor: { ...cursor, pools: { ...cursor.pools, [bucket.name]: bucket } } },
  }, { config });
}

/** A named Cursor variant model of a known Models.dev id, billed to Other Models. */
export const cursorVariant = (id: string): LaunchModel => variantModel('cursor', id, ['monthly', 'bucket:Other Models']);
