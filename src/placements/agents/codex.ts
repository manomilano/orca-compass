import { join } from 'node:path';
import { normalizeModelId } from '../ids.js';
import { parseEffort } from '../../routing/effort.js';
import { FAMILY_TIERS } from '../tiers.js';
import type { AgentDiscovery, Effort, EffortSource, LaunchModel } from '../../types.js';

const DEFAULT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
import { homeDir } from '../../paths.js';
import type { AgentDeps, Locator } from './deps.js';
import { description, fromOrcaCatalog, orcaCatalogPath, parseJson, type RawModel } from './orca-catalog.js';

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
  const sources: [string, (text: string | undefined) => RawModel[], EffortSource][] = [
    [join(deps.env.CODEX_HOME || join(homeDir(deps.env), '.codex'), 'models_cache.json'), fromCodexCache, 'provider'],
    [orcaCatalogPath(deps.env), (text) => fromOrcaCatalog(text, 'codex'), 'orca'],
  ];
  for (const [path, parse, effortSource] of sources) {
    const raw = parse(deps.readFile(path));
    if (raw.length === 0) continue;
    const models: LaunchModel[] = raw.map(({ id, efforts, defaultEffort, description: lineup }) => {
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
    return { agent: 'codex', installed: true, models, note: `models from ${path}` };
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
  if (models.length > 0) return { agent: 'codex', installed: true, models, note: 'models from the evidence catalog (Codex has not cached its model list yet)' };
  return { agent: 'codex', installed: true, models: [], note: 'no Codex model list found' };
}
