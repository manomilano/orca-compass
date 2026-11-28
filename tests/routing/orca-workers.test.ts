import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { endWorker, markRunning, routeAndReserve, syncReservations, workerStatesFor } from '../../src/routing/allocate.js';
import { readOrcaWorkers } from '../../src/routing/orca-workers.js';
import { LEDGER_FILE, readLedger } from '../../src/routing/reservations.js';
import type { Runner } from '../../src/system/run.js';
import { machineEnv, NOW, withUsageUpdatedAt } from '../helpers/env.js';

// Orca's own record of which workers are still running, and how reservations follow it.

const row = (dispatchId: string, outcome: string, verdict: string, terminalState = 'retained') =>
  ({ dispatchId, taskId: 't', state: 'ready', outcome, liveness: verdict, agent: 'claude/claude-sonnet-5-5', terminalState });
const answering = (result: object | string, code = 0): { run: Runner; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code, stderr: '', stdout: typeof result === 'string' ? result : JSON.stringify({ ok: true, result }) };
    },
  };
};

describe('readOrcaWorkers', () => {
  it('reads outcome, liveness and terminal state of every listed worker, in the concise and the full shape', async () => {
    const full = { dispatchId: 'ctx_3', terminalState: 'released', projection: { outcome: 'succeeded', liveness: { verdict: 'exited' } } };
    const { run, calls } = answering({ workers: [row('ctx_1', 'in_progress', 'live'), row('ctx_2', 'failed', 'exited'), full, { taskId: 'no dispatch' }, null], scope: { source: 'all' } });
    expect(await readOrcaWorkers(run)).toEqual({
      complete: true,
      states: [
        { dispatchId: 'ctx_1', outcome: 'in_progress', liveness: 'live', terminalState: 'retained', agent: 'claude', model: 'claude-sonnet-5-5' },
        { dispatchId: 'ctx_2', outcome: 'failed', liveness: 'exited', terminalState: 'retained', agent: 'claude', model: 'claude-sonnet-5-5' },
        { dispatchId: 'ctx_3', outcome: 'succeeded', liveness: 'exited', terminalState: 'released' },
      ],
    });
    expect(calls).toEqual([['orca', 'orchestration', 'worker-list', '--limit', '100', '--json']]);
  });

  it('does not call the list complete when more pages exist or it is narrowed to one Run', async () => {
    const workers = [row('ctx_1', 'in_progress', 'live')];
    expect((await readOrcaWorkers(answering({ workers, scope: { source: 'all' }, nextCursor: 'abc' }).run))!.complete).toBe(false);
    expect((await readOrcaWorkers(answering({ workers, scope: { source: 'all' }, page: { hasMore: true } }).run))!.complete).toBe(false);
    expect((await readOrcaWorkers(answering({ workers, scope: { source: 'bound' } }).run))!.complete).toBe(false);
  });

  it('says nothing when Orca cannot answer', async () => {
    expect(await readOrcaWorkers(answering('not json').run)).toBeUndefined();
    expect(await readOrcaWorkers(answering({ workers: [] }, 1).run)).toBeUndefined();
    expect(await readOrcaWorkers(answering(JSON.stringify({ ok: false, error: 'no runtime' })).run)).toBeUndefined();
    expect(await readOrcaWorkers(answering({ scope: { source: 'all' } }).run)).toBeUndefined();
    expect(await readOrcaWorkers(async () => { throw new Error('spawn failed'); })).toBeUndefined();
  });
});

describe('reservations follow Orca\'s workers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-workers-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const env = { ...machineEnv(), discoveries: machineEnv().discoveries.filter((d) => d.agent === 'claude') };

  it('asks Orca only when a reservation is bound to a worker that may have changed', async () => {
    const asked = answering({ workers: [], scope: { source: 'all' } });
    expect(await workerStatesFor(asked.run, dir)).toBeUndefined();
    const id = routeAndReserve({ tier: 'daily' }, env, DEFAULT_CONFIG, dir).reservation!.id;
    // Pending and not yet bound to a Dispatch: nothing to ask about.
    expect(await workerStatesFor(asked.run, dir)).toBeUndefined();
    expect(asked.calls).toEqual([]);
    markRunning({ reservationId: id, dispatchId: 'ctx_1' }, NOW, dir);
    expect(await workerStatesFor(asked.run, dir)).toEqual({ states: [], complete: true });
    expect(asked.calls).toHaveLength(1);
  });

  it('closes the reservation of a worker Orca reports finished, and releases it on the next fresh snapshot (#10)', async () => {
    const id = routeAndReserve({ tier: 'daily' }, env, DEFAULT_CONFIG, dir).reservation!.id;
    markRunning({ reservationId: id, dispatchId: 'ctx_1' }, NOW, dir);
    const live = await workerStatesFor(answering({ workers: [row('ctx_1', 'in_progress', 'live')], scope: { source: 'all' } }).run, dir);
    expect(syncReservations(env.usage, NOW + 60_000, DEFAULT_CONFIG, dir, live).reservations[0].state).toBe('running');
    // The coordinator never called release: Orca's own record ends the reservation.
    const done = await workerStatesFor(answering({ workers: [row('ctx_1', 'succeeded', 'exited')], scope: { source: 'all' } }).run, dir);
    const ended = syncReservations(env.usage, NOW + 120_000, DEFAULT_CONFIG, dir, done);
    expect(ended.reservations[0]).toMatchObject({ state: 'completed', endedAt: NOW + 120_000 });
    // Same snapshot as before the worker ended: still reserved. The next refresh reconciles it.
    expect(syncReservations(env.usage, NOW + 600_000, DEFAULT_CONFIG, dir).reservations[0].state).toBe('completed');
    expect(syncReservations(withUsageUpdatedAt(env, NOW + 300_000).usage, NOW + 600_000, DEFAULT_CONFIG, dir).reservations[0].state).toBe('released');
  });
});

describe('workers Orca confirms live', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-workers-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const env = { ...machineEnv(), discoveries: machineEnv().discoveries.filter((d) => d.agent === 'claude') };
  const HOUR = 3_600_000;

  it('#8 keeps a worker running past maxRunningHours while Orca lists it live, on sync and on route', async () => {
    const id = routeAndReserve({ tier: 'daily' }, env, DEFAULT_CONFIG, dir).reservation!.id;
    markRunning({ reservationId: id, dispatchId: 'ctx_1' }, NOW, dir);
    const live = await workerStatesFor(answering({ workers: [row('ctx_1', 'in_progress', 'live')], scope: { source: 'all' } }).run, dir);
    const later = withUsageUpdatedAt(env, NOW + 25 * HOUR);
    expect(syncReservations(later.usage, NOW + 25 * HOUR, DEFAULT_CONFIG, dir, live).reservations[0].state).toBe('running');
    routeAndReserve({ tier: 'daily' }, { ...later, now: NOW + 25 * HOUR }, DEFAULT_CONFIG, dir, { workers: live });
    expect(readLedger(dir).reservations.find((r) => r.id === id)!.state).toBe('running');
    // Without Orca's word the 24-hour close applies.
    routeAndReserve({ tier: 'daily' }, { ...later, now: NOW + 25 * HOUR }, DEFAULT_CONFIG, dir);
    expect(readLedger(dir).reservations.find((r) => r.id === id)).toMatchObject({ state: 'completed', note: 'closed: still running after 24h' });
  });

  it('#1 asks Orca for its workers when the ledger is unreadable, to reconstruct them', async () => {
    writeFileSync(join(dir, LEDGER_FILE), '{ not json');
    const asked = answering({ workers: [row('ctx_1', 'in_progress', 'live')], scope: { source: 'all' } });
    const workers = await workerStatesFor(asked.run, dir);
    expect(asked.calls).toHaveLength(1);
    const synced = syncReservations(env.usage, NOW, DEFAULT_CONFIG, dir, workers, { discoveries: env.discoveries });
    expect(synced.reservations).toMatchObject([{ state: 'running', dispatchId: 'ctx_1', agent: 'claude', model: 'claude-sonnet-5-5' }]);
    expect(synced.recovered).toContain('1 running reservation reconstructed');
  });
});

describe('final audit: a worker closed only by the running limit', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-workers-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const env = { ...machineEnv(), discoveries: machineEnv().discoveries.filter((d) => d.agent === 'claude') };
  const HOUR = 3_600_000;

  it('is asked about again, and runs again once Orca lists it live', async () => {
    const id = routeAndReserve({ tier: 'daily' }, env, DEFAULT_CONFIG, dir).reservation!.id;
    markRunning({ reservationId: id, dispatchId: 'ctx_1' }, NOW, dir);
    // Orca's worker list could not be read for a day: the 24-hour limit closes the record, as an inferred end.
    const later = withUsageUpdatedAt(env, NOW + 25 * HOUR);
    const closed = syncReservations(later.usage, NOW + 25 * HOUR, DEFAULT_CONFIG, dir).reservations[0];
    expect(closed).toMatchObject({ id, state: 'completed', inferred: true, endedAt: NOW + 25 * HOUR });
    // The next fresh snapshot even releases it.
    const released = syncReservations(withUsageUpdatedAt(env, NOW + 25 * HOUR + 5 * 60_000).usage, NOW + 25 * HOUR + 5 * 60_000, DEFAULT_CONFIG, dir).reservations[0];
    expect(released).toMatchObject({ state: 'released', inferred: true });
    // The record is neither pending nor running, but its end is only inferred: Orca is still asked.
    const asked = answering({ workers: [row('ctx_1', 'in_progress', 'live')], scope: { source: 'all' } });
    const live = await workerStatesFor(asked.run, dir);
    expect(asked.calls).toHaveLength(1);
    expect(live).toMatchObject({ states: [{ dispatchId: 'ctx_1', liveness: 'live' }] });
    const at = NOW + 25 * HOUR + 6 * 60_000;
    const revived = syncReservations(withUsageUpdatedAt(env, at).usage, at, DEFAULT_CONFIG, dir, live).reservations[0];
    expect(revived).toMatchObject({ id, state: 'running', dispatchId: 'ctx_1', startedAt: NOW });
    for (const gone of ['inferred', 'endedAt', 'settled', 'note']) expect(revived, gone).not.toHaveProperty(gone);
    expect(readLedger(dir).reservations[0]).toEqual(revived);
    // It counts against the quota again, and stays running while Orca lists it live.
    routeAndReserve({ tier: 'daily' }, { ...withUsageUpdatedAt(env, at), now: at }, DEFAULT_CONFIG, dir, { workers: live, dryRun: false });
    expect(readLedger(dir).reservations.find((r) => r.id === id)!.state).toBe('running');
  });

  it('is not asked about once its end was reported', async () => {
    const id = routeAndReserve({ tier: 'daily' }, env, DEFAULT_CONFIG, dir).reservation!.id;
    markRunning({ reservationId: id, dispatchId: 'ctx_1' }, NOW, dir);
    endWorker({ dispatchId: 'ctx_1' }, 'completed', NOW + 60_000, dir);
    const asked = answering({ workers: [row('ctx_1', 'in_progress', 'live')], scope: { source: 'all' } });
    expect(await workerStatesFor(asked.run, dir)).toBeUndefined();
    expect(asked.calls).toEqual([]);
    // And a worker list that still shows it live does not bring a reported end back.
    const listed = { complete: true, states: [{ dispatchId: 'ctx_1', outcome: 'in_progress', liveness: 'live' }] };
    expect(syncReservations(env.usage, NOW + 120_000, DEFAULT_CONFIG, dir, listed).reservations[0]).toMatchObject({ state: 'completed', endedAt: NOW + 60_000 });
  });
});
