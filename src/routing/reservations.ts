import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cacheDir } from '../paths.js';
import type { AgentId, AgentUsage, Config, UsagePool } from '../types.js';
import {
  applyWorkerStates, BUFFER_EFFORTS, BUFFER_TIERS, confirmedLiveDispatches, isCarried, isLive, poolKey, reconcile, RESERVATION_STATES, scopeOf,
  type BufferEffort, type BufferTier, type Reservation, type ReservationState, type WorkerState,
} from './quota.js';

// The reservation ledger: every allocated worker's lifecycle record, plus the last valid usage snapshot of
// each provider. It lives in the cache folder and is shared by every OrcaCompass process on the machine, so
// each change is one read-modify-write under an exclusive lock file, written through a temp file and an
// atomic rename. A crashed process leaves at most a stale lock, which the next one takes over.

export const LEDGER_FILE = 'reservations.json';
/** Where an unreadable ledger file is kept before a fresh one replaces it. */
export const CORRUPT_LEDGER_FILE = `${LEDGER_FILE}.corrupt`;
export const LOCK_FILE = 'reservations.lock';
/** A lock of another host, or one that names no owner, is taken over once it is this old. */
export const STALE_LOCK_MS = 20_000;
/** A lock of a live process on this host is respected this long: longer, the pid was reused or the process froze. */
export const LIVE_OWNER_MAX_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
/** A change whose lock was taken over before it could commit is run again on a fresh read, at most this often. */
const COMMIT_ATTEMPTS = 3;

/** Lock timing, for tests; the defaults apply to every field left out. */
export interface LockTiming {
  timeoutMs?: number;
  staleMs?: number;
  liveOwnerMaxMs?: number;
}

export interface Ledger {
  version: 2;
  reservations: Reservation[];
  /**
   * The last snapshot of each provider that held valid usage, merged window by window: it stands in when Orca
   * cannot be read, and an older read never replaces it.
   */
  snapshots: Record<AgentId, AgentUsage>;
}

/** What `withLedger` found besides the ledger itself. */
export interface LedgerInfo {
  /** Set when the file was unreadable (why): it was kept as `reservations.json.corrupt` and `change` got an empty ledger. */
  recovered?: string;
}

/** The ledger could not be locked, read or written: nothing was changed. */
export class LedgerError extends Error {}
/** The ledger stayed locked by another process, or the lock was taken over before the change could be written. */
export class LedgerLockError extends LedgerError {}

const emptyLedger = (): Ledger => ({ version: 2, reservations: [], snapshots: {} });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string');

function parseReservation(v: unknown): Reservation | undefined {
  if (!isObj(v)) return undefined;
  const { id, state, agent, model, tier, effort, scope, pools, createdAt } = v;
  if (typeof id !== 'string' || id === '' || typeof agent !== 'string' || typeof model !== 'string' || typeof scope !== 'string') return undefined;
  if (!RESERVATION_STATES.includes(state as ReservationState) || !BUFFER_TIERS.includes(tier as BufferTier) || !BUFFER_EFFORTS.includes(effort as BufferEffort)) return undefined;
  if (!strings(pools) || !finite(createdAt)) return undefined;
  return {
    id, state: state as ReservationState, agent, model, tier: tier as BufferTier, effort: effort as BufferEffort, scope, pools: [...new Set(pools)],
    ...(strings(v.settled) && v.settled.length > 0 ? { settled: [...new Set(v.settled)] } : {}),
    ...(nonEmpty(v.account) ? { account: v.account } : {}),
    ...(nonEmpty(v.plan) ? { plan: v.plan } : {}),
    ...(nonEmpty(v.dispatchId) ? { dispatchId: v.dispatchId } : {}),
    createdAt,
    ...(finite(v.startedAt) ? { startedAt: v.startedAt } : {}),
    ...(finite(v.endedAt) ? { endedAt: v.endedAt } : {}),
    snapshotAt: finite(v.snapshotAt) ? v.snapshotAt : null,
    ...(typeof v.note === 'string' ? { note: v.note } : {}),
  };
}

/** A stored window. One without `observedAt`/`seenAt` (a version 1 ledger) was read at the snapshot's own time. */
function parseWindow(p: Record<string, unknown> & { name: string; kind: UsagePool['kind'] }, updatedAt: number): UsagePool {
  return {
    name: p.name, kind: p.kind,
    usedPercent: finite(p.usedPercent) ? p.usedPercent : null,
    windowMinutes: finite(p.windowMinutes) ? p.windowMinutes : null,
    resetsAt: finite(p.resetsAt) ? p.resetsAt : null,
    ...(nonEmpty(p.group) ? { group: p.group } : {}),
    observedAt: finite(p.observedAt) ? p.observedAt : updatedAt,
    seenAt: finite(p.seenAt) ? p.seenAt : updatedAt,
  };
}

function parseSnapshot(v: unknown): AgentUsage | undefined {
  if (!isObj(v) || typeof v.agent !== 'string' || v.status !== 'ok' || !finite(v.updatedAt) || !isObj(v.pools)) return undefined;
  const updatedAt = v.updatedAt;
  const pools: Record<string, UsagePool> = {};
  for (const [name, p] of Object.entries(v.pools)) {
    if (!isObj(p) || typeof p.name !== 'string' || (p.kind !== 'session' && p.kind !== 'long')) continue;
    pools[name] = parseWindow(p as Record<string, unknown> & { name: string; kind: UsagePool['kind'] }, updatedAt);
  }
  return {
    agent: v.agent, status: 'ok', pools, updatedAt,
    ...(typeof v.scope === 'string' ? { scope: v.scope } : {}),
    ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
    ...(nonEmpty(v.account) ? { account: v.account } : {}),
    ...(nonEmpty(v.source) ? { source: v.source } : {}),
  };
}

/**
 * Parses the ledger file (version 1 or 2; always written as 2), dropping malformed entries and duplicate
 * reservation ids. `corrupt` says why a file that exists is not a ledger at all: not JSON, not an object, an
 * unknown version, or lists of the wrong type. A malformed entry inside a valid file is only dropped.
 */
export function inspectLedger(text: string | undefined): { ledger: Ledger; corrupt?: string } {
  const ledger = emptyLedger();
  if (text === undefined) return { ledger };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ledger, corrupt: 'not valid JSON' };
  }
  if (!isObj(raw)) return { ledger, corrupt: 'not a ledger object' };
  if (raw.version !== 1 && raw.version !== 2) return { ledger, corrupt: `unknown ledger version ${JSON.stringify(raw.version) ?? 'missing'}` };
  if (!Array.isArray(raw.reservations)) return { ledger, corrupt: 'reservations is not a list' };
  if (raw.snapshots !== undefined && !isObj(raw.snapshots)) return { ledger, corrupt: 'snapshots is not an object' };
  const seen = new Set<string>();
  for (const entry of raw.reservations) {
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
  return { ledger };
}

/** Parses the ledger file leniently: empty when missing or invalid. */
export function parseLedger(text: string | undefined): Ledger {
  return inspectLedger(text).ledger;
}

/** The ledger as `withLedger` writes it. */
const serialize = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * A read without the lock: a consistent copy, since the file is only ever replaced whole. `corrupt` is set when
 * the file is not a ledger, `error` when it could not be read at all.
 */
export function readLedgerState(dir: string = cacheDir()): { ledger: Ledger; corrupt?: string; error?: string } {
  try {
    return inspectLedger(readOptional(join(dir, LEDGER_FILE)));
  } catch (e) {
    return { ledger: emptyLedger(), error: (e as Error).message };
  }
}

/** A read without the lock; empty when the file is missing, unreadable or corrupt. */
export function readLedger(dir: string = cacheDir()): Ledger {
  return readLedgerState(dir).ledger;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- the lock ------------------------------------------------------------------------------

/** Who holds a lock: a JSON record, or a legacy `<pid>` line, read as a process on this host. */
function lockOwner(content: string): { pid: number; host: string } | undefined {
  const legacy = /^\s*(\d+)\s*$/.exec(content);
  if (legacy) return { pid: Number(legacy[1]), host: hostname() };
  try {
    const v: unknown = JSON.parse(content);
    if (isObj(v) && Number.isSafeInteger(v.pid) && (v.pid as number) > 0 && nonEmpty(v.host)) return { pid: v.pid as number, host: v.host };
  } catch { /* not a lock this version wrote */ }
  return undefined;
}

/** `process.kill(pid, 0)` only tests for existence, on Windows and POSIX alike: ESRCH means no such process. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a lock found in place may be taken over: its owner on this host is dead (at once), a live owner on
 * this host has held it past `liveOwnerMaxMs`, or a lock of another host or without an owner is past `staleMs`.
 */
function abandoned(content: string, ageMs: number, staleMs: number, liveOwnerMaxMs: number): boolean {
  const owner = lockOwner(content);
  if (owner !== undefined && owner.host === hostname()) return !processAlive(owner.pid) || ageMs > liveOwnerMaxMs;
  return ageMs > staleMs;
}

/** The lock's content and age; undefined when it vanished or could not be read (try again). */
function inspectLock(lock: string): { content: string; ageMs: number } | undefined {
  try {
    // Content first: a newer lock replacing it in between then looks younger, never older, than it is.
    const content = readFileSync(lock, 'utf8');
    return { content, ageMs: Date.now() - statSync(lock).mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * The only way a lock file is removed, for a takeover and for a release. The lock is renamed away, then its
 * content is checked: when it is not the lock that was judged (another process replaced it meanwhile) it is
 * put back with a hard link, which fails harmlessly when a new lock already exists.
 */
function retire(lock: string, expected: string): 'retired' | 'mismatch' | 'missing' | 'busy' {
  const dead = `${lock}.${randomBytes(6).toString('hex')}.dead`;
  try {
    renameSync(lock, dead);
  } catch (e) {
    // ENOENT: another process got there first. EPERM, EACCES, EBUSY: transient on Windows, try again.
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'busy';
  }
  let moved: string | undefined;
  try { moved = readFileSync(dead, 'utf8'); } catch { /* unreadable: treat as another lock */ }
  const matched = moved === expected;
  if (!matched) {
    try { linkSync(dead, lock); } catch { /* a new lock is already in place */ }
  }
  try { unlinkSync(dead); } catch { /* removed already */ }
  return matched ? 'retired' : 'mismatch';
}

interface Held {
  lock: string;
  content: string;
}

function acquire(dir: string, timing: LockTiming): Held {
  const lock = join(dir, LOCK_FILE);
  mkdirSync(dir, { recursive: true });
  const timeoutMs = timing.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = timing.staleMs ?? STALE_LOCK_MS;
  const liveOwnerMaxMs = timing.liveOwnerMaxMs ?? LIVE_OWNER_MAX_MS;
  const content = JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(8).toString('hex'), at: Date.now() });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // 'wx' creates the file only when it does not exist: one process wins.
      const fd = openSync(lock, 'wx');
      try {
        writeFileSync(fd, content);
      } catch (e) {
        closeSync(fd);
        try { unlinkSync(lock); } catch { /* best effort */ }
        throw e;
      }
      closeSync(fd);
      return { lock, content };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows reports a lock file being deleted by its owner as EPERM or EACCES for a moment.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
      const found = inspectLock(lock);
      // Taken over: compete for the lock again like anyone else.
      if (found !== undefined && abandoned(found.content, found.ageMs, staleMs, liveOwnerMaxMs) && retire(lock, found.content) === 'retired') continue;
      if (Date.now() >= deadline) throw new LedgerLockError(`the reservation ledger stayed locked for ${timeoutMs / 1000}s (${lock})`);
      sleepSync(8 + Math.floor(Math.random() * 25));
    }
  }
}

/** Whether the lock is still the one this process created. */
function holds(held: Held): boolean {
  try {
    return readFileSync(held.lock, 'utf8') === held.content;
  } catch {
    return false;
  }
}

/** Removes the lock when it is still ours; a holder that was taken over removes nothing. */
function release(held: Held): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!holds(held)) return;
    if (retire(held.lock, held.content) !== 'busy') return;
    sleepSync(5);
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

/** Runs one step of the ledger's I/O and turns its failure into a `LedgerError`. */
function io<T>(what: string, step: () => T): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError(`the reservation ledger could not be ${what}: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * One atomic change to the ledger: takes the lock, reads the file, runs `change` on it and writes the result
 * when it differs. Everything `change` decides is decided on the ledger no other process can alter meanwhile.
 *
 * - Locking, reading or writing that fails throws a `LedgerError` (`LedgerLockError` for the lock); nothing is
 *   written. An error thrown by `change` passes through untouched.
 * - A file that is not a ledger (see `inspectLedger`) is copied to `reservations.json.corrupt` and replaced by
 *   a fresh one; `change` gets an empty ledger and `info.recovered` says why.
 * - Right before writing, the lock is checked again. When another process took it over, nothing is written and
 *   the whole change runs again on a fresh read, at most three times.
 */
export function withLedger<T>(dir: string, change: (ledger: Ledger, info: LedgerInfo) => T, timing: LockTiming = {}): T {
  const file = join(dir, LEDGER_FILE);
  for (let attempt = 1; ; attempt++) {
    const held = io('locked', () => acquire(dir, timing));
    try {
      const text = io('read', () => readOptional(file));
      const { ledger, corrupt } = inspectLedger(text);
      if (corrupt !== undefined) {
        try { copyFileSync(file, join(dir, CORRUPT_LEDGER_FILE)); } catch { /* best effort: the fresh ledger is written regardless */ }
      }
      const result = change(ledger, corrupt !== undefined ? { recovered: corrupt } : {});
      const next = serialize(ledger);
      if (next === text) return result;
      if (holds(held)) {
        io('written', () => replaceFile(file, next));
        return result;
      }
    } finally {
      release(held);
    }
    if (attempt >= COMMIT_ATTEMPTS) {
      throw new LedgerLockError(`the reservation ledger lock was taken over ${COMMIT_ATTEMPTS} times before the change could be written`);
    }
  }
}

export const newReservationId = (): string => `rsv_${randomBytes(6).toString('hex')}`;

// --- usage snapshots -----------------------------------------------------------------------

const sameReading = (a: UsagePool, b: UsagePool): boolean =>
  a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt && a.windowMinutes === b.windowMinutes;

/**
 * The snapshot to store for a readable reading, merged window by window into `prev` (same quota identity) or
 * stored whole (`prev` undefined).
 * - A window read now is observed at the reading's time, except one Orca carries forward (`CARRIED_WINDOWS`):
 *   unchanged, it keeps its earlier `observedAt`; changed, it was re-read after the previous reading was last
 *   seen; never stored, its observation time is unknown (0).
 * - A window missing from the reading is kept while its reset is ahead (or unknown) and the last reading of it
 *   is at most four times `usageStaleMinutes` old.
 * - A window that already carries `seenAt` comes from an earlier merge and is kept as it is.
 */
function mergedSnapshot(u: AgentUsage & { updatedAt: number }, prev: AgentUsage | undefined, now: number, config: Config): AgentUsage {
  const at = u.updatedAt;
  const pools: Record<string, UsagePool> = {};
  const previous = (name: string): UsagePool | undefined => (prev ? Object.values(prev.pools).find((p) => poolKey(p.name) === poolKey(name)) : undefined);
  for (const p of Object.values(u.pools)) {
    const { name, kind, usedPercent, windowMinutes, resetsAt, group } = p;
    const base: UsagePool = { name, kind, usedPercent, windowMinutes, resetsAt, ...(group !== undefined ? { group } : {}) };
    if (p.seenAt !== undefined) {
      pools[name] = { ...base, observedAt: p.observedAt ?? p.seenAt, seenAt: p.seenAt };
      continue;
    }
    let observedAt = at;
    if (isCarried(u.agent, u.source, name)) {
      const old = previous(name);
      const oldSeen = old?.seenAt ?? prev?.updatedAt ?? 0;
      observedAt = old === undefined ? 0 : sameReading(old, p) ? old.observedAt ?? oldSeen : oldSeen;
    }
    pools[name] = { ...base, observedAt, seenAt: at };
  }
  const keepMs = 4 * config.usageStaleMinutes * 60_000;
  for (const old of Object.values(prev?.pools ?? {})) {
    if (Object.values(pools).some((p) => poolKey(p.name) === poolKey(old.name))) continue;
    const seen = old.seenAt ?? prev!.updatedAt ?? 0;
    if ((old.resetsAt !== null && old.resetsAt <= now) || now - seen > keepMs) continue;
    pools[old.name] = old;
  }
  return {
    agent: u.agent, status: 'ok', pools, updatedAt: at,
    ...(u.scope !== undefined ? { scope: u.scope } : {}),
    ...(u.plan !== undefined ? { plan: u.plan } : {}),
    ...(u.account !== undefined ? { account: u.account } : {}),
    ...(u.source !== undefined ? { source: u.source } : {}),
  };
}

/**
 * Folds one agent's reading into the ledger's snapshot (mutating the ledger) and returns the usage to route on.
 * Monotonic: an older reading never replaces a newer stored one, so a process that read usage before another
 * stored a later reading neither rolls usage back nor releases a reservation on it.
 *
 * | Reading | Ledger | Returned |
 * | --- | --- | --- |
 * | unreachable (or a stand-in), same account | none | stored, `retained` and `standIn`, with the error |
 * | reachable, another account | stored snapshot deleted, then as below | |
 * | `unavailable` | stored snapshot deleted | the reading |
 * | `unknown`, or `ok` without `updatedAt` | none | the reading |
 * | `ok`, same scope, not newer than stored | none | stored |
 * | `ok`, same scope, newer | merged window by window | merged |
 * | `ok`, another scope (plan changed), not older | replaced whole | new |
 * | `ok`, another scope, older | none | stored |
 *
 * A reading of the stored account without a plan inherits the stored plan and scope. `retained` and `error`
 * of the reading are copied onto what is returned.
 */
function mergeReading(ledger: Ledger, agent: AgentId, u: AgentUsage, now: number, config: Config): AgentUsage {
  let stored = Object.hasOwn(ledger.snapshots, agent) ? ledger.snapshots[agent] : undefined;
  const otherAccount = (s: AgentUsage): boolean => s.account !== u.account;
  if (u.standIn || (u.unreachable && u.status === 'unknown')) {
    // An unreadable agent of a known other account gets nothing of the stored one, and a stand-in whose
    // snapshot is gone from the ledger meanwhile (another account, signed out) is unknown again.
    if (!stored || (u.account !== undefined && otherAccount(stored))) {
      return u.standIn
        ? { agent, status: 'unknown', pools: {}, ...(u.account !== undefined ? { account: u.account } : {}), ...(u.error ? { error: u.error } : {}), unreachable: true }
        : u;
    }
    return { ...stored, retained: true, standIn: true, ...(u.error ? { error: u.error } : {}) };
  }
  if (stored && otherAccount(stored)) {
    delete ledger.snapshots[agent];
    stored = undefined;
  }
  if (u.status === 'unavailable') {
    delete ledger.snapshots[agent];
    return u;
  }
  if (u.status !== 'ok' || u.updatedAt === undefined) return u;
  const view = (s: AgentUsage): AgentUsage => ({ ...s, ...(u.retained ? { retained: true } : {}), ...(u.error ? { error: u.error } : {}) });
  let reading = u as AgentUsage & { updatedAt: number };
  if (stored && reading.plan === undefined && stored.plan !== undefined) reading = { ...reading, plan: stored.plan, ...(stored.scope !== undefined ? { scope: stored.scope } : {}) };
  const storedAt = stored?.updatedAt ?? Number.NEGATIVE_INFINITY;
  let next: AgentUsage;
  if (!stored) next = mergedSnapshot(reading, undefined, now, config);
  else if (scopeOf(reading) === scopeOf(stored)) {
    if (reading.updatedAt <= storedAt) return view(stored);
    next = mergedSnapshot(reading, stored, now, config);
  } else {
    if (reading.updatedAt < storedAt) return view(stored);
    next = mergedSnapshot(reading, undefined, now, config);
  }
  ledger.snapshots[agent] = next;
  return view(next);
}

/**
 * Folds what Orca reported into the ledger (mutating it) and returns the usage to route on (see `mergeReading`):
 * - each provider's reading is merged into the stored snapshot, never rolling it back;
 * - when an agent could not be read, the stored snapshot of the same account stands in, marked `retained`:
 *   valid usage is never replaced by nothing, and a retained snapshot never reconciles a reservation;
 * - a live record reserved under the `default` scope (usage was unknown) adopts the agent's stored scope,
 *   unless it was reserved on another account;
 * - the reservations are brought up to date with the workers Orca reports and with the snapshots. A running
 *   worker Orca confirms live is never closed for running too long.
 */
export function syncLedger(
  ledger: Ledger,
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: Config,
  workers?: { states: WorkerState[]; complete: boolean },
): Record<AgentId, AgentUsage> {
  const merged: Record<AgentId, AgentUsage> = {};
  for (const [agent, u] of Object.entries(usage)) merged[agent] = mergeReading(ledger, agent, u, now, config);
  let list: readonly Reservation[] = ledger.reservations.map((r) => {
    const s = Object.hasOwn(ledger.snapshots, r.agent) ? ledger.snapshots[r.agent] : undefined;
    if (!isLive(r) || r.scope !== 'default' || s?.scope === undefined || s.scope === 'default') return r;
    if (r.account !== undefined && s.account !== undefined && r.account !== s.account) return r;
    return { ...r, scope: s.scope };
  });
  if (workers) list = applyWorkerStates(list, workers.states, now, workers.complete);
  ledger.reservations = reconcile(list, merged, now, config.reservations, workers ? confirmedLiveDispatches(workers.states) : undefined);
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
