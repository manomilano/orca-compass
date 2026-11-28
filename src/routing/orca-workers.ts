import type { Runner } from '../system/run.js';
import type { WorkerState } from './quota.js';

// Orca knows which supervised workers are still running. Reservations bound to a Dispatch follow it, so a
// worker that finished without `orcacompass release` still ends its reservation.

/**
 * `orca orchestration worker-list --json`: every worker's outcome, liveness and launch (agent and model),
 * newest first. Undefined when Orca cannot say.
 */
export async function readOrcaWorkers(run: Runner): Promise<{ states: WorkerState[]; complete: boolean } | undefined> {
  try {
    const result = await run('orca', ['orchestration', 'worker-list', '--limit', '100', '--json'], { timeoutMs: 20_000 });
    if (result.code !== 0 || result.error) return undefined;
    const data = JSON.parse(result.stdout);
    const rows: unknown = data?.result?.workers;
    if (data?.ok !== true || !Array.isArray(rows)) return undefined;
    const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined);
    const states: WorkerState[] = [];
    for (const row of rows) {
      const dispatchId = str(row?.dispatchId);
      if (!dispatchId) continue;
      const projection = row.projection ?? {};
      const outcome = str(row.outcome) ?? str(projection.outcome);
      const liveness = str(row.liveness) ?? str(projection.liveness?.verdict);
      const terminalState = str(row.terminalState);
      // `agent` reads `<agent>/<model>`, e.g. `claude/claude-opus-5-5`; no effort is listed.
      const launched = str(row.agent);
      const slash = launched?.indexOf('/') ?? -1;
      const agent = launched === undefined ? undefined : slash > 0 ? launched.slice(0, slash) : launched;
      const model = launched !== undefined && slash > 0 ? str(launched.slice(slash + 1)) : undefined;
      states.push({
        dispatchId, ...(outcome ? { outcome } : {}), ...(liveness ? { liveness } : {}), ...(terminalState ? { terminalState } : {}),
        ...(agent ? { agent } : {}), ...(model ? { model } : {}),
      });
    }
    // A missing Dispatch is known to be gone only when the list holds every worker: no further page, and
    // not narrowed to the Run this terminal is bound to (another Run's workers are then left out).
    const more = data.result.nextCursor != null || data.result.page?.hasMore === true;
    return { states, complete: !more && data.result.scope?.source === 'all' };
  } catch {
    return undefined;
  }
}
