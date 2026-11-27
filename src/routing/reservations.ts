import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from '../paths.js';
import type { AgentId, AgentUsage, Config, UsagePool } from '../types.js';
import {
  applyWorkerStates, BUFFER_EFFORTS, BUFFER_TIERS, isLive, reconcile, RESERVATION_STATES,
  type BufferEffort, type BufferTier, type Reservation, type ReservationState, type WorkerState,
} from './quota.js';

// The reservation ledger: every allocated worker's lifecycle record, plus the last valid usage snapshot of
// each provider. It lives in the cache folder and is shared by every OrcaCompass process on the machine, so
// each change is one read-modify-write under an exclusive lock file, written through a temp file and an
// atomic rename. A crashed process leaves at most a stale lock, which the next one breaks.

export const LEDGER_FILE = 'reservations.json';
const LOCK_FILE = 'reservations.lock';
/** A lock this old belongs to a process that died while holding it. */
const STALE_LOCK_MS = 15_000;
const LOCK_TIMEOUT_MS = 20_000;

export interface Ledger {
  version: 1;
  reservations: Reservation[];
  /** The last snapshot of each provider that held valid usage: stands in when Orca cannot be read. */
  snapshots: Record<AgentId, AgentUsage>;
}

export class LedgerLockError extends Error {}

const emptyLedger = (): Ledger => ({ version: 1, reservations: [], snapshots: {} });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseReservation(v: unknown): Reservation | undefined {
  if (!isObj(v)) return undefined;
  const { id, state, agent, model, tier, effort, scope, pools, createdAt } = v;
  if (typeof id !== 'string' || id === '' || typeof agent !== 'string' || typeof model !== 'string' || typeof scope !== 'string') return undefined;
  if (!RESERVATION_STATES.includes(state as ReservationState) || !BUFFER_TIERS.includes(tier as BufferTier) || !BUFFER_EFFORTS.includes(effort as BufferEffort)) return undefined;
  if (!Array.isArray(pools) || !pools.every((p) => typeof p === 'string') || !finite(createdAt)) return undefined;
  return {
    id, state: state as ReservationState, agent, model, tier: tier as BufferTier, effort: effort as BufferEffort, scope, pools: [...new Set(pools as string[])],
    ...(typeof v.dispatchId === 'string' && v.dispatchId !== '' ? { dispatchId: v.dispatchId } : {}),
    createdAt,
    ...(finite(v.startedAt) ? { startedAt: v.startedAt } : {}),
    ...(finite(v.endedAt) ? { endedAt: v.endedAt } : {}),
    snapshotAt: finite(v.snapshotAt) ? v.snapshotAt : null,
    ...(typeof v.note === 'string' ? { note: v.note } : {}),
  };
}

function parseSnapshot(v: unknown): AgentUsage | undefined {
  if (!isObj(v) || typeof v.agent !== 'string' || v.status !== 'ok' || !finite(v.updatedAt) || !isObj(v.pools)) return undefined;
  const pools: Record<string, UsagePool> = {};
  for (const [name, p] of Object.entries(v.pools)) {
    if (!isObj(p) || typeof p.name !== 'string' || (p.kind !== 'session' && p.kind !== 'long')) continue;
    pools[name] = {
      name: p.name, kind: p.kind,
      usedPercent: finite(p.usedPercent) ? p.usedPercent : null,
      windowMinutes: finite(p.windowMinutes) ? p.windowMinutes : null,
      resetsAt: finite(p.resetsAt) ? p.resetsAt : null,
    };
  }
  return {
    agent: v.agent, status: 'ok', pools, updatedAt: v.updatedAt,
    ...(typeof v.scope === 'string' ? { scope: v.scope } : {}),
    ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
  };
}

/** Parses the ledger file, dropping malformed entries and duplicate reservation ids; empty when missing or invalid. */
export function parseLedger(text: string | undefined): Ledger {
  const ledger = emptyLedger();
  let raw: unknown;
  try { raw = JSON.parse(text ?? ''); } catch { return ledger; }
  if (!isObj(raw)) return ledger;
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.reservations) ? raw.reservations : []) {
    const r = parseReservation(entry);
    // A worker recorded twice is one worker: the first record stands.
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    ledger.reservations.push(r);
  }
  if (isObj(raw.snapshots)) {
    for (const [agent, entry] of Object.entries(raw.snapshots)) {
      const s = parseSnapshot(entry);
      if (s && s.agent === agent) ledger.snapshots[agent] = s;
    }
  }
  return ledger;
}

/** A read without the lock: a consistent copy, since the file is only ever replaced whole. */
export function readLedger(dir: string = cacheDir()): Ledger {
  try {
    return parseLedger(readFileSync(join(dir, LEDGER_FILE), 'utf8'));
  } catch {
    return emptyLedger();
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(dir: string): string {
  const lock = join(dir, LOCK_FILE);
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // 'wx' creates the file only when it does not exist: one process wins.
      const fd = openSync(lock, 'wx');
      try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return lock;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows reports a lock file being deleted by its owner as EPERM or EACCES for a moment.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch { /* released between the two calls: try again */ }
      if (Date.now() >= deadline) throw new LedgerLockError(`the reservation ledger stayed locked for ${LOCK_TIMEOUT_MS / 1000}s (${lock})`);
      sleepSync(8 + Math.floor(Math.random() * 25));
    }
  }
}

function release(lock: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      unlinkSync(lock);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      sleepSync(5);
    }
  }
}

function replaceFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text);
    // Windows refuses the rename for a moment while another process has the target open.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 60 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
        sleepSync(10);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed, or never written */ }
  }
}

/**
 * One atomic change to the ledger: takes the lock, reads the file, runs `change` on it and writes the result
 * when it differs. Everything `change` decides is decided on the ledger no other process can alter meanwhile.
 */
export function withLedger<T>(dir: string, change: (ledger: Ledger) => T): T {
  const lock = acquire(dir);
  try {
    const file = join(dir, LEDGER_FILE);
    let text: string | undefined;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const ledger = parseLedger(text);
    const result = change(ledger);
    const next = `${JSON.stringify(ledger, null, 2)}\n`;
    if (next !== text) replaceFile(file, next);
    return result;
  } finally {
    release(lock);
  }
}

export const newReservationId = (): string => `rsv_${randomBytes(6).toString('hex')}`;

/**
 * Folds what Orca reported into the ledger (mutating it) and returns the usage to route on:
 * - a provider's valid snapshot replaces the stored one;
 * - when Orca could not be read at all, the stored snapshot stands in, marked `retained`: valid usage is
 *   never replaced by nothing, and a retained snapshot never reconciles a reservation;
 * - the reservations are brought up to date with the workers Orca reports and with the snapshots.
 */
export function syncLedger(
  ledger: Ledger,
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: Config,
  workers?: { states: WorkerState[]; complete: boolean },
): Record<AgentId, AgentUsage> {
  const merged: Record<AgentId, AgentUsage> = {};
  for (const [agent, u] of Object.entries(usage)) {
    if (u.status === 'ok' && u.updatedAt !== undefined && !u.retained) {
      // Stored in the shape it is read back in, so an unchanged snapshot leaves the file byte for byte the same.
      ledger.snapshots[agent] = parseSnapshot(u) ?? ledger.snapshots[agent];
      merged[agent] = u;
    } else if (u.status === 'unknown' && u.unreachable && Object.hasOwn(ledger.snapshots, agent)) {
      merged[agent] = { ...ledger.snapshots[agent], retained: true, ...(u.error ? { error: u.error } : {}) };
    } else merged[agent] = u;
  }
  let list: readonly Reservation[] = ledger.reservations;
  if (workers) list = applyWorkerStates(list, workers.states, now, workers.complete);
  ledger.reservations = reconcile(list, merged, now, config.reservations);
  return merged;
}

/** The ledger's live reservations: those that count against their buckets. */
export const liveReservations = (ledger: Ledger): Reservation[] => ledger.reservations.filter(isLive);

export type ReleaseOutcome = 'completed' | 'cancelled' | 'failed-before-launch';

/**
 * Ends a reservation: `failed-before-launch` consumed nothing and stops counting at once; `completed` and
 * `cancelled` keep counting until a fresh snapshot covers what the worker used. Idempotent.
 */
export function endReservation(r: Reservation, outcome: ReleaseOutcome, now: number, note?: string): Reservation {
  if (!isLive(r) || r.state === 'completed' || r.state === 'cancelled_after_consumption') return r;
  const state: ReservationState = outcome === 'failed-before-launch' ? 'failed_before_launch' : outcome === 'cancelled' ? 'cancelled_after_consumption' : 'completed';
  return { ...r, state, endedAt: now, ...(note ? { note } : {}) };
}

/**
 * The reservation a Dispatch belongs to: the one already bound to it, else the given id, else the oldest
 * unbound pending reservation for the same agent and launch model.
 */
export function findReservation(list: readonly Reservation[], q: { reservationId?: string; dispatchId?: string; agent?: string; model?: string }): Reservation | undefined {
  if (q.dispatchId) {
    const bound = list.find((r) => r.dispatchId === q.dispatchId);
    if (bound) return bound;
  }
  if (q.reservationId) return list.find((r) => r.id === q.reservationId);
  if (!q.agent || !q.model) return undefined;
  return list
    .filter((r) => r.state === 'pending' && !r.dispatchId && r.agent === q.agent && r.model === q.model)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
}

/** Replaces the record with the same id. */
export function putReservation(ledger: Ledger, r: Reservation): void {
  ledger.reservations = ledger.reservations.map((x) => (x.id === r.id ? r : x));
}
