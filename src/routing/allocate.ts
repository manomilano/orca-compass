import { createHash } from 'node:crypto';
import { cacheDir } from '../paths.js';
import { modelFamily } from '../placements/tiers.js';
import type { AgentId, AgentUsage, Config, Decision, Effort, Environment, PlacedAgent, RouteRequest } from '../types.js';
import type { Runner } from '../system/run.js';
import {
  bufferEffortOf, bufferTierOf, isConfirmedLive, isLive, poolKey, revive, scopeOf, type BufferEffort, type BufferTier, type Reservation, type WorkerState,
} from './quota.js';
import { readOrcaWorkers } from './orca-workers.js';
import {
  CORRUPT_LEDGER_FILE, endReservation, findReservation, liveReservations, newReservationId, putReservation, readLedgerState, syncLedger, withLedger,
  type Ledger, type LockTiming, type ReleaseOutcome,
} from './reservations.js';
import { launchIds, planRoute } from './router.js';

// Where routing meets the reservation ledger. The router itself is pure; these functions make its decisions
// and the lifecycle of the reserved capacity atomic across every OrcaCompass process on the machine.

/** Orca's worker list as `readOrcaWorkers` returns it. */
export type Workers = { states: WorkerState[]; complete: boolean };

export interface Synced {
  /** The usage to route on: Orca's snapshots, or the last valid one where Orca could not be read. */
  usage: Record<AgentId, AgentUsage>;
  /** Every record still in the ledger, live or recently ended. */
  reservations: Reservation[];
  /** Set when the ledger could not be read or written; the result was then computed without saving it. */
  error?: string;
  /** Set when the ledger file was unreadable and was replaced: what happened, and what was reconstructed. */
  recovered?: string;
}

export interface SyncOptions {
  /** The placed models, to reconstruct the buffer row and windows of live workers after a corrupt ledger. */
  discoveries?: readonly PlacedAgent[];
  /** Lock timing, for tests. */
  timing?: LockTiming;
}

// --- recovery after a corrupt ledger -------------------------------------------------------

/** A recovered record's id: derived from its Dispatch, so recovering twice cannot count one worker twice. */
const recoveredId = (dispatchId: string): string => `rsv_${createHash('sha256').update(dispatchId).digest('hex').slice(0, 12)}`;

/** The effort a launch model id encodes (a Cursor variant such as `claude-opus-5-5-high`), when it does. */
function variantEffort(model: PlacedAgent['models'][number], launched: string): Effort | undefined {
  if (model.launch.kind !== 'variant') return undefined;
  return (Object.entries(model.launch.ids) as [Effort, string][]).find(([, id]) => id === launched)?.[0];
}

/**
 * Best-effort reservations for the workers Orca reports live when the ledger had to be reset: their records
 * were lost, but they are still drawing on their quotas. Each becomes a `running` record bound to its Dispatch,
 * on the windows its model is declared to draw on (or, with the model unknown, every window its agent reports
 * now), with its buffer row from the placed model (else the largest) and the effort its launch id encodes
 * (else the model's reported default, else `high`). Workers already in the ledger, not confirmed live, or
 * listed without an agent are left out; the latter are returned in `unmatched`. Pure and deterministic.
 */
export function recoverReservations(
  existing: readonly Reservation[],
  states: readonly WorkerState[],
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: Config,
  discoveries: readonly PlacedAgent[] = [],
): { added: Reservation[]; unmatched: string[] } {
  const added: Reservation[] = [];
  const unmatched: string[] = [];
  const bound = new Set(existing.map((r) => r.dispatchId).filter((d): d is string => d !== undefined));
  for (const w of states) {
    if (!isConfirmedLive(w) || bound.has(w.dispatchId)) continue;
    bound.add(w.dispatchId);
    if (w.agent === undefined) {
      unmatched.push(w.dispatchId);
      continue;
    }
    const u = Object.hasOwn(usage, w.agent) ? usage[w.agent] : undefined;
    const placed = w.model === undefined ? undefined : discoveries.find((d) => d.agent === w.agent)?.models.find((m) => launchIds(m).includes(w.model!));
    const pools = [...new Set((placed ? placed.poolNames : u?.status === 'ok' ? Object.values(u.pools).map((p) => p.name) : []).map(poolKey))];
    if (pools.length === 0) {
      unmatched.push(w.dispatchId);
      continue;
    }
    const tier: BufferTier = placed
      ? bufferTierOf({ modelId: placed.modelId, family: modelFamily(placed.modelId, placed.meta) }, placed.profile.cost?.tier ?? null, config.reservations)
      : 'frontier';
    const encoded = placed && w.model !== undefined ? variantEffort(placed, w.model) : undefined;
    const effort: BufferEffort = bufferEffortOf(encoded ?? null, placed?.defaultEffort);
    const assumed = [
      ...(placed ? [] : [w.model === undefined ? 'model not reported' : 'model not in the placement table', 'largest buffer row assumed']),
      ...(encoded ? [] : [`effort not reported, ${effort} assumed`]),
    ];
    added.push({
      id: recoveredId(w.dispatchId), state: 'running', agent: w.agent, model: w.model ?? 'unknown', tier, effort,
      scope: scopeOf(u), pools,
      ...(u?.status === 'ok' && u.account !== undefined ? { account: u.account } : {}),
      ...(u?.status === 'ok' && u.plan !== undefined ? { plan: u.plan } : {}),
      dispatchId: w.dispatchId, createdAt: now, startedAt: now, snapshotAt: u?.status === 'ok' ? u.updatedAt ?? null : null,
      note: `recovered from Orca's live workers after the reservation ledger was reset${assumed.length > 0 ? ` (${assumed.join('; ')})` : ''}`,
    });
  }
  return { added, unmatched };
}

/** Adds the recovered records to a ledger just reset, and says what happened. */
function recover(ledger: Ledger, why: string, usage: Record<AgentId, AgentUsage>, now: number, config: Config, workers: Workers | undefined, opts: SyncOptions): string {
  const parts = [`the reservation ledger was unreadable (${why}) and was reset; the old file is kept as ${CORRUPT_LEDGER_FILE}`];
  if (!workers) {
    parts.push("Orca's worker list was not available, so the reservations of workers still running are lost until they finish");
    return parts.join('; ');
  }
  const { added, unmatched } = recoverReservations(ledger.reservations, workers.states, usage, now, config, opts.discoveries);
  ledger.reservations.push(...added);
  parts.push(`${added.length} running reservation${added.length === 1 ? '' : 's'} reconstructed from Orca's live workers`);
  if (unmatched.length > 0) parts.push(`${unmatched.length} live worker${unmatched.length === 1 ? '' : 's'} could not be reconstructed (${unmatched.join(', ')})`);
  return parts.join('; ');
}

// --- sync and route ------------------------------------------------------------------------

/**
 * Reconciles the ledger with what Orca reports now and returns the result. The lock is taken only when
 * something changes, so commands that find nothing new leave the cache folder untouched. A ledger file that is
 * not a ledger is reset, and the running workers Orca reports live are reconstructed in it (see
 * `recoverReservations`).
 */
export function syncReservations(
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: Config,
  dir: string = cacheDir(),
  workers?: Workers,
  opts: SyncOptions = {},
): Synced {
  const state = readLedgerState(dir);
  const preview = state.ledger;
  const before = JSON.stringify(preview);
  const merged = syncLedger(preview, usage, now, config, workers);
  if (state.corrupt === undefined && state.error === undefined && JSON.stringify(preview) === before) return { usage: merged, reservations: preview.reservations };
  try {
    return withLedger(dir, (ledger, info) => {
      const fresh = syncLedger(ledger, usage, now, config, workers);
      const recovered = info.recovered !== undefined ? recover(ledger, info.recovered, fresh, now, config, workers, opts) : undefined;
      return { usage: fresh, reservations: [...ledger.reservations], ...(recovered !== undefined ? { recovered } : {}) };
    }, opts.timing);
  } catch (e) {
    return { usage: merged, reservations: preview.reservations, error: (e as Error).message };
  }
}

/**
 * Orca's worker states, asked for only when a reservation is bound to a Dispatch that may have changed (pending,
 * running, or ended only by a timeout, which Orca may still prove wrong), or when the ledger is unreadable and
 * its running workers may have to be reconstructed.
 */
export async function workerStatesFor(run: Runner, dir: string = cacheDir()): Promise<Workers | undefined> {
  const state = readLedgerState(dir);
  const bound = state.ledger.reservations.some((r) => r.dispatchId && (r.state === 'pending' || r.state === 'running' || r.inferred));
  return bound || state.corrupt !== undefined ? readOrcaWorkers(run) : undefined;
}

/**
 * Routes a job and reserves its capacity in one atomic step. Under the ledger's lock the reservations are
 * read again and the route is decided on them, so the decision is revalidated against every reservation
 * made since the usage was gathered, and two processes can never both take the last free capacity.
 * A dry run decides on a lock-free copy and reserves nothing.
 *
 * `workers` (Orca's worker list from the same gather) keeps a worker Orca confirms live from being closed for
 * running too long, and lets a ledger found corrupt here reconstruct the running workers. A ledger that cannot
 * be locked, read or written throws a `LedgerError`.
 */
export function routeAndReserve(
  req: RouteRequest,
  env: Environment,
  config: Config,
  dir: string = cacheDir(),
  opts: { dryRun?: boolean; workers?: Workers; timing?: LockTiming } = {},
): Decision {
  if (opts.dryRun) return planRoute(req, env, config).decision;
  return withLedger(dir, (ledger, info) => {
    const usage = syncLedger(ledger, env.usage, env.now, config, opts.workers);
    const recovered = info.recovered !== undefined ? recover(ledger, info.recovered, usage, env.now, config, opts.workers, { discoveries: env.discoveries }) : undefined;
    const { decision, reserve } = planRoute(req, { ...env, usage, reservations: liveReservations(ledger) }, config);
    if (recovered !== undefined) decision.warnings.push(recovered);
    if (decision.status === 'ok' && reserve) {
      const u = Object.hasOwn(usage, reserve.agent) ? usage[reserve.agent] : undefined;
      const known = u?.status === 'ok';
      // The account and plan reserved on, unless the router's spec already names them.
      const reservation: Reservation = {
        id: newReservationId(), state: 'pending',
        ...(known && u.account !== undefined ? { account: u.account } : {}),
        ...(known && u.plan !== undefined ? { plan: u.plan } : {}),
        ...reserve,
        createdAt: env.now,
      };
      ledger.reservations.push(reservation);
      decision.reservation = {
        id: reservation.id, state: 'pending',
        buckets: (decision.quota?.buckets ?? []).map((b) => ({ bucket: b.id, percentPoints: b.buffer })),
        expiresAt: env.now + config.reservations.pendingMinutes * 60_000,
      };
    }
    return decision;
  }, opts.timing);
}

// --- lifecycle -----------------------------------------------------------------------------

export interface LifecycleChange {
  /** The reservation after the change; undefined when none matched or it is bound to another Dispatch. */
  reservation?: Reservation;
  /** Its state before the change. */
  from?: Reservation['state'];
  /** The reservation found is bound to another Dispatch than the one given: nothing changed. */
  conflict?: { reservationId: string; boundTo: string };
}

function change(dir: string, q: Parameters<typeof findReservation>[1], apply: (r: Reservation, ledger: Ledger) => Reservation): LifecycleChange {
  return withLedger(dir, (ledger) => {
    const found = findReservation(ledger.reservations, q);
    if (!found) return {};
    // A reservation belongs to one worker: it is never moved silently to another Dispatch.
    if (q.dispatchId && found.dispatchId && found.dispatchId !== q.dispatchId) return { conflict: { reservationId: found.id, boundTo: found.dispatchId } };
    const next = apply(found, ledger);
    putReservation(ledger, next);
    return { reservation: next, from: found.state };
  });
}

/**
 * Binds a reservation to its worker's Dispatch and marks it running. The same record changes state: nothing is
 * reserved twice. A record whose end was only inferred from a timeout (abandoned as never confirmed, closed
 * for running too long) is running again: the worker was just seen started.
 */
export function markRunning(q: { reservationId?: string; dispatchId: string; agent?: string; model?: string }, now: number, dir: string = cacheDir()): LifecycleChange {
  return change(dir, q, (r) => {
    const bound = { ...revive(r, now), dispatchId: q.dispatchId };
    return bound.state === 'pending' ? { ...bound, state: 'running', startedAt: now } : bound;
  });
}

/**
 * Binds a reservation to its worker's Dispatch without confirming the launch (`verify` could not tell): it stays
 * pending, and Orca's worker list moves it on at the next sync, or `pendingMinutes` abandons it.
 */
export function bindDispatch(q: { reservationId?: string; dispatchId: string; agent?: string; model?: string }, dir: string = cacheDir()): LifecycleChange {
  return change(dir, q, (r) => ({ ...r, dispatchId: q.dispatchId }));
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
