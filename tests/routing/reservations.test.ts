import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { bindDispatch, clearReservations, endWorker, markRunning, recoverReservations, routeAndReserve, syncReservations } from '../../src/routing/allocate.js';
import { buildQuotaView, candidateQuota, isLive, type Reservation, type WorkerState } from '../../src/routing/quota.js';
import {
  CORRUPT_LEDGER_FILE, findReservation, LEDGER_FILE, LedgerError, LedgerLockError, LOCK_FILE, parseLedger, readLedger, syncLedger, TAKEOVER_FILE,
  takeOver, withLedger,
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
  const register = pathToFileURL(fileURLToPath(new URL('../helpers/ts-register.mjs', import.meta.url))).href;
  /** Runs a script as an independent `node` process that can load the TypeScript sources; resolves to its output, parsed. */
  const run = <T>(script: string, ...args: string[]) => new Promise<T>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', register, script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as T) : reject(new Error(`worker exited with ${code}: ${err}`))));
  });

  it.skipIf(!node.typescript)('#8 ten simultaneous routing requests neither lose nor duplicate a reservation', async () => {
    const env = claudeOnly(80);
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ env, config, req: daily }));
    const worker = fileURLToPath(new URL('../helpers/reserve-worker.ts', import.meta.url));
    // A lock left behind by a process that died: the first contender takes it over at once.
    writeFileSync(join(dir, LOCK_FILE), '999999\n');
    const startAt = Date.now() + 1500;
    const results = await Promise.all(Array.from({ length: 10 }, () => run<{ status: string; reservation: string | null }>(worker, input, dir, String(startAt))));
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

  // Ten processes that all find the same dead lock used to take it over one after another: a slower one
  // moved the winner's fresh lock away, which lost a change or left the winner waiting 20 s on its own lock.
  it.skipIf(!node.typescript)('#8 twenty bursts of ten processes on a dead process\'s lock lose no change and leave no lock stuck', async () => {
    const PROCESSES = 10;
    const ROUNDS = 20;
    // One folder per burst, each with the lock of a process that died, in either form a lock has.
    const dirs = Array.from({ length: ROUNDS }, (_, round) => {
      const folder = join(dir, `burst-${String(round).padStart(2, '0')}`);
      mkdirSync(folder);
      writeFileSync(join(folder, LOCK_FILE), round % 2 === 0 ? '999999\n' : JSON.stringify({ pid: 999999, host: hostname(), token: 'feedfacefeedface', at: Date.now() }));
      return folder;
    });
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify({ dirs, startAt: Date.now() + 1500, gapMs: 300, record: record('rsv') }));
    // One process: for every burst it reaches the lock at the shared instant and makes one change.
    const worker = join(dir, 'lock-worker.mjs');
    writeFileSync(worker, [
      'import { readFileSync } from \'node:fs\';',
      'const [moduleUrl, planFile, tag] = process.argv.slice(2);',
      'const { withLedger } = await import(moduleUrl);',
      'const { dirs, startAt, gapMs, record } = JSON.parse(readFileSync(planFile, \'utf8\'));',
      'const took = dirs.map((folder, round) => {',
      '  const at = startAt + round * gapMs;',
      '  if (at - Date.now() > 40) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, at - Date.now() - 40);',
      '  while (Date.now() < at) { /* spin so every process reaches the lock at the same moment */ }',
      '  const began = Date.now();',
      '  withLedger(folder, (ledger) => { ledger.reservations.push({ ...record, id: `rsv_${tag}_${round}` }); });',
      '  return Date.now() - began;',
      '});',
      'process.stdout.write(JSON.stringify(took));',
    ].join('\n'));
    const moduleUrl = new URL('../../src/routing/reservations.ts', import.meta.url).href;
    const took = await Promise.all(Array.from({ length: PROCESSES }, (_, tag) => run<number[]>(worker, moduleUrl, plan, String(tag))));
    dirs.forEach((folder, round) => {
      // No lost update: every process's change is in the ledger, once.
      const written = parseLedger(readFileSync(join(folder, LEDGER_FILE), 'utf8')).reservations.map((r) => r.id).sort();
      expect(written, `burst ${round}`).toEqual(Array.from({ length: PROCESSES }, (_, tag) => `rsv_${tag}_${round}`).sort());
      // No lock, takeover file or renamed lock left behind.
      expect(readdirSync(folder), `burst ${round}`).toEqual([LEDGER_FILE]);
    });
    // Nobody waited on a lock that no process held (the lock timeout is 20 s).
    expect(Math.max(...took.flat())).toBeLessThan(5_000);
  }, 120_000);

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
  const takeover = () => join(dir, TAKEOVER_FILE);
  const age = (ms: number, file = lock()) => { const t = new Date(Date.now() - ms); utimesSync(file, t, t); };
  /** The pid of a process that has exited. */
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
  /** The pid of a process that is alive and is not this one: a lock of this very process is an orphan. */
  let bystander: ChildProcess | undefined;
  const livePid = () => (bystander ??= spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })).pid!;
  afterAll(() => { bystander?.kill(); });
  const add =(id: string, timing?: Parameters<typeof withLedger>[2]) => withLedger(dir, (ledger) => { ledger.reservations.push(record(id)); }, timing);

  it('#2 takes over the lock of a dead process on this host at once, however fresh', () => {
    writeFileSync(lock(), owner(deadPid()));
    const started = Date.now();
    add('rsv_a', { timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(ids()).toEqual(['rsv_a']);
    expect(existsSync(lock())).toBe(false);
  });

  it('#2 respects a live owner on this host until it has held the lock for 30 seconds', () => {
    const content = owner(livePid());
    writeFileSync(lock(), content);
    age(20_000);
    expect(() => add('rsv_a', { timeoutMs: 300 })).toThrow(LedgerLockError);
    expect(readFileSync(lock(), 'utf8')).toBe(content);
    // Nothing was taken over, so no takeover file was ever created.
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    age(31_000);
    add('rsv_a', { timeoutMs: 300 });
    expect(ids()).toEqual(['rsv_a']);
    expect(existsSync(lock())).toBe(false);
  });

  it('takes over a lock of this very process at once, however fresh: nobody waits on their own orphan', () => {
    [owner(process.pid), `${process.pid}\n`].forEach((content, i) => {
      writeFileSync(lock(), content);
      const started = Date.now();
      add(`rsv_${i}`, { timeoutMs: 5000 });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(readdirSync(dir)).toEqual([LEDGER_FILE]);
    });
    expect(ids()).toEqual(['rsv_0', 'rsv_1']);
  });

  it('leaves the lock a winner put in place of the dead one alone, and removes only a lock that is still abandoned', () => {
    // What a slower contender finds when its turn to take over comes: the dead lock it judged is gone and
    // the winner's fresh lock is in its place.
    const fresh = owner(livePid());
    writeFileSync(lock(), fresh);
    expect(takeOver(lock())).toBe(false);
    expect(readFileSync(lock(), 'utf8')).toBe(fresh);
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    writeFileSync(lock(), owner(deadPid()));
    expect(takeOver(lock())).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    // Released meanwhile: nothing to take over.
    expect(takeOver(lock())).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('waits for a takeover in progress instead of joining it, until its takeover file is 5 seconds old', () => {
    const busy = owner(livePid());
    const dead = owner(deadPid());
    writeFileSync(lock(), dead);
    writeFileSync(takeover(), busy);
    expect(takeOver(lock())).toBe(false);
    expect(() => add('rsv_a', { timeoutMs: 300 })).toThrow(LedgerLockError);
    expect(readFileSync(lock(), 'utf8')).toBe(dead);
    expect(readFileSync(takeover(), 'utf8')).toBe(busy);
    // Held that long, the process taking over froze: its takeover file no longer counts.
    age(6_000, takeover());
    add('rsv_a', { timeoutMs: 5000 });
    expect(ids()).toEqual(['rsv_a']);
    expect(readdirSync(dir)).toEqual([LEDGER_FILE]);
  });

  it('is never blocked by a takeover file left behind by a process that died, by this one, or by nobody', () => {
    ['dead', 'own', 'empty'].forEach((kind, i) => {
      writeFileSync(lock(), owner(deadPid()));
      writeFileSync(takeover(), kind === 'dead' ? owner(deadPid()) : kind === 'own' ? owner(process.pid) : '');
      if (kind === 'empty') {
        // Its owner died before writing its name, or is about to write it: only its age tells.
        expect(() => add(`rsv_${i}`, { timeoutMs: 300 }), kind).toThrow(LedgerLockError);
        age(6_000, takeover());
      }
      const started = Date.now();
      add(`rsv_${i}`, { timeoutMs: 5000 });
      expect(Date.now() - started, kind).toBeLessThan(2500);
      expect(readdirSync(dir), kind).toEqual([LEDGER_FILE]);
    });
    expect(ids()).toEqual(['rsv_0', 'rsv_1', 'rsv_2']);
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
    const foreign = owner(livePid());
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

describe('final audit: stored snapshots', () => {
  const claudeAs = (account: string, patch: Partial<AgentUsage> = {}): Record<string, AgentUsage> =>
    ({ claude: { ...claudeOnly(62).usage.claude, account, scope: `scope-${account}`, ...patch } });
  const poolsAt = (weeklyUsed: number): AgentUsage['pools'] => claudeOnly(weeklyUsed).usage.claude.pools;
  /** Orca answered for the account, but its fetch failed and it has no window left to keep (`error`, zero pools). */
  const failedFetch = (account: string): Record<string, AgentUsage> =>
    ({ claude: { agent: 'claude', status: 'unknown', pools: {}, account, scope: `scope-${account}`, error: 'Claude usage fetch failed' } });

  it('drops the stored ungrouped session and weekly once Antigravity reports quota groups', () => {
    const G = 'Gemini Models';
    const window = (name: string, kind: 'session' | 'long', usedPercent: number, group?: string) =>
      ({ name, kind, usedPercent, windowMinutes: kind === 'session' ? 300 : 10080, resetsAt: NOW + 3 * 3_600_000, ...(group ? { group } : {}) });
    const reading = (updatedAt: number, pools: ReturnType<typeof window>[]): Record<string, AgentUsage> =>
      ({ antigravity: { agent: 'antigravity', status: 'ok', updatedAt, account: 'G', scope: 'scope-G', pools: Object.fromEntries(pools.map((p) => [p.name, p])) } });
    // An Orca without quota groups: only the tightest session and weekly across the groups, both nearly full.
    syncReservations(reading(NOW, [window('session', 'session', 97), window('weekly', 'long', 97)]), NOW, config, dir);
    const grouped = syncReservations(reading(NOW + 5 * MIN, [window('bucket:Gemini Models 5h', 'session', 0, G), window('bucket:Gemini Models', 'long', 0, G)]), NOW + 5 * MIN, config, dir);
    expect(Object.keys(grouped.usage.antigravity.pools)).toEqual(['bucket:Gemini Models 5h', 'bucket:Gemini Models']);
    expect(Object.keys(readLedger(dir).snapshots.antigravity.pools)).toEqual(['bucket:Gemini Models 5h', 'bucket:Gemini Models']);
    // A Gemini model declares its group's windows and the fallback names: the empty group decides, not a stale 97%.
    const declared = ['bucket:Gemini Models 5h', 'bucket:Gemini Models', 'session', 'weekly'];
    const q = candidateQuota(grouped.usage.antigravity, declared, { tier: 'frontier', effort: 'medium' }, [], config, NOW + 5 * MIN);
    expect(q).toMatchObject({ status: 'available', prospective: 2.5 });
    expect(q.buckets.map((b) => [b.pool, b.reported])).toEqual([['bucket:Gemini Models 5h', 0], ['bucket:Gemini Models', 0]]);
    // A grouped window missing from a later reading is still kept while it ages, as any window is.
    const partial = syncReservations(reading(NOW + 10 * MIN, [window('bucket:Gemini Models 5h', 'session', 3, G)]), NOW + 10 * MIN, config, dir);
    expect(Object.keys(partial.usage.antigravity.pools)).toEqual(['bucket:Gemini Models 5h', 'bucket:Gemini Models']);
    expect(partial.usage.antigravity.pools['bucket:Gemini Models']).toMatchObject({ usedPercent: 0, seenAt: NOW + 5 * MIN });
  });

  it('keeps the stored session and weekly of a provider without quota groups when a reading misses them', () => {
    syncReservations(claudeAs('A'), NOW, config, dir);
    const { session: _session, weekly: _weekly, ...rest } = poolsAt(62);
    const partial = syncReservations(claudeAs('A', { updatedAt: NOW + 5 * MIN, pools: rest }), NOW + 5 * MIN, config, dir);
    expect(Object.keys(partial.usage.claude.pools).sort()).toEqual(['fableWeekly', 'session', 'weekly']);
    expect(partial.usage.claude.pools.weekly).toMatchObject({ usedPercent: 62, seenAt: NOW });
  });

  it('keeps a known 100% blocking when one provider answers with a failed fetch for the same account', () => {
    syncReservations(claudeAs('A', { pools: poolsAt(100) }), NOW, config, dir);
    const failed = syncReservations(failedFetch('A'), NOW + 5 * MIN, config, dir);
    expect(failed.usage.claude).toMatchObject({ status: 'ok', retained: true, standIn: true, updatedAt: NOW, account: 'A', scope: 'scope-A', error: 'Claude usage fetch failed' });
    expect(failed.usage.claude.pools.weekly.usedPercent).toBe(100);
    expect(readLedger(dir).snapshots.claude).toMatchObject({ account: 'A', updatedAt: NOW, pools: { weekly: { usedPercent: 100 } } });
    // Routed on the failed reading itself: the exhausted weekly quota still blocks, instead of an unchecked route.
    const d = routeAndReserve(daily, { ...claudeOnly(), now: NOW + 5 * MIN, usage: failedFetch('A') }, config, dir);
    expect(d.status).toBe('decide');
    expect(d.options).toMatchObject({ wait: { until: expect.any(Number) }, use: [] });
    expect(d.reasons[0]).toContain('weekly 100% prospective, exhausted');
    expect(stored()).toEqual([]);
  });

  it('routes on the stored snapshot at medium confidence after a failed fetch, and settles nothing on it', () => {
    syncReservations(claudeAs('A'), NOW, config, dir);
    const d = routeAndReserve(daily, { ...claudeOnly(), now: NOW + 5 * MIN, usage: failedFetch('A') }, config, dir);
    expect(d).toMatchObject({ status: 'ok', confidence: 'medium' });
    expect(d.quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 62, prospective: 63.5, snapshotAt: NOW });
    expect(stored()[0]).toMatchObject({ scope: 'scope-A', account: 'A', snapshotAt: NOW });
    endWorker({ reservationId: d.reservation!.id }, 'completed', NOW + 6 * MIN, dir);
    // The stand-in is the old snapshot: however long the fetch keeps failing, it covers nothing the worker used.
    expect(syncReservations(failedFetch('A'), NOW + 40 * MIN, config, dir).reservations[0].state).toBe('completed');
    expect(syncReservations(claudeAs('A', { updatedAt: NOW + 45 * MIN }), NOW + 45 * MIN, config, dir).reservations[0].state).toBe('released');
  });

  it('still forgets the stored snapshot on a sign-out or another account, failed fetch or not', () => {
    syncReservations(claudeAs('A'), NOW, config, dir);
    // Another account's failed fetch: A's snapshot is not B's quota.
    expect(syncReservations(failedFetch('B'), NOW + MIN, config, dir).usage.claude).toMatchObject({ status: 'unknown', pools: {}, account: 'B' });
    expect(readLedger(dir).snapshots).toEqual({});
    syncReservations(claudeAs('A', { updatedAt: NOW + 2 * MIN }), NOW + 2 * MIN, config, dir);
    const signedOut: Record<string, AgentUsage> = { claude: { agent: 'claude', status: 'unavailable', pools: {}, account: 'A', error: 'Not signed in' } };
    expect(syncReservations(signedOut, NOW + 3 * MIN, config, dir).usage.claude).toMatchObject({ status: 'unavailable', pools: {} });
    expect(readLedger(dir).snapshots).toEqual({});
    // With nothing stored, a failed fetch is plain unknown usage.
    expect(syncReservations(failedFetch('A'), NOW + 4 * MIN, config, dir).usage.claude).toMatchObject({ status: 'unknown', pools: {}, error: 'Claude usage fetch failed' });
  });

  it('ignores a reading of the previous account that is older than the stored snapshot', () => {
    syncReservations(claudeAs('B', { updatedAt: NOW + 5 * MIN, pools: poolsAt(99) }), NOW + 5 * MIN, config, dir);
    // A process that read account A (2% used) before the switch to B was stored, and commits only now.
    const stale = claudeAs('A', { updatedAt: NOW, pools: poolsAt(2) });
    const late = syncReservations(stale, NOW + 6 * MIN, config, dir);
    expect(late.usage.claude).toMatchObject({ account: 'B', scope: 'scope-B', updatedAt: NOW + 5 * MIN });
    expect(late.usage.claude.pools.weekly.usedPercent).toBe(99);
    expect(readLedger(dir).snapshots.claude).toMatchObject({ account: 'B', updatedAt: NOW + 5 * MIN, pools: { weekly: { usedPercent: 99 } } });
    // Routing on that stale reading decides on B's 99%, and reserves nothing on A.
    const d = routeAndReserve(daily, { ...claudeOnly(2), now: NOW + 6 * MIN, usage: stale }, config, dir);
    expect(d.status).toBe('decide');
    expect(d.options!.use[0].quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 99 });
    // A reading of A taken after B's snapshot is a real switch back.
    const back = syncReservations(claudeAs('A', { updatedAt: NOW + 7 * MIN, pools: poolsAt(2) }), NOW + 7 * MIN, config, dir);
    expect(back.usage.claude).toMatchObject({ account: 'A', updatedAt: NOW + 7 * MIN });
    expect(readLedger(dir).snapshots.claude).toMatchObject({ account: 'A', pools: { weekly: { usedPercent: 2 } } });
  });

  it('moves a live record to the scope and plan its account discloses later, and never to another plan', () => {
    // The first reading of the account reports no plan: its scope is the plan-less one.
    const noPlan = claudeAs('A', { scope: 'scope-A-noplan' });
    const id = routeAndReserve(daily, { ...claudeOnly(62), usage: noPlan }, config, dir).reservation!.id;
    expect(stored()[0]).toMatchObject({ id, scope: 'scope-A-noplan', account: 'A' });
    expect(stored()[0]).not.toHaveProperty('plan');
    const disclosed = syncReservations(claudeAs('A', { plan: 'max_5x', scope: 'scope-A-max', updatedAt: NOW + 5 * MIN }), NOW + 5 * MIN, config, dir);
    expect(disclosed.reservations[0]).toMatchObject({ id, state: 'pending', scope: 'scope-A-max', plan: 'max_5x', account: 'A' });
    expect(stored()[0]).toMatchObject({ scope: 'scope-A-max', plan: 'max_5x' });
    // It still counts, on the bucket the account has now.
    expect(buildQuotaView(disclosed.usage, disclosed.reservations, config, NOW + 5 * MIN).buckets.find((b) => b.pool === 'weekly'))
      .toMatchObject({ id: 'claude:scope-A-max:weekly', reported: 62, reserved: 1.5, workers: 1 });
    // The plan really changes: the record names max_5x and stays on it.
    const changed = syncReservations(claudeAs('A', { plan: 'pro', scope: 'scope-A-pro', updatedAt: NOW + 6 * MIN }), NOW + 6 * MIN, config, dir);
    expect(changed.reservations[0]).toMatchObject({ scope: 'scope-A-max', plan: 'max_5x' });
    expect(buildQuotaView(changed.usage, changed.reservations, config, NOW + 6 * MIN).buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reserved: 0, workers: 0 });
  });

  it('never moves a record reserved on one account to the snapshot of another, or of an unknown, account', () => {
    const record = (id: string, scope: string, account?: string): Reservation => ({
      id, state: 'running', agent: 'claude', model: 'claude-sonnet-5-5', tier: 'daily', effort: 'medium', scope, pools: ['weekly'],
      ...(account ? { account } : {}), createdAt: NOW, startedAt: NOW, snapshotAt: null,
    });
    withLedger(dir, (ledger) => {
      ledger.reservations.push(record('rsv_default_b', 'default', 'B'), record('rsv_noplan_b', 'scope-B-noplan', 'B'), record('rsv_default', 'default'));
    });
    const scopes = (s: ReturnType<typeof syncReservations>) => Object.fromEntries(s.reservations.map((r) => [r.id, r.scope]));
    // A snapshot that names no account (a version 1 ledger) is not known to be B's: only the record without an account adopts it.
    const anonymous: Record<string, AgentUsage> = { claude: { ...claudeOnly(62).usage.claude, scope: 'scope-x', plan: 'max_5x' } };
    expect(scopes(syncReservations(anonymous, NOW + MIN, config, dir))).toEqual({ rsv_default_b: 'default', rsv_noplan_b: 'scope-B-noplan', rsv_default: 'scope-x' });
    // Account A discloses a plan: B's records stay where they are.
    const other = syncReservations(claudeAs('A', { plan: 'max_5x', updatedAt: NOW + 2 * MIN }), NOW + 2 * MIN, config, dir);
    expect(scopes(other)).toEqual({ rsv_default_b: 'default', rsv_noplan_b: 'scope-B-noplan', rsv_default: 'scope-x' });
    expect(other.reservations.find((r) => r.id === 'rsv_noplan_b')).not.toHaveProperty('plan');
    // B itself comes back with a plan: its records follow it.
    const own = syncReservations(claudeAs('B', { plan: 'pro', scope: 'scope-B-pro', updatedAt: NOW + 3 * MIN }), NOW + 3 * MIN, config, dir);
    expect(scopes(own)).toEqual({ rsv_default_b: 'scope-B-pro', rsv_noplan_b: 'scope-B-pro', rsv_default: 'scope-x' });
    expect(own.reservations.find((r) => r.id === 'rsv_noplan_b')).toMatchObject({ plan: 'pro' });
  });
});

describe('final audit: ends inferred from a timeout', () => {
  const launch = { agent: 'claude', model: 'claude-sonnet-5-5' };

  it('releases an abandoned pending record at once when it turns out to have failed before launch', () => {
    const env = claudeOnly();
    const id = routeAndReserve(daily, env, config, dir).reservation!.id;
    // Nobody confirmed the launch within pendingMinutes: held like a cancelled worker, as an inferred end.
    const abandoned = syncReservations(env.usage, NOW + 11 * MIN, config, dir).reservations[0];
    expect(abandoned).toMatchObject({ id, state: 'cancelled_after_consumption', inferred: true, endedAt: NOW + 10 * MIN });
    expect(stored()[0]).toMatchObject({ state: 'cancelled_after_consumption', inferred: true });
    expect(weekly({ ...env, now: NOW + 11 * MIN }, stored()).reserved).toBe(1.5);
    const change = endWorker({ reservationId: id }, 'failed-before-launch', NOW + 12 * MIN, dir, 'the agent refused the model at launch');
    expect(change).toMatchObject({ from: 'cancelled_after_consumption', reservation: { state: 'failed_before_launch', endedAt: NOW + 12 * MIN, note: 'the agent refused the model at launch' } });
    expect(change.reservation).not.toHaveProperty('inferred');
    expect(weekly({ ...env, now: NOW + 12 * MIN }, stored())).toMatchObject({ reserved: 0, workers: 0, effective: 50 });
    // On the same cached snapshot the capacity is free for the next route.
    expect(routeAndReserve(daily, { ...env, now: NOW + 12 * MIN }, config, dir).quota!.buckets.find((b) => b.pool === 'weekly')).toMatchObject({ reserved: 0, prospective: 51.5 });
  });

  it('replaces an inferred end by the explicit one, and counts settled windows again until a later snapshot', () => {
    const env = claudeOnly();
    const id = routeAndReserve(daily, env, config, dir).reservation!.id;
    syncReservations(env.usage, NOW + 11 * MIN, config, dir);
    withLedger(dir, (ledger) => { ledger.reservations[0] = { ...ledger.reservations[0], settled: ['weekly'] }; });
    const change = endWorker({ reservationId: id }, 'completed', NOW + 30 * MIN, dir);
    expect(change.reservation).toMatchObject({ state: 'completed', endedAt: NOW + 30 * MIN });
    for (const gone of ['inferred', 'settled', 'note']) expect(change.reservation, gone).not.toHaveProperty(gone);
    // A snapshot from before the real end no longer covers it; one after it does.
    expect(syncReservations(withUsageUpdatedAt(env, NOW + 20 * MIN).usage, NOW + 31 * MIN, config, dir).reservations[0].state).toBe('completed');
    expect(syncReservations(withUsageUpdatedAt(env, NOW + 32 * MIN).usage, NOW + 32 * MIN, config, dir).reservations[0].state).toBe('released');
  });

  it('runs an abandoned pending record again when its launch is confirmed late', () => {
    const env = claudeOnly();
    const id = routeAndReserve(daily, env, config, dir).reservation!.id;
    syncReservations(env.usage, NOW + 11 * MIN, config, dir);
    // verify names the Dispatch and the launch only: with nothing pending, the abandoned record is the worker's.
    expect(findReservation(stored(), { dispatchId: 'ctx_7', ...launch })?.id).toBe(id);
    const change = markRunning({ dispatchId: 'ctx_7', ...launch }, NOW + 12 * MIN, dir);
    expect(change).toMatchObject({ from: 'cancelled_after_consumption', reservation: { id, state: 'running', dispatchId: 'ctx_7', startedAt: NOW + 12 * MIN } });
    for (const gone of ['inferred', 'endedAt', 'note']) expect(change.reservation, gone).not.toHaveProperty(gone);
    expect(weekly({ ...env, now: NOW + 12 * MIN }, stored())).toMatchObject({ reserved: 1.5, workers: 1 });
    // A fresh snapshot does not release it now: it is running.
    expect(syncReservations(withUsageUpdatedAt(env, NOW + 15 * MIN).usage, NOW + 15 * MIN, config, dir).reservations[0].state).toBe('running');
  });

  it('prefers a pending record over an abandoned one, and never matches one that was released or ended explicitly', () => {
    const record = (id: string, createdAt: number, patch: Partial<Reservation>): Reservation =>
      ({ id, state: 'pending', ...launch, tier: 'daily', effort: 'medium', scope: 'default', pools: ['weekly'], createdAt, snapshotAt: NOW, ...patch });
    const abandoned = record('rsv_old', NOW, { state: 'cancelled_after_consumption', inferred: true, endedAt: NOW + 10 * MIN });
    const pending = record('rsv_new', NOW + 20 * MIN, {});
    expect(findReservation([abandoned, pending], launch)?.id).toBe('rsv_new');
    expect(findReservation([abandoned], launch)?.id).toBe('rsv_old');
    expect(findReservation([{ ...abandoned, state: 'released' }], launch)).toBeUndefined();
    expect(findReservation([record('rsv_cancelled', NOW, { state: 'cancelled_after_consumption', endedAt: NOW + MIN })], launch)).toBeUndefined();
    expect(findReservation([{ ...abandoned, dispatchId: 'ctx_1' }], launch)).toBeUndefined();
  });

  it('keeps the inferred mark in the ledger file, and drops anything else under that key', () => {
    const record = { id: 'rsv_1', state: 'completed', ...launch, tier: 'daily', effort: 'medium', scope: 'default', pools: ['weekly'], createdAt: NOW, endedAt: NOW + MIN, snapshotAt: NOW };
    const parsed = parseLedger(JSON.stringify({ version: 2, reservations: [{ ...record, inferred: true }, { ...record, id: 'rsv_2', inferred: 'yes' }], snapshots: {} })).reservations;
    expect(parsed[0]).toMatchObject({ id: 'rsv_1', inferred: true });
    expect(parsed[1]).not.toHaveProperty('inferred');
  });
});
