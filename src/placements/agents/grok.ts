import { join } from 'node:path';
import { homeDir } from '../../paths.js';
import { EFFORT_LADDER, parseEffort } from '../../routing/effort.js';
import type { AgentDiscovery, Effort, LaunchModel } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';
import { listModels, savedNote } from './list-cache.js';

// Orca's effort choices for grok (it passes them on as --reasoning-effort).
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
// Orca's grok catalog seed caps these models; other ids get the full menu, as in Orca.
const CEILINGS: Record<string, Effort> = { 'grok-4.7': 'xhigh', 'grok-4.6': 'xhigh', 'grok-4.5': 'high' };

interface GrokModel {
  id: string;
  efforts: Effort[];
  defaultEffort?: Effort;
}

/**
 * grok's own model cache (~/.grok/models_cache.json, written by grok from its account's model endpoint):
 * `models` keyed by id, each with `info.reasoning_efforts` and the default `info.reasoning_effort`.
 */
export function parseGrokCache(text: string | undefined): GrokModel[] {
  let models: unknown;
  try {
    models = text === undefined ? undefined : JSON.parse(text)?.models;
  } catch {
    return [];
  }
  if (typeof models !== 'object' || models === null) return [];
  const out: GrokModel[] = [];
  for (const [key, entry] of Object.entries(models as Record<string, any>)) {
    const info = entry?.info ?? {};
    if (info.hidden === true) continue;
    const id = typeof info.id === 'string' ? info.id : key;
    // On xAI's multi-agent models effort sets how many agents run, not how long one thinks: never pass it.
    const multiAgent = /multi-?agent/i.test(id);
    const levels: unknown[] =
      multiAgent || info.supports_reasoning_effort === false || !Array.isArray(info.reasoning_efforts) ? [] : info.reasoning_efforts;
    const supported = new Set(levels.map((l: any) => parseEffort(String(l?.value ?? l?.id ?? ''))).filter((e): e is Effort => e !== undefined));
    const native = typeof info.reasoning_effort === 'string' ? parseEffort(info.reasoning_effort) : undefined;
    out.push({ id, efforts: EFFORT_LADDER.filter((e) => supported.has(e)), ...(native ? { defaultEffort: native } : {}) });
  }
  return out;
}

/** `grok models` is text only: bulleted ids (`*` marks the default) under "Available models:", up to a blank line. */
export function parseGrokModels(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => l.trim() === 'Available models:');
  if (header < 0) return [];
  const ids: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '' && ids.length > 0) break;
    const m = /^\s*[*-]\s+([^\s(]+)/.exec(line);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

const effortsOf = (id: string): Effort[] => (CEILINGS[id] ? EFFORTS.slice(0, EFFORTS.indexOf(CEILINGS[id]) + 1) : EFFORTS);

function toLaunchModel(m: GrokModel, source: LaunchModel['effortSource'], deps: AgentDeps): LaunchModel {
  return {
    agent: 'grok',
    modelId: m.id,
    ...(deps.index[m.id] ? { meta: deps.index[m.id] } : {}),
    efforts: m.efforts,
    effortSource: source,
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    launch: { kind: 'flag', model: m.id },
    // xAI billing: a weekly credit window or a monthly budget, never a session window.
    poolNames: ['weekly', 'monthly'],
  };
}

// Orca looks in $GROK_HOME/bin and adds ~/.grok/bin to its PATH; the installer leaves ~/.grok/bin off the
// PATH of processes started before it ran.
export function locateGrok(deps: Locator): string | undefined {
  const dirs = [...(deps.env.GROK_HOME ? [join(deps.env.GROK_HOME, 'bin')] : []), join(homeDir(deps.env), '.grok', 'bin')];
  return deps.find('grok', dirs);
}

export async function discoverGrok(deps: AgentDeps): Promise<AgentDiscovery> {
  const grokHome = deps.env.GROK_HOME || join(homeDir(deps.env), '.grok');
  const exe = locateGrok(deps);
  if (!exe) return { agent: 'grok', installed: false, models: [], note: 'grok not found' };

  const cachePath = join(grokHome, 'models_cache.json');
  const cached = parseGrokCache(deps.readFile(cachePath));
  if (cached.length > 0) {
    return { agent: 'grok', installed: true, models: cached.map((m) => toLaunchModel(m, 'provider', deps)), note: `models from ${cachePath}` };
  }

  const listing = await listModels(deps, exe, ['models'], 'grok', (text) => parseGrokModels(text).map((id) => ({ id })));
  if (!listing.items) {
    const note = listing.signedOut ? `not signed in: ${listing.error}` : `grok models failed: ${listing.error}`;
    return { agent: 'grok', installed: true, models: [], note, ...(listing.signedOut ? { signedOut: true } : {}) };
  }
  const note = savedNote('grok models', listing, deps.now);
  const models = listing.items.map(({ id }) => toLaunchModel({ id, efforts: effortsOf(id) }, 'orca', deps));
  return { agent: 'grok', installed: true, models, ...(note ? { note } : {}) };
}
