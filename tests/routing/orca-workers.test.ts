import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { markRunning, routeAndReserve, syncReservations, workerStatesFor } from '../../src/routing/allocate.js';
import { readOrcaWorkers } from '../../src/routing/orca-workers.js';
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
        { dispatchId: 'ctx_1', outcome: 'in_progress', liveness: 'live', terminalState: 'retained' },
        { dispatchId: 'ctx_2', outcome: 'failed', liveness: 'exited', terminalState: 'retained' },
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
