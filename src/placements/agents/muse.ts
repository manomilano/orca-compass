import { normalizeModelId } from '../ids.js';
import type { AgentDiscovery, Effort, LaunchModel } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';

/**
 * Muse has no model list command and Orca keeps no Muse model list (its ids are account-scoped), so until one of
 * them lists Muse models this built-in lineup is routed. Orca launches Muse with any --model. The ids follow Meta's
 * naming as Cursor lists it (muse-wonder-1.0, muse-spark-1.3); muse-ember-1.0 is inferred from that pattern.
 */
export const MUSE_FALLBACK_MODELS: readonly string[] = ['muse-wonder-1.0', 'muse-spark-1.1', 'muse-ember-1.0', 'muse-spark-1.3'];

// Orca's Muse effort menu (it passes the choice on as --reasoning-effort), without "ultra", which has no rung here.
const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const locateMuse = (deps: Locator): string | undefined => deps.find('muse');

export async function discoverMuse(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locateMuse(deps)) return { agent: 'muse', installed: false, models: [], note: 'muse not found on PATH' };
  const models: LaunchModel[] = MUSE_FALLBACK_MODELS.map((id) => {
    const meta = deps.index[id] ?? deps.index[normalizeModelId(id)];
    return {
      agent: 'muse',
      modelId: id,
      ...(meta ? { meta } : {}),
      efforts: EFFORTS,
      effortSource: 'orca',
      defaultEffort: 'high',
      launch: { kind: 'flag', model: id },
      // The windows of Orca's `muse` usage entry; they stay unknown while Orca reports no usage for Muse.
      poolNames: ['session', 'weekly'],
    };
  });
  return { agent: 'muse', installed: true, models, note: "models from OrcaCompass's built-in Muse list (neither Muse nor Orca lists Muse models)" };
}
