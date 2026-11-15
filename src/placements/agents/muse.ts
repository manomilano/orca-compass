import { normalizeModelId } from '../ids.js';
import type { AgentDiscovery, LaunchModel } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';
import { effortsOf, nativeEffortOf, orcaModels } from './orca-catalog.js';

/**
 * Orca launches Muse with any --model. Muse model ids are account-scoped and Muse has no list command, so the
 * only model list is the one Orca's catalog holds after it probes Muse; without it Muse is detected, never routed.
 */
export const locateMuse = (deps: Locator): string | undefined => deps.find('muse');

export async function discoverMuse(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locateMuse(deps)) return { agent: 'muse', installed: false, models: [], note: 'muse not found on PATH' };
  const orca = await orcaModels(deps, 'muse');
  if (orca.models.length === 0) {
    const note = 'no model list available from Orca; not routed';
    return { agent: 'muse', installed: true, models: [], note: orca.skipped ? `${note} (${orca.skipped})` : note };
  }
  const models: LaunchModel[] = orca.models.map((m) => {
    const meta = deps.index[m.id] ?? deps.index[normalizeModelId(m.id)];
    return {
      agent: 'muse',
      modelId: m.id,
      ...(meta ? { meta } : {}),
      efforts: effortsOf(m),
      effortSource: 'orca',
      ...nativeEffortOf(m),
      launch: { kind: 'flag', model: m.id },
      // Orca reports no usage for Muse, so these pools stay unknown.
      poolNames: ['session', 'weekly'],
      ...(m.description ? { lineup: m.description } : {}),
    };
  });
  return { agent: 'muse', installed: true, models, note: `models from ${orca.path}` };
}
