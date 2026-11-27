import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  applyWorkerStates, bucketQuota, bufferEffortOf, bufferFor, bufferTierOf, buildQuotaView, candidateQuota, CARRIED_SETTLE_MS, classify, DEFAULT_BUFFERS,
  drawsOn, isLive, poolKey, reconcile, reservationsOn, scopeOf, type Reservation,
} from '../../src/routing/quota.js';
import type { AgentUsage, Config, UsagePool } from '../../src/types.js';

// The quota accounting on its own: reported, reserved and effective usage per bucket, and the lifecycle of
// the reservation records. The "#n" in a test name is the scenario number of the redesign's section 10.

const NOW = 1793232000000;
const MIN = 60_000;
const config: Config = DEFAULT_CONFIG;
const cfg = config.reservations;

const pool = (name: string, usedPercent: number | null, patch: Partial<UsagePool> = {}): UsagePool =>
  ({ name, kind: name === 'session' ? 'session' : 'long', usedPercent, windowMinutes: 10080, resetsAt: NOW + 86_400_000, ...patch });

const usageOf = (agent: string, pools: UsagePool[], patch: Partial<AgentUsage> = {}): AgentUsage =>
  ({ agent, status: 'ok', updatedAt: NOW, scope: 'acct-a', pools: Object.fromEntries(pools.map((p) => [p.name, p])), ...patch });

let next = 0;
/** A frontier worker at medium effort reserves 2.5 pp, the figure of the redesign's worked example. */
const worker = (patch: Partial<Reservation> = {}): Reservation => ({
  id: `rsv_${++next}`, state: 'running', agent: 'claude', model: 'claude-fable-5-1', tier: 'frontier', effort: 'medium',
  scope: 'acct-a', pools: ['weekly'], createdAt: NOW - 10 * MIN, snapshotAt: NOW - 10 * MIN, ...patch,
});

const weeklyOf = (reported: number | null, reservations: Reservation[], patch: Partial<AgentUsage> = {}, now = NOW) => {
  const u = usageOf('claude', [pool('weekly', reported)], patch);
  return bucketQuota(u, u.pools.weekly, reservations, config, now);
};

describe('the buffer table', () => {
  it('holds the proposed starting values on the canonical tiers, Standard being daily', () => {
    expect(DEFAULT_BUFFERS).toEqual({
      minimal: { low: 0.5, medium: 0.5, high: 0.75, xhigh: 1 },
      light: { low: 0.5, medium: 1, high: 1.25, xhigh: 1.5 },
      daily: { low: 1, medium: 1.5, high: 1.75, xhigh: 2 },
      advanced: { low: 1.5, medium: 2, high: 2.5, xhigh: 3 },
      frontier: { low: 2, medium: 2.5, high: 3, xhigh: 3.5 },
    });
  });

  it('maps a model to its cost tier, to an explicit row, or to the largest row when it has no cost tier', () => {
    expect(bufferTierOf({ modelId: 'claude-sonnet-5-5' }, 'daily', cfg)).toBe('daily');
    expect(bufferTierOf({ modelId: 'auto' }, null, cfg)).toBe('frontier');
    const mapped = { ...cfg, modelTiers: { 'claude-haiku-5-5': 'minimal' as const, 'gpt-luna': 'minimal' as const } };
    expect(bufferTierOf({ modelId: 'claude-haiku-5-5' }, 'light', mapped)).toBe('minimal');
    expect(bufferTierOf({ modelId: 'gpt-6-luna', family: 'gpt-luna' }, 'light', mapped)).toBe('minimal');
  });

  it('maps every effort to a column: none and minimal to low, max to xhigh, an unset effort to the provider default or high', () => {
    expect((['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) => bufferEffortOf(e)))
      .toEqual(['low', 'low', 'low', 'medium', 'high', 'xhigh', 'xhigh']);
    expect(bufferEffortOf(null, 'medium')).toBe('medium');
    expect(bufferEffortOf(null)).toBe('high');
  });

  it('applies provider-, plan- and quota-specific overrides in order', () => {
    const w = { agent: 'claude', plan: 'max_5x', pool: 'session', tier: 'daily' as const, effort: 'medium' as const };
    expect(bufferFor(cfg, w)).toBe(1.5);
    const overridden = {
      ...cfg,
      overrides: [
        { agent: 'claude', pool: 'Session', scale: 3 },
        { plan: 'max_20x', scale: 0.25 },
        { agent: 'claude', plan: 'max_5x', buffers: { daily: { medium: 4 } } },
      ],
    };
    // The cell override replaces the scaled value; the max_20x rule does not match.
    expect(bufferFor(overridden, w)).toBe(4);
    expect(bufferFor(overridden, { ...w, plan: 'pro' })).toBe(4.5);
    expect(bufferFor(overridden, { ...w, agent: 'codex', plan: 'max_20x' })).toBeCloseTo(0.375);
    expect(bufferFor(overridden, { ...w, pool: 'weekly', plan: 'pro' })).toBe(1.5);
  });
});

describe('a bucket: reported, reserved and effective usage', () => {
  it('#1 treats a valid 0% as completely available before reservations', () => {
    expect(weeklyOf(0, [])).toMatchObject({ reported: 0, reserved: 0, workers: 0, effective: 0, remaining: 100, status: 'available', stale: false });
    expect(classify(0, 0, config.riskThresholds)).toBe('available');
  });

  it('#3 keeps missing usage unknown, never 0', () => {
    const b = weeklyOf(null, [worker()]);
    expect(b).toMatchObject({ reported: null, effective: null, remaining: null, status: 'unknown', reserved: 2.5, note: 'usage not reported' });
    // Not a number, negative or infinite is not usage either.
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(weeklyOf(bad, []).status).toBe('unknown');
  });

  it('#4 takes a missing reset time as it is: no reset time, not an expired window', () => {
    const u = usageOf('antigravity', [pool('bucket:Claude and GPT models', 0, { resetsAt: null })]);
    const b = bucketQuota(u, Object.values(u.pools)[0], [], config, NOW);
    expect(b).toMatchObject({ reported: 0, effective: 0, status: 'available', resetsAt: null, note: 'no reset time reported (window not started or unknown)' });
  });

  it('reads a window whose reset passed since the snapshot as unknown, and one snapshotted after the reset as valid', () => {
    const passed = usageOf('claude', [pool('weekly', 99, { resetsAt: NOW - 1 })], { updatedAt: NOW - 5 * MIN });
    expect(bucketQuota(passed, passed.pools.weekly, [], config, NOW)).toMatchObject({ reported: null, status: 'unknown', note: 'usage unknown: the window reset after the last snapshot' });
    const after = usageOf('claude', [pool('weekly', 3, { resetsAt: NOW - 5 * MIN })], { updatedAt: NOW - MIN });
    expect(bucketQuota(after, after.pools.weekly, [], config, NOW)).toMatchObject({ reported: 3, status: 'available', resetsAt: null });
  });

  it('marks a snapshot older than usageStaleMinutes stale and one four times older unknown', () => {
    expect(weeklyOf(40, [], { updatedAt: NOW - 30 * MIN })).toMatchObject({ reported: 40, stale: false });
    expect(weeklyOf(40, [], { updatedAt: NOW - 31 * MIN })).toMatchObject({ reported: 40, status: 'available', stale: true });
    expect(weeklyOf(40, [], { updatedAt: NOW - 121 * MIN })).toMatchObject({ reported: null, status: 'unknown', stale: true, note: 'usage unknown: the last snapshot is 2h old' });
  });

  it('classifies effective usage by the risk thresholds and tells exhausted from fully reserved', () => {
    const t = config.riskThresholds;
    expect([0, 84.99, 85, 89.99, 90, 99.99].map((n) => classify(n, n, t))).toEqual(['available', 'available', 'caution', 'caution', 'high', 'high']);
    expect(classify(100, 100, t)).toBe('exhausted');
    expect(classify(96, 100, t)).toBe('reserved');
    expect(classify(null, null, t)).toBe('unknown');
    expect(classify(50, 60, { cautionPercent: 55, highPercent: 70 })).toBe('caution');
  });

  it('#17 caps effective and prospective usage at 100% and keeps the reservation records accurate', () => {
    const workers = [worker(), worker(), worker()];
    const b = weeklyOf(99, workers);
    expect(b).toMatchObject({ reported: 99, reserved: 7.5, workers: 3, effective: 100, remaining: 0, status: 'reserved' });
    const u = usageOf('claude', [pool('weekly', 99)]);
    const q = candidateQuota(u, ['weekly'], { tier: 'frontier', effort: 'xhigh' }, workers, config, NOW);
    expect(q.buckets[0]).toMatchObject({ buffer: 3.5, prospective: 100, prospectiveStatus: 'reserved' });
    expect(workers.every((w) => w.tier === 'frontier' && w.effort === 'medium')).toBe(true);
  });
});

describe('reservations are per quota bucket', () => {
  it('#13 #14 shares a reservation total between models on one quota and leaves an unrelated quota alone', () => {
    // The redesign's example: 70% reported, two workers reserving 2.5 pp each, both models see 75%.
    const shared = usageOf('antigravity', [pool('bucket:Gemini Models', 70), pool('bucket:Claude and GPT models', 30)]);
    const workers = [worker({ agent: 'antigravity', pools: ['bucket:gemini models'] }), worker({ agent: 'antigravity', pools: ['bucket:gemini models'] })];
    for (const model of ['gemini-4-neon', 'gemini-4-carbon']) {
      const q = candidateQuota(shared, ['bucket:Gemini Models'], { tier: 'frontier', effort: 'medium' }, workers, config, NOW);
      expect(q.buckets[0], model).toMatchObject({ reported: 70, reserved: 5, effective: 75, prospective: 77.5 });
    }
    const other = candidateQuota(shared, ['bucket:Claude and GPT models'], { tier: 'frontier', effort: 'medium' }, workers, config, NOW);
    expect(other.buckets[0]).toMatchObject({ reported: 30, reserved: 0, effective: 30 });
    // Another provider with a window of the same name is another bucket.
    const codex = usageOf('codex', [pool('bucket:Gemini Models', 10)]);
    expect(bucketQuota(codex, Object.values(codex.pools)[0], workers, config, NOW).reserved).toBe(0);
  });

  it('#15 evaluates every applicable window on its own and lets the most restrictive one decide', () => {
    const u = usageOf('claude', [pool('session', 88), pool('weekly', 10), pool('fableWeekly', 40)]);
    const q = candidateQuota(u, ['session', 'weekly', 'fableWeekly'], { tier: 'frontier', effort: 'medium' }, [], config, NOW);
    expect(q.buckets.map((b) => [b.pool, b.prospective, b.prospectiveStatus])).toEqual([['session', 90.5, 'high'], ['weekly', 12.5, 'available'], ['fableWeekly', 42.5, 'available']]);
    // Never the sum of the windows: the session alone makes it high risk and binds the route.
    expect(q).toMatchObject({ status: 'high', binding: 'claude:acct-a:session', remaining: 12, prospective: 90.5 });
    // A worker on three windows reserves once on each, not three times on one.
    const w = worker({ pools: ['session', 'weekly', 'fableweekly'] });
    expect(Object.values(u.pools).map((p) => bucketQuota(u, p, [w], config, NOW).reserved)).toEqual([2.5, 2.5, 2.5]);
  });

  it('#29 folds duplicate aliases of one window into one bucket and counts a reservation once', () => {
    const u = usageOf('cursor', [pool('bucket:Other Models', 20)]);
    const q = candidateQuota(u, ['bucket:Other Models', 'bucket:other  models', ' BUCKET:OTHER MODELS '], { tier: 'daily', effort: 'medium' }, [], config, NOW);
    expect(q.buckets).toHaveLength(1);
    const w = worker({ agent: 'cursor', pools: ['bucket:other models', 'Bucket:Other  Models'] });
    expect(bucketQuota(u, Object.values(u.pools)[0], [w, w], config, NOW)).toMatchObject({ reserved: 2.5, workers: 1 });
    expect(reservationsOn([w, { ...w }], 'cursor', 'acct-a', 'bucket:Other Models')).toHaveLength(1);
  });

  it('#24 never assigns reservations of another account, runtime or plan to the new quota identity', () => {
    const before = worker({ scope: 'acct-a' });
    expect(weeklyOf(40, [before]).effective).toBe(42.5);
    const switched = weeklyOf(5, [before], { scope: 'acct-b' });
    expect(switched).toMatchObject({ id: 'claude:acct-b:weekly', reported: 5, reserved: 0, effective: 5 });
    // The new account's fresh snapshot does not reconcile the old account's finished worker either.
    const ended = { ...before, state: 'completed' as const, endedAt: NOW - 10 * MIN };
    const kept = reconcile([ended], { claude: usageOf('claude', [pool('weekly', 5)], { scope: 'acct-b' }) }, NOW, cfg);
    expect(kept).toEqual([ended]);
    expect(reconcile([ended], { claude: usageOf('claude', [pool('weekly', 44)], { scope: 'acct-a' }) }, NOW, cfg)[0].state).toBe('released');
  });
});

describe('the buffer is rebuilt on every snapshot, never accumulated', () => {
  it('#6 follows the worked example: the buffer is recalculated from the workers still active', () => {
    const workers = [worker(), worker(), worker(), worker()];
    const steps: [reported: number, active: number, effective: number][] = [[40, 4, 50], [48, 3, 55.5], [55, 1, 57.5], [58, 0, 58], [58, 0, 58]];
    steps.forEach(([reported, active, effective], i) => {
      const b = weeklyOf(reported, workers.slice(0, active), { updatedAt: NOW + i * 5 * MIN }, NOW + i * 5 * MIN);
      expect([b.reported, b.reserved, b.effective]).toEqual([reported, active * 2.5, effective]);
    });
  });

  it('#5 gives the same result however often the same data is read', () => {
    const usage = { claude: usageOf('claude', [pool('weekly', 40), pool('session', 5)]) };
    const workers = [worker({ pools: ['weekly', 'session'] }), worker({ state: 'pending' })];
    const first = buildQuotaView(usage, workers, config, NOW);
    for (let i = 0; i < 50; i++) expect(buildQuotaView(usage, reconcile(workers, usage, NOW, cfg), config, NOW)).toEqual(first);
    expect(first.buckets.map((b) => [b.pool, b.effective])).toEqual([['session', 7.5], ['weekly', 45]]);
  });

  it('#9 recalculates a long-running worker against every fresh baseline', () => {
    const long = worker({ createdAt: NOW, startedAt: NOW });
    let list = [long];
    [41, 47, 52, 60, 66].forEach((reported, i) => {
      const at = NOW + (i + 1) * 5 * MIN;
      const usage = { claude: usageOf('claude', [pool('weekly', reported)], { updatedAt: at }) };
      list = reconcile(list, usage, at, cfg);
      expect(list).toEqual([long]);
      expect(bucketQuota(usage.claude, usage.claude.pools.weekly, list, config, at).effective).toBe(reported + 2.5);
    });
  });

  it('#16 uses the new baseline when the quota resets under a running worker', () => {
    const running = [worker()];
    expect(weeklyOf(96, running)).toMatchObject({ effective: 98.5, status: 'high' });
    const reset = usageOf('claude', [pool('weekly', 1, { resetsAt: NOW + 7 * 86_400_000 })], { updatedAt: NOW + 5 * MIN });
    expect(bucketQuota(reset, reset.pools.weekly, reconcile(running, { claude: reset }, NOW + 5 * MIN, cfg), config, NOW + 5 * MIN))
      .toMatchObject({ reported: 1, reserved: 2.5, effective: 3.5, status: 'available' });
  });

  it('#18 stays bounded over hundreds of refresh cycles', () => {
    let list: Reservation[] = [worker({ createdAt: NOW, startedAt: NOW })];
    let highest = 0;
    for (let i = 1; i <= 600; i++) {
      const at = NOW + i * 5 * MIN;
      const reported = Math.min(100, 30 + (i % 70));
      const usage = { claude: usageOf('claude', [pool('weekly', reported)], { updatedAt: at }) };
      list = reconcile(list, usage, at, { ...cfg, maxRunningHours: 1000 });
      const b = bucketQuota(usage.claude, usage.claude.pools.weekly, list, config, at);
      expect(b.effective).toBe(Math.min(100, reported + 2.5));
      highest = Math.max(highest, b.reserved);
    }
    expect(highest).toBe(2.5);
    expect(list).toHaveLength(1);
  });
});

describe('the lifecycle of a reservation', () => {
  const snapshot = (updatedAt: number, patch: Partial<AgentUsage> = {}) => ({ claude: usageOf('claude', [pool('weekly', 40)], { updatedAt, ...patch }) });

  it('counts pending, running, completed and cancelled-after-consumption records, and nothing else', () => {
    const states = ['pending', 'running', 'completed', 'cancelled_after_consumption', 'failed_before_launch', 'released'] as const;
    expect(states.map((state) => isLive(worker({ state })))).toEqual([true, true, true, true, false, false]);
  });

  it('#10 keeps a completed worker reserved until a snapshot taken after it ended covers it', () => {
    const done = worker({ state: 'completed', endedAt: NOW });
    // Taken before the worker ended, then within the settle time: both leave the reservation standing.
    expect(reconcile([done], snapshot(NOW - 2 * MIN), NOW + 20 * MIN, cfg)).toEqual([done]);
    expect(reconcile([done], snapshot(NOW + 59_000), NOW + 20 * MIN, cfg)).toEqual([done]);
    const released = reconcile([done], snapshot(NOW + 60_000), NOW + 20 * MIN, cfg);
    expect(released[0]).toMatchObject({ state: 'released', note: `reconciled by the usage snapshot of ${new Date(NOW + 60_000).toISOString()}` });
    expect(weeklyOf(40, released).reserved).toBe(0);
  });

  it('#7 does not reconcile on a cached snapshot, however often or however much later it is read', () => {
    const done = worker({ state: 'completed', endedAt: NOW });
    let list = [done];
    for (let i = 1; i <= 30; i++) list = reconcile(list, snapshot(NOW - MIN), NOW + i * 5 * MIN, cfg);
    expect(list).toEqual([done]);
    expect(weeklyOf(40, list, { updatedAt: NOW - MIN }, NOW + 25 * MIN).reserved).toBe(2.5);
  });

  it('#28 recognizes a fresh snapshot by its timestamp even when it reports the same percentage', () => {
    const done = worker({ state: 'completed', endedAt: NOW });
    const same = reconcile([done], snapshot(NOW + 5 * MIN), NOW + 5 * MIN, cfg);
    expect(same[0].state).toBe('released');
    expect(weeklyOf(40, same, { updatedAt: NOW + 5 * MIN }, NOW + 5 * MIN)).toMatchObject({ reported: 40, effective: 40 });
  });

  it('#32 keeps a worker cancelled after consumption reserved until it is reconciled', () => {
    const cancelled = worker({ state: 'cancelled_after_consumption', endedAt: NOW });
    expect(weeklyOf(40, reconcile([cancelled], snapshot(NOW - MIN), NOW + 10 * MIN, cfg)).effective).toBe(42.5);
    expect(reconcile([cancelled], snapshot(NOW + 2 * MIN), NOW + 10 * MIN, cfg)[0].state).toBe('released');
  });

  it('#11 stops counting a worker that failed before launch at once', () => {
    const failed = worker({ state: 'failed_before_launch', endedAt: NOW });
    expect(weeklyOf(40, [failed, worker()]).reserved).toBe(2.5);
    // Kept for an hour for the record, then dropped.
    expect(reconcile([failed], snapshot(NOW), NOW + 59 * MIN, cfg)).toHaveLength(1);
    expect(reconcile([failed], snapshot(NOW), NOW + 61 * MIN, cfg)).toEqual([]);
  });

  it('#31 reconciles only the providers whose snapshot is fresh', () => {
    const claude = worker({ state: 'completed', endedAt: NOW });
    const codex = worker({ agent: 'codex', state: 'completed', endedAt: NOW });
    const usage = {
      claude: usageOf('claude', [pool('weekly', 44)], { updatedAt: NOW + 5 * MIN }),
      // Codex failed to refresh: Orca still holds its snapshot from before the worker ended.
      codex: usageOf('codex', [pool('weekly', 20)], { updatedAt: NOW - 3 * MIN, error: 'Codex usage fetch failed' }),
    };
    const list = reconcile([claude, codex], usage, NOW + 5 * MIN, cfg);
    expect(list.map((r) => [r.agent, r.state])).toEqual([['claude', 'released'], ['codex', 'completed']]);
    expect(bucketQuota(usage.codex, usage.codex.pools.weekly, list, config, NOW + 5 * MIN)).toMatchObject({ reported: 20, reserved: 2.5 });
    expect(bucketQuota(usage.claude, usage.claude.pools.weekly, list, config, NOW + 5 * MIN)).toMatchObject({ reported: 44, reserved: 0 });
    // Neither does an unreadable provider, nor a snapshot OrcaCompass kept from an earlier read.
    expect(reconcile([claude], { claude: { agent: 'claude', status: 'unknown', pools: {} } }, NOW + 5 * MIN, cfg)).toEqual([claude]);
    expect(reconcile([claude], snapshot(NOW + 5 * MIN, { retained: true }), NOW + 5 * MIN, cfg)).toEqual([claude]);
  });

  it('#25 abandons a pending reservation nobody confirmed, and holds it until a fresh snapshot', () => {
    const pending = worker({ state: 'pending', createdAt: NOW, snapshotAt: NOW });
    expect(reconcile([pending], snapshot(NOW), NOW + 9 * MIN, cfg)).toEqual([pending]);
    // Past pendingMinutes with only the old snapshot: abandoned, still counted (the worker may have run).
    const abandoned = reconcile([pending], snapshot(NOW), NOW + 10 * MIN, cfg);
    expect(abandoned[0]).toMatchObject({ state: 'cancelled_after_consumption', endedAt: NOW + 10 * MIN, note: 'abandoned: the launch was never confirmed' });
    expect(weeklyOf(40, abandoned).reserved).toBe(2.5);
    // It cannot remain: the next snapshot after that releases it, and an hour later the record is gone.
    const released = reconcile(abandoned, snapshot(NOW + 12 * MIN), NOW + 12 * MIN, cfg);
    expect(released[0].state).toBe('released');
    expect(reconcile(released, snapshot(NOW + 12 * MIN), NOW + 75 * MIN, cfg)).toEqual([]);
    // Time alone never releases a counted reservation.
    expect(isLive(reconcile(abandoned, snapshot(NOW), NOW + 3 * 86_400_000, cfg)[0])).toBe(true);
  });

  it('closes a running reservation after maxRunningHours and drops week-old records', () => {
    const running = worker({ createdAt: NOW, startedAt: NOW });
    expect(reconcile([running], snapshot(NOW), NOW + 23 * 3_600_000, cfg)[0].state).toBe('running');
    const closed = reconcile([running], snapshot(NOW), NOW + 24 * 3_600_000, cfg);
    expect(closed[0]).toMatchObject({ state: 'completed', endedAt: NOW + 24 * 3_600_000 });
    const orphan = worker({ state: 'completed', createdAt: NOW, endedAt: NOW, scope: 'gone' });
    expect(reconcile([orphan], snapshot(NOW + 8 * 86_400_000), NOW + 8 * 86_400_000, cfg)).toEqual([]);
  });

  it('#12 follows Orca\'s view of a worker without counting it twice', () => {
    const pending = worker({ state: 'pending', dispatchId: 'ctx_1' });
    const unbound = worker({ state: 'pending' });
    const live = applyWorkerStates([pending, unbound], [{ dispatchId: 'ctx_1', outcome: 'in_progress', liveness: 'live' }], NOW, true);
    expect(live.map((r) => r.state)).toEqual(['running', 'pending']);
    expect(live[0]).toMatchObject({ id: pending.id, startedAt: NOW });
    expect(weeklyOf(40, live).workers).toBe(2);
    const done = applyWorkerStates(live, [{ dispatchId: 'ctx_1', outcome: 'succeeded', liveness: 'exited' }], NOW + MIN, true);
    expect(done[0]).toMatchObject({ state: 'completed', endedAt: NOW + MIN });
    for (const ended of [{ outcome: 'in_progress', liveness: 'exited' }, { outcome: 'failed' }, { outcome: 'stopped', liveness: 'live' }, { outcome: 'in_progress', terminalState: 'released' }]) {
      expect(applyWorkerStates(live, [{ dispatchId: 'ctx_1', ...ended }], NOW, true)[0].state).toBe('cancelled_after_consumption');
    }
    // A worker Orca no longer lists is closed only when the list is complete.
    expect(applyWorkerStates(live, [], NOW, false)[0].state).toBe('running');
    expect(applyWorkerStates(live, [], NOW, true)[0]).toMatchObject({ state: 'completed', note: 'closed: Orca no longer reports this worker' });
  });
});

describe('window keys and quota groups', () => {
  it('#7 folds the space after bucket: and every other spacing or case difference into one key', () => {
    expect(poolKey('bucket:  Other  Models')).toBe(poolKey('bucket:other models'));
    expect(poolKey('bucket: Other Models')).toBe('bucket:other models');
    expect(poolKey(' Session ')).toBe('session');
  });

  it('#7 draws a declared group name on every window of the group, and nothing else', () => {
    const p = (name: string, group?: string): UsagePool => pool(name, 10, group ? { group } : {});
    expect(drawsOn('bucket:Gemini Models', p('bucket:Gemini Models 5h', 'Gemini Models'))).toBe(true);
    expect(drawsOn('bucket:gemini  models', p('bucket:Gemini Models 1d', 'Gemini Models'))).toBe(true);
    expect(drawsOn('bucket:Gemini Models 5h', p('bucket:Gemini Models', 'Gemini Models'))).toBe(false);
    expect(drawsOn('bucket:Gemini Models', p('bucket:Gemini Models 5h'))).toBe(false);
    expect(drawsOn('bucket:Claude and GPT models', p('bucket:Gemini Models 5h', 'Gemini Models'))).toBe(false);
  });

  it('#7 gives a model declaring a group every window of it, and a 24-hour window at 100% blocks it', () => {
    const g = { group: 'Gemini Models' };
    const u = usageOf('antigravity', [
      pool('bucket:Gemini Models 5h', 40, { ...g, kind: 'session', windowMinutes: 300 }),
      pool('bucket:Gemini Models 1d', 100, { ...g, windowMinutes: 1440 }),
      pool('bucket:Gemini Models', 10, g),
      pool('bucket:Claude and GPT models', 5, { group: 'Claude and GPT models' }),
    ]);
    const q = candidateQuota(u, ['bucket:Gemini Models 5h', 'bucket:Gemini Models', 'session', 'weekly'], { tier: 'frontier', effort: 'medium' }, [], config, NOW);
    expect(q.buckets.map((b) => b.pool)).toEqual(['bucket:Gemini Models 5h', 'bucket:Gemini Models 1d', 'bucket:Gemini Models']);
    expect(q.status).toBe('exhausted');
    // A worker reserved on the group counts on each of its windows.
    const w = worker({ agent: 'antigravity', pools: ['bucket:gemini models'] });
    expect(Object.values(u.pools).map((p) => bucketQuota(u, p, [w], config, NOW).reserved)).toEqual([2.5, 2.5, 2.5, 0]);
  });
});

describe('the scope of usage', () => {
  it('#6 is known only for a readable snapshot', () => {
    expect(scopeOf(usageOf('claude', []))).toBe('acct-a');
    expect(scopeOf({ agent: 'claude', status: 'unknown', pools: {}, scope: 'acct-a' })).toBe('default');
    expect(scopeOf({ agent: 'claude', status: 'unavailable', pools: {}, scope: 'acct-a' })).toBe('default');
    expect(scopeOf(undefined)).toBe('default');
  });
});

describe('snapshot time', () => {
  it('#9 keeps the number of a snapshot without a time, stale, and reconciles nothing on it', () => {
    const u = usageOf('claude', [pool('weekly', 40)], { updatedAt: undefined });
    expect(bucketQuota(u, u.pools.weekly, [], config, NOW)).toMatchObject({ reported: 40, stale: true, snapshotAt: null, note: 'snapshot time not reported' });
    // A reported 100% still blocks.
    const full = usageOf('claude', [pool('weekly', 100)], { updatedAt: undefined });
    expect(bucketQuota(full, full.pools.weekly, [], config, NOW).status).toBe('exhausted');
    const done = worker({ state: 'completed', endedAt: NOW - 10 * MIN });
    expect(reconcile([done], { claude: u }, NOW + 60 * MIN, cfg)).toEqual([done]);
  });

  it('ages a window kept from an earlier reading from the last snapshot that reported it', () => {
    const u = usageOf('claude', [pool('weekly', 40), pool('fableWeekly', 75, { seenAt: NOW - 40 * MIN, observedAt: NOW - 40 * MIN })]);
    expect(bucketQuota(u, u.pools.weekly, [], config, NOW)).toMatchObject({ stale: false, snapshotAt: NOW });
    expect(bucketQuota(u, u.pools.fableWeekly, [], config, NOW)).toMatchObject({ reported: 75, stale: true, snapshotAt: NOW - 40 * MIN });
  });
});

describe('the buffer guard', () => {
  it('#10e keeps a buffer finite and within 0..100 whatever the overrides', () => {
    const w = { agent: 'claude', pool: 'weekly', tier: 'daily' as const, effort: 'medium' as const };
    for (const overrides of [[{ scale: 1e308 }, { scale: 1e308 }, { scale: 0 }], [{ scale: 1e308 }, { scale: 1e308 }], [{ scale: -5 }], [{ scale: 1e308 }, { scale: 0 }]]) {
      const value = bufferFor({ ...cfg, overrides }, w);
      expect(Number.isFinite(value), JSON.stringify(overrides)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(bufferFor({ ...cfg, overrides: [{ scale: 1e308 }, { scale: 1e308 }, { scale: 0 }] }, w)).toBe(100);
  });
});

describe('per-window reconciliation', () => {
  const at = (observedAt: number) => ({ observedAt, seenAt: observedAt });

  it('#4 settles each window on its own and releases the record once every window is covered', () => {
    const done = worker({ state: 'completed', endedAt: NOW, snapshotAt: NOW - 10 * MIN, pools: ['session', 'weekly', 'fableweekly'] });
    const first = usageOf('claude', [pool('session', 10, at(NOW + 5 * MIN)), pool('weekly', 40, at(NOW + 5 * MIN)), pool('fableWeekly', 75, at(NOW - 10 * MIN))], { updatedAt: NOW + 5 * MIN });
    const held = reconcile([done], { claude: first }, NOW + 5 * MIN, cfg);
    expect(held[0]).toMatchObject({ state: 'completed', settled: ['session', 'weekly'] });
    expect(bucketQuota(first, first.pools.weekly, held, config, NOW + 5 * MIN).reserved).toBe(0);
    expect(bucketQuota(first, first.pools.fableWeekly, held, config, NOW + 5 * MIN).reserved).toBe(2.5);
    // Running it again changes nothing.
    expect(reconcile(held, { claude: first }, NOW + 5 * MIN, cfg)).toEqual(held);
    const later = usageOf('claude', [pool('session', 10, at(NOW + 20 * MIN)), pool('weekly', 40, at(NOW + 20 * MIN)), pool('fableWeekly', 76, at(NOW + 20 * MIN))], { updatedAt: NOW + 20 * MIN });
    expect(reconcile(held, { claude: later }, NOW + 20 * MIN, cfg)[0]).toMatchObject({ state: 'released' });
  });

  it('#4 never settles on the snapshot the worker was allocated on, even with settleSeconds 0', () => {
    const instant = { ...cfg, settleSeconds: 0 };
    const done = worker({ state: 'completed', endedAt: NOW, snapshotAt: NOW });
    expect(reconcile([done], { claude: usageOf('claude', [pool('weekly', 40)], { updatedAt: NOW }) }, NOW, instant)).toEqual([done]);
    expect(reconcile([done], { claude: usageOf('claude', [pool('weekly', 40)], { updatedAt: NOW + 1 }) }, NOW + 1, instant)[0].state).toBe('released');
  });

  it('#5 settles a declared window Orca does not report on a snapshot taken after the end, not before', () => {
    const done = worker({ state: 'completed', endedAt: NOW, pools: ['session', 'weekly', 'monthly'] });
    const before = usageOf('claude', [pool('session', 10), pool('weekly', 40)], { updatedAt: NOW - MIN });
    expect(reconcile([done], { claude: before }, NOW + 5 * MIN, cfg)).toEqual([done]);
    const fresh = usageOf('claude', [pool('session', 10), pool('weekly', 40)], { updatedAt: NOW + 2 * MIN });
    expect(reconcile([done], { claude: fresh }, NOW + 5 * MIN, cfg)[0].state).toBe('released');
  });

  it('#5 counts a declared window that appears after the allocation', () => {
    const running = worker({ pools: ['session', 'weekly', 'monthly'] });
    const u = usageOf('claude', [pool('session', 88, { kind: 'session', windowMinutes: 300 }), pool('weekly', 40)]);
    expect(bucketQuota(u, u.pools.session, [running], config, NOW)).toMatchObject({ reserved: 2.5, workers: 1 });
  });

  it('#4 settles a carried window whose value did not move once a healthy snapshot is 20 minutes past the end', () => {
    const done = worker({ state: 'completed', endedAt: NOW, snapshotAt: NOW - 10 * MIN, pools: ['weekly', 'fableweekly'] });
    // A live-session tick: weekly re-read, fableWeekly carried forward unchanged since before the worker ended.
    const tick = (t: number, patch: Partial<AgentUsage> = {}) => usageOf('claude', [
      pool('weekly', 40, at(t)), pool('fableWeekly', 75, { observedAt: NOW - 30 * MIN, seenAt: t }),
    ], { updatedAt: t, source: 'live-session', ...patch });
    const early = tick(NOW + CARRIED_SETTLE_MS - MIN);
    expect(reconcile([done], { claude: early }, early.updatedAt!, cfg)[0]).toMatchObject({ state: 'completed', settled: ['weekly'] });
    const late = tick(NOW + CARRIED_SETTLE_MS);
    expect(reconcile([done], { claude: late }, late.updatedAt!, cfg)[0].state).toBe('released');
    // Not while Orca keeps old windows after a failed refresh, and not for a window Orca does not carry.
    expect(reconcile([done], { claude: tick(NOW + CARRIED_SETTLE_MS, { retained: true }) }, NOW + CARRIED_SETTLE_MS, cfg)[0].state).toBe('completed');
    expect(reconcile([done], { claude: tick(NOW + CARRIED_SETTLE_MS, { source: 'oauth' }) }, NOW + CARRIED_SETTLE_MS, cfg)[0]).toMatchObject({ state: 'completed', settled: ['weekly'] });
    // A worker allocated on a later snapshot than the tick is not settled by it.
    const recent = { ...done, snapshotAt: NOW + CARRIED_SETTLE_MS };
    expect(reconcile([recent], { claude: late }, late.updatedAt!, cfg)[0].state).toBe('completed');
  });
});

describe('running workers and retention', () => {
  it('#8 keeps a running record Orca confirms live past maxRunningHours, and closes it otherwise', () => {
    const running = worker({ createdAt: NOW, startedAt: NOW, dispatchId: 'ctx_1' });
    const usage = { claude: usageOf('claude', [pool('weekly', 40)]) };
    expect(reconcile([running], usage, NOW + 24 * 3_600_000, cfg, new Set(['ctx_1']))[0].state).toBe('running');
    expect(reconcile([running], usage, NOW + 24 * 3_600_000, cfg, new Set(['ctx_2']))[0].state).toBe('completed');
    expect(reconcile([running], usage, NOW + 24 * 3_600_000, cfg)[0].state).toBe('completed');
  });

  it('#8 measures the seven-day retention from the end, not the creation', () => {
    const usage = { claude: usageOf('claude', [pool('weekly', 40)], { updatedAt: NOW - 9 * 86_400_000 }) };
    const longRun = worker({ state: 'completed', createdAt: NOW - 8 * 86_400_000, endedAt: NOW - MIN });
    expect(reconcile([longRun], usage, NOW, cfg)).toEqual([longRun]);
    const old = worker({ state: 'completed', createdAt: NOW - 9 * 86_400_000, endedAt: NOW - 8 * 86_400_000 });
    expect(reconcile([old], usage, NOW, cfg)).toEqual([]);
  });

  it('#8 counts two live records of one Dispatch once', () => {
    const a = worker({ dispatchId: 'ctx_1' });
    const b = worker({ dispatchId: 'ctx_1' });
    expect(reservationsOn([a, b], 'claude', 'acct-a', 'weekly')).toEqual([a]);
    expect(weeklyOf(40, [a, b])).toMatchObject({ reserved: 2.5, workers: 1 });
    expect(weeklyOf(40, [a, worker({ dispatchId: 'ctx_2' })])).toMatchObject({ reserved: 5, workers: 2 });
  });

  it('#4 does not count a record on a window it settled', () => {
    const w = worker({ state: 'completed', endedAt: NOW, pools: ['session', 'weekly'], settled: ['weekly'] });
    expect(reservationsOn([w], 'claude', 'acct-a', 'weekly')).toEqual([]);
    expect(reservationsOn([w], 'claude', 'acct-a', 'session')).toEqual([w]);
  });
});
