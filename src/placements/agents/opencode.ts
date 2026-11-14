import { join } from 'node:path';
import { homeDir } from '../../paths.js';
import { normalizeModelId } from '../ids.js';
import type { AgentDiscovery, LaunchModel, ModelMeta } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';
import { listModels, savedNote } from './list-cache.js';

// Providers that serve models from this machine.
const LOCAL = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'localai', 'vllm']);

/**
 * `opencode models`: one `provider/model` id per line, for every provider OpenCode can reach (an API key, a
 * subscription or a local server). OpenRouter's `~vendor/x-latest` ids are moving aliases of models it also
 * lists by their own id, so they are skipped.
 */
export function parseOpencodeModels(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (/^[\w.-]+\/\S+$/.test(id) && !id.includes('/~') && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** How a model is paid for: on this machine, free, or per token. */
export function billingOf(provider: string, model: string): { text: string; rank: number } {
  if (LOCAL.has(provider)) return { text: `runs on this machine (${provider})`, rank: 0 };
  if (/[-:]free$/.test(model)) return { text: `free model through ${provider}`, rank: 1 };
  return { text: `pay per use through ${provider}`, rank: 2 };
}

/**
 * OpenCode reaches many providers, so one model can be listed more than once (Zen and OpenRouter): each model
 * is kept once, from the cheapest way to run it. Effort is not passed: Orca does not support it for OpenCode.
 */
export function toOpencodeModels(ids: string[], deps: Pick<AgentDeps, 'index'>): LaunchModel[] {
  const byNorm = new Map<string, ModelMeta>();
  for (const m of Object.values(deps.index)) if (!byNorm.has(normalizeModelId(m.id))) byNorm.set(normalizeModelId(m.id), m);
  const best = new Map<string, { model: LaunchModel; rank: number }>();
  for (const id of ids) {
    const provider = id.slice(0, id.indexOf('/'));
    const sub = id.slice(provider.length + 1);
    const billing = billingOf(provider, sub);
    // A free copy (glm-5.3-flash-free, cohere/north-mini-code:free) is the same model: rate and keep it as one.
    const base = sub.replace(/[-:]free$/, '');
    const meta = deps.index[base] ?? byNorm.get(normalizeModelId(base));
    const model: LaunchModel = {
      agent: 'opencode',
      modelId: meta?.id ?? base,
      ...(meta ? { meta } : {}),
      efforts: [],
      effortSource: 'orca',
      launch: { kind: 'flag', model: id },
      // No usage window: Orca tracks no OpenCode limits, and these models cost per token or local resources.
      poolNames: [],
      billing: billing.text,
    };
    const cur = best.get(model.modelId);
    if (!cur || billing.rank < cur.rank) best.set(model.modelId, { model, rank: billing.rank });
  }
  return [...best.values()].map((b) => b.model);
}

export function locateOpencode(deps: Locator): string | undefined {
  return deps.find('opencode', [join(homeDir(deps.env), '.opencode', 'bin')]);
}

export async function discoverOpencode(deps: AgentDeps): Promise<AgentDiscovery> {
  const exe = locateOpencode(deps);
  if (!exe) return { agent: 'opencode', installed: false, models: [], note: 'opencode not found' };
  const listing = await listModels(deps, exe, ['models'], 'opencode', (text) => parseOpencodeModels(text).map((id) => ({ id })));
  if (!listing.items) {
    const note = listing.signedOut ? `not signed in: ${listing.error}` : `opencode models failed: ${listing.error}`;
    return { agent: 'opencode', installed: true, models: [], note, ...(listing.signedOut ? { signedOut: true } : {}) };
  }
  const note = savedNote('opencode models', listing, deps.now);
  return { agent: 'opencode', installed: true, models: toOpencodeModels(listing.items.map((m) => m.id), deps), ...(note ? { note } : {}) };
}
