import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { clearReservations, endWorker, markRunning, routeAndReserve, syncReservations } from '../../src/routing/allocate.js';
import { buildQuotaView, isLive, type Reservation } from '../../src/routing/quota.js';
import { findReservation, LEDGER_FILE, parseLedger, readLedger, syncLedger, withLedger } from '../../src/routing/reservations.js';
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
      scope: 'default', pools: ['session', 'weekly'], createdAt: NOW, snapshotAt: NOW,
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
    expect(() => withLedger(dir, (ledger) => { ledger.reservations = []; throw new Error('boom'); })).toThrow('boom');
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
    for (const text of [undefined, '', '{', '[]', 'null']) expect(parseLedger(text)).toEqual({ version: 1, reservations: [], snapshots: {} });
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
    const ledger = { version: 1 as const, reservations: [], snapshots: {} };
    const merged = syncLedger(ledger, env.usage, NOW, config);
    expect(merged.claude).toBe(env.usage.claude);
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
