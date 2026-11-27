import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { bindDispatch, clearReservations, endWorker, markRunning, recoverReservations, routeAndReserve, syncReservations } from '../../src/routing/allocate.js';
import { buildQuotaView, isLive, type Reservation, type WorkerState } from '../../src/routing/quota.js';
import {
  CORRUPT_LEDGER_FILE, findReservation, LEDGER_FILE, LedgerError, LedgerLockError, LOCK_FILE, parseLedger, readLedger, syncLedger, withLedger,
} from '../../src/routing/reservations.js';
import type { AgentUsage, Config, Environment } from '../../src/types.js';
import { machineEnv, NOW, withPool, withUsageUpdatedAt } from '../helpers/env.js';

// The reservation ledger on disk: atomic updates, recovery after a restart, and the lifecycle commands.
// The "#n" in a test name is the scenario number of the redesign's section 10.

const MIN = 60_000;
const config: Config = DEFAULT_CONFIG;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-ledger-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Claude only, so every route draws on the same session and weekly buckets. */
const claudeOnly = (weeklyUsed = 50): Environment => withPool(
  { ...machineEnv(), discoveries: machineEnv().discoveries.filter((d) => d.agent === 'claude') }, 'claude', 'weekly', { usedPercent: weeklyUsed });
const daily = { tier: 'daily' as const };
const weekly = (env: Environment, reservations: Reservation[]) =>
  buildQuotaView(env.usage, reservations, config, env.now).buckets.find((b) => b.agent === 'claude' && b.pool === 'weekly')!;
const stored = (): Reservation[] => readLedger(dir).reservations;

describe('routing reserves capacity', () => {
  it('reserves the route\'s buffer on every bucket it draws on and reports it', () => {
    const env = claudeOnly();
    const d = routeAndReserve(daily, env, config, dir);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } });
    expect(d.reservation).toMatchObject({
      id: expect.stringMatching(/^rsv_[0-9a-f]{12}$/), state: 'pending', expiresAt: NOW + 10 * MIN,
      buckets: [{ bucket: 'claude:default:session', percentPoints: 1.5 }, { bucket: 'claude:default:weekly', percentPoints: 1.5 }],
    });
    expect(stored()).toEqual([{
      id: d.reservation!.id, state: 'pending', agent: 'claude', model: 'claude-sonnet-5-5', tier: 'daily', effort: 'medium',
      scope: 'default', pools: ['session', 'weekly', 'monthly'], createdAt: NOW, snapshotAt: NOW,
    }]);
    // The next route sees it: reported stays 50, 1.5 pp is reserved, and its own buffer comes on top.
    const second = routeAndReserve(daily, env, config, dir);
    expect(second.quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 50, reserved: 1.5, workers: 1, effective: 51.5, buffer: 1.5, prospective: 53 });
    expect(second.reasons[0]).toContain('weekly 50% reported + 1.5 pp reserved (1 worker) + 1.5 pp for this worker = 53% prospective (available)');
  });

  it('reserves nothing on a dry run, for a decision without a route, or for a route without a usage window', () => {
    expect(routeAndReserve(daily, claudeOnly(), config, dir, { dryRun: true })).toMatchObject({ status: 'ok' });
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(false);
    const full = routeAndReserve(daily, claudeOnly(100), config, dir);
    expect(full.status).toBe('decide');
    expect(full.reservation).toBeUndefined();
    expect(stored()).toEqual([]);
  });

  it('#5 does not grow the buffer when routing is repeated on unchanged data without reserving', () => {
    const env = claudeOnly();
    routeAndReserve(daily, env, config, dir);
    const before = readFileSync(join(dir, LEDGER_FILE), 'utf8');
    const first = routeAndReserve(daily, { ...env, reservations: stored() }, config, dir, { dryRun: true });
    for (let i = 0; i < 25; i++) {
      const synced = syncReservations(env.usage, env.now, config, dir);
      expect(routeAndReserve(daily, { ...env, usage: synced.usage, reservations: synced.reservations }, config, dir, { dryRun: true })).toEqual(first);
    }
    expect(readFileSync(join(dir, LEDGER_FILE), 'utf8')).toBe(before);
    expect(weekly(env, stored())).toMatchObject({ reported: 50, reserved: 1.5, effective: 51.5 });
  });

  it('reserves every declared window, so a window missing at allocation counts once it appears (#2a)', () => {
    const base = claudeOnly();
    const { session: _session, ...pools } = base.usage.claude.pools;
    const noSession: Environment = { ...base, usage: { ...base.usage, claude: { ...base.usage.claude, pools } } };
    const d = routeAndReserve(daily, noSession, config, dir);
    expect(d.status).toBe('ok');
    // The decision lists only what is reported now; the ledger records every declared window.
    expect(d.reservation!.buckets.map((b) => b.bucket)).toEqual(['claude:default:weekly']);
    expect(stored()).toMatchObject([{ id: d.reservation!.id, pools: ['session', 'weekly', 'monthly'] }]);
    markRunning({ reservationId: d.reservation!.id, dispatchId: 'ctx_1' }, NOW + MIN, dir);
    // Session reappears at 88%: the running worker counts on it, and the next daily worker would reach 91%.
    const later = withUsageUpdatedAt(withPool(base, 'claude', 'session', { usedPercent: 88 }), NOW + 5 * MIN);
    const synced = syncReservations(later.usage, NOW + 5 * MIN, config, dir);
    const session = buildQuotaView(synced.usage, synced.reservations, config, NOW + 5 * MIN).buckets.find((b) => b.agent === 'claude' && b.pool === 'session');
    expect(session).toMatchObject({ reported: 88, reserved: 1.5, workers: 1 });
    const next = routeAndReserve(daily, { ...later, now: NOW + 5 * MIN }, config, dir);
    expect(next.status).toBe('decide');
    expect(next.options!.use[0].quota!.buckets.find((b) => b.pool === 'session')).toMatchObject({ prospective: 91, prospectiveStatus: 'high' });
  });

  it('#26 checks the thresholds on the prospective worker, under the lock, before allocating it', () => {
    // 80% reported: three daily workers stay below 85%, three more below 90%, the seventh would cross it.
    const env = claudeOnly(80);
    const outcomes = Array.from({ length: 8 }, () => routeAndReserve(daily, env, config, dir));
    expect(outcomes.map((d) => d.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'decide', 'decide']);
    expect(outcomes.map((d) => d.quota?.status ?? null)).toEqual(['available', 'available', 'available', 'caution', 'caution', 'caution', null, null]);
    expect(outcomes[5].quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ effective: 87.5, prospective: 89 });
    expect(weekly(env, stored())).toMatchObject({ reported: 80, reserved: 9, workers: 6, effective: 89, status: 'caution' });
    // The effective usage alone (89%) is below the limit: it is the seventh worker's own 1.5 pp that crosses it.
    expect(outcomes[6].options!.use[0]).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5', use: '--use claude/claude-sonnet-5-5' });
    expect(outcomes[6].options!.use[0].quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ prospective: 90.5, prospectiveStatus: 'high' });
  });
});

describe('concurrent processes', () => {
  const node = process.features as { typescript?: unknown };

  it.skipIf(!node.typescript)('#8 ten simultaneous routing requests neither lose nor duplicate a reservation', async () => {
    const env = claudeOnly(80);
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ env, config, req: daily }));
    const register = pathToFileURL(fileURLToPath(new URL('../helpers/ts-register.mjs', import.meta.url))).href;
    const worker = fileURLToPath(new URL('../helpers/reserve-worker.ts', import.meta.url));
    // A lock left behind by a process that died: the first contender takes it over at once.
    writeFileSync(join(dir, LOCK_FILE), '999999\n');
    const startAt = Date.now() + 1500;
    const run = () => new Promise<{ status: string; reservation: string | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', '--import', register, worker, input, dir, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited with ${code}: ${err}`))));
    });
    const results = await Promise.all(Array.from({ length: 10 }, run));
    // Exactly as many routes as fit below the threshold: six, as in the sequential case. Without an atomic
    // revalidation every process would have seen 80% and all ten would have been routed.
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(6);
    expect(results.filter((r) => r.status === 'decide')).toHaveLength(4);
    const ids = results.map((r) => r.reservation).filter((id): id is string => id !== null);
    expect(new Set(ids).size).toBe(6);
    // No lost update: every reservation handed out is in the ledger, once, and the file is intact.
    const ledger = parseLedger(readFileSync(join(dir, LEDGER_FILE), 'utf8'));
    expect(ledger.reservations.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(weekly(env, ledger.reservations)).toMatchObject({ reported: 80, reserved: 9, workers: 6, effective: 89 });
    expect(existsSync(join(dir, 'reservations.lock'))).toBe(false);
  }, 60_000);

  it('serializes changes made in one process and breaks a lock left by a dead one', () => {
    const add = (id: string) => withLedger(dir, (ledger) => { ledger.reservations.push({ id, state: 'pending', agent: 'claude', model: 'm', tier: 'daily', effort: 'low', scope: 'default', pools: ['weekly'], createdAt: NOW, snapshotAt: null }); });
    add('rsv_a');
    // A lock file nobody will remove: fresh, it would block; fifteen seconds old, it is taken over.
    const lock = join(dir, 'reservations.lock');
    writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    add('rsv_b');
    expect(stored().map((r) => r.id)).toEqual(['rsv_a', 'rsv_b']);
    expect(existsSync(lock)).toBe(false);
    // An exception inside the change releases the lock and writes nothing.
    let thrown: unknown;
    try { withLedger(dir, (ledger) => { ledger.reservations = []; throw new Error('boom'); }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('boom');
    // Not wrapped: only the ledger's own I/O becomes a LedgerError.
    expect(thrown).not.toBeInstanceOf(LedgerError);
    expect(stored()).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('the ledger file', () => {
  it('#25 reconstructs active and pending reservations after a restart, straight from the file', () => {
    const env = claudeOnly();
    const first = routeAndReserve(daily, env, config, dir);
    const second = routeAndReserve(daily, env, config, dir);
    markRunning({ reservationId: first.reservation!.id, dispatchId: 'ctx_1' }, NOW + MIN, dir);
    // A new process knows nothing but the file.
    const afterRestart = syncReservations(env.usage, NOW + 2 * MIN, config, dir);
    expect(afterRestart.reservations.map((r) => [r.id, r.state])).toEqual([[first.reservation!.id, 'running'], [second.reservation!.id, 'pending']]);
    expect(weekly(env, afterRestart.reservations)).toMatchObject({ reserved: 3, workers: 2 });
    // Hours later, still on the old snapshot: the pending one was abandoned but stays counted.
    const later = syncReservations(env.usage, NOW + 3 * 3_600_000, config, dir);
    expect(later.reservations.map((r) => r.state)).toEqual(['running', 'cancelled_after_consumption']);
    expect(weekly(env, later.reservations).reserved).toBe(3);
    // The next real refresh reconciles it; the running worker keeps its reservation.
    const fresh = withUsageUpdatedAt(env, NOW + 3 * 3_600_000 + 5 * MIN);
    const reconciled = syncReservations(fresh.usage, NOW + 3 * 3_600_000 + 5 * MIN, config, dir);
    expect(reconciled.reservations.map((r) => r.state)).toEqual(['running']);
    expect(weekly({ ...fresh, now: NOW + 3 * 3_600_000 + 5 * MIN }, reconciled.reservations)).toMatchObject({ reserved: 1.5, workers: 1 });
  });

  it('#12 drops malformed entries and counts a worker recorded twice once', () => {
    const r = { id: 'rsv_1', state: 'running', agent: 'claude', model: 'm', tier: 'daily', effort: 'medium', scope: 'default', pools: ['weekly', 'weekly'], createdAt: NOW, snapshotAt: NOW };
    const ledger = parseLedger(JSON.stringify({ version: 1, reservations: [r, { ...r }, { ...r, id: 'rsv_2', state: 'sleeping' }, { id: 'rsv_3' }, null, 'x', { ...r, id: 'rsv_4', tier: 'huge' }], snapshots: { claude: { agent: 'codex' } } }));
    expect(ledger.reservations).toEqual([{ ...r, pools: ['weekly'] }]);
    expect(ledger.snapshots).toEqual({});
    expect(weekly(claudeOnly(), ledger.reservations)).toMatchObject({ reserved: 1.5, workers: 1 });
    for (const text of [undefined, '', '{', '[]', 'null']) expect(parseLedger(text)).toEqual({ version: 2, reservations: [], snapshots: {} });
  });

  it('#12 moves one record from pending to running instead of reserving again', () => {
    const env = claudeOnly();
    const d = routeAndReserve(daily, env, config, dir);
    const before = weekly(env, stored());
    const change = markRunning({ dispatchId: 'ctx_9', agent: 'claude', model: 'claude-sonnet-5-5' }, NOW + MIN, dir);
    expect(change).toMatchObject({ from: 'pending', reservation: { id: d.reservation!.id, state: 'running', dispatchId: 'ctx_9', startedAt: NOW + MIN } });
    expect(stored()).toHaveLength(1);
    expect(weekly(env, stored())).toEqual(before);
    // Verifying the same worker again changes nothing.
    expect(markRunning({ dispatchId: 'ctx_9', agent: 'claude', model: 'claude-sonnet-5-5' }, NOW + 2 * MIN, dir).reservation).toMatchObject({ state: 'running', startedAt: NOW + MIN });
    expect(stored()).toHaveLength(1);
  });

  it('binds a Dispatch to the reservation named, else to the oldest unbound pending one for the same launch', () => {
    const list: Reservation[] = (['rsv_new', 'rsv_old', 'rsv_other', 'rsv_bound'] as const).map((id, i) => ({
      id, state: 'pending', agent: 'claude', model: i === 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', tier: 'daily', effort: 'medium', scope: 'default', pools: ['weekly'],
      createdAt: NOW - [1, 5, 9, 9][i] * MIN, snapshotAt: null, ...(i === 3 ? { dispatchId: 'ctx_b' } : {}),
    }));
    const launch = { agent: 'claude', model: 'claude-sonnet-5-5' };
    expect(findReservation(list, { dispatchId: 'ctx_new', ...launch })?.id).toBe('rsv_old');
    expect(findReservation(list, { dispatchId: 'ctx_new', reservationId: 'rsv_new', ...launch })?.id).toBe('rsv_new');
    expect(findReservation(list, { dispatchId: 'ctx_b', reservationId: 'rsv_new', ...launch })?.id).toBe('rsv_bound');
    expect(findReservation(list, { dispatchId: 'ctx_x', agent: 'codex', model: 'gpt-6.1-terra' })).toBeUndefined();
    expect(findReservation(list, { dispatchId: 'ctx_x' })).toBeUndefined();
  });
});

describe('ending a worker', () => {
  it('#11 releases the reservation of a worker that failed to launch at once', () => {
    const env = claudeOnly();
    const d = routeAndReserve(daily, env, config, dir);
    expect(weekly(env, stored()).reserved).toBe(1.5);
    const change = endWorker({ reservationId: d.reservation!.id }, 'failed-before-launch', NOW + MIN, dir, 'the agent refused the model at launch');
    expect(change).toMatchObject({ from: 'pending', reservation: { state: 'failed_before_launch', endedAt: NOW + MIN, note: 'the agent refused the model at launch' } });
    expect(weekly(env, stored())).toMatchObject({ reserved: 0, workers: 0, effective: 50 });
    // The freed capacity is there for the next route straight away, on the same cached snapshot.
    expect(routeAndReserve(daily, env, config, dir).quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reserved: 0, prospective: 51.5 });
  });

  it('#10 #32 keeps a finished or cancelled worker reserved until a fresh snapshot covers it', () => {
    const env = claudeOnly();
    const done = routeAndReserve(daily, env, config, dir).reservation!.id;
    const cancelled = routeAndReserve(daily, env, config, dir).reservation!.id;
    markRunning({ reservationId: done, dispatchId: 'ctx_1' }, NOW + MIN, dir);
    markRunning({ reservationId: cancelled, dispatchId: 'ctx_2' }, NOW + MIN, dir);
    expect(endWorker({ dispatchId: 'ctx_1' }, 'completed', NOW + 4 * MIN, dir).reservation).toMatchObject({ state: 'completed', endedAt: NOW + 4 * MIN });
    expect(endWorker({ dispatchId: 'ctx_2' }, 'cancelled', NOW + 4 * MIN, dir).reservation).toMatchObject({ state: 'cancelled_after_consumption' });
    // Their processes are gone, the snapshot is still the one from before: both still count.
    expect(weekly(env, syncReservations(env.usage, NOW + 9 * MIN, config, dir).reservations)).toMatchObject({ reserved: 3, workers: 2 });
    // Ending them again is a no-op, not a second transition.
    expect(endWorker({ dispatchId: 'ctx_1' }, 'failed-before-launch', NOW + 5 * MIN, dir).reservation).toMatchObject({ state: 'completed', endedAt: NOW + 4 * MIN });
    const fresh = withUsageUpdatedAt(withPool(env, 'claude', 'weekly', { usedPercent: 53 }), NOW + 10 * MIN);
    const synced = syncReservations(fresh.usage, NOW + 10 * MIN, config, dir);
    expect(synced.reservations.map((r) => r.state)).toEqual(['released', 'released']);
    expect(weekly({ ...fresh, now: NOW + 10 * MIN }, synced.reservations)).toMatchObject({ reported: 53, reserved: 0, effective: 53 });
  });

  it('reports no reservation for an unknown worker and forgets everything on request', () => {
    expect(endWorker({ dispatchId: 'ctx_missing' }, 'completed', NOW, dir)).toEqual({});
    routeAndReserve(daily, claudeOnly(), config, dir);
    routeAndReserve(daily, claudeOnly(), config, dir);
    expect(clearReservations(dir)).toBe(2);
    expect(stored()).toEqual([]);
  });
});

describe('usage snapshots in the ledger', () => {
  const unreachable = (): Record<string, AgentUsage> => ({
    claude: { agent: 'claude', status: 'unknown', pools: {}, error: 'Orca not reachable: spawn orca ENOENT', unreachable: true },
  });

  it('#23 keeps the last valid usage when the Orca CLI fails, never an artificial zero', () => {
    const env = claudeOnly(62);
    syncReservations(env.usage, NOW, config, dir);
    const down = syncReservations(unreachable(), NOW + 5 * MIN, config, dir);
    expect(down.usage.claude).toMatchObject({ status: 'ok', retained: true, updatedAt: NOW, error: 'Orca not reachable: spawn orca ENOENT' });
    expect(down.usage.claude.pools.weekly.usedPercent).toBe(62);
    const d = routeAndReserve(daily, { ...env, now: NOW + 5 * MIN, usage: down.usage, reservations: [] }, config, dir, { dryRun: true });
    expect(d).toMatchObject({ status: 'ok', confidence: 'medium' });
    expect(d.quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 62, prospective: 63.5 });
    // With nothing stored the usage is unknown: a low-confidence route, still not 0% used.
    const empty = mkdtempSync(join(tmpdir(), 'oc-ledger-empty-'));
    try {
      const nothing = syncReservations(unreachable(), NOW, config, empty);
      expect(nothing.usage.claude).toMatchObject({ status: 'unknown', pools: {} });
      const blind = routeAndReserve(daily, { ...env, usage: nothing.usage }, config, empty, { dryRun: true });
      expect(blind).toMatchObject({ status: 'ok', confidence: 'low', quota: { status: 'unknown', buckets: [] } });
      expect(blind.warnings.join('\n')).toContain('usage of claude is unknown');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('#7 #28 a retained or re-read snapshot reconciles nothing; a fresh one does, whatever it reports', () => {
    const env = claudeOnly();
    const id = routeAndReserve(daily, env, config, dir).reservation!.id;
    endWorker({ reservationId: id }, 'completed', NOW + MIN, dir);
    for (let i = 2; i <= 6; i++) expect(syncReservations(env.usage, NOW + i * 5 * MIN, config, dir).reservations[0].state).toBe('completed');
    expect(syncReservations(unreachable(), NOW + 40 * MIN, config, dir).reservations[0].state).toBe('completed');
    // Same 50%, new timestamp: Orca refreshed.
    expect(syncReservations(withUsageUpdatedAt(env, NOW + 45 * MIN).usage, NOW + 45 * MIN, config, dir).reservations[0].state).toBe('released');
  });

  it('writes the file only when something changed', () => {
    const env = claudeOnly();
    const ledger = { version: 2 as const, reservations: [], snapshots: {} };
    const merged = syncLedger(ledger, env.usage, NOW, config);
    // The ledger's view of the reading: the same windows, each stamped with when it was read.
    expect(merged.claude).toMatchObject({ status: 'ok', updatedAt: NOW, pools: { weekly: { usedPercent: 50, observedAt: NOW, seenAt: NOW } } });
    expect(Object.keys(ledger.snapshots)).toEqual(['claude', 'codex', 'cursor']);
    syncReservations(env.usage, NOW, config, dir);
    const file = join(dir, LEDGER_FILE);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    syncReservations(env.usage, NOW + MIN, config, dir);
    expect(Math.abs(statSync(file).mtimeMs - old.getTime())).toBeLessThan(2000);
    expect(stored().filter(isLive)).toEqual([]);
  });
});

const record = (id: string): Reservation => ({ id, state: 'pending', agent: 'claude', model: 'm', tier: 'daily', effort: 'low', scope: 'default', pools: ['weekly'], createdAt: NOW, snapshotAt: null });
const ids = (): string[] => stored().map((r) => r.id);
const unreachable = (agents: string[] = ['claude']): Record<string, AgentUsage> =>
  Object.fromEntries(agents.map((agent) => [agent, { agent, status: 'unknown', pools: {}, error: 'Orca not reachable: spawn orca ENOENT', unreachable: true }]));

describe('the lock', () => {
  const lock = () => join(dir, LOCK_FILE);
  const owner = (pid: number, host = hostname()) => JSON.stringify({ pid, host, token: 'feedfacefeedface', at: Date.now() });
  const age = (ms: number) => { const t = new Date(Date.now() - ms); utimesSync(lock(), t, t); };
  /** The pid of a process that has exited. */
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
  const add = (id: string, timing?: Parameters<typeof withLedger>[2]) => withLedger(dir, (ledger) => { ledger.reservations.push(record(id)); }, timing);

  it('#2 takes over the lock of a dead process on this host at once, however fresh', () => {
    writeFileSync(lock(), owner(deadPid()));
    const started = Date.now();
    add('rsv_a', { timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(ids()).toEqual(['rsv_a']);
    expect(existsSync(lock())).toBe(false);
  });

  it('#2 respects a live owner on this host until it has held the lock for 30 seconds', () => {
    const content = owner(process.pid);
    writeFileSync(lock(), content);
    age(20_000);
    expect(() => add('rsv_a', { timeoutMs: 300 })).toThrow(LedgerLockError);
    expect(readFileSync(lock(), 'utf8')).toBe(content);
    age(31_000);
    add('rsv_a', { timeoutMs: 300 });
    expect(ids()).toEqual(['rsv_a']);
    expect(existsSync(lock())).toBe(false);
  });

  it('#2 judges a lock of another host, or one naming no owner, by its age only', () => {
    ['other', 'empty', 'garbage'].forEach((kind, i) => {
      writeFileSync(lock(), kind === 'other' ? owner(process.pid, 'another-host') : kind === 'empty' ? '' : 'garbage');
      age(5_000);
      expect(() => add(`rsv_${i}`, { timeoutMs: 200 }), kind).toThrow(LedgerLockError);
      age(21_000);
      add(`rsv_${i}`, { timeoutMs: 200 });
    });
    expect(ids()).toEqual(['rsv_0', 'rsv_1', 'rsv_2']);
  });

  it('#2 writes nothing when its lock was taken over during the change, and leaves the new owner\'s lock in place', () => {
    add('rsv_a');
    const before = readFileSync(join(dir, LEDGER_FILE), 'utf8');
    const foreign = owner(process.pid);
    let runs = 0;
    expect(() => withLedger(dir, (ledger) => {
      runs++;
      ledger.reservations = [];
      writeFileSync(lock(), foreign);
    }, { timeoutMs: 300 })).toThrow(LedgerLockError);
    expect(runs).toBe(1);
    expect(readFileSync(join(dir, LEDGER_FILE), 'utf8')).toBe(before);
    expect(readFileSync(lock(), 'utf8')).toBe(foreign);
  });

  it('#2 runs a change whose lock was taken over again on a fresh read, at most three times', () => {
    const dead = owner(deadPid());
    let runs = 0;
    withLedger(dir, (ledger) => {
      runs++;
      ledger.reservations.push(record(`rsv_${runs}`));
      if (runs === 1) writeFileSync(lock(), dead);
    }, { timeoutMs: 5000 });
    expect(runs).toBe(2);
    expect(ids()).toEqual(['rsv_2']);
    expect(existsSync(lock())).toBe(false);
    runs = 0;
    expect(() => withLedger(dir, (ledger) => {
      runs++;
      ledger.reservations = [];
      writeFileSync(lock(), dead);
    }, { timeoutMs: 5000 })).toThrow(LedgerLockError);
    expect(runs).toBe(3);
    expect(ids()).toEqual(['rsv_2']);
  });
});

describe('a ledger that cannot be read or written', () => {
  it('#1 throws a LedgerError, quarantines nothing and leaves no lock behind', () => {
    mkdirSync(join(dir, LEDGER_FILE));
    expect(() => withLedger(dir, () => 1)).toThrow(LedgerError);
    expect(() => withLedger(dir, () => 1)).toThrow(/reservation ledger could not be read/);
    expect(() => routeAndReserve(daily, claudeOnly(), config, dir)).toThrow(LedgerError);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(existsSync(join(dir, CORRUPT_LEDGER_FILE))).toBe(false);
    // A sync reports it and still returns the usage it was given.
    const synced = syncReservations(claudeOnly().usage, NOW, config, dir);
    expect(synced.error).toMatch(/could not be read/);
    expect(synced.usage.claude).toMatchObject({ status: 'ok', pools: { weekly: { usedPercent: 50 } } });
  });
});

describe('a corrupt ledger', () => {
  const file = () => join(dir, LEDGER_FILE);
  const live = (dispatchId: string, agent?: string, model?: string): WorkerState =>
    ({ dispatchId, outcome: 'in_progress', liveness: 'live', terminalState: 'retained', ...(agent ? { agent } : {}), ...(model ? { model } : {}) });

  it('#1 keeps a file that is not a ledger aside and starts a fresh one', () => {
    for (const text of ['{"version": 2, "reservations": [', '', '[]', '{"version": 9, "reservations": []}', '{"version": 2, "reservations": {}}']) {
      writeFileSync(file(), text);
      expect(withLedger(dir, (_ledger, info) => info).recovered, text).toEqual(expect.any(String));
      expect(readFileSync(join(dir, CORRUPT_LEDGER_FILE), 'utf8')).toBe(text);
      expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 2, reservations: [], snapshots: {} });
      expect(withLedger(dir, (_ledger, info) => info)).toEqual({});
    }
  });

  it('#1 reconstructs the workers Orca reports live, on the latest usage snapshot', () => {
    const env = claudeOnly(62);
    writeFileSync(file(), '{ not json');
    const workers = {
      complete: true,
      states: [
        live('ctx_1', 'claude', 'claude-sonnet-5-5'),
        { dispatchId: 'ctx_2', outcome: 'succeeded', liveness: 'exited', agent: 'claude', model: 'claude-sonnet-5-5' },
        live('ctx_3'),
        live('ctx_4', 'claude', 'claude-mystery-9'),
      ],
    };
    const synced = syncReservations(env.usage, NOW, config, dir, workers, { discoveries: env.discoveries });
    expect(synced.error).toBeUndefined();
    expect(synced.recovered).toBe(
      'the reservation ledger was unreadable (not valid JSON) and was reset; the old file is kept as reservations.json.corrupt; ' +
      "2 running reservations reconstructed from Orca's live workers; 1 live worker could not be reconstructed (ctx_3)",
    );
    expect(synced.reservations).toHaveLength(2);
    const sonnet = synced.reservations.find((r) => r.dispatchId === 'ctx_1');
    expect(sonnet).toMatchObject({
      state: 'running', agent: 'claude', model: 'claude-sonnet-5-5', tier: 'daily', effort: 'high', scope: 'default',
      pools: ['session', 'weekly', 'monthly'], createdAt: NOW, startedAt: NOW, snapshotAt: NOW,
      note: "recovered from Orca's live workers after the reservation ledger was reset (effort not reported, high assumed)",
    });
    // A model the placement table does not know: every window its agent reports, the largest buffer row.
    expect(synced.reservations.find((r) => r.dispatchId === 'ctx_4')).toMatchObject({
      model: 'claude-mystery-9', tier: 'frontier', effort: 'high', pools: ['session', 'weekly', 'fableweekly'],
      note: expect.stringContaining('model not in the placement table'),
    });
    // The usage is the live snapshot, stored again.
    expect(readLedger(dir).snapshots.claude.pools.weekly.usedPercent).toBe(62);
    expect(weekly(env, synced.reservations)).toMatchObject({ reported: 62, reserved: 4.75, workers: 2 });
    // Recovered once: the next sync finds a valid ledger and adds nothing.
    const again = syncReservations(env.usage, NOW + MIN, config, dir, workers, { discoveries: env.discoveries });
    expect(again.recovered).toBeUndefined();
    expect(again.reservations.map((r) => r.dispatchId)).toEqual(['ctx_1', 'ctx_4']);
  });

  it('#1 says so when Orca\'s worker list is not available', () => {
    writeFileSync(file(), 'garbage');
    const synced = syncReservations(claudeOnly().usage, NOW, config, dir);
    expect(synced.recovered).toMatch(/worker list was not available/);
    expect(synced.reservations).toEqual([]);
  });

  it('#1 resets a corrupt ledger found while routing, with a warning, and still reserves', () => {
    writeFileSync(file(), 'garbage');
    const d = routeAndReserve(daily, claudeOnly(), config, dir, { workers: { complete: true, states: [live('ctx_1', 'claude', 'claude-sonnet-5-5')] } });
    expect(d.status).toBe('ok');
    expect(d.warnings.join('\n')).toContain('1 running reservation reconstructed');
    expect(stored().map((r) => [r.state, r.dispatchId ?? null])).toEqual([['running', 'ctx_1'], ['pending', null]]);
  });

  it('#1 reconstructs deterministically, with the effort a launch id encodes, and never twice for one Dispatch', () => {
    const env = machineEnv();
    const states = [live('ctx_9', 'cursor', 'claude-opus-5-5-low')];
    const first = recoverReservations([], states, env.usage, NOW, config, env.discoveries);
    expect(first.added).toEqual(recoverReservations([], states, env.usage, NOW, config, env.discoveries).added);
    expect(first.added[0]).toMatchObject({ agent: 'cursor', model: 'claude-opus-5-5-low', effort: 'low', pools: ['monthly', 'bucket:other models'] });
    expect(first.added[0].note).not.toContain('effort');
    expect(recoverReservations(first.added, states, env.usage, NOW, config, env.discoveries).added).toEqual([]);
  });
});

describe('the stored snapshot only moves forward', () => {
  it('#3 never routes on, or stores, a reading older than the stored one', () => {
    syncReservations(withUsageUpdatedAt(claudeOnly(99), NOW + 5 * MIN).usage, NOW + 5 * MIN, config, dir);
    // A process that read 10% before the 99% was stored.
    const d = routeAndReserve(daily, { ...claudeOnly(10), now: NOW + 6 * MIN }, config, dir);
    expect(d.status).toBe('decide');
    expect(d.options!.use[0].quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 99 });
    expect(readLedger(dir).snapshots.claude).toMatchObject({ updatedAt: NOW + 5 * MIN, pools: { weekly: { usedPercent: 99 } } });
  });

  it('#3 leaves the file byte for byte the same on a second sync of the same reading', () => {
    const env = claudeOnly();
    syncReservations(env.usage, NOW, config, dir);
    const before = readFileSync(join(dir, LEDGER_FILE), 'utf8');
    syncReservations(env.usage, NOW + MIN, config, dir);
    expect(readFileSync(join(dir, LEDGER_FILE), 'utf8')).toBe(before);
  });

  it('#3 reads a version 1 ledger and writes it back as version 2', () => {
    const weeklyPool = { name: 'weekly', kind: 'long', usedPercent: 40, windowMinutes: 10080, resetsAt: NOW + 86_400_000 };
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify({ version: 1, reservations: [], snapshots: { claude: { agent: 'claude', status: 'ok', updatedAt: NOW, pools: { weekly: weeklyPool } } } }));
    withLedger(dir, () => {});
    const written = JSON.parse(readFileSync(join(dir, LEDGER_FILE), 'utf8'));
    expect(written.version).toBe(2);
    expect(written.snapshots.claude.pools.weekly).toEqual({ ...weeklyPool, observedAt: NOW, seenAt: NOW });
  });

  it('#4 tracks when a carried window was really read, and settles a Fable worker only on a sound reading', () => {
    const base = claudeOnly().usage.claude;
    const reading = (t: number, fable: number, source: string): Record<string, AgentUsage> => ({
      claude: { ...base, updatedAt: t, source, pools: { ...base.pools, fableWeekly: { ...base.pools.fableWeekly, usedPercent: fable } } },
    });
    // A Fable worker that ended a minute after the OAuth reading.
    withLedger(dir, (ledger) => {
      ledger.reservations.push({
        id: 'rsv_f', state: 'completed', agent: 'claude', model: 'claude-fable-5-1', tier: 'frontier', effort: 'medium', scope: 'default',
        pools: ['session', 'weekly', 'monthly', 'fableweekly'], createdAt: NOW - 30 * MIN, endedAt: NOW + MIN, snapshotAt: NOW - 30 * MIN,
      });
    });
    const fable = () => readLedger(dir).snapshots.claude.pools.fableWeekly;
    const state = (s: ReturnType<typeof syncReservations>) => [s.reservations[0].state, s.reservations[0].settled ?? []];
    // OAuth: every window read now.
    expect(state(syncReservations(reading(NOW, 75, 'oauth'), NOW, config, dir))).toEqual(['completed', []]);
    expect(fable()).toMatchObject({ observedAt: NOW, seenAt: NOW });
    // A status-line tick carries fableWeekly forward unchanged: not a re-read.
    expect(state(syncReservations(reading(NOW + 5 * MIN, 75, 'live-session'), NOW + 5 * MIN, config, dir))).toEqual(['completed', ['session', 'weekly', 'monthly']]);
    expect(fable()).toMatchObject({ observedAt: NOW, seenAt: NOW + 5 * MIN });
    // It changed: re-read some time after it was last seen unchanged, which is after the worker ended.
    expect(state(syncReservations(reading(NOW + 10 * MIN, 76, 'live-session'), NOW + 10 * MIN, config, dir))[0]).toBe('released');
    expect(fable()).toMatchObject({ observedAt: NOW + 5 * MIN, seenAt: NOW + 10 * MIN });
  });

  it('#4 settles a Fable worker on an unchanged carried window after 20 minutes of healthy readings', () => {
    const base = claudeOnly().usage.claude;
    const tick = (t: number, patch: Partial<AgentUsage> = {}): Record<string, AgentUsage> => ({ claude: { ...base, updatedAt: t, source: 'live-session', ...patch } });
    syncReservations({ claude: { ...base, source: 'oauth' } }, NOW, config, dir);
    withLedger(dir, (ledger) => {
      ledger.reservations.push({
        id: 'rsv_f', state: 'completed', agent: 'claude', model: 'claude-fable-5-1', tier: 'frontier', effort: 'medium', scope: 'default',
        pools: ['weekly', 'fableweekly'], createdAt: NOW - 30 * MIN, endedAt: NOW + MIN, snapshotAt: NOW,
      });
    });
    expect(syncReservations(tick(NOW + 20 * MIN), NOW + 20 * MIN, config, dir).reservations[0].state).toBe('completed');
    // Orca kept its old windows after a failed refresh: never settles.
    expect(syncReservations(tick(NOW + 22 * MIN, { retained: true, error: 'Claude usage is unavailable.' }), NOW + 22 * MIN, config, dir).reservations[0].state).toBe('completed');
    expect(syncReservations(tick(NOW + 23 * MIN), NOW + 23 * MIN, config, dir).reservations[0].state).toBe('released');
  });

  it('#4 keeps a window missing from a reading while it ages, and drops it after two hours or once it reset', () => {
    const env = withPool(claudeOnly(), 'claude', 'session', { resetsAt: NOW + 20 * MIN });
    syncReservations(env.usage, NOW, config, dir);
    const without = (t: number, ...names: string[]): Record<string, AgentUsage> => {
      const u = env.usage.claude;
      return { ...env.usage, claude: { ...u, updatedAt: t, pools: Object.fromEntries(Object.entries(u.pools).filter(([n]) => !names.includes(n))) } };
    };
    const at = (t: number) => {
      const synced = syncReservations(without(t, 'fableWeekly', 'session'), t, config, dir);
      return Object.fromEntries(buildQuotaView(synced.usage, [], config, t).buckets.filter((b) => b.agent === 'claude').map((b) => [b.pool, [b.reported, b.stale]]));
    };
    expect(at(NOW + 10 * MIN)).toEqual({ session: [10, false], weekly: [50, false], fableWeekly: [75, false] });
    // The session window reset: gone. fableWeekly is 40 minutes old: stale.
    expect(at(NOW + 40 * MIN)).toEqual({ weekly: [50, false], fableWeekly: [75, true] });
    expect(at(NOW + 121 * MIN)).toEqual({ weekly: [50, false] });
  });
});

describe('accounts', () => {
  const as = (account: string, patch: Partial<AgentUsage> = {}): Record<string, AgentUsage> =>
    ({ claude: { ...claudeOnly(62).usage.claude, account, scope: `scope-${account}`, ...patch } });

  it('#6 never stands in a signed-out account\'s snapshot', () => {
    syncReservations(as('A'), NOW, config, dir);
    syncReservations({ claude: { agent: 'claude', status: 'unavailable', pools: {}, account: 'A', error: 'Not signed in' } }, NOW + MIN, config, dir);
    expect(readLedger(dir).snapshots).toEqual({});
    expect(syncReservations(unreachable(), NOW + 2 * MIN, config, dir).usage.claude).toMatchObject({ status: 'unknown', pools: {} });
  });

  it('#6 never stands in the snapshot of the account used before', () => {
    syncReservations(as('A'), NOW, config, dir);
    syncReservations({ claude: { agent: 'claude', status: 'unknown', pools: {}, account: 'B', error: 'Orca usage loading' } }, NOW + MIN, config, dir);
    expect(syncReservations(unreachable(), NOW + 2 * MIN, config, dir).usage.claude).toMatchObject({ status: 'unknown', pools: {} });
    // An agent that could not be read, of another known account, gets nothing of the stored one either.
    syncReservations(as('A'), NOW + 3 * MIN, config, dir);
    const other = { claude: { ...unreachable().claude, account: 'B' } };
    expect(syncReservations(other, NOW + 4 * MIN, config, dir).usage.claude).toMatchObject({ status: 'unknown', pools: {} });
    expect(syncReservations(unreachable(), NOW + 4 * MIN, config, dir).usage.claude).toMatchObject({ status: 'ok', retained: true });
  });

  it('#6 keeps the stored plan and scope for a reading of the same account that reports no plan', () => {
    syncReservations(as('A', { plan: 'max_5x', scope: 'scope-plan' }), NOW, config, dir);
    const tick = syncReservations(as('A', { plan: undefined, scope: 'scope-noplan', updatedAt: NOW + 5 * MIN }), NOW + 5 * MIN, config, dir);
    expect(tick.usage.claude).toMatchObject({ plan: 'max_5x', scope: 'scope-plan', updatedAt: NOW + 5 * MIN });
    expect(readLedger(dir).snapshots.claude).toMatchObject({ plan: 'max_5x', scope: 'scope-plan', updatedAt: NOW + 5 * MIN });
  });

  it('#6 counts a record reserved while Orca was down on the real bucket once a snapshot exists', () => {
    const env = claudeOnly();
    const down = { ...env, usage: unreachable(['claude', 'codex', 'cursor']) };
    expect(routeAndReserve(daily, down, config, dir).status).toBe('ok');
    expect(stored()[0]).toMatchObject({ scope: 'default', pools: ['session', 'weekly', 'monthly'] });
    const back = syncReservations(as('A'), NOW + MIN, config, dir);
    expect(back.reservations[0].scope).toBe('scope-A');
    expect(buildQuotaView(back.usage, back.reservations, config, NOW + MIN).buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 62, workers: 1 });
  });
});

describe('one reservation, one Dispatch', () => {
  it('#8 refuses to move a reservation bound to another Dispatch', () => {
    const id = routeAndReserve(daily, claudeOnly(), config, dir).reservation!.id;
    markRunning({ reservationId: id, dispatchId: 'ctx_7' }, NOW + MIN, dir);
    expect(markRunning({ reservationId: id, dispatchId: 'ctx_9' }, NOW + 2 * MIN, dir)).toEqual({ conflict: { reservationId: id, boundTo: 'ctx_7' } });
    expect(endWorker({ reservationId: id, dispatchId: 'ctx_9' }, 'completed', NOW + 2 * MIN, dir)).toEqual({ conflict: { reservationId: id, boundTo: 'ctx_7' } });
    expect(stored()).toMatchObject([{ id, state: 'running', dispatchId: 'ctx_7' }]);
  });

  it('#8 binds a Dispatch without confirming the launch, and Orca\'s worker list moves it on', () => {
    const id = routeAndReserve(daily, claudeOnly(), config, dir).reservation!.id;
    expect(bindDispatch({ reservationId: id, dispatchId: 'ctx_7' }, dir)).toMatchObject({ from: 'pending', reservation: { state: 'pending', dispatchId: 'ctx_7' } });
    const workers = { complete: true, states: [{ dispatchId: 'ctx_7', outcome: 'in_progress', liveness: 'live' }] };
    expect(syncReservations(claudeOnly().usage, NOW + MIN, config, dir, workers).reservations[0]).toMatchObject({ state: 'running', startedAt: NOW + MIN });
  });
});
