import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { parseSnapshot, type SnapshotModel } from '../../src/evidence/snapshot.js';
import { fixture } from '../helpers/fakes.js';
import { agentSkipReason, CHOSEN_UNVERIFIED, formatLaunch, planRoute, route } from '../../src/routing/router.js';
import type { Config, Effort, Environment, LaunchModel, Reservation, RouteRequest } from '../../src/types.js';
import {
  CURSOR_AUTO, cursorVariant, machineEnv, onlyModels, placed, withCursorModels, withPool, withUsageStatus, withUsageUpdatedAt,
} from '../helpers/env.js';

const env = machineEnv();
// Fable 5.1 clears 76/80/86; Sonnet misses only the agentic cut.
const fableNeeds = { coding: 'mid', agentic: 'high', reasoning: 'high' } as const;
const r = (req: RouteRequest) => route(req, env, DEFAULT_CONFIG);
// Remaining capacity in the fixture: Cursor's Other Models 93.75%, Codex weekly 80%, Claude weekly 50% (Fable weekly 25%).
const claude = ['claude'];
const bucketOf = (d: { quota?: { buckets: { pool: string }[] } | null }, pool: string) => d.quota!.buckets.find((b) => b.pool === pool)!;

describe('routing by cost tier', () => {
  it('Daily takes the most economical eligible route in the bucket with the most remaining capacity', () => {
    const d = r({ tier: 'daily' });
    // Cursor's Other Models bucket has the most room; in it Sonnet ($4/M, Daily) reserves less than Opus or Fable.
    expect(d).toMatchObject({ status: 'ok', tier: 'daily', confidence: 'high', route: { agent: 'cursor', model: 'claude-sonnet-5-5-medium', effort: null } });
    expect(d.reasons.join('\n')).toContain('eligible routes: 9 across all cost tiers');
    expect(d.reasons).toContain('cost: daily ($4.00/M blended, maker price)');
    // Alternatives follow the buckets: the rest of Cursor's, then Codex (80% left), then Claude (50% left).
    expect(d.alternatives.map((a) => `${a.agent} ${a.model}`)).toEqual([
      'cursor claude-opus-5-5-medium', 'cursor claude-fable-5-1-medium', 'codex gpt-6.1-terra', 'codex gpt-6.1-sol', 'codex gpt-6-astra',
    ]);
  });
  it('Advanced uses the Daily-cost Sonnet because its raw evidence covers every mid cut', () => {
    // 84.3/78.2/87.3 clears the fixture cuts 76/70/78.
    expect(r({ tier: 'advanced', agents: claude })).toMatchObject({ tier: 'daily', upgraded: false, downgraded: false, route: { model: 'claude-sonnet-5-5' } });
  });
  it('Frontier uses Advanced-cost Opus before Frontier-cost Fable 5.2', () => {
    const e = withCursorModels(env, [cursorVariant('claude-fable-5-2')]);
    const d = route({ tier: 'frontier' }, e, DEFAULT_CONFIG);
    // Both are on the same Cursor bucket: Opus (Advanced, 2.5 pp) reserves less than Fable 5.2 (Frontier, 3 pp).
    expect(d).toMatchObject({ tier: 'advanced', route: { agent: 'cursor', model: 'claude-opus-5-5-high', effort: null }, quality: { class: 'frontier', cost: { tier: 'advanced', blended: 8, source: 'price' } } });
    expect(route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, banModels: ['claude-opus'] })).toMatchObject({ tier: 'frontier', route: { model: 'claude-fable-5-2-high' } });
  });
  it('Light compares all eligible models and chooses Haiku inside the Claude bucket', () => {
    const d = r({ tier: 'light', agents: claude });
    // On one bucket the Light-cost Haiku reserves the least.
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
    expect(d.alternatives[0].model).toBe('claude-sonnet-5-5');
    expect(r({ tier: 'light' }).reasons.join('\n')).toContain('eligible routes: 11 across all cost tiers');
  });
  it('ranks a nearly exhausted cheap route below a healthy higher-priced model', () => {
    const pair = onlyModels(onlyModels(env, 'claude', ['claude-haiku-5-5']), 'cursor', ['claude-opus-5-5']);
    const req = { tier: 'light' as const, agents: ['claude', 'cursor'] };
    for (const usedPercent of [96, 94]) {
      const usage = withPool(pair, 'claude', 'weekly', { usedPercent });
      const decision = route(req, usage, DEFAULT_CONFIG);
      expect(decision.route?.agent).toBe('cursor');
      expect(decision.alternatives[0]).toMatchObject({ agent: 'claude', blocked: false });
    }
  });

  it.each([
    [{ tier: 'light', blended: 4, source: 'override' }, 'cost: light ($4.00/M blended, your override)'],
    [{ tier: 'daily', blended: null, source: 'family' }, 'cost: daily (family hint, no price)'],
    [{ tier: 'daily', blended: null, source: 'lineup' }, "cost: daily (provider's lineup, no price)"],
    [{ tier: 'frontier', blended: null, source: 'evidence' }, 'cost: frontier (evidence class, no price)'],
  ] as const)('explains the stored cost source %s', (cost, reason) => {
    const e = structuredClone(env);
    e.discoveries.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-sonnet-5-5')!.profile.cost = { ...cost };
    const d = route({ tier: 'daily' }, e, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' } } });
    expect(d.tier).toBe(cost.tier);
    expect(d.quality?.cost).toEqual(cost);
    expect(d.reasons).toContain(reason);
  });
});

describe('per-axis routing', () => {
  it('reports shorthand needs, quality and all Frontier alternatives in rank order', () => {
    const d = r({ tier: 'frontier' });
    expect(d).toMatchObject({ needsSource: 'tier', needs: { coding: 'high', agentic: 'high', reasoning: 'high' }, quality: { covers: true, class: 'frontier' } });
    expect(d.alternatives.map((a) => `${a.agent} ${a.model}`)).toEqual(['claude claude-opus-5-5']);
    expect(r({ tier: 'advanced' }).quality).toMatchObject({ class: 'frontier', covers: true, overshoot: 2 });
  });
  it('high/mid/low admits every covering tier', () => {
    const d = r({ needs: { coding: 'high', agentic: 'mid', reasoning: 'low' } });
    expect(d).toMatchObject({ requestedTier: 'frontier', needsSource: 'need', route: { agent: 'cursor', model: 'claude-sonnet-5-5-high' } });
    expect(d.reasons.join(' ')).toContain('needs coding=high agentic=mid reasoning=low; eligible routes:');
  });
  it('low/low/min on Claude picks Daily-cost Sonnet and explains below-need models', () => {
    const d = r({ needs: { coding: 'low', agentic: 'low', reasoning: 'min' }, agents: ['claude'] });
    expect(d).toMatchObject({ requestedTier: 'daily', tier: 'daily', upgraded: false, route: { model: 'claude-sonnet-5-5' } });
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-haiku-5-5', reason: 'below need on agentic (53.5 < 60)' });
  });
  it('never lowers the requirements on its own: the Orchestrator gets WAIT and LOWER', () => {
    const config = { ...DEFAULT_CONFIG, banModels: ['claude-opus-5-5'] };
    const blocked = withPool(env, 'claude', 'fableWeekly', { usedPercent: 100 });
    const d = route({ needs: fableNeeds, agents: claude }, blocked, config);
    expect(d).toMatchObject({ status: 'decide', downgraded: false });
    expect(d.route).toBeUndefined();
    expect(d.options).toMatchObject({
      wait: { until: 1793282400000, reason: 'the earliest quota reset is in 14h' },
      use: [],
      // Nearest to the job first. With Opus 5.5 banned its predecessor is listed again, and it falls short too.
      lower: [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', shortfall: 'below need on agentic (78.2 < 80)', use: '--use claude/claude-sonnet-5-5' }, { model: 'claude-opus-5' }, { model: 'claude-haiku-5-5' }],
    });
    expect(d.reasons[0]).toBe('no eligible route is below the 90% risk threshold: claude claude-fable-5-1 (fableWeekly 100% prospective, exhausted)');
    expect(d.reasons).toContain('WAIT: until 2026-10-29T14:00:00.000Z (14h); the earliest quota reset is in 14h');
    expect(d.reasons).toContain('to LOWER, route again with lower --need or --demand; to take one route as it is, add its --use flag');
    // The Orchestrator lowers the need explicitly, or takes the weaker route as it is.
    expect(route({ needs: { ...fableNeeds, agentic: 'mid' }, agents: claude }, blocked, config)).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'claude-sonnet-5-5' } });
    const used = route({ needs: fableNeeds, agents: claude, use: { agent: 'claude', model: 'claude-sonnet-5-5' } }, blocked, config);
    expect(used).toMatchObject({ status: 'ok', downgraded: true, tier: 'daily', route: { model: 'claude-sonnet-5-5', effort: 'high' }, quality: { covers: false, shortfall: 1 } });
    expect(used.warnings).toContain("claude-sonnet-5-5 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks");
    expect(used.reasons).toContain('chosen by the Orchestrator (--use claude/claude-sonnet-5-5): risk thresholds and requirements were not applied');
  });
  it('#21 moves on to the next bucket when the one with the most capacity has no eligible route', () => {
    // Cursor has the most room but only Sonnet and Fable 5.1, which miss a Frontier job; Codex comes next and has none either.
    const e = onlyModels(env, 'cursor', ['claude-sonnet-5-5', 'claude-fable-5-1']);
    const d = route({ tier: 'frontier' }, e, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', tier: 'advanced', downgraded: false, upgraded: false, route: { agent: 'claude', model: 'claude-opus-5-5' } });
    expect(d.buckets!.map((b) => `${b.agent} ${b.pool} ${b.remaining}`)).toEqual([
      'cursor monthly 97.5', 'cursor bucket:Other Models 93.75', 'claude session 90', 'codex weekly 80', 'claude weekly 50', 'claude fableWeekly 25',
    ]);
    expect(d.reasons.find((line) => line.startsWith('selection:')))
      .toBe('selection: quota bucket claude weekly has 50% effective capacity left (bucket 1 of 1 with an eligible route); most economical eligible route in it below the 85% caution threshold');
    // An exhausted bucket is passed over the same way.
    const full = withPool(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 100 }), 'codex', 'weekly', { usedPercent: 100 });
    expect(route({ tier: 'daily' }, full, DEFAULT_CONFIG)).toMatchObject({ status: 'ok', route: { agent: 'claude', model: 'claude-sonnet-5-5' } });
  });
  it('#22 returns the decision to the Orchestrator when every suitable route is at high usage', () => {
    const e = onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-opus-5-5']);
    const tight = withPool(withPool(withPool(e, 'cursor', 'bucket:Other Models', { usedPercent: 93 }), 'claude', 'weekly', { usedPercent: 93 }), 'codex', 'weekly', { usedPercent: 91 });
    const d = route({ tier: 'daily' }, tight, DEFAULT_CONFIG);
    expect(d.status).toBe('decide');
    expect(d.route).toBeUndefined();
    expect(d.launchArgs).toBeUndefined();
    // Every eligible route is offered for USE, the least loaded bucket first; nothing was picked silently.
    expect(d.options!.use.map((u) => [u.use, u.reason])).toEqual([
      ['--use codex/gpt-6.1-terra', 'weekly 92.5% prospective, high risk'],
      ['--use codex/gpt-6.1-sol', 'weekly 92.5% prospective, high risk'],
      ['--use codex/gpt-6-astra', 'weekly 93.5% prospective, high risk'],
      ['--use claude/claude-opus-5-5', 'weekly 95% prospective, high risk'],
      ['--use cursor/claude-sonnet-5-5-medium', 'Other Models 94.5% prospective, high risk'],
    ]);
    expect(d.options!.wait).toEqual({ until: tight.usage.claude.pools.weekly.resetsAt, reason: 'the earliest quota reset is in 14h' });
    // Haiku and Luna are below the job, and at high usage too: no LOWER option either.
    expect(d.options!.lower).toEqual([]);
    expect(d.reasons).toContain('USE: codex gpt-6.1-terra with --use codex/gpt-6.1-terra (weekly 92.5% prospective, high risk)');
    // USE proceeds despite the risk, saying so.
    const used = route({ tier: 'daily', use: { agent: 'claude', model: 'claude-opus-5-5' } }, tight, DEFAULT_CONFIG);
    expect(used).toMatchObject({ status: 'ok', route: { agent: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, quota: { status: 'high' } });
    expect(used.warnings).toContain('weekly quota would be 95% used with this worker (high risk); resets in 14h');
    // Actual exhaustion cannot be used: the decision stays with the Orchestrator.
    const exhausted = route({ tier: 'daily', use: { agent: 'claude', model: 'claude-opus-5-5' } }, withPool(tight, 'claude', 'weekly', { usedPercent: 100 }), DEFAULT_CONFIG);
    expect(exhausted.status).toBe('decide');
    expect(exhausted.reasons[0]).toBe('--use claude/claude-opus-5-5: quota exhausted (weekly 100% used, resets in 14h)');
    expect(route({ tier: 'daily', use: { agent: 'claude', model: 'no-such-model' } }, tight, DEFAULT_CONFIG)).toMatchObject({ status: 'none', reasons: expect.arrayContaining(['--use claude/no-such-model: not available']) });
  });
  it('does not pass a group over for a pricier route whose usage is unknown', () => {
    const e = onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-opus-5-5']);
    const strained = withUsageStatus(withPool(e, 'cursor', 'bucket:Other Models', { usedPercent: 93 }), 'unknown', ['claude']);
    expect(route({ tier: 'daily' }, strained, DEFAULT_CONFIG).tier).toBe('daily');
  });
  it('ranks equal headroom by price before evidence and weighted score', () => {
    const req = { tier: 'frontier', agents: ['cursor'] } as const;
    // Put two covering models in Advanced cost; Fable 5.2 scores 795.3 vs Opus 780, on identical pools.
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-fable-5-2': 'advanced' } };
    const tied = withCursorModels(env, [cursorVariant('claude-fable-5-2')], 0.5, config);
    const run = (e: Environment) => route({ ...req, agents: [...req.agents] }, e, config);
    // Opus is $8/M and Fable $16/M: the cheaper covering model wins before the score.
    expect(run(tied).route?.model).toBe('claude-opus-5-5-high');
    const changed = structuredClone(tied);
    const cursor = changed.discoveries.find((d) => d.agent === 'cursor')!;
    // Both models still cover the job.
    cursor.models.find((m) => m.modelId === 'claude-opus-5-5')!.profile.axes.coding.label = 'partial';
    expect(run(changed).route?.model).toBe('claude-opus-5-5-high');
    // At the same price, the higher need-weighted score wins.
    cursor.models.find((m) => m.modelId === 'claude-opus-5-5')!.profile.axes.coding.label = 'measured';
    for (const m of cursor.models) if (m.profile.cost) m.profile.cost = { ...m.profile.cost, blended: 8 };
    expect(run(changed).route?.model).toBe('claude-fable-5-2-high');
  });
  it('offers Cursor auto only as an option the Orchestrator must take itself', () => {
    const auto = withCursorModels(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 100 }), [CURSOR_AUTO]);
    const req = { tier: 'frontier' as const, agents: ['cursor'] };
    const d = route(req, auto, DEFAULT_CONFIG);
    // Cursor picks the model behind auto, so no capability is claimed for it: it is never routed silently.
    expect(d.status).toBe('decide');
    expect(d.options!.lower.at(-1)).toMatchObject({ agent: 'cursor', model: 'auto', effort: null, tier: null, shortfall: 'capability unknown: Cursor picks the model', use: '--use cursor/auto' });
    const used = route({ ...req, use: { agent: 'cursor', model: 'auto' } }, auto, DEFAULT_CONFIG);
    expect(used).toMatchObject({ status: 'ok', route: { agent: 'cursor', model: 'auto', effort: null }, quality: null, source: 'auto', confidence: 'medium' });
    expect(used.tier).toBeUndefined();
    expect(used.reasons).toContain('cursor auto: capability unknown, Cursor picks the model');
    const offered = (d2: ReturnType<typeof route>) => (d2.options?.lower ?? []).some((l) => l.model === 'auto');
    expect(offered(route(req, auto, { ...DEFAULT_CONFIG, cursorAuto: false }))).toBe(false);
    expect(offered(route(req, withPool(auto, 'cursor', 'bucket:Cursor Models', { usedPercent: 100 }), DEFAULT_CONFIG))).toBe(false);
    expect(offered(route(req, auto, { ...DEFAULT_CONFIG, banModels: ['auto'] }))).toBe(false);
    expect(offered(route({ ...req, effort: 'high' }, onlyModels(auto, 'cursor', ['auto']), DEFAULT_CONFIG))).toBe(false);
    expect(offered(route(req, onlyModels(auto, 'cursor', ['auto']), DEFAULT_CONFIG))).toBe(true);
    const named = route(req, withCursorModels(env, [CURSOR_AUTO]), DEFAULT_CONFIG);
    expect(named.route?.model).not.toBe('auto');
    expect(named.alternatives.some((a) => a.model === 'auto')).toBe(false);
  });
  it('skips an agent-only pin whose models are all unranked without throwing', () => {
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'flag', model: 'mystery-9' }, poolNames: [] };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    const d = route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor' } } });
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'claude' } });
    expect(d.warnings).toContain('preferred cursor skipped: not available (unranked: no evidence or estimate)');
  });
  it('honors a pinned model even when it does not cover', () => {
    const d = route({ tier: 'frontier' }, env, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'claude', model: 'claude-sonnet-5-5' } } });
    expect(d.route?.model).toBe('claude-sonnet-5-5');
    expect(d.downgraded).toBe(true);
    expect(d.quality).toMatchObject({ covers: false, shortfall: 1 });
    expect(d.reasons.join('\n')).toContain('preferred route does not cover the job: agentic 78.2 < 80');
    expect(d.reasons).not.toContain('Manually preferred model; benchmark data unavailable. Task coverage could not be verified.');
    expect(d.warnings).toContain("claude-sonnet-5-5 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks");
    expect(d.skipped.some((s) => s.agent === 'claude' && s.model === 'claude-sonnet-5-5')).toBe(false);
  });
  it('tries last-resort named routes before auto', () => {
    const auto = withCursorModels(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 100 }), [CURSOR_AUTO]);
    const e = placed({ ...auto, discoveries: [...auto.discoveries, { agent: 'opencode', installed: true, models: [{ agent: 'opencode', modelId: 'claude-opus-5-5', efforts: [], poolNames: [], launch: { kind: 'flag', model: 'claude-opus-5-5' } }] }] });
    const d = route({ tier: 'frontier', excludeAgents: ['claude', 'codex'] }, e, DEFAULT_CONFIG);
    expect(d.route?.agent).toBe('opencode');
    expect(d.warnings.join('\n')).toContain('last-resort agent');
  });
  it('warns that an auto tier override has no effect', () => {
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { auto: 'frontier' } };
    const d = route({ tier: 'light', agents: ['cursor'] }, withCursorModels(env, [CURSOR_AUTO], 0.5, config), config);
    expect(d.route?.model).not.toBe('auto');
    expect(d.warnings).toContain('tierOverrides.auto is ignored: Cursor auto has no model profile');
  });
  it('allows an explicit unranked model pin, reporting unknown coverage without downgrade or artificial shortfall', () => {
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'flag', model: 'mystery-9' }, poolNames: [] };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    const d = route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } });
    expect(d).toMatchObject({
      status: 'ok', downgraded: false, upgraded: false,
      route: { agent: 'cursor', model: 'mystery-9', effort: null }, confidence: 'low',
      quality: { class: null, cost: null, covers: null, evidence: 'unranked', shortfall: 0, overshoot: 0 },
    });
    for (const axis of ['coding', 'agentic', 'reasoning'] as const) {
      expect(d.quality!.axes[axis]).toMatchObject({ score: null, band: null, evidence: 'unranked' });
    }
    expect(d.reasons).toContain('Manually preferred model; benchmark data unavailable. Task coverage could not be verified.');
    expect(d.reasons.join('\n')).not.toContain('preferred route does not cover the job');
    expect(d.reasons.join('\n')).not.toContain('downgraded from');
    expect(d.warnings.some((w) => w.includes('falls short'))).toBe(false);
    expect(d.skipped.some((s) => s.agent === 'cursor' && s.model === 'mystery-9')).toBe(false);
  });
  it('offers auto after every named Cursor model was rejected, but honors an auto rejection', () => {
    const auto = withCursorModels(env, [CURSOR_AUTO]);
    const rejections = auto.discoveries.find((d) => d.agent === 'cursor')!.models.filter((m) => m.modelId !== 'auto').map((m) => ({ agent: 'cursor', model: m.modelId, message: 'not available', at: env.now }));
    const req = { tier: 'frontier' as const, agents: ['cursor'] };
    expect(route(req, { ...auto, rejections }, DEFAULT_CONFIG).options!.lower.map((l) => l.model)).toEqual(['auto']);
    const rejectedAuto = { ...auto, rejections: [...rejections, { agent: 'cursor', model: 'auto', message: 'not available', at: env.now }] };
    expect(route(req, rejectedAuto, DEFAULT_CONFIG)).toMatchObject({ status: 'none' });
    expect(route({ ...req, use: { agent: 'cursor', model: 'auto' } }, rejectedAuto, DEFAULT_CONFIG).reasons[0]).toBe('--use cursor/auto: not available (refused by cursor 0m ago: "not available")');
    expect(route(req, withUsageStatus(auto, 'unknown', ['cursor']), DEFAULT_CONFIG).confidence).toBe('low');
  });
  it('uses the environment cuts in quality and shortfall explanations', () => {
    const e = structuredClone(env);
    e.bands.coding = [70, 80, 90];
    // Stored bands stay authoritative: model the profile rebuilt with the raised coding cut.
    e.discoveries.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-sonnet-5-5')!.profile.axes.coding.band = 'advanced';
    const d = route({ tier: 'frontier', agents: ['claude'] }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'claude', model: 'claude-sonnet-5-5' } } });
    expect(d.quality!.axes.coding.cut).toBe(90);
    expect(d.reasons.join('\n')).toContain('coding 84.3 < 90');
  });
});

describe('stored placement routing', () => {
  it('uses stored overrides without recomputing model tiers', () => {
    const edited: Environment = {
      ...env,
      discoveries: env.discoveries.map((d) => (d.agent !== 'claude' ? d : {
        ...d,
        models: d.models.map((m) => (m.modelId !== 'claude-fable-5-1' ? m : { ...m, profile: { ...m.profile, cost: { tier: 'light' as const, blended: 20, source: 'override' as const }, hint: { tier: 'light' as const, source: 'override' as const } } })),
      })),
    };
    const light = route({ tier: 'light', agents: ['claude'] }, edited, DEFAULT_CONFIG);
    expect([light.route?.model, ...light.alternatives.map((a) => a.model)]).toContain('claude-fable-5-1');
    expect(route({ tier: 'frontier', agents: ['claude'] }, edited, DEFAULT_CONFIG).route?.model).toBe('claude-opus-5-5');
  });

  it('ranks usage headroom before classification origin within one agent', () => {
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-opus-5-5': 'frontier' } };
    const candidates = placed(withPool(env, 'claude', 'fableWeekly', { usedPercent: 60 }), { config });
    const decision = route({ needs: fableNeeds, agents: ['claude'] }, candidates, config);
    expect(decision.route?.model).toBe('claude-opus-5-5');
    expect(decision.alternatives[0]?.model).toBe('claude-fable-5-1');
  });
});

describe('route with synthetic usage', () => {
  it('Frontier: the Advanced-cost Opus, on the bucket with the most room', () => {
    expect(r({ tier: 'frontier' })).toMatchObject({
      status: 'ok', tier: 'advanced', downgraded: false, upgraded: false,
      route: { agent: 'cursor', model: 'claude-opus-5-5-high', effort: null }, confidence: 'high',
    });
    expect(r({ tier: 'frontier' }).launchArgs).toEqual(['--agent', 'cursor', '--model', 'claude-opus-5-5-high']);
    expect(r({ tier: 'frontier', agents: claude }).launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']);
  });

  it('Daily and Advanced use Sonnet; Light uses Haiku with the tier default effort', () => {
    expect(r({ tier: 'daily', agents: claude }).route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(r({ tier: 'advanced', agents: claude }).route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(r({ tier: 'light', agents: claude }).route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
    expect(r({ tier: 'daily', agents: claude }).launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'medium']);
  });

  it('hides older releases in the same cost tier and keeps an older release in a different tier', () => {
    // Opus 5 ($10/M) and 5.5 ($8/M) are both Advanced cost, so only 5.5 competes.
    const d = r({ tier: 'advanced', agents: claude });
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(d.alternatives.some((a) => a.agent === 'claude' && a.model === 'claude-opus-5')).toBe(false);
    // Hidden releases must also be absent from below-need diagnostics, not merely from the fit group.
    expect(r({ tier: 'frontier' }).skipped.some((a) => a.model === 'claude-opus-5')).toBe(false);
    const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
    snapshot.models.push({ ...snapshot.models.find((m) => m.id === 'claude-sonnet-5-5')!, id: 'claude-sonnet-4-6', aliases: [], pricing: { inputPerM: 3, outputPerM: 15 } });
    const newer = env.discoveries.find((a) => a.agent === 'claude')!.models.find((m) => m.modelId === 'claude-sonnet-5-5')!;
    const older: LaunchModel = { ...newer, modelId: 'claude-sonnet-4-6', meta: { ...newer.meta!, id: 'claude-sonnet-4-6', releaseDate: '2026-02-17' }, launch: { kind: 'flag', model: 'claude-sonnet-4-6' } };
    const e = placed({ ...env, discoveries: env.discoveries.map((a) => a.agent === 'claude' ? { ...a, models: [...a.models, older] } : a) }, { snapshot });
    // Same Frontier evidence class, different cost tiers: $6/M Advanced vs $4/M Daily.
    // An explicit pin proves the older release survives collection alongside the newer release.
    const pinned = route({ tier: 'advanced', agents: ['claude'] }, e, { ...DEFAULT_CONFIG, pins: { advanced: { agent: 'claude', model: 'claude-sonnet-4-6' } } });
    expect(pinned).toMatchObject({ tier: 'advanced', route: { model: 'claude-sonnet-4-6' } });
  });

  it('keeps every Gemini line in a cost tier: a newer Hydrogen does not hide Carbon', () => {
    const geminiModel = (id: string, family: string, releaseDate: string): LaunchModel => ({
      agent: 'cursor', modelId: id, efforts: ['low', 'medium', 'high'],
      meta: { id, provider: 'google', name: id, family, releaseDate },
      launch: { kind: 'variant', ids: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` } },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
    const row = (id: string, family: string, releasedAt: string, coding: number, agentic: number, reasoning: number): SnapshotModel => ({
      id, aliases: [], provider: 'google', name: id, family, releasedAt, results: [],
      pricing: { inputPerM: 2, outputPerM: 10 },
      scores: Object.fromEntries(Object.entries({ coding, agentic, reasoning }).map(([axis, score]) => [axis, { score, benchmarks: 3, kind: 'measured' }])) as SnapshotModel['scores'],
    });
    const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
    // Same price, so the same cost tier. Hydrogen is newer but falls short of an Advanced job; Carbon covers it.
    snapshot.models.push(row('gemini-4-carbon', 'gemini-carbon', '2026-11-10', 86.6, 78.5, 93), row('gemini-4-hydrogen', 'gemini-hydrogen', '2026-11-12', 77.9, 69.5, 86.9));
    const models = [geminiModel('gemini-4-carbon', 'gemini-carbon', '2026-11-10'), geminiModel('gemini-4-hydrogen', 'gemini-hydrogen', '2026-11-12')];
    const e = onlyModels(placed(withCursorModels(env, models, 0.1), { snapshot }), 'cursor', ['gemini-4-carbon', 'gemini-4-hydrogen']);
    const advanced = route({ tier: 'advanced', agents: ['cursor'] }, e, DEFAULT_CONFIG);
    expect(advanced.route?.model).toBe('gemini-4-carbon-medium');
    expect(advanced.skipped).toContainEqual(expect.objectContaining({ model: 'gemini-4-hydrogen', reason: expect.stringMatching(/^below need/) }));
  });

  it('routes a day-0 Gemini release in place of its predecessor, with borrowed scores', () => {
    const neon = (id: string): LaunchModel => ({
      agent: 'cursor', modelId: id, efforts: ['low', 'medium', 'high'],
      launch: { kind: 'variant', ids: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` } },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
    const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
    snapshot.models.push({
      id: 'gemini-4-neon', aliases: [], provider: 'google', name: 'Gemini 4 Neon', family: 'gemini-neon', releasedAt: '2026-11-18', results: [],
      pricing: { inputPerM: 2, outputPerM: 10 },
      scores: { coding: { score: 86.9, benchmarks: 4, kind: 'measured' }, agentic: { score: 85.7, benchmarks: 3, kind: 'measured' }, reasoning: { score: 93.5, benchmarks: 3, kind: 'measured' } },
    });
    const e = onlyModels(placed(withCursorModels(env, [neon('gemini-4-neon'), neon('gemini-5-neon')], 0.1), { snapshot }), 'cursor', ['gemini-4-neon', 'gemini-5-neon']);
    const d = route({ tier: 'frontier', agents: ['cursor'] }, e, DEFAULT_CONFIG);
    expect(d.route?.model).toBe('gemini-5-neon-high');
    expect(d.quality?.axes.coding).toMatchObject({ score: 86.9, evidence: 'assumed' });
    expect(d.alternatives.map((a) => a.model)).not.toContain('gemini-4-neon-high');
  });

  it('#19 leaves out a model that cannot apply an effort satisfying the demand, however cheap it is', () => {
    const gemini = (id: string, efforts: Effort[], pools: string[]): LaunchModel => ({
      agent: 'cursor', modelId: id, efforts,
      meta: { id, provider: 'google', name: id, family: id.replace(/^gemini-4-/, 'gemini-'), releaseDate: '2026-11-10' },
      launch: { kind: 'variant', ids: Object.fromEntries(efforts.map((e) => [e, `${id}-${e}`])) },
      poolNames: pools,
    });
    const row = (id: string, inputPerM: number): SnapshotModel => ({
      id, aliases: [], provider: 'google', name: id, family: id.replace(/^gemini-4-/, 'gemini-'), releasedAt: '2026-11-10', results: [],
      pricing: { inputPerM, outputPerM: inputPerM * 5 },
      scores: { coding: { score: 86, benchmarks: 4, kind: 'measured' }, agentic: { score: 80, benchmarks: 3, kind: 'measured' }, reasoning: { score: 92, benchmarks: 4, kind: 'measured' } },
    });
    const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
    // Carbon is cheaper ($4/M blended) but stops at high; Neon ($6/M) offers xhigh. Same pools, same capabilities.
    snapshot.models.push(row('gemini-4-carbon', 2), row('gemini-4-neon', 3));
    const shared = ['monthly', 'bucket:Cursor Models'];
    const models = [gemini('gemini-4-carbon', ['low', 'medium', 'high'], shared), gemini('gemini-4-neon', ['low', 'medium', 'high', 'xhigh'], shared)];
    const e = onlyModels(placed(withCursorModels(env, models, 0.1), { snapshot }), 'cursor', ['gemini-4-carbon', 'gemini-4-neon']);
    const req = { needs: { coding: 'mid', agentic: 'mid', reasoning: 'mid' } as const, agents: ['cursor'] };
    const exceptional = route({ ...req, demand: 'exceptional' }, e, DEFAULT_CONFIG);
    expect(exceptional.route?.model).toBe('gemini-4-neon-xhigh');
    expect(exceptional.effort).toMatchObject({ target: 'xhigh', resolved: 'xhigh', adjusted: false });
    // Carbon is not a runner-up at a lower effort: it is out, with the reason.
    expect(exceptional.alternatives).toEqual([]);
    expect(exceptional.skipped).toContainEqual({ agent: 'cursor', model: 'gemini-4-carbon', reason: 'highest effort high is below xhigh (low/medium/high)' });
    expect(exceptional.reasons.join('\n')).toContain('eligible routes: 1 across all cost tiers');
    // When both can apply the target, the cheaper one takes it.
    expect(route({ ...req, demand: 'high' }, e, DEFAULT_CONFIG).route?.model).toBe('gemini-4-carbon-high');
    // Alone, Carbon is not downgraded to high: the Orchestrator decides.
    const alone = route({ ...req, demand: 'exceptional' }, onlyModels(e, 'cursor', ['gemini-4-carbon']), DEFAULT_CONFIG);
    expect(alone).toMatchObject({ status: 'decide', options: { wait: null, use: [], lower: [{ model: 'gemini-4-carbon-high', shortfall: 'highest effort high is below xhigh (low/medium/high)' }] } });
    expect(alone.reasons[0]).toBe('no route that covers the job can apply effort xhigh (exceptional demand)');
    // An explicit lower demand makes it eligible again.
    expect(route({ ...req, demand: 'high' }, onlyModels(e, 'cursor', ['gemini-4-carbon']), DEFAULT_CONFIG).route?.model).toBe('gemini-4-carbon-high');
  });

  it('hides older Grok releases in the same cost tier before checking evidence', () => {
    const grokModel = (id: string, releaseDate: string): LaunchModel => ({
      agent: 'cursor', modelId: id, efforts: ['low', 'medium', 'high'],
      meta: { id, provider: 'x-ai', name: id, family: 'grok', releaseDate },
      launch: { kind: 'variant', ids: { low: `cursor-${id}-low`, medium: `cursor-${id}-medium`, high: `cursor-${id}-high` } },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
    const row = (id: string, releasedAt: string, coding: number, agentic: number, reasoning: number): SnapshotModel => ({
      id, aliases: [], provider: 'x-ai', name: id, family: 'grok', releasedAt, results: [],
      pricing: { inputPerM: 2, outputPerM: 6 },
      scores: Object.fromEntries(Object.entries({ coding, agentic, reasoning }).map(([axis, score]) => [axis, { score, benchmarks: 3, kind: 'measured' }])) as SnapshotModel['scores'],
    });
    const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
    // 4.5 is Light on every axis; 4.6 and 4.7 are Daily on reasoning only, so neither covers a Daily job.
    snapshot.models.push(row('grok-4-5', '2026-07-08', 52.3, 32.2, 65), row('grok-4-6', '2026-08-15', 63.9, 38.5, 76), row('grok-4-7', '2026-09-21', 65.8, 46.8, 75.1));
    const e = placed(withCursorModels(env, [grokModel('grok-4.5', '2026-07-08'), grokModel('grok-4.6', '2026-08-15'), grokModel('grok-4.7', '2026-09-21')], 0.1), { snapshot });
    const light = route({ tier: 'light' }, e, DEFAULT_CONFIG);
    // Grok qualifies alongside the other Light-eligible routes on Cursor's bucket.
    expect([light.route, ...light.alternatives].some((a) => a?.model.includes('grok-4.7'))).toBe(true);
    // Only 4.7 competes at Daily cost; its coding 65.8 and agentic 46.8 miss the low cuts 68/60.
    const daily = route({ tier: 'daily' }, e, DEFAULT_CONFIG);
    expect(daily.skipped).toContainEqual({ agent: 'cursor', model: 'grok-4.7', reason: 'below need on coding (65.8 < 68)' });
    expect(daily.skipped).toContainEqual({ agent: 'cursor', model: 'grok-4.7', reason: 'below need on agentic (46.8 < 60)' });
    for (const d of [light, daily]) {
      const older = [d.route, ...d.alternatives, ...d.skipped].filter((a) => a?.model && /grok-4\.[56]/.test(a.model));
      expect(older).toEqual([]);
    }
  });

  it('lists skipped agents with a reason', () => {
    expect(r({ tier: 'daily' }).skipped).toContainEqual({ agent: 'muse', reason: 'not installed' });
    expect(r({ tier: 'daily', agents: ['claude'] }).skipped).toContainEqual({ agent: 'codex', reason: 'excluded by request' });
    expect(r({ tier: 'daily', excludeAgents: ['cursor'] }).skipped).toContainEqual({ agent: 'cursor', reason: 'excluded by request' });
    expect(route({ tier: 'daily' }, env, { ...DEFAULT_CONFIG, denyAgents: ['codex'] }).skipped).toContainEqual({ agent: 'codex', reason: 'excluded by config' });
    expect(route({ tier: 'daily' }, env, { ...DEFAULT_CONFIG, allowAgents: ['claude'] }).skipped).toContainEqual({ agent: 'cursor', reason: 'excluded by config' });
    const signedOut = withUsageStatus({ ...env, usage: { ...env.usage, codex: { ...env.usage.codex, error: 'login required' } } }, 'unavailable', ['codex']);
    expect(route({ tier: 'daily' }, signedOut, DEFAULT_CONFIG).skipped).toContainEqual({ agent: 'codex', reason: 'not signed in or unavailable: login required' });
  });

  it('Claude-only view picks Opus at high for Frontier', () => {
    expect(r({ tier: 'frontier', agents: ['claude'] }).route).toEqual({ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  });

  it('does not downgrade to Sonnet when the Frontier pool is exhausted', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100 });
    const d = route({ needs: fableNeeds, agents: claude }, blocked, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'decide', downgraded: false });
    expect(d.options!.lower.map((l) => l.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(d.reasons).toContain('LOWER: claude claude-sonnet-5-5 takes the job with lower requirements: below need on agentic (78.2 < 80) (weekly 51.75% prospective, available)');
  });

  it('does not lower the effort when it goes up a tier', () => {
    const d = route({ tier: 'light', agents: ['claude'], demand: 'high' }, onlyModels(env, 'claude', ['claude-opus-5-5']), DEFAULT_CONFIG);
    expect(d).toMatchObject({ tier: 'advanced', upgraded: true, route: { effort: 'high' } });
  });

  it('offers WAIT with the earliest reset that frees an eligible route', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100 });
    const d = route({ needs: fableNeeds, agents: claude }, blocked, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'decide', downgraded: false, upgraded: false, options: { wait: { until: 1793282400000 }, use: [], lower: [] } });
    expect(d.route).toBeUndefined();
    expect(d.alternatives).toContainEqual(expect.objectContaining({ agent: 'claude', model: 'claude-fable-5-1', blocked: true }));
  });

  it('#4 names no waiting time when the quota reports no reset', () => {
    const noReset = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100, resetsAt: null });
    const d = route({ needs: fableNeeds, agents: claude }, noReset, DEFAULT_CONFIG);
    expect(d.status).toBe('decide');
    expect(d.options!.wait).toEqual({ reason: 'no reset time is reported for the quota holding these routes back' });
    expect(d.reasons).toContain('WAIT: no reset time is reported for the quota holding these routes back');
    expect(d.reasons[0]).toContain('fableWeekly 100% prospective, exhausted');
    // A valid 0% without a reset time is simply available: the window has not started.
    const unstarted = withPool(env, 'claude', 'session', { usedPercent: 0, resetsAt: null });
    const ok = route({ tier: 'daily', agents: claude }, unstarted, DEFAULT_CONFIG);
    expect(ok).toMatchObject({ status: 'ok', confidence: 'high', warnings: [] });
    expect(bucketOf(ok, 'session')).toMatchObject({ reported: 0, prospective: 1.5, prospectiveStatus: 'available', resetsAt: null });
    expect(ok.reasons[0]).toContain('session 0% reported + 1.5 pp for this worker = 1.5% prospective (available), no reset time reported');
  });

  it('hands a top/top/top job at 96% to the Orchestrator, and offers no USE at actual exhaustion', () => {
    const req = { needs: { coding: 'top', agentic: 'top', reasoning: 'top' } as const, agents: ['claude', 'codex'] };
    const pair = onlyModels(onlyModels(env, 'claude', ['claude-opus-5-5']), 'codex', ['gpt-6-astra']);
    const nearlyFull = withPool(pair, 'claude', 'weekly', { usedPercent: 96 });
    const risky = route(req, nearlyFull, DEFAULT_CONFIG);
    expect(risky).toMatchObject({ status: 'decide', options: { use: [{ agent: 'claude', model: 'claude-opus-5-5', reason: 'weekly 98.5% prospective, high risk' }], lower: [{ agent: 'codex', model: 'gpt-6-astra' }] } });
    expect(route({ ...req, use: { agent: 'claude', model: 'claude-opus-5-5' } }, nearlyFull, DEFAULT_CONFIG)).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'claude-opus-5-5' } });
    const exhausted = withPool(nearlyFull, 'claude', 'weekly', { usedPercent: 100 });
    expect(route(req, exhausted, DEFAULT_CONFIG)).toMatchObject({
      status: 'decide', options: { wait: { until: exhausted.usage.claude.pools.weekly.resetsAt }, use: [], lower: [{ agent: 'codex', model: 'gpt-6-astra' }] },
    });
    const both = route(req, withPool(exhausted, 'codex', 'weekly', { usedPercent: 100 }), DEFAULT_CONFIG);
    expect(both).toMatchObject({ status: 'decide', options: { use: [], lower: [] } });
  });

  it('routes a top need only to models at or above the top cuts, and reports it as frontier', () => {
    const d = r({ needs: { coding: 'top', agentic: 'top', reasoning: 'top' } });
    // Opus 5.5 (87.4/82/90.6) reaches every top cut; Astra and Fable 5.1 are high but not top.
    expect(d).toMatchObject({ status: 'ok', requestedTier: 'frontier', route: { agent: 'cursor', model: 'claude-opus-5-5-high' } });
    expect(d.reasons.join(' ')).toContain('needs coding=top agentic=top reasoning=top; eligible routes:');
    expect(d.skipped).toContainEqual({ agent: 'codex', model: 'gpt-6-astra', reason: 'below need on coding (83.9 < 87)' });
  });

  it('Codex-only Advanced: the cheaper covering Terra before Sol, not up to Astra', () => {
    expect(r({ tier: 'advanced', agents: ['codex'] })).toMatchObject({
      tier: 'daily', downgraded: false, upgraded: false, route: { model: 'gpt-6.1-terra', effort: 'medium' },
    });
  });

  it('goes up a tier only when nothing is installed at or below the requested tier', () => {
    const d = route({ tier: 'light', agents: ['claude'] }, onlyModels(env, 'claude', ['claude-opus-5-5']), DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', tier: 'advanced', upgraded: true, downgraded: false, route: { model: 'claude-opus-5-5' } });
    expect(d.warnings).toContain('no model in the light cost tier covers the job; using advanced');
  });

  it('answers with low confidence when usage is unknown', () => {
    const d = route({ tier: 'daily' }, withUsageStatus(env, 'unknown'), DEFAULT_CONFIG);
    expect(d.status).toBe('ok');
    expect(d.confidence).toBe('low');
    expect(d.reasons[0]).toMatch(/usage unknown/);
    expect(d.quota).toMatchObject({ status: 'unknown', binding: null, prospective: null, buckets: [] });
    // With nothing to rank by, the cheapest eligible route is taken, and the missing quota check is said out loud.
    expect(d.route).toEqual({ agent: 'codex', model: 'gpt-6.1-terra', effort: 'medium' });
    expect(d.warnings).toContain('usage of codex is unknown: usage unknown (Orca not reachable); routed without a quota check');
    expect(d.alternatives.every((a) => a.quota?.status === 'unknown' && a.confidence === 'low')).toBe(true);
  });

  it('#3 reads a window that reset since the snapshot as unknown, not as full or empty', () => {
    const fable = onlyModels(env, 'claude', ['claude-fable-5-1']);
    const expired = withUsageUpdatedAt(withPool(fable, 'claude', 'fableWeekly', { resetsAt: env.now - 1, usedPercent: 99 }), env.now - 60_000);
    const d = route({ needs: fableNeeds, agents: claude }, expired, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', confidence: 'low', route: { model: 'claude-fable-5-1' }, quota: { status: 'unknown' } });
    expect(bucketOf(d, 'fableWeekly')).toMatchObject({ reported: null, prospective: null, prospectiveStatus: 'unknown' });
    expect(d.reasons[0]).toContain('fableWeekly usage unknown: the window reset after the last snapshot');
    // Session and weekly are still known, so the check was incomplete rather than missing.
    expect(d.warnings).toContain('usage of claude is unknown: fableWeekly: usage unknown: the window reset after the last snapshot; routed without a complete quota check');
    // Usage Orca did not report is unknown as well; with a route of known usage around, that one is taken.
    const missing = withPool(env, 'claude', 'weekly', { usedPercent: null });
    const known = route({ tier: 'daily', agents: ['claude', 'codex'] }, withPool(missing, 'codex', 'weekly', { usedPercent: 88 }), DEFAULT_CONFIG);
    expect(known).toMatchObject({ route: { agent: 'codex' }, quota: { status: 'caution' } });
    expect(known.alternatives.find((a) => a.agent === 'claude')).toMatchObject({ confidence: 'low', blocked: false, quota: { status: 'unknown' } });
  });

  it('honors preferences, explicit effort and denied agents', () => {
    const pinned: Config = { ...DEFAULT_CONFIG, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } };
    const d = route({ tier: 'daily' }, env, pinned);
    expect(d.route?.agent).toBe('codex');
    expect(d.reasons).toContain('preferred route, available');
    expect(r({ tier: 'daily', effort: 'high' }).route).toEqual({ agent: 'cursor', model: 'claude-sonnet-5-5-high', effort: null });
    expect(r({ tier: 'daily', effort: 'high', agents: claude }).route?.effort).toBe('high');
    expect(route({ tier: 'frontier' }, env, { ...DEFAULT_CONFIG, denyAgents: ['cursor'] }).route?.agent).toBe('claude');
  });

  it('falls back to automatic choice when the preferred model is exhausted', () => {
    const pinned: Config = { ...DEFAULT_CONFIG, preferRiskLimit: 100, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } };
    const d = route({ tier: 'daily' }, withPool(env, 'codex', 'weekly', { usedPercent: 100 }), pinned);
    expect(d.route?.agent).toBe('cursor');
    expect(d.warnings).toContain('preferred codex gpt-6.1-terra skipped: quota exhausted (weekly 100% used, resets in 5d)');
  });

  it('applies an explicit effort exactly, through the flag or the Cursor variant', () => {
    const d = r({ tier: 'frontier', agents: ['cursor'], effort: 'max' });
    expect(d.route).toEqual({ agent: 'cursor', model: 'claude-opus-5-5-max', effort: null });
    expect(d.effort).toEqual({
      source: 'explicit', target: 'max', resolved: 'max', applied: 'model-id', adjusted: false, supportSource: 'unknown',
    });
    expect(d.reasons).toContain('effort: max from request, chosen through the model id');
    expect(route({ tier: 'light', agents: ['codex'], effort: 'none' }, env, DEFAULT_CONFIG).route?.effort).toBe('none');
  });

  it('never snaps an explicit effort: routes that cannot apply it are left out', () => {
    // Codex Luna offers none, Claude Haiku does not: the explicit effort leaves only Codex.
    expect(r({ tier: 'light', agents: ['claude', 'codex'], effort: 'none' }).route).toEqual({ agent: 'codex', model: 'gpt-6-luna', effort: 'none' });
    const d = route({ tier: 'light', agents: claude, effort: 'none' }, env, DEFAULT_CONFIG);
    expect(d.status).toBe('decide');
    expect(d.route).toBeUndefined();
    expect(d.reasons[0]).toContain('no light route supports effort none: claude claude-haiku-5-5 (low/medium/high/xhigh/max)');
    expect(d.options!.lower[0]).toMatchObject({ agent: 'claude', model: 'claude-haiku-5-5', shortfall: 'does not support effort none (low/medium/high/xhigh/max)' });
  });

  it('follows the effort demand through the effort policy, independent of the tier', () => {
    const c = (req: RouteRequest, config: Config = DEFAULT_CONFIG) => route({ ...req, agents: claude }, env, config);
    // A Light model at high effort is fine when its capabilities meet the needs.
    const light = c({ tier: 'light', demand: 'high' });
    expect(light.route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'high' });
    expect(light.effort).toMatchObject({ source: 'demand', demand: 'high', policy: 'balanced', target: 'high', resolved: 'high', applied: 'flag' });
    expect(light.reasons).toContain('effort: high from high effort demand (balanced policy), passed as --effort');
    expect(c({ tier: 'frontier', demand: 'low' }).effort).toMatchObject({ target: 'low', resolved: 'low' });
    expect(c({ tier: 'daily', demand: 'exceptional' }).route?.effort).toBe('xhigh');
    const quality: Config = { ...DEFAULT_CONFIG, effortPolicy: 'quality' };
    expect(c({ tier: 'daily', demand: 'high' }, quality).route?.effort).toBe('xhigh');
    const efficient: Config = { ...DEFAULT_CONFIG, effortPolicy: 'efficient' };
    expect(c({ tier: 'daily', demand: 'exceptional' }, efficient).route?.effort).toBe('high');
    expect(c({ tier: 'daily', demand: 'low' }, quality).route?.effort).toBe('low');
    // An explicit effort wins over the demand.
    expect(c({ tier: 'daily', demand: 'low', effort: 'high' }).effort).toMatchObject({ source: 'explicit', target: 'high' });
    // The effort sets the size of the reservation: Haiku at high reserves 1.25 pp, at low 0.5 pp.
    expect(bucketOf(light, 'weekly')).toMatchObject({ buffer: 1.25 });
    expect(bucketOf(c({ tier: 'light' }), 'weekly')).toMatchObject({ buffer: 0.5 });
  });

  it('falls back to the requested tier\'s default effort and reports how it is applied', () => {
    const d = r({ tier: 'daily', agents: claude });
    expect(d.effort).toEqual({
      source: 'tier-default', target: 'medium', resolved: 'medium', applied: 'flag', adjusted: false, supportSource: 'unknown',
    });
    expect(d.reasons).toContain('effort: medium from tier default, passed as --effort');
  });

  it('uses the provider\'s own effort scale: the next higher level it offers, never a level it lacks', () => {
    const one = onlyModels(env, 'claude', ['claude-sonnet-5-5']);
    const withEfforts = (efforts: Effort[], defaultEffort?: Effort): Environment => ({
      ...one,
      discoveries: one.discoveries.map((d) => (d.agent === 'claude'
        ? { ...d, models: d.models.map((m) => ({ ...m, efforts, effortSource: 'provider' as const, ...(defaultEffort ? { defaultEffort } : {}) })) }
        : d)),
    });
    const lowHigh = withEfforts(['low', 'high'], 'high');
    // medium is not offered: high satisfies it, low would not.
    const d = route({ tier: 'daily', agents: claude, demand: 'moderate' }, lowHigh, DEFAULT_CONFIG);
    expect(d.route?.effort).toBe('high');
    expect(d.effort).toMatchObject({ target: 'medium', resolved: 'high', adjusted: true, supportSource: 'provider', providerDefault: 'high' });
    expect(d.reasons).toContain('effort: high from moderate effort demand (balanced policy) (medium not offered, next higher supported), passed as --effort');
    // A tier default is a preference, not a demand: with nothing at or above it, the nearest level is used.
    const onlyLow = route({ tier: 'daily', agents: claude }, withEfforts(['low']), DEFAULT_CONFIG);
    expect(onlyLow.effort).toMatchObject({ source: 'tier-default', target: 'medium', resolved: 'low', adjusted: true });
    expect(onlyLow.reasons).toContain('effort: low from tier default (medium not offered, nearest supported), passed as --effort');
    // The same model does not satisfy a moderate demand.
    expect(route({ tier: 'daily', agents: claude, demand: 'moderate' }, withEfforts(['low']), DEFAULT_CONFIG)).toMatchObject({
      status: 'decide', options: { lower: [{ shortfall: 'highest effort low is below medium (low)' }] },
    });
    // An agent that sets the effort itself satisfies a demand up to its reported default.
    const own = withEfforts([], 'high');
    const unset = route({ tier: 'daily', agents: claude }, own, DEFAULT_CONFIG);
    expect(unset.launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-sonnet-5-5']);
    expect(unset.effort).toMatchObject({ resolved: null, applied: 'provider-default' });
    expect(unset.reasons).toContain('effort: not set, claude uses its own default (high); medium wanted from tier default');
    expect(route({ tier: 'daily', agents: claude, demand: 'high' }, own, DEFAULT_CONFIG).status).toBe('ok');
    expect(route({ tier: 'daily', agents: claude, demand: 'exceptional' }, own, DEFAULT_CONFIG).options!.lower[0].shortfall)
      .toBe('effort cannot be set (claude decides, default high); xhigh needed');
    // With no default reported it can be trusted with the lowest demand only.
    const unknown = withEfforts([]);
    expect(route({ tier: 'daily', agents: claude, demand: 'low' }, unknown, DEFAULT_CONFIG).status).toBe('ok');
    expect(route({ tier: 'daily', agents: claude, demand: 'moderate' }, unknown, DEFAULT_CONFIG).options!.lower[0].shortfall)
      .toBe('effort cannot be set (claude decides, default not reported); medium needed');
    // #10a A known default of none or minimal is below a low demand: only an unreported default is trusted with it.
    for (const own of ['none', 'minimal'] as const) {
      const d = route({ tier: 'daily', agents: claude, demand: 'low' }, withEfforts([], own), DEFAULT_CONFIG);
      expect(d.status).toBe('decide');
      expect(d.options!.lower[0].shortfall).toBe(`effort cannot be set (claude decides, default ${own}); low needed`);
    }
    expect(route({ tier: 'daily', agents: claude, demand: 'low' }, withEfforts([], 'low'), DEFAULT_CONFIG).status).toBe('ok');
    // Without a demand the tier default is a preference only: a none default is still routed.
    expect(route({ tier: 'daily', agents: claude }, withEfforts([], 'none'), DEFAULT_CONFIG).status).toBe('ok');
  });

  it('#10b --use with an effort-variant id launches that variant and reserves at its effort', () => {
    const daily = { tier: 'daily' as const, agents: ['cursor'] };
    const use = (model: string) => ({ agent: 'cursor', model });
    const high = planRoute({ ...daily, use: use('claude-sonnet-5-5-high') }, env, DEFAULT_CONFIG);
    expect(high.decision).toMatchObject({
      status: 'ok', route: { agent: 'cursor', model: 'claude-sonnet-5-5-high', effort: null },
      launchArgs: ['--agent', 'cursor', '--model', 'claude-sonnet-5-5-high'],
      effort: { source: 'tier-default', target: 'medium', resolved: 'high', applied: 'model-id' },
    });
    expect(high.decision.reasons).toContain('effort: high, encoded in the model id named by --use; medium wanted from tier default');
    expect(high.decision.warnings).toEqual([]);
    // The reservation is in the high column of the Daily row (1.75 pp), not the tier default's medium (1.5 pp).
    expect(high.reserve).toMatchObject({ model: 'claude-sonnet-5-5-high', tier: 'daily', effort: 'high' });
    expect(bucketOf(high.decision, 'bucket:Other Models').buffer).toBe(DEFAULT_CONFIG.reservations.buffers.daily.high);
    // The base id is unchanged: the tier default picks the variant.
    const base = planRoute({ ...daily, use: use('claude-sonnet-5-5') }, env, DEFAULT_CONFIG);
    expect(base.decision).toMatchObject({ route: { model: 'claude-sonnet-5-5-medium' }, effort: { resolved: 'medium', applied: 'model-id' } });
    expect(base.decision.reasons).toContain('effort: medium from tier default, chosen through the model id');
    expect(base.reserve).toMatchObject({ model: 'claude-sonnet-5-5-medium', effort: 'medium' });
    // An explicit --effort the named variant disagrees with: the variant still runs, with a warning.
    const low = route({ ...daily, effort: 'low', use: use('claude-sonnet-5-5-high') }, env, DEFAULT_CONFIG);
    expect(low).toMatchObject({ status: 'ok', route: { model: 'claude-sonnet-5-5-high' }, effort: { source: 'explicit', target: 'low', resolved: 'high' } });
    expect(low.reasons).toContain('effort: high, encoded in the model id named by --use; low wanted from request');
    expect(low.warnings).toContain('claude-sonnet-5-5 runs at effort high encoded in claude-sonnet-5-5-high, not the requested low');
    // A variant below the demand: the same.
    const demanded = route({ ...daily, demand: 'exceptional', use: use('claude-sonnet-5-5-low') }, env, DEFAULT_CONFIG);
    expect(demanded).toMatchObject({ status: 'ok', route: { model: 'claude-sonnet-5-5-low' }, effort: { target: 'xhigh', resolved: 'low' } });
    expect(demanded.warnings).toContain('claude-sonnet-5-5 runs at effort low encoded in claude-sonnet-5-5-low, below xhigh needed for the exceptional demand');
    // A variant at or above the demand satisfies it without a warning.
    expect(route({ ...daily, demand: 'high', use: use('claude-sonnet-5-5-xhigh') }, env, DEFAULT_CONFIG)).toMatchObject({ route: { model: 'claude-sonnet-5-5-xhigh' }, warnings: [] });
  });

  it('returns none when no agent is usable', () => {
    const d = route({ tier: 'daily' }, withUsageStatus(env, 'unavailable'), DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'none', requestedTier: 'daily', downgraded: false, upgraded: false });
    expect(d.route).toBeUndefined();
    expect(d.skipped).toHaveLength(4);
    expect(formatLaunch(d)).toBeUndefined();
  });

  it('excludes NO ZDR models only when configured', () => {
    const noZdr = { ...env, discoveries: env.discoveries.map((d) => d.agent !== 'cursor' ? d : { ...d, models: d.models.map((m) => ({ ...m, noZdr: true })) }) };
    expect(route({ tier: 'frontier', excludeAgents: ['claude'] }, noZdr, DEFAULT_CONFIG).route?.agent).toBe('cursor');
    expect(route({ tier: 'frontier', excludeAgents: ['claude'] }, noZdr, { ...DEFAULT_CONFIG, excludeNoZdr: true })).toMatchObject({ status: 'decide', options: { lower: expect.arrayContaining([expect.objectContaining({ agent: 'codex', model: 'gpt-6-astra', shortfall: 'below need on coding (83.9 < 84)' })]) } });
  });

  it('explains the pick with every quota it draws on, and names the runner-up and skipped agents', () => {
    const d = r({ tier: 'daily', excludeAgents: ['claude'] });
    // The binding bucket (least room left) first, then the route's other window.
    expect(d.reasons[0]).toBe('cursor claude-sonnet-5-5-medium: Other Models 6.25% reported + 1.5 pp for this worker = 7.75% prospective (available), resets in 22d; monthly 2.5% reported + 1.5 pp for this worker = 4% prospective (available), resets in 22d');
    expect(d.reasons.find((line) => line.startsWith('selection:')))
      .toBe('selection: quota bucket cursor Other Models has 93.75% effective capacity left (bucket 1 of 2 with an eligible route); most economical eligible route in it below the 85% caution threshold');
    expect(d.reasons.find((line) => line.startsWith('next best:'))).toBe('next best: cursor claude-opus-5-5-medium (Other Models 8.25% prospective, available, $8.00/M blended)');
    expect(d.skipped).toContainEqual({ agent: 'muse', reason: 'not installed' });
    expect(d.alternatives[0]).toMatchObject({ agent: 'cursor', model: 'claude-opus-5-5-medium', blocked: false });
    // Reported, reserved, effective and prospective usage are kept apart for every bucket.
    expect(d.quota).toMatchObject({ status: 'available', binding: 'cursor:default:bucket:other models', remaining: 93.75, prospective: 7.75 });
    expect(bucketOf(d, 'bucket:Other Models')).toMatchObject({ reported: 6.25, reserved: 0, workers: 0, effective: 6.25, buffer: 1.5, prospective: 7.75, prospectiveStatus: 'available' });
    expect(d.alternatives.find((a) => a.model === 'gpt-6.1-terra')?.quota).toMatchObject({ binding: 'codex:default:weekly', remaining: 80, prospective: 21.5 });
  });

  it('is deterministic', () => {
    expect(r({ tier: 'frontier' })).toEqual(r({ tier: 'frontier' }));
    expect(JSON.stringify(route({ tier: 'daily' }, withUsageStatus(env, 'unknown'), DEFAULT_CONFIG)))
      .toBe(JSON.stringify(route({ tier: 'daily' }, withUsageStatus(env, 'unknown'), DEFAULT_CONFIG)));
  });
});

describe('ranking by remaining capacity', () => {
  it('#2 with every provider at 0% routes normally, without a cold-start penalty', () => {
    let fresh = env;
    for (const [agent, u] of Object.entries(env.usage)) for (const name of Object.keys(u.pools)) fresh = withPool(fresh, agent, name, { usedPercent: 0 });
    const d = route({ tier: 'daily' }, fresh, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', confidence: 'high', warnings: [], quota: { status: 'available', remaining: 100, prospective: 1.5 } });
    expect(d.buckets!.every((b) => b.reported === 0 && b.effective === 0 && b.status === 'available')).toBe(true);
    // Every bucket is equally free, so the order is the fixed bucket order and the cheapest route in it.
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(route({ tier: 'light' }, fresh, DEFAULT_CONFIG).route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
    // Where a window stands in time changes nothing: usage is not extrapolated.
    const justStarted = withPool(withPool(fresh, 'claude', 'weekly', { resetsAt: env.now + 7 * 86_400_000 - 60_000 }), 'claude', 'session', { resetsAt: env.now + 299 * 60_000 });
    const nearlyOver = withPool(withPool(fresh, 'claude', 'weekly', { resetsAt: env.now + 60_000 }), 'claude', 'session', { resetsAt: env.now + 60_000 });
    for (const e of [justStarted, nearlyOver]) expect(route({ tier: 'daily' }, e, DEFAULT_CONFIG)).toMatchObject({ status: 'ok', warnings: [], route: d.route, quota: { status: 'available' } });
  });

  it('#15 ranks a route by its most restrictive window', () => {
    // Claude's weekly is nearly empty, but its session is at 70%: 30% left binds it, behind Codex's 80%.
    const hot = withPool(withPool(env, 'claude', 'session', { usedPercent: 70 }), 'claude', 'weekly', { usedPercent: 10 });
    const d = route({ tier: 'advanced', agents: ['claude', 'codex'] }, hot, DEFAULT_CONFIG);
    expect(d.route?.agent).toBe('codex');
    expect(d.alternatives.find((a) => a.agent === 'claude')?.quota).toMatchObject({ binding: 'claude:default:session', remaining: 30, prospective: 71.5, status: 'available' });
    // A full session blocks every Claude model, however empty the weekly is.
    const full = route({ tier: 'advanced', agents: claude }, withPool(hot, 'claude', 'session', { usedPercent: 100 }), DEFAULT_CONFIG);
    expect(full.status).toBe('decide');
    expect(full.reasons[0]).toMatch(/^no eligible route is below the 90% risk threshold: claude claude-sonnet-5-5 \(session 100% prospective, exhausted\)/);
    expect(full.options!.wait!.until).toBe(env.usage.claude.pools.session.resetsAt);
  });

  it('#30 passes over a route whose reservation crosses the threshold for a smaller one in the same bucket', () => {
    // 83.2% reported: Sonnet's 1.5 pp stays below 85%, Opus (2 pp) and Fable (2.5 pp) would cross it.
    const e = withPool(withPool(env, 'claude', 'weekly', { usedPercent: 83.2 }), 'codex', 'weekly', { usedPercent: 84 });
    const d = route({ tier: 'advanced', agents: ['claude', 'codex'] }, e, DEFAULT_CONFIG);
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(d.quota).toMatchObject({ status: 'available', prospective: 84.7 });
    expect(d.warnings).toEqual([]);
    expect(d.alternatives.map((a) => [a.model, a.quota!.status, a.quota!.prospective])).toEqual([
      ['claude-opus-5-5', 'caution', 85.2], ['claude-fable-5-1', 'caution', 85.7], ['gpt-6.1-terra', 'caution', 85.5], ['gpt-6.1-sol', 'caution', 85.5], ['gpt-6-astra', 'caution', 86.5],
    ]);
    // Without Sonnet nothing is below 85%: the bucket with the most room is used in the caution range, with a warning.
    const caution = route({ tier: 'advanced', agents: ['claude', 'codex'] }, e, { ...DEFAULT_CONFIG, banModels: ['claude-sonnet'] });
    expect(caution).toMatchObject({ status: 'ok', route: { agent: 'claude', model: 'claude-opus-5-5' }, quota: { status: 'caution' } });
    expect(caution.warnings).toEqual(['weekly quota would be 85.2% used with this worker (caution); resets in 14h']);
    expect(caution.reasons.find((line) => line.startsWith('selection:'))).toContain('in the caution range (no route is below 85%)');
  });

  it('#10c describes a known caution bucket by its own status and names the windows that could not be read', () => {
    // Other Models is known (84% + 1.5 pp = 85.5%, caution); monthly is not reported, so the route counts as unknown.
    const one = onlyModels(env, 'cursor', ['claude-sonnet-5-5']);
    const e = withPool(withPool(one, 'cursor', 'bucket:Other Models', { usedPercent: 84 }), 'cursor', 'monthly', { usedPercent: null });
    const d = route({ tier: 'daily', agents: ['cursor'] }, e, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', route: { model: 'claude-sonnet-5-5-medium' }, quota: { status: 'unknown', binding: 'cursor:default:bucket:other models' } });
    expect(bucketOf(d, 'bucket:Other Models')).toMatchObject({ prospective: 85.5, prospectiveStatus: 'caution' });
    const selection = d.reasons.find((line) => line.startsWith('selection:'))!;
    expect(selection).toBe('selection: quota bucket cursor Other Models has 16% effective capacity left (bucket 1 of 1 with an eligible route); '
      + 'most economical eligible route in it in the caution range; 1 other window could not be read (monthly), so the route counts as unknown');
    expect(selection).not.toContain('no route is below');
    expect(d.warnings).toContainEqual(expect.stringMatching(/^usage of cursor is unknown: .*; routed without a complete quota check$/));
    // A known available bucket next to an unreadable one is described as available.
    const available = route({ tier: 'daily', agents: ['cursor'] }, withPool(one, 'cursor', 'monthly', { usedPercent: null }), DEFAULT_CONFIG);
    expect(available.reasons.find((line) => line.startsWith('selection:'))).toContain('in it below the 85% caution threshold; 1 other window could not be read (monthly), so the route counts as unknown');
    // With no window known at all the warning keeps saying there was no quota check.
    const none = route({ tier: 'daily', agents: ['cursor'] }, withPool(e, 'cursor', 'bucket:Other Models', { usedPercent: null }), DEFAULT_CONFIG);
    expect(none.warnings).toContainEqual(expect.stringMatching(/^usage of cursor is unknown: .*; routed without a quota check$/));
  });

  it('#26 prefers another bucket once this worker would take a bucket into the caution range', () => {
    // Claude at 84% is still "available" as it stands; with one more worker it is not.
    const e = withPool(withPool(env, 'claude', 'weekly', { usedPercent: 84 }), 'codex', 'weekly', { usedPercent: 84.5 });
    const d = route({ tier: 'light', agents: ['claude', 'codex'] }, e, DEFAULT_CONFIG);
    expect(d.buckets!.filter((b) => b.pool === 'weekly').map((b) => [b.agent, b.status])).toEqual([['claude', 'available'], ['codex', 'available']]);
    // Haiku (0.5 pp) keeps Claude's fuller-capacity bucket below 85%, so it is taken first.
    expect(d).toMatchObject({ route: { agent: 'claude', model: 'claude-haiku-5-5' }, quota: { status: 'available', prospective: 84.5 } });
    // A Daily job needs Sonnet (1.5 pp → 85.5%) or Codex Terra (1.5 pp → 86%): both caution, the roomier bucket wins.
    expect(route({ tier: 'daily', agents: ['claude', 'codex'] }, e, DEFAULT_CONFIG)).toMatchObject({ route: { agent: 'claude' }, quota: { status: 'caution', prospective: 85.5 } });
    // With a third bucket that stays available, the caution buckets are passed over.
    expect(route({ tier: 'daily' }, e, DEFAULT_CONFIG)).toMatchObject({ route: { agent: 'cursor' }, quota: { status: 'available' } });
  });

  it('applies configurable risk thresholds', () => {
    const strict: Config = { ...DEFAULT_CONFIG, riskThresholds: { cautionPercent: 40, highPercent: 51 } };
    // Claude weekly 50% + 1.5 pp = 51.5%: high risk under these thresholds, so Claude alone needs a decision.
    expect(route({ tier: 'daily', agents: claude }, env, strict)).toMatchObject({ status: 'decide', options: { use: [{ reason: 'weekly 51.5% prospective, high risk' }, {}, {}] } });
    expect(route({ tier: 'daily', agents: claude }, env, { ...strict, riskThresholds: { cautionPercent: 40, highPercent: 60 } })).toMatchObject({ status: 'ok', quota: { status: 'caution' } });
    expect(route({ tier: 'daily', agents: claude }, env, DEFAULT_CONFIG)).toMatchObject({ status: 'ok', quota: { status: 'available' } });
  });

  it('tells a fully reserved quota from an exhausted one', () => {
    const reservation = (id: string): Reservation => ({
      id, state: 'running', agent: 'claude', model: 'claude-fable-5-1', tier: 'frontier', effort: 'high', scope: 'default', pools: ['session', 'weekly'], createdAt: env.now, snapshotAt: env.now,
    });
    const reserved = { ...withPool(env, 'claude', 'weekly', { usedPercent: 94 }), reservations: [reservation('rsv_1'), reservation('rsv_2')] };
    const d = route({ tier: 'daily', agents: claude }, reserved, DEFAULT_CONFIG);
    // 94% reported + 6 pp reserved = 100% effective: unavailable for normal routing, but nothing is actually used up.
    expect(d.status).toBe('decide');
    expect(d.buckets!.find((b) => b.pool === 'weekly')).toMatchObject({ reported: 94, reserved: 6, workers: 2, effective: 100, status: 'reserved' });
    expect(d.options!.use[0]).toMatchObject({ model: 'claude-sonnet-5-5', reason: 'weekly 100% prospective, fully reserved' });
    expect(d.options!.wait!.reason).toBe('the earliest quota reset is in 14h; up to 6 pp is temporarily reserved for allocated workers and frees with a fresh usage snapshot after they finish');
    expect(route({ tier: 'daily', agents: claude, use: { agent: 'claude', model: 'claude-sonnet-5-5' } }, reserved, DEFAULT_CONFIG).status).toBe('ok');
    const exhausted = route({ tier: 'daily', agents: claude }, withPool(env, 'claude', 'weekly', { usedPercent: 100 }), DEFAULT_CONFIG);
    expect(exhausted.buckets!.find((b) => b.pool === 'weekly')).toMatchObject({ status: 'exhausted' });
    expect(exhausted.options!.use).toEqual([]);
    expect(exhausted.alternatives.every((a) => a.blocked)).toBe(true);
  });

  it('#13 #14 counts a worker against the quota its models share, and against no other', () => {
    const fableWorker: Reservation = {
      id: 'rsv_1', state: 'running', agent: 'claude', model: 'claude-fable-5-1', tier: 'frontier', effort: 'medium', scope: 'default', pools: ['session', 'weekly', 'fableweekly'], createdAt: env.now, snapshotAt: env.now,
    };
    const d = route({ tier: 'advanced', agents: ['claude', 'codex'] }, { ...env, reservations: [fableWorker, { ...fableWorker, id: 'rsv_2' }] }, DEFAULT_CONFIG);
    const quotaOf = (model: string) => [d, ...d.alternatives].find((x) => ('route' in x ? x.route?.model : x.model) === model)!.quota!;
    // Sonnet, Opus and Fable all see the two Fable workers on the weekly quota they share: 50% + 5 pp.
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      expect(quotaOf(model).buckets.find((b) => b.pool === 'weekly'), model).toMatchObject({ reported: 50, reserved: 5, workers: 2, effective: 55 });
    }
    expect(quotaOf('claude-fable-5-1').buckets.find((b) => b.pool === 'fableWeekly')).toMatchObject({ reported: 75, reserved: 5, effective: 80 });
    // Codex has its own quota: untouched.
    expect(quotaOf('gpt-6.1-terra').buckets[0]).toMatchObject({ reported: 20, reserved: 0, effective: 20 });
    expect(d.reasons.join('\n') + d.alternatives.map((a) => a.reason).join('\n')).toContain('weekly 50% reported + 5 pp reserved (2 workers) + 1.5 pp for this worker = 56.5% prospective (available)');
  });
});

describe('stale usage (graduated)', () => {
  it('31-minute-old usage still counts: an exhausted Fable is not routed', () => {
    const stale = withUsageUpdatedAt(withPool(onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100 }), env.now - 31 * 60_000, ['claude']);
    const d = route({ needs: fableNeeds, agents: claude }, stale, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'decide', options: { use: [] } });
  });

  it('45-minute-old usage keeps the ranking, drops confidence to medium and says how old it is', () => {
    const fresh = r({ tier: 'daily' });
    const d = route({ tier: 'daily' }, withUsageUpdatedAt(env, env.now - 45 * 60_000), DEFAULT_CONFIG);
    expect(d.route).toEqual(fresh.route);
    expect(d.confidence).toBe('medium');
    expect(d.reasons[0]).toBe(`${fresh.reasons[0]}; usage 45m old`);
    expect(d.alternatives.map((a) => a.quota!.prospective)).toEqual(fresh.alternatives.map((a) => a.quota!.prospective));
    expect(d.alternatives.every((a) => a.confidence === 'medium')).toBe(true);
    expect(d.buckets!.every((b) => b.stale && b.reported !== null)).toBe(true);
  });

  it('3-hour-old usage is unknown: routes with known usage come first, and nothing is assumed free or full', () => {
    const old = withUsageUpdatedAt(env, env.now - 3 * 3_600_000, ['claude']);
    expect(route({ tier: 'advanced', agents: ['claude', 'codex'] }, old, DEFAULT_CONFIG).route?.agent).toBe('codex');
    const d = route({ tier: 'daily', agents: claude }, old, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', confidence: 'low', route: { model: 'claude-sonnet-5-5' }, quota: { status: 'unknown', prospective: null } });
    expect(d.reasons[0]).toContain('weekly usage unknown: the last snapshot is 3h old');
    expect(d.buckets!.filter((b) => b.agent === 'claude').every((b) => b.reported === null && b.status === 'unknown')).toBe(true);
  });

  it('the staleness bands scale with usageStaleMinutes', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, usageStaleMinutes: 5 };
    const at = (min: number) => route({ tier: 'daily', agents: claude }, withUsageUpdatedAt(env, env.now - min * 60_000), cfg);
    expect(at(5).confidence).toBe('high');
    expect(at(6).confidence).toBe('medium');
    expect(at(20).confidence).toBe('medium');
    expect(at(21).confidence).toBe('low');
  });
});

describe('formatLaunch', () => {
  it('prefixes the launch args with the worker-start command', () => {
    expect(formatLaunch(r({ tier: 'frontier', agents: claude }))).toBe('orca orchestration worker-start --spec "<task>" --agent claude --model claude-opus-5-5 --effort high');
    expect(formatLaunch(r({ tier: 'daily' }))).toBe('orca orchestration worker-start --spec "<task>" --agent cursor --model claude-sonnet-5-5-medium');
  });

  it('is undefined when there is no route', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100 });
    expect(formatLaunch(route({ tier: 'frontier', agents: ['claude'] }, blocked, DEFAULT_CONFIG))).toBeUndefined();
  });
});

describe('Cursor auto is not a ranked model', () => {
  const auto = withCursorModels(env, [CURSOR_AUTO, cursorVariant('gpt-6-luna')], 20);

  it.each(['light', 'daily', 'advanced', 'frontier'] as const)('uses named models for %s when available', (tier) => {
    const decision = route({ tier, agents: ['cursor'] }, auto, DEFAULT_CONFIG);
    expect(decision.status).toBe('ok');
    expect(decision.route?.model).not.toBe('auto');
    expect(decision.alternatives.some((alternative) => alternative.model === 'auto')).toBe(false);
  });

  it('applies effort demand through the named model variants', () => {
    const decision = route({ tier: 'daily', agents: ['cursor'], demand: 'high' }, auto, DEFAULT_CONFIG);
    expect(decision.launchArgs).toEqual(['--agent', 'cursor', '--model', 'claude-sonnet-5-5-high']);
    expect(decision.effort).toMatchObject({ target: 'high', resolved: 'high', applied: 'model-id' });
  });

  it('keeps explicit effort support on named models', () => {
    expect(route({ tier: 'daily', agents: ['cursor'], effort: 'high' }, auto, DEFAULT_CONFIG).route).toEqual({ agent: 'cursor', model: 'claude-sonnet-5-5-high', effort: null });
  });

  it('compares named models with other agents by remaining capacity', () => {
    expect(route({ tier: 'advanced' }, auto, DEFAULT_CONFIG).route).toEqual({ agent: 'cursor', model: 'claude-sonnet-5-5-medium', effort: null });
    const decision = route({ tier: 'advanced' }, withPool(auto, 'cursor', 'bucket:Other Models', { usedPercent: 60 }), DEFAULT_CONFIG);
    expect(decision.route).toEqual({ agent: 'codex', model: 'gpt-6.1-terra', effort: 'medium' });
  });

  it.each([false, true])('keeps auto unranked with cursorAuto %s and an override', (cursorAuto) => {
    const config: Config = { ...DEFAULT_CONFIG, cursorAuto, tierOverrides: { auto: 'advanced' } };
    const profiles = placed(auto, { config });
    expect(profiles.discoveries.find((discovery) => discovery.agent === 'cursor')!.models.find((model) => model.modelId === 'auto')!.profile.class).toBeNull();
    expect(route({ tier: 'daily', agents: ['cursor'] }, profiles, config).route?.model).toBe('claude-sonnet-5-5-medium');
  });

  it('retains agent filters and model pins on named routes', () => {
    const excluded = route({ tier: 'advanced', excludeAgents: ['cursor'] }, withPool(auto, 'claude', 'weekly', { usedPercent: 85 }), DEFAULT_CONFIG);
    expect(excluded.route?.agent).toBe('codex');
    expect(excluded.alternatives.some((alternative) => alternative.agent === 'cursor')).toBe(false);
    const config: Config = { ...DEFAULT_CONFIG, pins: { advanced: { agent: 'cursor', model: 'claude-sonnet-5-5' } } };
    expect(route({ tier: 'advanced' }, auto, config).route?.model).toBe('claude-sonnet-5-5-medium');
  });
});

describe('Grok, Antigravity and Muse', () => {
  const grok47: LaunchModel = {
    agent: 'grok', modelId: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'],
    launch: { kind: 'flag', model: 'grok-4.7' }, poolNames: ['weekly', 'monthly'],
  };
  const grok45: LaunchModel = { ...grok47, modelId: 'grok-4.5', efforts: ['low', 'medium', 'high'], launch: { kind: 'flag', model: 'grok-4.5' } };
  const flash: LaunchModel = {
    agent: 'antigravity', modelId: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'],
    launch: { kind: 'variant', ids: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' } },
    poolNames: ['session', 'weekly'],
  };
  // Antigravity also serves Claude models; the family table places them as usual.
  const agySonnet: LaunchModel = {
    agent: 'antigravity', modelId: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high'],
    meta: { id: 'claude-sonnet-4-6', provider: 'anthropic', name: 'Claude Sonnet 4.6', family: 'claude-sonnet', releaseDate: '2026-02-17' },
    launch: { kind: 'flag', model: 'claude-sonnet-4-6' }, poolNames: ['session', 'weekly'],
  };
  // Overrides set cost only; explicit evidence keeps these launch/usage tests independent of day-0 inference.
  const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'grok-4.7': 'daily', 'grok-4.5': 'daily', 'gemini-3.8-flash': 'light' } };
  const weekly = (usedPercent: number, resetsAt: number) => ({ name: 'weekly', kind: 'long' as const, usedPercent, windowMinutes: 10080, resetsAt });
  const snapshot = parseSnapshot(fixture('evidence-mini.json'))!;
  for (const [id, provider, coding, agentic, reasoning] of [
    ['grok-4.7', 'x-ai', 80, 75, 82],
    ['grok-4.5', 'x-ai', 77, 72, 80],
    ['gemini-3.8-flash', 'google', 65, 55, 65],
  ] as const) {
    snapshot.models.push({
      id, aliases: [], provider, name: id, results: [],
      scores: Object.fromEntries(Object.entries({ coding, agentic, reasoning }).map(([axis, score]) => [axis, { score, benchmarks: 3, kind: 'measured' }])) as SnapshotModel['scores'],
    });
  }
  const ext: Environment = placed({
    ...env,
    discoveries: [
      ...env.discoveries,
      { agent: 'grok', installed: true, models: [grok47] },
      { agent: 'antigravity', installed: true, models: [flash, agySonnet] },
      { agent: 'muse', installed: true, models: [], note: 'no Muse models listed' },
    ],
    usage: {
      ...env.usage,
      // An hour before the weekly reset with 10% used: headroom 90%, more than any other agent.
      grok: { agent: 'grok', status: 'ok', updatedAt: env.now, pools: { weekly: weekly(10, env.now + 3_600_000) } },
      antigravity: {
        agent: 'antigravity', status: 'ok', updatedAt: env.now, pools: {
          session: { name: 'session', kind: 'session', usedPercent: 20, windowMinutes: 300, resetsAt: env.now + 3_600_000 },
          weekly: weekly(30, env.now + 3 * 86_400_000),
        },
      },
      muse: { agent: 'muse', status: 'unknown', pools: {}, error: 'Orca reports no usage for muse' },
    },
  }, { config, snapshot });
  const withUsage = (agent: string, patch: Partial<Environment['usage'][string]>): Environment =>
    ({ ...ext, usage: { ...ext.usage, [agent]: { ...ext.usage[agent], ...patch } } });

  it('launches Grok with --effort and an Antigravity Gemini variant with the effort in its id', () => {
    expect(route({ tier: 'advanced', agents: ['grok'] }, ext, config)).toMatchObject({
      status: 'ok', route: { agent: 'grok', model: 'grok-4.7', effort: 'medium' },
      launchArgs: ['--agent', 'grok', '--model', 'grok-4.7', '--effort', 'medium'],
    });
    expect(route({ tier: 'light', agents: ['antigravity'] }, ext, config)).toMatchObject({
      status: 'ok', route: { agent: 'antigravity', model: 'gemini-3.8-flash-low', effort: null },
      launchArgs: ['--agent', 'antigravity', '--model', 'gemini-3.8-flash-low'],
    });
    expect(route({ tier: 'daily', agents: ['antigravity'] }, ext, config).launchArgs)
      .toEqual(['--agent', 'antigravity', '--model', 'claude-sonnet-4-6', '--effort', 'medium']);
  });

  it('leaves out a Grok model whose highest effort is below the demand, and applies an Antigravity variant', () => {
    const only45 = placed({ ...ext, discoveries: ext.discoveries.map((d) => (d.agent === 'grok' ? { ...d, models: [grok45] } : d)) }, { config, snapshot });
    // quality policy: exceptional work wants xhigh, which Grok 4.5 does not offer.
    expect(route({ tier: 'advanced', agents: ['grok'], demand: 'exceptional' }, only45, { ...config, effortPolicy: 'quality' })).toMatchObject({
      status: 'decide', options: { lower: [{ agent: 'grok', model: 'grok-4.5', effort: 'high', shortfall: 'highest effort high is below xhigh (low/medium/high)' }] },
    });
    expect(route({ tier: 'advanced', agents: ['grok'], demand: 'exceptional' }, ext, { ...config, effortPolicy: 'quality' }).route).toEqual({ agent: 'grok', model: 'grok-4.7', effort: 'xhigh' });
    expect(route({ tier: 'light', agents: ['antigravity'], demand: 'high' }, ext, config).route?.model).toBe('gemini-3.8-flash-high');
  });

  it('rejects an explicit effort the Grok model or Antigravity route cannot apply', () => {
    const only45 = placed({ ...ext, discoveries: ext.discoveries.map((d) => (d.agent === 'grok' ? { ...d, models: [grok45] } : d)) }, { config, snapshot });
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'xhigh' }, only45, config)).toMatchObject({ status: 'decide', options: { wait: null, use: [] } });
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'max' }, ext, config).route).toBeUndefined();
    expect(route({ tier: 'light', agents: ['antigravity'], effort: 'max' }, ext, config).reasons[0])
      .toContain('no light route supports effort max: antigravity gemini-3.8-flash (low/medium/high)');
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'xhigh' }, ext, config).route).toEqual({ agent: 'grok', model: 'grok-4.7', effort: 'xhigh' });
  });

  it('competes with the other agents by remaining capacity', () => {
    // Grok's weekly has 90% left: behind Cursor's 93.75%, ahead of Codex, Antigravity and Claude.
    expect(route({ tier: 'advanced' }, ext, config).route?.agent).toBe('cursor');
    const d = route({ tier: 'advanced', excludeAgents: ['cursor'] }, ext, config);
    expect(d.route).toMatchObject({ agent: 'grok', model: 'grok-4.7' });
    expect(d.confidence).toBe('high');
    expect(d.reasons[0]).toBe('grok grok-4.7: weekly 10% reported + 1.5 pp for this worker = 11.5% prospective (available), resets in 1h');
    expect(route({ tier: 'advanced', excludeAgents: ['cursor', 'grok'] }, ext, config).route?.agent).toBe('codex');
  });

  it('ranks with low confidence when Orca usage is unknown', () => {
    const d = route({ tier: 'advanced', agents: ['grok'] }, withUsage('grok', { status: 'unknown', pools: {} }), config);
    expect(d).toMatchObject({ status: 'ok', confidence: 'low', route: { model: 'grok-4.7' } });
    expect(d.reasons[0]).toMatch(/usage unknown/);
    expect(route({ tier: 'light', agents: ['antigravity'] }, withUsage('antigravity', { pools: {} }), config))
      .toMatchObject({ status: 'ok', confidence: 'low' });
  });

  it('skips agents Orca reports unavailable, and agents that are not installed', () => {
    const signedOut = withUsage('grok', { status: 'unavailable', pools: {}, error: 'Not signed in to Grok' });
    const d = route({ tier: 'advanced' }, signedOut, config);
    expect(d.route?.agent).not.toBe('grok');
    expect(d.skipped).toContainEqual({ agent: 'grok', reason: 'not signed in or unavailable: Not signed in to Grok' });
    const missing = { ...ext, discoveries: ext.discoveries.map((x) => (x.agent === 'antigravity' ? { ...x, installed: false, models: [] } : x)) };
    expect(route({ tier: 'light' }, missing, config).skipped).toContainEqual({ agent: 'antigravity', reason: 'not installed' });
  });

  it('blocks Gemini and Claude routes alike when the Antigravity session is full', () => {
    const pools = ext.usage.antigravity.pools;
    const full = withUsage('antigravity', { pools: { ...pools, session: { ...pools.session, usedPercent: 100 } } });
    for (const tier of ['light', 'daily'] as const) {
      expect(route({ tier, agents: ['antigravity'] }, full, config)).toMatchObject({ status: 'decide', options: { wait: { until: env.now + 3_600_000 }, use: [] } });
    }
  });

  it('skips an installed agent that lists no models and says why', () => {
    expect(route({ tier: 'daily' }, ext, config).skipped)
      .toContainEqual({ agent: 'muse', reason: 'no models: no Muse models listed' });
    const d = route({ tier: 'daily', agents: ['muse'] }, ext, config);
    expect(d.status).toBe('none');
    expect(d.reasons[0]).toBe('no usable agent');
  });

  it('honors agent filters and config allow/deny lists by id', () => {
    expect(route({ tier: 'light' }, ext, { ...config, denyAgents: ['antigravity'] }).skipped)
      .toContainEqual({ agent: 'antigravity', reason: 'excluded by config' });
    expect(route({ tier: 'light' }, ext, { ...config, allowAgents: ['antigravity'] }).route?.agent).toBe('antigravity');
    expect(route({ tier: 'advanced', agents: ['grok', 'antigravity'] }, ext, config).route?.agent).toBe('grok');
  });
});

describe('agents the user has not enabled in Orca', () => {
  const disabled = (agents: string[]): Environment => ({ ...env, orcaAgents: { known: true, disabled: agents, source: 'test' } });
  const reasons = (e: Environment, config: Config = DEFAULT_CONFIG, req: RouteRequest = { tier: 'daily' }) =>
    Object.fromEntries(route(req, e, config).skipped.map((s) => [s.agent, s.reason]));

  it('skips an agent Orca has disabled, and routes the rest as before', () => {
    const d = route({ tier: 'daily' }, disabled(['claude']), DEFAULT_CONFIG);
    expect(d.skipped).toContainEqual({ agent: 'claude', reason: 'not enabled in Orca' });
    expect(d.route?.agent).not.toBe('claude');
    expect(route({ tier: 'daily' }, disabled([]), DEFAULT_CONFIG).route).toEqual(r({ tier: 'daily' }).route);
  });

  it('falls back to today\'s behavior when Orca\'s setting could not be read', () => {
    const unknown: Environment = { ...env, orcaAgents: { known: false, reason: 'Orca settings not found' } };
    expect(route({ tier: 'daily' }, unknown, DEFAULT_CONFIG).route).toEqual(r({ tier: 'daily' }).route);
    expect(route({ tier: 'daily' }, unknown, DEFAULT_CONFIG).skipped.filter((s) => s.agent === 'claude' && !s.model)).toEqual([]);
  });

  it('reports the strongest reason: user choice, then Orca not enabled, then unavailable, then not installed', () => {
    const e = withUsageStatus(disabled(['claude', 'codex', 'muse']), 'unavailable', ['claude', 'codex', 'cursor']);
    expect(reasons(e, { ...DEFAULT_CONFIG, denyAgents: ['claude'] })).toMatchObject({
      claude: 'excluded by config',
      codex: 'not enabled in Orca',
      cursor: expect.stringMatching(/^not signed in or unavailable/),
      muse: 'not enabled in Orca',
    });
    expect(reasons(e, DEFAULT_CONFIG, { tier: 'daily', excludeAgents: ['codex'] }).codex).toBe('excluded by request');
    expect(reasons(env).muse).toBe('not installed');
  });

  it('gives the same verdict per agent without a request', () => {
    const e = disabled(['codex']);
    const verdict = (agent: string) => agentSkipReason(e.discoveries.find((d) => d.agent === agent)!, e, DEFAULT_CONFIG);
    expect(verdict('claude')).toBeUndefined();
    expect(verdict('codex')).toBe('not enabled in Orca');
    expect(verdict('muse')).toBe('not installed');
  });

  it('skips an agent whose model list asked the user to sign in', () => {
    const e: Environment = {
      ...env,
      discoveries: env.discoveries.map((d) => (d.agent === 'cursor' ? { ...d, models: [], signedOut: true, note: 'not signed in: Not logged in' } : d)),
    };
    expect(agentSkipReason(e.discoveries.find((d) => d.agent === 'cursor')!, e, DEFAULT_CONFIG)).toBe('not signed in: Not logged in');
    expect(route({ tier: 'daily' }, e, DEFAULT_CONFIG).skipped).toContainEqual({ agent: 'cursor', reason: 'not signed in: Not logged in' });
  });
});

describe('preferences', () => {
  const pin = (agent: string, model?: string, extra: Partial<Config> = {}): Config =>
    ({ ...DEFAULT_CONFIG, pins: { daily: { agent, ...(model ? { model } : {}) } }, ...extra });
  const terra = pin('codex', 'gpt-6.1-terra');

  it('uses the preference while its prospective usage is below the limit', () => {
    const d = route({ tier: 'daily' }, env, terra);
    expect(d.route).toEqual({ agent: 'codex', model: 'gpt-6.1-terra', effort: 'medium' });
    expect(d.reasons).toContain('preferred route, available');
    expect(d.reservation).toBeUndefined();
    // It applies to its own tier only.
    expect(route({ tier: 'frontier' }, env, terra).route?.agent).toBe('cursor');
  });

  it('skips a preference whose usage would reach the limit, says why, and routes on without it', () => {
    const near = withPool(env, 'codex', 'weekly', { usedPercent: 89 });
    const d = route({ tier: 'daily' }, near, terra);
    expect(d.route?.agent).toBe('cursor');
    expect(d.warnings).toContain('preferred codex gpt-6.1-terra skipped: weekly would be 90.5% used with this worker (limit 90%); resets in 5d');
    // Below the limit it is kept, in the caution range, with the usual warning.
    const kept = route({ tier: 'daily' }, withPool(env, 'codex', 'weekly', { usedPercent: 87 }), terra);
    expect(kept.route?.agent).toBe('codex');
    expect(kept.warnings).toEqual(['weekly quota would be 88.5% used with this worker (caution); resets in 5d']);
  });

  it('keeps an over-threshold favorite when the user raised the limit', () => {
    const near = withPool(env, 'codex', 'weekly', { usedPercent: 93 });
    const d = route({ tier: 'daily' }, near, pin('codex', 'gpt-6.1-terra', { preferRiskLimit: 100 }));
    expect(d.route?.agent).toBe('codex');
    expect(d.quota).toMatchObject({ status: 'high', prospective: 94.5 });
    expect(d.warnings).toContain('weekly quota would be 94.5% used with this worker (high risk); resets in 5d');
  });

  it('hands the decision back when the favorite is over the limit and nothing else is below the threshold', () => {
    const tight = withPool(env, 'codex', 'weekly', { usedPercent: 93 });
    const d = route({ tier: 'daily', agents: ['codex'] }, tight, terra);
    expect(d.status).toBe('decide');
    expect(d.warnings).toContain('preferred codex gpt-6.1-terra skipped: weekly would be 94.5% used with this worker (limit 90%); resets in 5d');
    expect(d.options!.use.map((u) => u.model)).toContain('gpt-6.1-terra');
  });

  it('never uses an exhausted or banned favorite', () => {
    const blocked = route({ tier: 'daily' }, withPool(env, 'codex', 'weekly', { usedPercent: 100 }), pin('codex', 'gpt-6.1-terra', { preferRiskLimit: 1000 }));
    expect(blocked.route?.agent).toBe('cursor');
    expect(blocked.warnings).toContain('preferred codex gpt-6.1-terra skipped: quota exhausted (weekly 100% used, resets in 5d)');
    const banned = route({ tier: 'daily' }, env, pin('codex', 'gpt-6.1-terra', { banModels: ['gpt-6.1-terra'] }));
    expect(banned.route?.agent).toBe('cursor');
    expect(banned.warnings).toContain('preferred codex gpt-6.1-terra skipped: not available (banned by you)');
  });

  it('does not use a favorite with unknown usage as if it were within the limit, but keeps it routable', () => {
    const d = route({ tier: 'daily' }, withUsageStatus(env, 'unknown', ['codex']), terra);
    // Unknown usage cannot be over a limit: the explicit preference stands, at low confidence and with a warning.
    expect(d).toMatchObject({ route: { agent: 'codex' }, confidence: 'low', quota: { status: 'unknown' } });
    expect(d.warnings).toContain('usage of codex is unknown: usage unknown (Orca not reachable); routed without a quota check');
  });

  it('with an agent only, takes that agent\'s most economical eligible route', () => {
    const d = route({ tier: 'daily' }, env, pin('claude'));
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(d.reasons).toContain('preferred route, available');
    // Haiku is cheaper but below a Daily job: an agent preference never lowers the requirements.
    expect(d.alternatives.some((a) => a.model === 'claude-haiku-5-5')).toBe(false);
    const none = route({ tier: 'frontier' }, onlyModels(env, 'claude', ['claude-haiku-5-5']), { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'claude' } } });
    expect(none.warnings).toContain('preferred claude skipped: none of its models is eligible for the job');
    expect(none.route?.agent).toBe('cursor');
  });

  it('applies only after request flags, bans and the effort requirement', () => {
    const excluded = route({ tier: 'daily', excludeAgents: ['codex'] }, env, terra);
    expect(excluded.route?.agent).toBe('cursor');
    expect(excluded.warnings).toContain('preferred codex gpt-6.1-terra skipped: not available (excluded by request)');
    const effort = route({ tier: 'daily', effort: 'max' }, env, pin('codex', 'gpt-6.1-terra'));
    expect(effort.route?.model).toBe('gpt-6.1-terra');
    const variant: Config = pin('cursor', 'claude-sonnet-5-5');
    expect(route({ tier: 'daily', effort: 'none' }, env, variant).warnings).toContain('preferred cursor claude-sonnet-5-5 skipped: does not support effort none (low/medium/high/xhigh/max)');
  });
});

describe('unranked models with manual preferences', () => {
  const UNAVAILABLE_REASON = 'Manually preferred model; benchmark data unavailable. Task coverage could not be verified.';
  const mystery: LaunchModel = {
    agent: 'cursor', modelId: 'mystery-9', efforts: ['low', 'medium', 'high'],
    launch: { kind: 'flag', model: 'mystery-9' }, poolNames: ['monthly', 'bucket:Cursor Models'],
  };
  const composer: LaunchModel = {
    agent: 'cursor', modelId: 'composer-2-5', efforts: ['low', 'medium', 'high'],
    launch: { kind: 'flag', model: 'composer-2-5' }, poolNames: ['monthly', 'bucket:Cursor Models'],
  };

  it('excludes unranked models from automatic routing even with a cost override or when no other model exists', () => {
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'mystery-9': 'daily' } };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery], 0.5, config);
    for (const tier of ['light', 'daily', 'advanced', 'frontier'] as const) {
      const d = route({ tier, agents: ['cursor'] }, e, config);
      expect(d.status).toBe('none');
      expect(d.route).toBeUndefined();
      expect(d.skipped).toContainEqual({ agent: 'cursor', model: 'mystery-9', reason: 'unranked: no evidence or estimate' });
    }
    // Agent-only pin also excludes unranked models even when cost override is set.
    const agentPin = route({ tier: 'daily' }, e, { ...config, pins: { daily: { agent: 'cursor' } } });
    expect(agentPin.route?.agent).not.toBe('cursor');
    expect(agentPin.warnings).toContain('preferred cursor skipped: not available (unranked: no evidence or estimate)');
  });

  it('routes an explicitly preferred unranked model across tiers including light and noDowngrade without downgrade or skipped entry', () => {
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    for (const tier of ['light', 'daily', 'frontier'] as const) {
      const d = route({ tier, noDowngrade: true }, e, { ...DEFAULT_CONFIG, pins: { [tier]: { agent: 'cursor', model: 'mystery-9' } } });
      expect(d).toMatchObject({
        status: 'ok', downgraded: false, upgraded: false,
        route: { agent: 'cursor', model: 'mystery-9' },
        quality: { class: null, cost: null, covers: null, shortfall: 0, overshoot: 0, evidence: 'unranked' },
      });
      for (const axis of ['coding', 'agentic', 'reasoning'] as const) {
        expect(d.quality!.axes[axis]).toMatchObject({ score: null, band: null, evidence: 'unranked' });
      }
      expect(d.reasons).toContain(UNAVAILABLE_REASON);
      expect(d.warnings.some((w) => w.includes('falls short'))).toBe(false);
      expect(d.skipped.some((s) => s.agent === 'cursor' && s.model === 'mystery-9')).toBe(false);
    }
  });

  it('does not leak a blocked explicitly preferred unranked model with a cost override into automatic routing', () => {
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'mystery-9': 'daily' }, pins: { daily: { agent: 'cursor', model: 'mystery-9' } } };
    const e = withPool(withCursorModels(onlyModels(env, 'cursor', []), [mystery], 0.5, config), 'cursor', 'bucket:Cursor Models', { usedPercent: 100 });
    const d = route({ tier: 'daily', agents: ['cursor'] }, e, config);
    expect(d.status).toBe('none');
    expect(d.route).toBeUndefined();
    expect(d.warnings.some((w) => w.includes('preferred cursor mystery-9 skipped: quota exhausted'))).toBe(true);
  });

  it('distinguishes unknown axes from measured shortfall on a partially unranked model', () => {
    const e = withCursorModels(onlyModels(env, 'cursor', []), [composer]);
    // Automatic routing excludes composer-2-5 when a needed axis is unranked, even as a downgrade fallback.
    const autoDaily = route({ tier: 'daily', agents: ['cursor'] }, e, DEFAULT_CONFIG);
    expect(autoDaily.status).toBe('none');
    expect(autoDaily.skipped).toContainEqual({ agent: 'cursor', model: 'composer-2-5', reason: 'unranked: no evidence or estimate (agentic, reasoning)' });
    // Automatic routing still allows composer-2-5 when unranked axes are min.
    const autoCodingOnly = route({ needs: { coding: 'low', agentic: 'min', reasoning: 'min' }, agents: ['cursor'] }, e, DEFAULT_CONFIG);
    expect(autoCodingOnly).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'composer-2-5' }, quality: { covers: true, shortfall: 0 } });
    // Manually preferred on daily: coding covers low (80 >= 68), agentic/reasoning are unknown -> no downgrade, no shortfall, informational reason.
    const pinnedDaily = route({ tier: 'daily' }, e, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'cursor', model: 'composer-2-5' } } });
    expect(pinnedDaily).toMatchObject({
      status: 'ok', downgraded: false, route: { agent: 'cursor', model: 'composer-2-5' },
      quality: { class: 'advanced', covers: null, shortfall: 0, evidence: 'unranked' },
    });
    expect(pinnedDaily.reasons).toContain(UNAVAILABLE_REASON);
    expect(pinnedDaily.warnings.some((w) => w.includes('falls short'))).toBe(false);
    expect(pinnedDaily.skipped.some((s) => s.agent === 'cursor' && s.model === 'composer-2-5')).toBe(false);
    // Manually preferred on frontier: coding has measured shortfall of 1 (80 < 84), agentic/reasoning are unknown -> downgraded with shortfall 1 (coding only).
    const pinnedFrontier = route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'composer-2-5' } } });
    expect(pinnedFrontier).toMatchObject({
      status: 'ok', downgraded: true, route: { agent: 'cursor', model: 'composer-2-5' },
      quality: { class: 'advanced', covers: false, shortfall: 1, evidence: 'unranked' },
    });
    expect(pinnedFrontier.reasons).toContain(UNAVAILABLE_REASON);
    expect(pinnedFrontier.reasons.join('\n')).toContain('preferred route does not cover the job: coding 80 < 84');
    expect(pinnedFrontier.warnings).toContain("composer-2-5 falls short of the job's needs by 1 band step (coding); effort is not raised to make up for it: split the job or add stronger checks");
    expect(pinnedFrontier.skipped.some((s) => s.agent === 'cursor' && s.model === 'composer-2-5')).toBe(false);
  });

  it('evaluates a previously unranked preferred model normally once benchmark data becomes available', () => {
    const pinConfig: Config = { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } };
    // Stage 1: unranked -> unknown coverage, no downgrade, informational reason.
    const unrankedEnv = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    const before = route({ tier: 'frontier' }, unrankedEnv, pinConfig);
    expect(before).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'mystery-9' }, quality: { class: null, covers: null, shortfall: 0, evidence: 'unranked' } });
    expect(before.reasons).toContain(UNAVAILABLE_REASON);
    expect(before.warnings).toEqual([]);

    // Stage 2: benchmark data arrives and reveals a genuine shortfall on agentic (75 < 80).
    const shortSnap = parseSnapshot(fixture('evidence-mini.json'))!;
    shortSnap.models.push({
      id: 'mystery-9', aliases: [], provider: 'custom', name: 'Mystery 9', results: [],
      scores: {
        coding: { score: 86, benchmarks: 3, kind: 'measured' },
        agentic: { score: 75, benchmarks: 3, kind: 'measured' },
        reasoning: { score: 88, benchmarks: 3, kind: 'measured' },
      },
    });
    const shortEnv = placed(unrankedEnv, { snapshot: shortSnap });
    const withShortfall = route({ tier: 'frontier' }, shortEnv, pinConfig);
    expect(withShortfall).toMatchObject({ status: 'ok', downgraded: true, route: { model: 'mystery-9' }, quality: { class: 'frontier', covers: false, shortfall: 1, evidence: 'measured' } });
    expect(withShortfall.reasons).not.toContain(UNAVAILABLE_REASON);
    expect(withShortfall.warnings).toContain("mystery-9 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks");
    expect(withShortfall.skipped.some((s) => s.agent === 'cursor' && s.model === 'mystery-9')).toBe(false);

    // Stage 3: benchmark data covers all needs -> covers: true, no downgrade, no warnings.
    const fullSnap = parseSnapshot(fixture('evidence-mini.json'))!;
    fullSnap.models.push({
      id: 'mystery-9', aliases: [], provider: 'custom', name: 'Mystery 9', results: [],
      scores: {
        coding: { score: 86, benchmarks: 3, kind: 'measured' },
        agentic: { score: 82, benchmarks: 3, kind: 'measured' },
        reasoning: { score: 88, benchmarks: 3, kind: 'measured' },
      },
    });
    const fullEnv = placed(unrankedEnv, { snapshot: fullSnap });
    const covering = route({ tier: 'frontier' }, fullEnv, pinConfig);
    expect(covering).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'mystery-9' }, quality: { class: 'frontier', covers: true, shortfall: 0, evidence: 'measured' } });
    expect(covering.reasons).not.toContain(UNAVAILABLE_REASON);
    expect(covering.warnings).toEqual([]);
  });

  it('exposes the informational reason as coverageNote only when coverage could not be verified', () => {
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    const preferred = route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } });
    expect(preferred.coverageNote).toBe(UNAVAILABLE_REASON);
    // A ranked route, automatic or preferred, has its coverage checked: no note.
    expect(r({ tier: 'daily' })).not.toHaveProperty('coverageNote');
    expect(route({ tier: 'daily' }, env, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } })).not.toHaveProperty('coverageNote');
  });

  it('keeps the informational reason when --use selects an unranked model', () => {
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    // Not preferred: the Orchestrator names it, so the reason says so instead of claiming a manual preference.
    const chosen = route({ tier: 'frontier', use: { agent: 'cursor', model: 'mystery-9' } }, e, DEFAULT_CONFIG);
    expect(chosen).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'mystery-9' }, quality: { covers: null, shortfall: 0 }, coverageNote: CHOSEN_UNVERIFIED });
    expect(chosen.reasons).toContain(CHOSEN_UNVERIFIED);
    expect(chosen.reasons).not.toContain(UNAVAILABLE_REASON);
    expect(chosen.warnings.some((w) => w.includes('falls short'))).toBe(false);
    // Preferred for the tier and taken with --use: the exact manual-preference reason.
    const pinned = route({ tier: 'frontier', use: { agent: 'cursor', model: 'mystery-9' } }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } });
    expect(pinned).toMatchObject({ status: 'ok', downgraded: false, coverageNote: UNAVAILABLE_REASON });
    expect(pinned.reasons).toContain(UNAVAILABLE_REASON);
    expect(pinned.reasons).toContain('chosen by the Orchestrator (--use cursor/mystery-9): risk thresholds and requirements were not applied');
    // A ranked model taken with --use has its coverage checked: no note.
    expect(route({ tier: 'daily', use: { agent: 'codex', model: 'gpt-6.1-terra' } }, env, DEFAULT_CONFIG)).not.toHaveProperty('coverageNote');
  });

  it('hands a preferred unranked model over the preference limit back to the Orchestrator as WAIT and USE', () => {
    const config: Config = { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery], 95);
    const resetsAt = e.usage.cursor.pools['bucket:Cursor Models'].resetsAt!;
    const d = route({ tier: 'frontier', agents: ['cursor'] }, e, config);
    expect(d.status).toBe('decide');
    expect(d.route).toBeUndefined();
    expect(d.warnings.some((w) => w.startsWith('preferred cursor mystery-9 skipped: Cursor Models would be'))).toBe(true);
    expect(d.options!.use).toHaveLength(1);
    expect(d.options!.use[0]).toMatchObject({
      agent: 'cursor', model: 'mystery-9', use: '--use cursor/mystery-9', preferred: true, coverageNote: UNAVAILABLE_REASON,
      reason: expect.stringMatching(/^preferred route, Cursor Models 9\d(\.\d+)?% prospective is at or above the 90% preference limit$/),
    });
    expect(d.options!.wait).toMatchObject({ until: resetsAt });
    // Never offered as a lower-requirement route, and never routed automatically.
    expect(d.options!.lower.some((l) => l.model === 'mystery-9')).toBe(false);
    expect(d.alternatives).toEqual([]);
    expect(d.reasons[0]).toBe('preferred cursor mystery-9 is over the 90% preference limit and no other route can take the job automatically');
    expect(d.reasons.some((x) => x.startsWith('USE: cursor mystery-9 with --use cursor/mystery-9 (preferred route') && x.endsWith(UNAVAILABLE_REASON))).toBe(true);
    // The Orchestrator takes it: routed with the manual-preference reason.
    const used = route({ tier: 'frontier', agents: ['cursor'], use: { agent: 'cursor', model: 'mystery-9' } }, e, config);
    expect(used).toMatchObject({ status: 'ok', downgraded: false, route: { model: 'mystery-9' }, coverageNote: UNAVAILABLE_REASON });
    // Without the preference it stays out entirely.
    expect(route({ tier: 'frontier', agents: ['cursor'] }, e, DEFAULT_CONFIG).status).toBe('none');
  });

  it('offers a preferred unranked model held back by a lower preference limit, waiting for the bucket over it', () => {
    // 60% is below every risk threshold, but at or above the user's own 50% limit for preferences.
    const config: Config = { ...DEFAULT_CONFIG, preferRiskLimit: 50, pins: { daily: { agent: 'cursor', model: 'mystery-9' } } };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery], 60);
    const d = route({ tier: 'daily', agents: ['cursor'] }, e, config);
    expect(d.status).toBe('decide');
    expect(d.options!.use[0]).toMatchObject({ model: 'mystery-9', preferred: true, reason: expect.stringContaining('at or above the 50% preference limit') });
    expect(d.options!.wait).toMatchObject({ until: e.usage.cursor.pools['bucket:Cursor Models'].resetsAt });
  });

  it('puts the held preference before other routes over the risk threshold', () => {
    const config: Config = { ...DEFAULT_CONFIG, pins: { daily: { agent: 'cursor', model: 'mystery-9' } } };
    // Cursor's own routes are on Other Models; push both buckets and the monthly over the threshold.
    let e = withCursorModels(onlyModels(env, 'cursor', ['claude-sonnet-5-5']), [mystery], 95);
    e = withPool(withPool(e, 'cursor', 'bucket:Other Models', { usedPercent: 95 }), 'cursor', 'monthly', { usedPercent: 95 });
    const d = route({ tier: 'daily', agents: ['cursor'] }, e, config);
    expect(d.status).toBe('decide');
    expect(d.options!.use.map((u) => u.model)).toEqual(['mystery-9', 'claude-sonnet-5-5-medium']);
    expect(d.options!.use[1]).not.toHaveProperty('preferred');
    expect(d.reasons[0]).toMatch(/^no eligible route is below the 90% risk threshold: cursor claude-sonnet-5-5/);
  });

  it('does not offer an exhausted or effort-incompatible preferred unranked model', () => {
    const config: Config = { ...DEFAULT_CONFIG, pins: { daily: { agent: 'cursor', model: 'mystery-9' } } };
    const exhausted = withCursorModels(onlyModels(env, 'cursor', []), [mystery], 100);
    expect(route({ tier: 'daily', agents: ['cursor'] }, exhausted, config)).toMatchObject({ status: 'none' });
    const tight = withCursorModels(onlyModels(env, 'cursor', []), [mystery], 95);
    const effort = route({ tier: 'daily', agents: ['cursor'], effort: 'max' }, tight, config);
    expect(effort.status).toBe('none');
    expect(effort.warnings).toContain('preferred cursor mystery-9 skipped: does not support effort max (low/medium/high)');
  });
});

describe('explicit preferences for older releases', () => {
  // Opus 5 and 5.5 are both Advanced cost: automatic routing sees only 5.5.
  const opus5: Config = { ...DEFAULT_CONFIG, pins: { advanced: { agent: 'claude', model: 'claude-opus-5' } } };

  it('routes a preferred older release in the same cost tier instead of dropping it as not available', () => {
    const d = route({ tier: 'advanced', agents: claude }, env, opus5);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'claude', model: 'claude-opus-5' } });
    expect(d.reasons).toContain('preferred route, available');
    expect(d.warnings.some((w) => w.includes('not available'))).toBe(false);
    expect(d).not.toHaveProperty('coverageNote');
  });

  it('takes an older release named with --use', () => {
    expect(route({ tier: 'advanced', agents: claude, use: { agent: 'claude', model: 'claude-opus-5' } }, env, DEFAULT_CONFIG))
      .toMatchObject({ status: 'ok', route: { model: 'claude-opus-5' } });
  });

  it('keeps the older release out of automatic routing, alternatives and other tiers', () => {
    // The preference is skipped over its limit: routing goes on without it, and never to it.
    const d = route({ tier: 'advanced' }, env, { ...opus5, preferRiskLimit: 10 });
    expect(d.route?.model).not.toBe('claude-opus-5');
    expect(d.alternatives.some((a) => a.model === 'claude-opus-5')).toBe(false);
    expect(d.skipped.some((s) => s.model === 'claude-opus-5')).toBe(false);
    // A preference for Advanced does not bring it into a Frontier route.
    const frontier = route({ tier: 'frontier', agents: claude }, env, opus5);
    expect(frontier.route?.model).not.toBe('claude-opus-5');
    expect(frontier.alternatives.some((a) => a.model === 'claude-opus-5')).toBe(false);
  });

  it('hands a preferred older release over the limit back as USE when nothing else is below the threshold', () => {
    const tight = withPool(env, 'claude', 'weekly', { usedPercent: 95 });
    const d = route({ tier: 'advanced', agents: claude }, tight, opus5);
    expect(d.status).toBe('decide');
    expect(d.options!.use[0]).toMatchObject({ model: 'claude-opus-5', preferred: true });
    expect(d.options!.use[0]).not.toHaveProperty('coverageNote');
    expect(d.options!.lower.some((l) => l.model === 'claude-opus-5')).toBe(false);
  });
});

describe('last-resort agents (OpenCode)', () => {
  const metaOf = (id: string) => env.discoveries.flatMap((d) => d.models).find((m) => m.modelId === id)!.meta;
  const oc = (id: string, launchId: string): LaunchModel => ({
    agent: 'opencode', modelId: id, meta: metaOf(id), efforts: [], effortSource: 'orca',
    launch: { kind: 'flag', model: launchId }, poolNames: [], billing: 'pay per use through openrouter',
  });
  const withOc: Environment = placed({
    ...env,
    discoveries: [...env.discoveries, {
      agent: 'opencode', installed: true,
      models: [oc('claude-sonnet-5-5', 'openrouter/anthropic/claude-sonnet-5.5'), oc('claude-fable-5-1', 'openrouter/anthropic/claude-fable-5.1')],
    }],
  });
  const LAST = 'last resort: used only when no other agent can take the job';

  it('are left out while another agent can take the job', () => {
    const d = route({ tier: 'daily' }, withOc, DEFAULT_CONFIG);
    expect(d.route?.agent).not.toBe('opencode');
    expect(d.skipped).toContainEqual({ agent: 'opencode', reason: LAST });
    expect(d.alternatives.some((a) => a.agent === 'opencode')).toBe(false);
  });

  it('take the job when nothing else can, with a warning and how it is paid for', () => {
    const d = route({ tier: 'daily', excludeAgents: ['claude', 'codex', 'cursor'] }, withOc, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5.5', effort: null }, confidence: 'low', quota: null });
    expect(d.launchArgs).toEqual(['--agent', 'opencode', '--model', 'openrouter/anthropic/claude-sonnet-5.5']);
    expect(d.reasons[0]).toBe('opencode openrouter/anthropic/claude-sonnet-5.5: no usage window: pay per use through openrouter');
    expect(d.reasons).toContain('opencode: Orca takes --model for OpenCode only in an existing worktree (--worktree current or a selector)');
    expect(d.warnings).toContain('opencode is a last-resort agent (lastResortAgents), used as nothing else can take it: pay per use through openrouter');
  });

  it('come before waiting, never before a route the Orchestrator could still use', () => {
    const blocked = withPool(onlyModels(withOc, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 100 });
    const req = { needs: fableNeeds, excludeAgents: ['codex', 'cursor'] };
    // The only eligible Claude route is exhausted: the last resort takes the job rather than a wait.
    const d = route(req, blocked, DEFAULT_CONFIG);
    expect(d.route).toMatchObject({ agent: 'opencode', model: 'openrouter/anthropic/claude-fable-5.1' });
    expect(d.downgraded).toBe(false);
    expect(d.warnings.some((w) => /^opencode is a last-resort agent \(lastResortAgents\), used instead of waiting \d+[mhd]: pay per use/.test(w))).toBe(true);
    // At high risk Claude can still take it: that is the Orchestrator's call, with the last resort listed as one more option.
    const risky = route(req, withPool(blocked, 'claude', 'fableWeekly', { usedPercent: 95 }), DEFAULT_CONFIG);
    expect(risky.status).toBe('decide');
    expect(risky.options!.use.map((u) => [u.agent, u.model, u.lastResort ?? false])).toEqual([
      ['claude', 'claude-fable-5-1', false], ['opencode', 'openrouter/anthropic/claude-fable-5.1', true],
    ]);
    expect(risky.options!.use[1].reason).toBe('last-resort agent (lastResortAgents): pay per use through openrouter');
  });

  it('are ordinary agents when named with --agent, preferred for the tier, or lastResortAgents is empty', () => {
    const named = route({ tier: 'advanced', agents: ['opencode'] }, withOc, DEFAULT_CONFIG);
    expect(named.route?.agent).toBe('opencode');
    expect(named.warnings.some((w) => w.includes('last-resort'))).toBe(false);
    const pinned = route({ tier: 'advanced' }, withOc, { ...DEFAULT_CONFIG, pins: { advanced: { agent: 'opencode' } } });
    expect(pinned.route?.agent).toBe('opencode');
    const plain = route({ tier: 'advanced' }, withOc, { ...DEFAULT_CONFIG, lastResortAgents: [] });
    expect(plain.skipped.some((s) => s.agent === 'opencode')).toBe(false);
    // Without a usage window it still ranks after every route with usage data.
    expect(plain.route?.agent).not.toBe('opencode');
    expect(plain.alternatives.every((a) => a.quota !== null)).toBe(true);
  });
});

describe('models an agent refused at launch', () => {
  const refused = {
    ...env,
    rejections: [{ agent: 'claude', model: 'claude-sonnet-5-5', message: 'There\'s an issue with the selected model (claude-sonnet-5-5).', at: env.now - 2 * 3_600_000 }],
  };

  it('are skipped for that agent only, with the agent\'s words', () => {
    const d = route({ tier: 'advanced' }, refused, DEFAULT_CONFIG);
    expect(d.route).not.toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5' });
    expect(d.skipped).toContainEqual({
      agent: 'claude', model: 'claude-sonnet-5-5', reason: 'refused by claude 2h ago: "There\'s an issue with the selected model (claude-sonnet-5-5)."',
    });
    expect([d.route, ...d.alternatives]).toContainEqual(expect.objectContaining({ agent: 'cursor', model: expect.stringMatching(/^claude-sonnet-5-5/) }));
  });

  it('turn a preference for them into a warning', () => {
    const d = route({ tier: 'daily' }, refused, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' } } });
    expect(d.warnings).toContain('preferred claude claude-sonnet-5-5 skipped: not available (refused by claude 2h ago: "There\'s an issue with the selected model (claude-sonnet-5-5).")');
  });
});

describe('ban list', () => {
  const ban = (...banModels: string[]): Config => ({ ...DEFAULT_CONFIG, banModels });

  it('bans a family on every agent and lists each banned model as skipped', () => {
    const d = route({ tier: 'daily' }, env, ban('claude-sonnet'));
    expect(d.route?.model).not.toMatch(/sonnet/);
    expect(d.alternatives.some((a) => a.model.includes('sonnet'))).toBe(false);
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-sonnet-5-5', reason: 'banned by you' });
    expect(d.skipped).toContainEqual({ agent: 'cursor', model: 'claude-sonnet-5-5', reason: 'banned by you' });
    expect(d.reasons.join('\n')).toContain('claude claude-sonnet-5-5 (banned by you)');
  });

  it('lists banned models across classes for pin diagnostics', () => {
    const d = route({ tier: 'light' }, env, ban('claude-sonnet'));
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-sonnet-5-5', reason: 'banned by you' });
  });

  it('bans a model id, including its Cursor effort variants', () => {
    const d = route({ tier: 'frontier' }, env, ban('claude-fable-5-1'));
    expect(d.route?.agent).toBe('cursor');
    expect(d.alternatives.some((a) => a.model.includes('fable'))).toBe(false);
  });

  it('matches the Models.dev family exactly: grok bans grok models, not grok-build', () => {
    const grokMeta = { id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7', family: 'grok', releaseDate: '2026-09-21' };
    const buildMeta = { id: 'grok-build-0.1', provider: 'xai', name: 'Grok Build', family: 'grok-build', releaseDate: '2026-09-01' };
    const grokModel = (meta: typeof grokMeta): LaunchModel => ({
      agent: 'grok', modelId: meta.id, meta, efforts: ['low', 'medium', 'high'], launch: { kind: 'flag', model: meta.id }, poolNames: ['weekly'],
    });
    const config: Config = { ...ban('grok'), tierOverrides: { 'grok-build': 'advanced' } };
    const e: Environment = placed({ ...env, discoveries: [...env.discoveries, { agent: 'grok', installed: true, models: [grokModel(grokMeta), grokModel(buildMeta)] }] }, { config });
    const skipped = route({ tier: 'advanced' }, e, config).skipped;
    expect(skipped).toContainEqual({ agent: 'grok', model: 'grok-4.7', reason: 'banned by you' });
    expect(skipped.some((s) => s.model === 'grok-build-0.1' && s.reason === 'banned by you')).toBe(false);
  });
});

describe('eligibility is all or nothing', () => {
  it('#20 leaves out a model that exceeds some needs but fails another', () => {
    // Sonnet (84.3 / 78.2 / 87.3) is far above the coding and reasoning needs and misses agentic by under two points.
    const d = r({ needs: { coding: 'mid', agentic: 'high', reasoning: 'low' } });
    expect(d).toMatchObject({ status: 'ok', downgraded: false, quality: { covers: true, shortfall: 0 } });
    expect(d.route?.model).toBe('claude-opus-5-5-high');
    // It is the cheapest model on the bucket with the most room, and still not a candidate: not picked, not a runner-up.
    for (const agent of ['claude', 'cursor']) expect(d.skipped).toContainEqual({ agent, model: 'claude-sonnet-5-5', reason: 'below need on agentic (78.2 < 80)' });
    expect([d.route!.model, ...d.alternatives.map((a) => a.model)].some((model) => model.includes('sonnet'))).toBe(false);
    expect(d.alternatives.every((a) => a.quality.covers)).toBe(true);
    // Strength on the other axes does not buy it back, whatever the quota looks like.
    const onlySonnet = onlyModels(onlyModels(onlyModels(env, 'claude', ['claude-sonnet-5-5']), 'cursor', ['claude-sonnet-5-5']), 'codex', []);
    const alone = route({ needs: { coding: 'mid', agentic: 'high', reasoning: 'low' } }, onlySonnet, DEFAULT_CONFIG);
    expect(alone.status).toBe('decide');
    expect(alone.route).toBeUndefined();
    expect(alone.options!.lower.map((l) => l.shortfall)).toEqual(['below need on agentic (78.2 < 80)', 'below need on agentic (78.2 < 80)']);
  });

  it('#27 treats a model without capability scores as unclassified and invents none', () => {
    // On the bucket with the most room, with nothing known about it.
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'flag', model: 'mystery-9' }, poolNames: ['monthly', 'bucket:Other Models'] };
    const e = withCursorModels(env, [mystery]);
    const profile = e.discoveries.find((a) => a.agent === 'cursor')!.models.find((m) => m.modelId === 'mystery-9')!.profile;
    expect(profile).toMatchObject({ class: null, cost: null, axes: { coding: { score: null, band: null }, agentic: { score: null, band: null }, reasoning: { score: null, band: null } } });
    for (const tier of ['light', 'daily', 'advanced', 'frontier'] as const) {
      const d = route({ tier }, e, DEFAULT_CONFIG);
      expect(d.status, tier).toBe('ok');
      expect(d.route?.model.includes('mystery'), tier).toBe(false);
      expect(d.alternatives.some((a) => a.model === 'mystery-9'), tier).toBe(false);
      expect(d.skipped, tier).toContainEqual({ agent: 'cursor', model: 'mystery-9', reason: 'unranked: no evidence or estimate' });
    }
    // Not even for a job with no minimum, and not as a LOWER option when nothing else is left.
    const alone = route({ tier: 'frontier', agents: ['cursor'] }, onlyModels(e, 'cursor', ['mystery-9']), DEFAULT_CONFIG);
    expect(alone).toMatchObject({ status: 'none', reasons: expect.arrayContaining(['no model covers the job']) });
    expect(alone.options).toBeUndefined();
    // Only an explicit choice routes it, and the decision says that nothing is known: no score is made up.
    const used = route({ tier: 'frontier', use: { agent: 'cursor', model: 'mystery-9' } }, e, DEFAULT_CONFIG);
    expect(used).toMatchObject({ status: 'ok', downgraded: false, route: { agent: 'cursor', model: 'mystery-9', effort: null }, quality: { class: null, cost: null, covers: null, shortfall: 0, evidence: 'unranked' } });
    expect(used.tier).toBeUndefined();
    expect(Object.values(used.quality!.axes).map((a) => [a.score, a.band, a.evidence])).toEqual([[null, null, 'unranked'], [null, null, 'unranked'], [null, null, 'unranked']]);
    // With no cost tier it reserves the largest buffer row.
    expect(bucketOf(used, 'bucket:Other Models')).toMatchObject({ buffer: 3 });
  });
});

describe('declared windows', () => {
  const claudeWith = (pools: Environment['usage'][string]['pools']): Environment => ({
    ...env,
    discoveries: env.discoveries.filter((d) => d.agent === 'claude'),
    usage: { ...env.usage, claude: { agent: 'claude', status: 'ok', updatedAt: env.now, account: 'acct', plan: 'max_5x', scope: 'scope_1', pools } },
  });
  const monthly = (usedPercent: number) => ({ monthly: { name: 'monthly', kind: 'long' as const, usedPercent, windowMinutes: 44640, resetsAt: env.now + 86_400_000 } });

  it('a monthly-only Claude account at 100% is exhausted: the decision goes back, never an unknown route', () => {
    const e = claudeWith(monthly(100));
    const d = route({ tier: 'daily' }, e, DEFAULT_CONFIG);
    expect(d.status).toBe('decide');
    expect(d.route).toBeUndefined();
    expect(d.alternatives.length).toBeGreaterThan(0);
    for (const a of d.alternatives) expect(a).toMatchObject({ blocked: true, quota: { status: 'exhausted', binding: 'claude:scope_1:monthly' } });
    const used = route({ tier: 'daily', use: { agent: 'claude', model: 'claude-sonnet-5-5' } }, e, DEFAULT_CONFIG);
    expect(used.status).toBe('decide');
    expect(used.reasons[0]).toBe('--use claude/claude-sonnet-5-5: quota exhausted (monthly 100% used, resets in 1d)');
    // Below the limit it routes on the monthly window, with a known quota.
    expect(route({ tier: 'daily' }, claudeWith(monthly(40)), DEFAULT_CONFIG)).toMatchObject({ status: 'ok', quota: { status: 'available', binding: 'claude:scope_1:monthly' } });
  });

  it('reserves every declared window with the account and plan, while the decision shows only the windows reported now', () => {
    const { session: _session, fableWeekly: _fable, ...pools } = env.usage.claude.pools;
    const p = planRoute({ tier: 'daily' }, claudeWith(pools), DEFAULT_CONFIG);
    expect(p.reserve).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5', scope: 'scope_1', pools: ['session', 'weekly', 'monthly'], account: 'acct', plan: 'max_5x' });
    expect(p.decision.quota!.buckets.map((b) => b.id)).toEqual(['claude:scope_1:weekly']);
  });
});
