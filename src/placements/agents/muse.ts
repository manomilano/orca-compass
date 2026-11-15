import type { AgentDiscovery } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';

/** Orca launches Muse with any --model but has no Muse model list (account-scoped ids), so Muse is detected, never routed. */
export const locateMuse = (deps: Locator): string | undefined => deps.find('muse');

export async function discoverMuse(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locateMuse(deps)) return { agent: 'muse', installed: false, models: [], note: 'muse not found on PATH' };
  return { agent: 'muse', installed: true, models: [], note: 'no model list available from Orca; not routed' };
}
