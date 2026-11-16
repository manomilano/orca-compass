import { join } from 'node:path';
import { normalizeModelId } from '../ids.js';
import { parseEffort } from '../../routing/effort.js';
import { FAMILY_TIERS } from '../tiers.js';
import type { AgentDiscovery, Effort, EffortSource, LaunchModel } from '../../types.js';

const DEFAULT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
import { homeDir } from '../../paths.js';
import type { AgentDeps, Locator } from './deps.js';
import { description, orcaModels, parseJson, withSkipped, type RawModel } from './orca-catalog.js';

/** Codex CLI's own cache: models[] with visibility and supported_reasoning_levels. */
function fromCodexCache(text: string | undefined): RawModel[] {
  const models = parseJson(text)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m?.visibility === 'list' && typeof m.slug === 'string')
    .map((m) => ({
      id: m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((l: { effort?: unknown }) => String(l?.effort)),
      ...(typeof m.default_reasoning_level === 'string' ? { defaultEffort: m.default_reasoning_level } : {}),
      ...description(m.description),
    }));
}

export const locateCodex = (deps: Locator): string | undefined => deps.find('codex');

export async function discoverCodex(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locateCodex(deps)) return { agent: 'codex', installed: false, models: [], note: 'codex not found on PATH' };
  const orca = await orcaModels(deps, 'codex');
  const cachePath = join(deps.env.CODEX_HOME || join(homeDir(deps.env), '.codex'), 'models_cache.json');
  const cache = fromCodexCache(deps.readFile(cachePath));
  // Orca does not always record the effort Codex uses when none is passed; Codex's own cache does.
  const cachedDefault = new Map(cache.map((m) => [m.id, m.defaultEffort]));
  const sources: [string | undefined, RawModel[], EffortSource][] = [
    [orca.path, orca.models, 'orca'],
    [cachePath, cache, 'provider'],
  ];
  for (const [path, raw, effortSource] of sources) {
    if (raw.length === 0) continue;
    const models: LaunchModel[] = raw.map(({ id, efforts, defaultEffort = cachedDefault.get(id), description: lineup }) => {
      const native = defaultEffort === undefined ? undefined : parseEffort(defaultEffort);
      const meta = deps.index[id] ?? deps.index[normalizeModelId(id)];
      return {
        agent: 'codex',
        modelId: id,
        ...(meta ? { meta } : {}),
        efforts: [...new Set(efforts.map(parseEffort).filter((e): e is Effort => e !== undefined))],
        effortSource,
        ...(native ? { defaultEffort: native } : {}),
        launch: { kind: 'flag', model: id },
        poolNames: ['session', 'weekly'],
        ...(lineup ? { lineup } : {}),
      };
    });
    return { agent: 'codex', installed: true, models, note: withSkipped(`models from ${path}`, orca) };
  }
  // The evidence catalog lists every OpenAI model; only the Codex lineup families are launchable here, and
  // "-latest" ids are moving aliases.
  const families = Object.keys(FAMILY_TIERS).filter((f) => f.startsWith('gpt-'));
  const models: LaunchModel[] = [...new Map(Object.values(deps.index).map((m) => [m.id, m])).values()]
    .filter((m) => m.provider === 'openai' && m.family !== undefined && families.includes(m.family) && !m.id.endsWith('-latest'))
    .map((meta) => ({
      agent: 'codex',
      modelId: meta.id,
      meta,
      efforts: DEFAULT_EFFORTS,
      effortSource: 'assumed',
      launch: { kind: 'flag', model: meta.id },
      poolNames: ['session', 'weekly'],
    }));
  if (models.length > 0) return { agent: 'codex', installed: true, models, note: withSkipped('models from the evidence catalog (Codex has not cached its model list yet)', orca) };
  return { agent: 'codex', installed: true, models: [], note: 'no Codex model list found' };
}
