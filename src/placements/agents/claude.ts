import { join } from 'node:path';
import { normalizeModelId } from '../ids.js';
import { parseEffort } from '../../routing/effort.js';
import type { AgentDiscovery, Effort, EffortSource, LaunchModel } from '../../types.js';
import { homeDir } from '../../paths.js';
import type { AgentDeps, Locator } from './deps.js';
import { description, fromOrcaCatalog, orcaCatalogPath, parseJson, type RawModel } from './orca-catalog.js';

const DEFAULT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const isClaude = (id: string): boolean => id.startsWith('claude-');

const poolNames = (id: string): string[] => (id.startsWith('claude-fable') ? ['session', 'weekly', 'fableWeekly'] : ['session', 'weekly']);

/** Claude Code's cached account catalog, <account>-<hash>-cc.json; several files can exist after an account change. */
function fromClaudeCache(deps: AgentDeps, dir: string): { path: string; models: RawModel[] } | undefined {
  const newest = deps.listDir(dir)
    .filter((name) => name.endsWith('-cc.json'))
    .map((name) => {
      const path = join(dir, name);
      const doc = parseJson(deps.readFile(path));
      return { path, fetchedAt: Number(doc?.fetchedAt) || 0, models: doc?.catalog?.config?.models };
    })
    .filter((c) => Array.isArray(c.models))
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  if (!newest) return undefined;
  const models: RawModel[] = newest.models
    .filter((m: { id?: unknown }) => typeof m?.id === 'string')
    .map((m: { id: string; description?: unknown; thinking?: { effort_options?: { id?: unknown }[] } }) => ({
      id: m.id,
      efforts: (m.thinking?.effort_options ?? []).map((o) => String(o?.id)),
      ...description(m.description),
    }));
  return { path: newest.path, models };
}

function toLaunch({ id, efforts, description: lineup }: RawModel, deps: AgentDeps, effortSource: EffortSource): LaunchModel {
  const meta = deps.index[id] ?? deps.index[normalizeModelId(id)];
  return {
    agent: 'claude',
    modelId: id,
    ...(meta ? { meta } : {}),
    efforts: [...new Set(efforts.map(parseEffort).filter((e): e is Effort => e !== undefined))],
    effortSource,
    launch: { kind: 'flag', model: id },
    poolNames: poolNames(id),
    ...(lineup ? { lineup } : {}),
  };
}

/** Claude Code has no model list command: its account catalog, then Orca's probe, then the evidence catalog. */
export const locateClaude = (deps: Locator): string | undefined => deps.find('claude');

export async function discoverClaude(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locateClaude(deps)) return { agent: 'claude', installed: false, models: [], note: 'claude not found on PATH' };
  const configDir = deps.env.CLAUDE_CONFIG_DIR || join(homeDir(deps.env), '.claude');
  const cache = fromClaudeCache(deps, join(configDir, 'cache', 'model-catalog'));
  const orcaPath = orcaCatalogPath(deps.env);
  const sources: [string, RawModel[], EffortSource][] = [
    ...(cache ? [[cache.path, cache.models, 'provider'] as [string, RawModel[], EffortSource]] : []),
    [orcaPath, fromOrcaCatalog(deps.readFile(orcaPath), 'claude'), 'orca'],
  ];
  for (const [path, raw, effortSource] of sources) {
    const unique = new Map(raw.filter((m) => isClaude(m.id)).map((m) => [m.id, m]));
    if (unique.size === 0) continue;
    return { agent: 'claude', installed: true, models: [...unique.values()].map((m) => toLaunch(m, deps, effortSource)), note: `models from ${path}` };
  }
  const models: LaunchModel[] = [...new Map(Object.values(deps.index).map((m) => [m.id, m])).values()]
    .filter((m) => m.provider === 'anthropic' && m.family?.startsWith('claude-'))
    .map((meta) => ({
      agent: 'claude',
      modelId: meta.id,
      meta,
      efforts: DEFAULT_EFFORTS,
      effortSource: 'assumed',
      launch: { kind: 'flag', model: meta.id },
      poolNames: poolNames(meta.id),
    }));
  return { agent: 'claude', installed: true, models };
}
