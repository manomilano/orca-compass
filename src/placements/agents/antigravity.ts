import { join } from 'node:path';
import { homeDir } from '../../paths.js';
import { EFFORT_LADDER, parseEffort } from '../../routing/effort.js';
import type { AgentDiscovery, Effort, LaunchModel } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';
import { listModels, savedNote } from './list-cache.js';
import { orcaModels, withSkipped } from './orca-catalog.js';

// Orca's effort choices for an Antigravity model its catalog does not list (it passes them on as agy --effort).
const EFFORTS: Effort[] = ['low', 'medium', 'high'];
const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
// agy bills each quota group separately (Orca's bucket groups); these are the labels agy 1.4 reports.
const GEMINI_GROUP = 'Gemini Models';
const OTHER_GROUP = 'Claude and GPT models';

/** A group's own pools, then Orca's overall windows, which it reports only when there are no groups. */
const poolsOf = (id: string): string[] => {
  const group = id.startsWith('gemini') ? GEMINI_GROUP : OTHER_GROUP;
  return [`bucket:${group} 5h`, `bucket:${group}`, 'session', 'weekly'];
};

/** `agy models` prints `id<TAB>label` rows; older agy versions print display names only, which are not launch ids. */
export function parseAgyModels(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    if (!id || /\s/.test(id) || /^(id|model)$/i.test(id) || !line.slice(tab + 1).trim() || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

interface Group {
  ids: Partial<Record<Effort, string>>;
  plain?: string;
}

/**
 * agy bakes effort into Gemini ids (gemini-3.8-flash-high); other ids take Orca's --effort, with the efforts
 * Orca's catalog lists for them (`orcaEfforts`, by agy id or catalog id) or else Orca's default menu.
 */
function toLaunchModels(ids: string[], deps: AgentDeps, orcaEfforts: Map<string, Effort[]> = new Map()): LaunchModel[] {
  const groups = new Map<string, Group>();
  for (const id of ids) {
    const m = EFFORT_SUFFIX.exec(id);
    const base = m ? id.slice(0, m.index) : id;
    const g: Group = groups.get(base) ?? { ids: {} };
    groups.set(base, g);
    if (m) g.ids[m[1] as Effort] = id;
    else g.plain = id;
  }
  return [...groups].map(([base, g]) => {
    // agy lists some Claude models as claude-opus-4-6-thinking; the catalog knows them without the suffix.
    const plain = base.replace(/-thinking$/, '');
    const modelId = deps.index[base] || !deps.index[plain] ? base : plain;
    const common = {
      agent: 'antigravity',
      modelId,
      ...(deps.index[modelId] ? { meta: deps.index[modelId] } : {}),
      poolNames: poolsOf(base),
    };
    // A plain id takes Orca's effort menu; agy does not say which efforts it honors.
    if (Object.keys(g.ids).length === 0) {
      const efforts = orcaEfforts.get(base) ?? orcaEfforts.get(modelId) ?? EFFORTS;
      return { ...common, efforts, effortSource: 'orca', launch: { kind: 'flag', model: g.plain! } };
    }
    // An unsuffixed sibling is agy's default, so it stands in for a missing medium.
    if (g.plain && !g.ids.medium) g.ids.medium = g.plain;
    return {
      ...common,
      efforts: EFFORT_LADDER.filter((e) => g.ids[e]),
      effortSource: 'provider',
      launch: { kind: 'variant', ids: g.ids, ...(g.plain ? { defaultId: g.plain } : {}) },
    };
  });
}

// agy otherwise forks a detached updater every 15 minutes, and on Windows its console-less child opens a visible terminal. agy accepts only the exact value "true".
const NO_AUTO_UPDATE = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

// The agy installer's default locations; a process started before the install misses them on PATH.
export function locateAntigravity(deps: Locator): string | undefined {
  const home = homeDir(deps.env);
  const localAppData = deps.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return deps.find('agy', [join(localAppData, 'agy', 'bin'), join(home, '.local', 'bin')]);
}

export async function discoverAntigravity(deps: AgentDeps): Promise<AgentDiscovery> {
  const exe = locateAntigravity(deps);
  if (!exe) return { agent: 'antigravity', installed: false, models: [], note: 'agy not found' };

  const listing = await listModels(deps, exe, ['models'], 'antigravity', (text) => parseAgyModels(text).map((id) => ({ id })), NO_AUTO_UPDATE);
  if (!listing.items) {
    const note = listing.signedOut ? `not signed in: ${listing.error}` : `agy models gave no model ids: ${listing.error}`;
    return { agent: 'antigravity', installed: true, models: [], note, ...(listing.signedOut ? { signedOut: true } : {}) };
  }
  const orca = await orcaModels(deps, 'antigravity');
  const orcaEfforts = new Map(orca.models.filter((m) => m.efforts.length > 0)
    .map((m) => [m.id, EFFORT_LADDER.filter((e) => m.efforts.map(parseEffort).includes(e))]));
  const saved = savedNote('agy models', listing, deps.now);
  const note = orca.skipped ? withSkipped(saved ?? 'agy models', orca) : saved;
  return { agent: 'antigravity', installed: true, models: toLaunchModels(listing.items.map((m) => m.id), deps, orcaEfforts), ...(note ? { note } : {}) };
}
