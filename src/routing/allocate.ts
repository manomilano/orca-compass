import { cacheDir } from '../paths.js';
import type { Config, Decision, Environment, RouteRequest } from '../types.js';
import type { Runner } from '../system/run.js';
import { isLive, type Reservation, type WorkerState } from './quota.js';
import { readOrcaWorkers } from './orca-workers.js';
import {
  endReservation, findReservation, liveReservations, newReservationId, putReservation, readLedger, syncLedger, withLedger,
  type Ledger, type ReleaseOutcome,
} from './reservations.js';
import { planRoute } from './router.js';
import type { AgentId, AgentUsage } from '../types.js';

// Where routing meets the reservation ledger. The router itself is pure; these functions make its decisions
// and the lifecycle of the reserved capacity atomic across every OrcaCompass process on the machine.

export interface Synced {
  /** The usage to route on: Orca's snapshots, or the last valid one where Orca could not be read. */
  usage: Record<AgentId, AgentUsage>;
  /** Every record still in the ledger, live or recently ended. */
  reservations: Reservation[];
  /** Set when the ledger could not be written; the result was then computed without saving it. */
  error?: string;
}

/**
 * Reconciles the ledger with what Orca reports now and returns the result. The lock is taken only when
 * something changes, so commands that find nothing new leave the cache folder untouched.
 */
export function syncReservations(
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: Config,
  dir: string = cacheDir(),
  workers?: { states: WorkerState[]; complete: boolean },
): Synced {
  const preview = readLedger(dir);
  const before = JSON.stringify(preview);
  const merged = syncLedger(preview, usage, now, config, workers);
  if (JSON.stringify(preview) === before) return { usage: merged, reservations: preview.reservations };
  try {
    return withLedger(dir, (ledger) => {
      const fresh = syncLedger(ledger, usage, now, config, workers);
      return { usage: fresh, reservations: [...ledger.reservations] };
    });
  } catch (e) {
    return { usage: merged, reservations: preview.reservations, error: (e as Error).message };
  }
}

/** Orca's worker states, asked for only when a reservation is bound to a Dispatch that may have changed. */
export async function workerStatesFor(run: Runner, dir: string = cacheDir()): Promise<{ states: WorkerState[]; complete: boolean } | undefined> {
  const bound = readLedger(dir).reservations.some((r) => r.dispatchId && (r.state === 'pending' || r.state === 'running'));
  return bound ? readOrcaWorkers(run) : undefined;
}

/**
 * Routes a job and reserves its capacity in one atomic step. Under the ledger's lock the reservations are
 * read again and the route is decided on them, so the decision is revalidated against every reservation
 * made since the usage was gathered, and two processes can never both take the last free capacity.
 * A dry run decides on a lock-free copy and reserves nothing.
 */
export function routeAndReserve(req: RouteRequest, env: Environment, config: Config, dir: string = cacheDir(), opts: { dryRun?: boolean } = {}): Decision {
  if (opts.dryRun) return planRoute(req, env, config).decision;
  return withLedger(dir, (ledger) => {
    const usage = syncLedger(ledger, env.usage, env.now, config);
    const { decision, reserve } = planRoute(req, { ...env, usage, reservations: liveReservations(ledger) }, config);
    if (decision.status === 'ok' && reserve) {
      const reservation: Reservation = { id: newReservationId(), state: 'pending', ...reserve, createdAt: env.now };
      ledger.reservations.push(reservation);
      decision.reservation = {
        id: reservation.id, state: 'pending',
        buckets: (decision.quota?.buckets ?? []).map((b) => ({ bucket: b.id, percentPoints: b.buffer })),
        expiresAt: env.now + config.reservations.pendingMinutes * 60_000,
      };
    }
    return decision;
  });
}

export interface LifecycleChange {
  /** The reservation after the change; undefined when none matched. */
  reservation?: Reservation;
  /** Its state before the change. */
  from?: Reservation['state'];
}

function change(dir: string, q: Parameters<typeof findReservation>[1], apply: (r: Reservation, ledger: Ledger) => Reservation): LifecycleChange {
  return withLedger(dir, (ledger) => {
    const found = findReservation(ledger.reservations, q);
    if (!found) return {};
    const next = apply(found, ledger);
    putReservation(ledger, next);
    return { reservation: next, from: found.state };
  });
}

/** Binds a reservation to its worker's Dispatch and marks it running. The same record changes state: nothing is reserved twice. */
export function markRunning(q: { reservationId?: string; dispatchId: string; agent?: string; model?: string }, now: number, dir: string = cacheDir()): LifecycleChange {
  return change(dir, q, (r) => {
    const bound = { ...r, dispatchId: q.dispatchId };
    return r.state === 'pending' ? { ...bound, state: 'running', startedAt: now } : bound;
  });
}

/**
 * Ends a reservation. `failed-before-launch` releases it at once; `completed` and `cancelled` keep it counting
 * until a fresh usage snapshot covers what the worker consumed.
 */
export function endWorker(
  q: { reservationId?: string; dispatchId?: string; agent?: string; model?: string },
  outcome: ReleaseOutcome,
  now: number,
  dir: string = cacheDir(),
  note?: string,
): LifecycleChange {
  return change(dir, q, (r) => endReservation(q.dispatchId && !r.dispatchId ? { ...r, dispatchId: q.dispatchId } : r, outcome, now, note));
}

/** Drops every reservation: an escape hatch, like `rejected --clear`. Returns how many still counted. */
export function clearReservations(dir: string = cacheDir()): number {
  return withLedger(dir, (ledger) => {
    const live = ledger.reservations.filter(isLive).length;
    ledger.reservations = [];
    return live;
  });
}
