import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { parseSnapshot, type SnapshotModel } from '../../src/evidence/snapshot.js';
import { fixture } from '../helpers/fakes.js';
import { agentSkipReason, formatLaunch, route } from '../../src/routing/router.js';
import type { Config, Effort, Environment, LaunchModel, RouteRequest } from '../../src/types.js';
import {
  CURSOR_AUTO, cursorVariant, machineEnv, onlyModels, placed, withCursorModels, withPool, withUsageStatus, withUsageUpdatedAt,
} from '../helpers/env.js';

const env = machineEnv();
// Fable 5.1 clears 76/80/86; Sonnet misses only the agentic cut.
const fableNeeds = { coding: 'mid', agentic: 'high', reasoning: 'high' } as const;
const r = (req: RouteRequest) => route(req, env, DEFAULT_CONFIG);

describe('routing by cost tier', () => {
  it('Daily uses Sonnet with more headroom than the other Daily-cost routes', () => {
    const d = r({ tier: 'daily' });
    // Terra is $2/M and Sonnet/Sol $4/M; Cursor Sonnet is a fourth route sharing Sonnet's profile.
    // Claude's weekly headroom is 45%, ahead of Cursor's scaled 20% and Codex's -14%.
    expect(d).toMatchObject({ status: 'ok', tier: 'daily', route: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } });
    expect(d.reasons.join('\n')).toContain('fit group: daily cost tier (4 models)');
    expect(d.reasons).toContain('cost: daily ($4.00/M blended, maker price)');
    expect(d.alternatives.map((a) => a.model)).toEqual(['claude-sonnet-5-5-medium', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  });
  it('Advanced uses the Daily-cost Sonnet because its raw evidence covers every mid cut', () => {
    // 84.3/78.2/87.3 clears the fixture cuts 76/70/78; price, not evidence class, forms the group.
    expect(r({ tier: 'advanced' })).toMatchObject({ tier: 'daily', upgraded: false, downgraded: false, route: { model: 'claude-sonnet-5-5' } });
  });
  it('Frontier uses Advanced-cost Opus before Frontier-cost Fable 5.2', () => {
    const e = withCursorModels(env, [cursorVariant('claude-fable-5-2')]);
    const d = route({ tier: 'frontier' }, e, DEFAULT_CONFIG);
    // Opus costs $8/M and clears 84/80/86; Fable 5.2 costs $16/M and is reached only without Opus routes.
    expect(d).toMatchObject({ tier: 'advanced', route: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, quality: { class: 'frontier', cost: { tier: 'advanced', blended: 8, source: 'price' } } });
    expect(route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, banModels: ['claude-opus'] })).toMatchObject({ tier: 'frontier', route: { model: 'claude-fable-5-2-high' } });
  });
  it('Light groups only Light-cost models even when their evidence class is Daily', () => {
    const d = r({ tier: 'light' });
    // Haiku and Luna both cost $0.20/M; Claude's weekly headroom wins.
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
    expect(d.alternatives.map((a) => a.model)).toEqual(['gpt-6-luna']);
    expect(d.reasons.join('\n')).toContain('fit group: light cost tier (2 models)');
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
    expect(d.alternatives.map((a) => `${a.agent} ${a.model}`)).toEqual(['cursor claude-opus-5-5-high']);
    expect(r({ tier: 'advanced' }).quality).toMatchObject({ class: 'frontier', covers: true, overshoot: 2 });
  });
  it('high/mid/low uses quota within the cheapest covering cost tier', () => {
    const d = r({ needs: { coding: 'high', agentic: 'mid', reasoning: 'low' } });
    expect(d).toMatchObject({ requestedTier: 'frontier', needsSource: 'need', route: { model: 'claude-sonnet-5-5' } });
    expect(d.reasons).toContain('needs coding=high agentic=mid reasoning=low; fit group: daily cost tier (2 models)');
  });
  it('low/low/min on Claude picks Daily-cost Sonnet and explains below-need models', () => {
    const d = r({ needs: { coding: 'low', agentic: 'low', reasoning: 'min' }, agents: ['claude'] });
    expect(d).toMatchObject({ requestedTier: 'daily', tier: 'daily', upgraded: false, route: { model: 'claude-sonnet-5-5' } });
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-haiku-5-5', reason: 'below need on agentic (53.5 < 60)' });
  });
  it('downgrades by shortfall with unchanged effort, or waits when forbidden', () => {
    const config = { ...DEFAULT_CONFIG, banModels: ['claude-opus-5-5'] };
    const blocked = withPool(env, 'claude', 'fableWeekly', { usedPercent: 96 });
    const d = route({ needs: fableNeeds, agents: ['claude'] }, blocked, config);
    expect(d).toMatchObject({ downgraded: true, tier: 'daily', route: { model: 'claude-sonnet-5-5', effort: 'high' }, quality: { covers: false, shortfall: 1 } });
    expect(d.warnings).toContain("claude-sonnet-5-5 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks");
    expect(route({ needs: fableNeeds, agents: ['claude'], noDowngrade: true }, blocked, config)).toMatchObject({ status: 'wait', waitUntil: 1793282400000 });
  });
  it('never promotes above a blocked fit group', () => {
    // Leave Claude Haiku and dearer Opus available while blocking the Daily-cost Codex/Cursor group.
    const e = onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-opus-5-5']);
    const blocked = withPool(withPool(e, 'codex', 'weekly', { usedPercent: 96 }), 'cursor', 'bucket:Other Models', { usedPercent: 96 });
    expect(route({ tier: 'daily' }, blocked, DEFAULT_CONFIG)).toMatchObject({ downgraded: true, route: { agent: 'claude', model: 'claude-haiku-5-5' }, quality: { shortfall: 1 } });
    expect(route({ tier: 'daily', noDowngrade: true }, blocked, DEFAULT_CONFIG).status).toBe('wait');
  });
  it('breaks quota ties by evidence then need-weighted score', () => {
    const req = { tier: 'frontier', agents: ['cursor'] } as const;
    // Put two covering models in Advanced cost; Fable 5.2 scores 795.3 vs Opus 780, on identical pools.
    const config: Config = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-fable-5-2': 'advanced' } };
    const tied = withCursorModels(env, [cursorVariant('claude-fable-5-2')], 0.5, config);
    const run = (e: Environment) => route({ ...req, agents: [...req.agents] }, e, config);
    expect(run(tied).route?.model).toBe('claude-fable-5-2-high');
    const changed = structuredClone(tied);
    const cursor = changed.discoveries.find((d) => d.agent === 'cursor')!;
    cursor.models.find((m) => m.modelId === 'claude-opus-5-5')!.profile.axes.coding.label = 'partial';
    expect(run(changed).route?.model).toBe('claude-fable-5-2-high');
    cursor.models.find((m) => m.modelId === 'claude-fable-5-2')!.profile.axes.reasoning.label = 'estimated';
    expect(run(changed).route?.model).toBe('claude-opus-5-5-high');
  });
  it('uses Cursor auto only as an allowed, unblocked fallback', () => {
    const auto = withCursorModels(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 96 }), [CURSOR_AUTO]);
    const req = { tier: 'frontier' as const, agents: ['cursor'] };
    const d = route(req, auto, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'cursor', model: 'auto', effort: null }, quality: null, source: 'auto', confidence: 'medium' });
    expect(d.tier).toBeUndefined();
    expect(d.reasons).toContain('cursor auto: fallback, no named model could be routed (Cursor picks the model)');
    expect(route({ ...req, noDowngrade: true }, auto, DEFAULT_CONFIG).status).toBe('wait');
    expect(route(req, auto, { ...DEFAULT_CONFIG, cursorAuto: false }).status).toBe('wait');
    expect(route(req, withPool(auto, 'cursor', 'bucket:Cursor Models', { usedPercent: 96 }), DEFAULT_CONFIG).status).toBe('wait');
    expect(route(req, auto, { ...DEFAULT_CONFIG, banModels: ['auto'] }).status).toBe('wait');
    expect(route({ ...req, effort: 'high' }, onlyModels(auto, 'cursor', ['auto']), DEFAULT_CONFIG).route).toBeUndefined();
    expect(route(req, onlyModels(auto, 'cursor', ['auto']), DEFAULT_CONFIG).route?.model).toBe('auto');
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
    expect(d.quality).toMatchObject({ covers: false, shortfall: 1 });
    expect(d.reasons.join('\n')).toContain('preferred route does not cover the job: agentic 78.2 < 80');
  });
  it('tries last-resort named routes before auto', () => {
    const auto = withCursorModels(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 96 }), [CURSOR_AUTO]);
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
  it('allows an explicit unranked model pin, while reporting its missing evidence', () => {
    const mystery: LaunchModel = { agent: 'cursor', modelId: 'mystery-9', efforts: [], launch: { kind: 'flag', model: 'mystery-9' }, poolNames: [] };
    const e = withCursorModels(onlyModels(env, 'cursor', []), [mystery]);
    const d = route({ tier: 'frontier' }, e, { ...DEFAULT_CONFIG, pins: { frontier: { agent: 'cursor', model: 'mystery-9' } } });
    expect(d).toMatchObject({ status: 'ok', route: { model: 'mystery-9' }, confidence: 'low', quality: { class: null, covers: false, evidence: 'unranked', shortfall: 12 } });
    expect(d.reasons.join('\n')).toContain('preferred route does not cover the job: coding unranked < 84');
  });
  it('offers auto after every named Cursor model was rejected, but honors an auto rejection', () => {
    const auto = withCursorModels(env, [CURSOR_AUTO]);
    const rejections = auto.discoveries.find((d) => d.agent === 'cursor')!.models.filter((m) => m.modelId !== 'auto').map((m) => ({ agent: 'cursor', model: m.modelId, message: 'not available', at: env.now }));
    const req = { tier: 'frontier' as const, agents: ['cursor'] };
    expect(route(req, { ...auto, rejections }, DEFAULT_CONFIG).route?.model).toBe('auto');
    const rejectedAuto = { ...auto, rejections: [...rejections, { agent: 'cursor', model: 'auto', message: 'not available', at: env.now }] };
    expect(route(req, rejectedAuto, DEFAULT_CONFIG).route).toBeUndefined();
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
  it('does not swap a risky Daily favorite for a higher covering cost tier', () => {
    const d = route({ tier: 'daily' }, { ...env, discoveries: env.discoveries.filter((a) => a.agent !== 'claude' && a.agent !== 'cursor') }, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } });
    expect(d.route?.model).toBe('gpt-6.1-terra');
    expect(d.warnings.join('\n')).toContain('retained: no unblocked alternative with known usage');
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
    expect(route({ tier: 'frontier', agents: ['claude'], noDowngrade: true }, edited, DEFAULT_CONFIG).route?.model).toBe('claude-opus-5-5');
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
  it('Frontier: Claude Opus (45%) beats Cursor Opus (20%) within Advanced cost', () => {
    expect(r({ tier: 'frontier' })).toMatchObject({
      status: 'ok', tier: 'advanced', downgraded: false, upgraded: false,
      route: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, confidence: 'high',
    });
    expect(r({ tier: 'frontier' }).launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-opus-5-5', '--effort', 'high']);
  });

  it('Daily and Advanced use Sonnet; Light uses Haiku with the tier default effort', () => {
    expect(r({ tier: 'daily' }).route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(r({ tier: 'advanced' }).route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(r({ tier: 'light' }).route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
    expect(r({ tier: 'daily' }).launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-sonnet-5-5', '--effort', 'medium']);
  });

  it('never offers a frontier model for a light task (anti-goal)', () => {
    const d = r({ tier: 'light' });
    expect(d.alternatives.length).toBeGreaterThan(0);
    expect(d.alternatives.every((a) => a.tier === 'light')).toBe(true);
  });

  it('hides older releases in the same cost tier and keeps an older release in a different tier', () => {
    // Opus 5 ($10/M) and 5.5 ($8/M) are both Advanced cost, so only 5.5 competes.
    const d = r({ tier: 'advanced' });
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
    // All three are $3/M (Daily cost), so even Cursor's free pool cannot put Grok in the Light group.
    expect(light.route?.model).toBe('claude-haiku-5-5');
    expect([light.route, ...light.alternatives].some((a) => a?.model.includes('grok'))).toBe(false);
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

  it('downgrades to Sonnet when the Frontier pool is blocked, keeping the effort and warning about capability', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 });
    const d = route({ needs: fableNeeds, agents: ['claude'] }, blocked, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', tier: 'daily', downgraded: true, route: { model: 'claude-sonnet-5-5', effort: 'high' } });
    expect(d.reasons.some((s) => /^downgraded from frontier: /.test(s))).toBe(true);
    expect(d.warnings).toContain("claude-sonnet-5-5 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks");
  });

  it('does not lower the effort when it goes up a tier', () => {
    const d = route({ tier: 'light', agents: ['claude'], demand: 'high' }, onlyModels(env, 'claude', ['claude-opus-5-5']), DEFAULT_CONFIG);
    expect(d).toMatchObject({ tier: 'advanced', upgraded: true, route: { effort: 'high' } });
  });

  it('waits for the earliest unblocking reset when noDowngrade is set', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 });
    const d = route({ needs: fableNeeds, agents: ['claude'], noDowngrade: true }, blocked, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'wait', waitUntil: 1793282400000, downgraded: false, upgraded: false });
    expect(d.route).toBeUndefined();
    expect(d.alternatives).toContainEqual(expect.objectContaining({ agent: 'claude', model: 'claude-fable-5-1', blocked: true }));
  });

  it('Codex-only Advanced: Sol, not up to Astra', () => {
    expect(r({ tier: 'advanced', agents: ['codex'] })).toMatchObject({
      tier: 'daily', downgraded: false, upgraded: false, route: { model: 'gpt-6.1-sol', effort: 'medium' },
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
    expect(d.alternatives.every((a) => a.headroom === null && a.confidence === 'low')).toBe(true);
  });

  it('ignores an expired pool and lowers confidence', () => {
    const d = route({ tier: 'frontier', agents: ['claude'] }, withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { resetsAt: env.now - 1 }), DEFAULT_CONFIG);
    expect(d.confidence).toBe('low');
    expect(d.route?.model).toBe('claude-fable-5-1');
    expect(d.reasons.join('\n')).toMatch(/fableWeekly.*expired/);
    const expiredAndFull = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { resetsAt: env.now - 1, usedPercent: 99 });
    expect(route({ tier: 'frontier', agents: ['claude'] }, expiredAndFull, DEFAULT_CONFIG).status).toBe('ok');
  });

  it('honors preferences, explicit effort and denied agents', () => {
    const pinned: Config = { ...DEFAULT_CONFIG, preferRiskLimit: 150, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } };
    const d = route({ tier: 'daily' }, env, pinned);
    expect(d.route?.agent).toBe('codex');
    expect(d.reasons).toContain('preferred route, on pace for 120%');
    expect(r({ tier: 'daily', effort: 'high' }).route?.effort).toBe('high');
    expect(route({ tier: 'frontier' }, env, { ...DEFAULT_CONFIG, denyAgents: ['cursor'] }).route?.agent).toBe('claude');
  });

  it('falls back to automatic choice when the preferred model is blocked', () => {
    const pinned: Config = { ...DEFAULT_CONFIG, preferRiskLimit: 1000, pins: { daily: { agent: 'codex', model: 'gpt-6.1-terra' } } };
    const d = route({ tier: 'daily' }, withPool(env, 'codex', 'weekly', { usedPercent: 97 }), pinned);
    expect(d.route?.agent).toBe('claude');
    expect(d.warnings).toContain('preferred codex gpt-6.1-terra skipped: blocked (weekly 97% used, resets in 5d)');
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

  it('never snaps an explicit effort: routes that cannot apply it are left out, or there is no route', () => {
    // Codex Luna offers none, Claude Haiku does not: the explicit effort picks Codex though Claude ranks first.
    expect(r({ tier: 'light' }).route?.agent).toBe('claude');
    expect(r({ tier: 'light', effort: 'none' }).route).toEqual({ agent: 'codex', model: 'gpt-6-luna', effort: 'none' });
    const d = route({ tier: 'light', agents: ['claude'], effort: 'none' }, env, DEFAULT_CONFIG);
    expect(d.status).toBe('none');
    expect(d.reasons[0]).toBe('no light route supports effort none: claude claude-haiku-5-5 (low/medium/high/xhigh/max)');
    expect(d.alternatives[0]).toMatchObject({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('follows the reasoning demand through the effort policy, independent of the tier', () => {
    const light = route({ tier: 'light', demand: 'high' }, env, DEFAULT_CONFIG);
    expect(light.route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'high' });
    expect(light.effort).toMatchObject({ source: 'demand', demand: 'high', policy: 'balanced', target: 'high', resolved: 'high', applied: 'flag' });
    expect(light.reasons).toContain('effort: high from high reasoning demand (balanced policy), passed as --effort');
    expect(route({ tier: 'frontier', demand: 'low' }, env, DEFAULT_CONFIG).effort).toMatchObject({ target: 'low', resolved: 'low' });
    expect(route({ tier: 'daily', demand: 'exceptional' }, env, DEFAULT_CONFIG).route?.effort).toBe('high');
    const quality: Config = { ...DEFAULT_CONFIG, effortPolicy: 'quality' };
    expect(route({ tier: 'daily', demand: 'exceptional' }, env, quality).route?.effort).toBe('xhigh');
    expect(route({ tier: 'daily', demand: 'low' }, env, quality).route?.effort).toBe('low');
    // An explicit effort wins over the demand.
    expect(route({ tier: 'daily', demand: 'low', effort: 'high' }, env, DEFAULT_CONFIG).effort).toMatchObject({ source: 'explicit', target: 'high' });
  });

  it('falls back to the requested tier\'s default effort and reports how it is applied', () => {
    const d = r({ tier: 'daily' });
    expect(d.effort).toEqual({
      source: 'tier-default', target: 'medium', resolved: 'medium', applied: 'flag', adjusted: false, supportSource: 'unknown',
    });
    expect(d.reasons).toContain('effort: medium from tier default, passed as --effort');
  });

  it('snaps an automatic effort down to a supported one, never inventing a level', () => {
    const lowHigh = onlyModels(env, 'claude', ['claude-sonnet-5-5']);
    const sonnet = lowHigh.discoveries.map((d) => (d.agent === 'claude'
      ? { ...d, models: d.models.map((m) => ({ ...m, efforts: ['low', 'high'] as Effort[], effortSource: 'provider' as const, defaultEffort: 'high' as Effort })) }
      : d));
    const d = route({ tier: 'daily', agents: ['claude'] }, { ...lowHigh, discoveries: sonnet }, DEFAULT_CONFIG);
    expect(d.route?.effort).toBe('low');
    expect(d.effort).toMatchObject({ target: 'medium', resolved: 'low', adjusted: true, supportSource: 'provider', providerDefault: 'high' });
    expect(d.reasons).toContain('effort: low from tier default (medium not offered, nearest supported), passed as --effort');
    const none = { ...lowHigh, discoveries: sonnet.map((x) => ({ ...x, models: x.models.map((m) => ({ ...m, efforts: [] as Effort[] })) })) };
    const unset = route({ tier: 'daily', agents: ['claude'] }, none, DEFAULT_CONFIG);
    expect(unset.launchArgs).toEqual(['--agent', 'claude', '--model', 'claude-sonnet-5-5']);
    expect(unset.effort).toMatchObject({ resolved: null, applied: 'provider-default' });
    expect(unset.reasons).toContain('effort: not set, claude uses its own default (high); medium wanted from tier default');
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
    expect(route({ tier: 'frontier', excludeAgents: ['claude'] }, noZdr, { ...DEFAULT_CONFIG, excludeNoZdr: true }).route?.agent).toBe('codex');
  });

  it('explains the pick with its tightest pool and names the runner-up and skipped agents', () => {
    const d = r({ tier: 'daily', excludeAgents: ['claude'] });
    expect(d.reasons[0]).toBe('cursor claude-sonnet-5-5-medium: Other Models 6.3% used, 29% of window elapsed (headroom 64%, counted as 20% for a reset beyond 7d) → on pace for 22% before reset in 22d');
    expect(d.reasons).toContain('next best: codex gpt-6.1-sol (weekly headroom -14%, resets in 5d)');
    expect(d.skipped).toContainEqual({ agent: 'muse', reason: 'not installed' });
    expect(d.alternatives.map((a) => [a.agent, a.model, a.blocked])).toEqual([
      ['codex', 'gpt-6.1-sol', false],
      ['codex', 'gpt-6.1-terra', false],
    ]);
    expect(d.alternatives[0].headroom).toBeCloseTo(-0.1375, 3);
    expect(d.alternatives[1].headroom).toBeCloseTo(-0.1375, 3);
  });

  it('is deterministic', () => {
    expect(r({ tier: 'frontier' })).toEqual(r({ tier: 'frontier' }));
    expect(JSON.stringify(route({ tier: 'daily' }, withUsageStatus(env, 'unknown'), DEFAULT_CONFIG)))
      .toBe(JSON.stringify(route({ tier: 'daily' }, withUsageStatus(env, 'unknown'), DEFAULT_CONFIG)));
  });
});

describe('ranking by headroom', () => {
  it('a just-reset session does not hide Claude weekly (45%, resets in 14h): Claude beats Codex (19%) and Cursor (20% counted)', () => {
    const e = withPool(withPool(env, 'claude', 'session', { usedPercent: 0, resetsAt: env.now + 297 * 60_000 }), 'codex', 'weekly', { usedPercent: 12 });
    const d = route({ tier: 'advanced' }, e, DEFAULT_CONFIG);
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(d.reasons[0]).toBe('claude claude-sonnet-5-5: weekly 50% used, 92% of window elapsed (headroom 45%) → on pace for 55% before reset in 14h');
    expect(d.alternatives.find((a) => a.agent === 'codex')?.headroom).toBeCloseTo(0.1925, 3);
  });

  it('a session at its threshold still blocks every Claude model', () => {
    const d = route({ tier: 'advanced', agents: ['claude'] }, withPool(env, 'claude', 'session', { usedPercent: 91 }), DEFAULT_CONFIG);
    expect(d.status).toBe('wait');
    expect(d.reasons[0]).toMatch(/all advanced candidates blocked: claude claude-sonnet-5-5 \(session 91% used/);
  });

  it('a session on pace to hit its threshold before it resets ranks the route by that session', () => {
    const { usedPercent, windowMinutes, resetsAt } = env.usage.claude.pools.weekly;
    const same = { usedPercent, windowMinutes, resetsAt };
    const tied = withPool(withPool(env, 'cursor', 'monthly', same), 'cursor', 'bucket:Other Models', same);
    expect(route({ tier: 'advanced' }, tied, DEFAULT_CONFIG).route?.agent).toBe('claude');
    // 72% used, 60% into a 5h session: on pace for 120%, so the session (-19%) ranks Claude, not the weekly (45%).
    const hot = withPool(tied, 'claude', 'session', { usedPercent: 72 });
    const d = route({ tier: 'advanced' }, hot, DEFAULT_CONFIG);
    expect(d.route?.agent).toBe('cursor');
    const claude = d.alternatives.find((a) => a.agent === 'claude');
    expect(claude).toMatchObject({ blocked: false });
    expect(claude?.headroom).toBeCloseTo(-0.1886, 3);
    expect(claude?.reason).toBe('session 72% used, 60% of window elapsed (headroom -19%) → on pace for 120% before reset in 2h');
    expect(route({ tier: 'advanced' }, withPool(env, 'claude', 'session', { usedPercent: 72 }), DEFAULT_CONFIG).route?.agent).toBe('cursor');
  });

  it('a hot session not on pace to hit its threshold is reported and only breaks ties', () => {
    // 72% used with 90% of the session elapsed: on pace for 80%, under the 90% threshold.
    const late = withPool(env, 'claude', 'session', { usedPercent: 72, resetsAt: env.now + 30 * 60_000 });
    const d = route({ tier: 'advanced' }, late, DEFAULT_CONFIG);
    expect(d.route?.agent).toBe('claude');
    expect(d.reasons[0]).toBe('claude claude-sonnet-5-5: weekly 50% used, 92% of window elapsed (headroom 45%) → on pace for 55% before reset in 14h; session 72% used → on pace for 80% before reset in 30m');
  });

  const WEEK = 7 * 86_400_000;
  const weeks = (codex: [number, number], claude: [number, number]) =>
    withPool(withPool(env, 'codex', 'weekly', { usedPercent: codex[0], resetsAt: env.now + (1 - codex[1]) * WEEK }),
      'claude', 'weekly', { usedPercent: claude[0], resetsAt: env.now + (1 - claude[1]) * WEEK });
  const advanced = (e: Environment) => route({ tier: 'advanced', excludeAgents: ['cursor'] }, e, DEFAULT_CONFIG).route?.agent;

  it('prefers the pool on pace to use less over one further below even pace', () => {
    // Codex 20% used, 51% elapsed (on pace for 39%); Claude 6% used, 26% elapsed (on pace for 23%).
    expect(advanced(weeks([20, 0.51], [6, 0.26]))).toBe('claude');
  });

  it('prefers an early, barely used window over a late, moderately used one', () => {
    expect(advanced(weeks([60, 0.8], [0, 0.1]))).toBe('claude');
  });

  it('uses capacity about to reset unused before a window that has just started', () => {
    expect(advanced(weeks([50, 0.95], [0.5, 0.01]))).toBe('codex');
  });

  it('avoids a pool on pace to run out', () => {
    expect(advanced(weeks([45, 0.4], [70, 0.9]))).toBe('claude');
  });
});

describe('stale usage (graduated)', () => {
  it('31-minute-old usage still blocks: Fable at 96% downgrades to Sonnet, not Fable', () => {
    const stale = withUsageUpdatedAt(withPool(onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 }), env.now - 31 * 60_000, ['claude']);
    const d = route({ needs: fableNeeds, agents: ['claude'] }, stale, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', tier: 'daily', downgraded: true, route: { model: 'claude-sonnet-5-5', effort: 'high' } });
  });

  it('45-minute-old usage keeps the headroom ranking, drops confidence to medium and says how old it is', () => {
    const fresh = r({ tier: 'daily' });
    const d = route({ tier: 'daily' }, withUsageUpdatedAt(env, env.now - 45 * 60_000), DEFAULT_CONFIG);
    expect(d.route).toEqual(fresh.route);
    expect(d.confidence).toBe('medium');
    expect(d.reasons[0]).toBe(`${fresh.reasons[0]}; usage 45m old`);
    expect(d.alternatives.map((a) => a.headroom)).toEqual(fresh.alternatives.map((a) => a.headroom));
    expect(d.alternatives.every((a) => a.confidence === 'medium')).toBe(true);
  });

  it('3-hour-old usage nulls the headroom and lowers confidence, but blocked pools still block', () => {
    const stale = withUsageUpdatedAt(withPool(onlyModels(env, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 }), env.now - 3 * 3_600_000, ['claude']);
    const d = route({ needs: fableNeeds, agents: ['claude'] }, stale, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', tier: 'daily', downgraded: true, confidence: 'low', route: { model: 'claude-sonnet-5-5' } });
    expect(d.reasons[0]).toBe('claude claude-sonnet-5-5: usage stale (updated 3h ago)');
    expect(d.reasons.some((s) => s.startsWith('downgraded from frontier: all frontier candidates blocked: claude claude-fable-5-1 (fableWeekly 96% used'))).toBe(true);
    const wait = route({ needs: fableNeeds, agents: ['claude'], noDowngrade: true }, stale, DEFAULT_CONFIG);
    expect(wait.status).toBe('wait');
    expect(wait.alternatives[0]).toMatchObject({ blocked: true, headroom: null, reason: 'blocked: fableWeekly 96% used, resets in 14h' });
    // routes with known headroom beat stale-unknown ones
    expect(route({ tier: 'advanced' }, withUsageUpdatedAt(env, env.now - 3 * 3_600_000, ['claude']), DEFAULT_CONFIG).route?.agent).toBe('cursor');
  });

  it('the staleness bands scale with usageStaleMinutes', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, usageStaleMinutes: 5 };
    const at = (min: number) => route({ tier: 'daily', agents: ['claude'] }, withUsageUpdatedAt(env, env.now - min * 60_000), cfg);
    expect(at(5).confidence).toBe('high');
    expect(at(6).confidence).toBe('medium');
    expect(at(20).confidence).toBe('medium');
    expect(at(21).confidence).toBe('low');
  });
});

describe('formatLaunch', () => {
  it('prefixes the launch args with the worker-start command', () => {
    expect(formatLaunch(r({ tier: 'frontier' }))).toBe('orca orchestration worker-start --spec "<task>" --agent claude --model claude-opus-5-5 --effort high');
    expect(formatLaunch(r({ tier: 'daily' }))).toBe('orca orchestration worker-start --spec "<task>" --agent claude --model claude-sonnet-5-5 --effort medium');
  });

  it('is undefined when there is no route', () => {
    const blocked = withPool(onlyModels(env, 'claude', ['claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 });
    expect(formatLaunch(route({ tier: 'frontier', agents: ['claude'], noDowngrade: true }, blocked, DEFAULT_CONFIG))).toBeUndefined();
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

  it('compares named models with other agents by headroom', () => {
    expect(route({ tier: 'advanced' }, auto, DEFAULT_CONFIG).route?.agent).toBe('claude');
    const decision = route({ tier: 'advanced' }, withPool(auto, 'claude', 'weekly', { usedPercent: 80 }), DEFAULT_CONFIG);
    expect(decision.route).toEqual({ agent: 'cursor', model: 'claude-sonnet-5-5-medium', effort: null });
  });

  it.each([false, true])('keeps auto unranked with cursorAuto %s and an override', (cursorAuto) => {
    const config: Config = { ...DEFAULT_CONFIG, cursorAuto, tierOverrides: { auto: 'advanced' } };
    const profiles = placed(auto, { config });
    expect(profiles.discoveries.find((discovery) => discovery.agent === 'cursor')!.models.find((model) => model.modelId === 'auto')!.profile.class).toBeNull();
    expect(route({ tier: 'daily', agents: ['cursor'] }, profiles, config).route?.model).toBe('claude-sonnet-5-5-medium');
  });

  it('retains agent filters and model pins on named routes', () => {
    const excluded = route({ tier: 'advanced', excludeAgents: ['cursor'] }, withPool(auto, 'claude', 'weekly', { usedPercent: 85 }), DEFAULT_CONFIG);
    expect(excluded.route?.agent).toBe('claude');
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
      { agent: 'muse', installed: true, models: [], note: 'no model list available from Orca; not routed' },
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

  it('snaps an automatic effort to what the Grok model or Antigravity route supports', () => {
    const only45 = placed({ ...ext, discoveries: ext.discoveries.map((d) => (d.agent === 'grok' ? { ...d, models: [grok45] } : d)) }, { config, snapshot });
    expect(route({ tier: 'advanced', agents: ['grok'], demand: 'exceptional' }, only45, { ...config, effortPolicy: 'quality' }).route)
      .toEqual({ agent: 'grok', model: 'grok-4.5', effort: 'high' });
    expect(route({ tier: 'light', agents: ['antigravity'], demand: 'high' }, ext, config).route?.model).toBe('gemini-3.8-flash-high');
  });

  it('rejects an explicit effort the Grok model or Antigravity route cannot apply', () => {
    const only45 = placed({ ...ext, discoveries: ext.discoveries.map((d) => (d.agent === 'grok' ? { ...d, models: [grok45] } : d)) }, { config, snapshot });
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'xhigh' }, only45, config).status).toBe('none');
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'max' }, ext, config).status).toBe('none');
    expect(route({ tier: 'light', agents: ['antigravity'], effort: 'max' }, ext, config).reasons[0])
      .toBe('no light route supports effort max: antigravity gemini-3.8-flash (low/medium/high)');
    expect(route({ tier: 'advanced', agents: ['grok'], effort: 'xhigh' }, ext, config).route).toEqual({ agent: 'grok', model: 'grok-4.7', effort: 'xhigh' });
  });

  it('competes with the other agents by headroom', () => {
    const d = route({ tier: 'advanced' }, ext, config);
    expect(d.route).toMatchObject({ agent: 'grok', model: 'grok-4.7' });
    expect(d.confidence).toBe('high');
    expect(d.reasons[0]).toMatch(/^grok grok-4\.7: weekly 10% used, 99% of window elapsed \(headroom 90%\)/);
    expect(route({ tier: 'advanced', excludeAgents: ['grok'] }, ext, config).route?.agent).toBe('claude');
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
    const full = withUsage('antigravity', { pools: { ...pools, session: { ...pools.session, usedPercent: 92 } } });
    expect(route({ tier: 'light', agents: ['antigravity'], noDowngrade: true }, full, config).status).toBe('wait');
    expect(route({ tier: 'daily', agents: ['antigravity'], noDowngrade: true }, full, config).status).toBe('wait');
  });

  it('never routes Muse and says why', () => {
    expect(route({ tier: 'daily' }, ext, config).skipped)
      .toContainEqual({ agent: 'muse', reason: 'no models: no model list available from Orca; not routed' });
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

describe('consumption risk', () => {
  // Codex weekly: 20% used with 17% of the window elapsed. Claude weekly: 50% used, 92% elapsed.
  it('projects each route\'s usage to the end of its window and reports the worst pool', () => {
    const d = route({ tier: 'daily', agents: ['codex'] }, env, DEFAULT_CONFIG);
    expect(d.risk).toEqual({ pool: 'weekly', usedPercent: 20, elapsedPercent: 17, projectedPercent: 120, tooEarly: false, resetsAt: 1793736000000 });
    expect(d.reasons[0]).toMatch(/weekly 20% used, 17% of window elapsed \(headroom -14%\) → on pace for 120% before reset in 5d$/);
    const claude = r({ tier: 'advanced' });
    expect(claude.risk).toMatchObject({ pool: 'weekly', projectedPercent: 54.5 });
    expect(claude.alternatives.every((a) => a.risk !== undefined)).toBe(true);
  });

  it('does not extrapolate early in a window', () => {
    const fresh = withPool(env, 'codex', 'weekly', { usedPercent: 4, resetsAt: env.now + 7 * 24 * 60 * 60_000 - 60 * 60_000 });
    const d = route({ tier: 'daily', agents: ['codex'] }, fresh, DEFAULT_CONFIG);
    expect(d.risk).toMatchObject({ pool: 'weekly', usedPercent: 4, projectedPercent: 4, tooEarly: true });
    expect(d.reasons[0]).toMatch(/weekly 4% used, 1% of window elapsed \(headroom 0%\), resets in 6d \(too early to project\)$/);
  });

  it('is null when usage is unknown', () => {
    const d = route({ tier: 'daily', agents: ['codex'] }, withUsageStatus(env, 'unknown', ['codex']), DEFAULT_CONFIG);
    expect(d.risk).toBeNull();
  });
});

describe('preferences', () => {
  const prefer = (pin: Config['pins'], extra: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, pins: pin, ...extra });

  it('chooses a known within-limit alternative when the favorite exceeds the limit', () => {
    const pinned = prefer({ advanced: { agent: 'codex' } });
    const used = withPool(env, 'codex', 'weekly', { usedPercent: 60, resetsAt: env.now + 0.6 * 10080 * 60_000 });
    const competing = withPool(used, 'claude', 'weekly', { usedPercent: 20, windowMinutes: 10080, resetsAt: env.now + 0.6 * 10080 * 60_000 });
    const request: RouteRequest = { tier: 'advanced', agents: ['codex', 'claude'] };
    const d = route(request, competing, pinned);
    expect(d.route?.agent).toBe('claude');
    expect(d.warnings.join('\n')).toContain('on pace for 150%');
    expect(d.alternatives.some((a) => a.agent === 'codex' && !a.blocked)).toBe(false);
  });

  it('keeps the over-limit favorite when no other route is allowed', () => {
    const d = route({ tier: 'daily', agents: ['codex'], noDowngrade: true }, env, prefer({ daily: { agent: 'codex' } }));
    expect(d.status).toBe('ok');
    expect(d.route?.agent).toBe('codex');
    expect(d.warnings.join('\n')).toContain('retained');
  });

  it('keeps an over-limit favorite when it is the only lower-tier fallback', () => {
    const dailyOnly = onlyModels(env, 'codex', ['gpt-6.1-terra']);
    const d = route({ tier: 'frontier', agents: ['codex'] }, dailyOnly, prefer({ frontier: { agent: 'codex' } }));
    expect(d.status).toBe('ok');
    expect(d.route?.agent).toBe('codex');
    expect(d.downgraded).toBe(true);
  });

  it('keeps the favorite when all eligible alternatives exceed the risk limit', () => {
    const used = withPool(env, 'codex', 'weekly', { usedPercent: 70, resetsAt: env.now + 0.6 * 10080 * 60_000 });
    const competing = withPool(used, 'claude', 'weekly', { usedPercent: 60, resetsAt: env.now + 0.6 * 10080 * 60_000 });
    const request: RouteRequest = { tier: 'advanced', agents: ['codex', 'claude'] };
    expect(route(request, competing, DEFAULT_CONFIG).route?.agent).toBe('claude');
    const d = route(request, competing, prefer({ advanced: { agent: 'codex' } }));
    expect(d.route?.agent).toBe('codex');
    expect(d.downgraded).toBe(false);
    expect(d.warnings.join('\n')).toContain('retained');
    expect(d.warnings.join('\n')).not.toContain('skipped');
  });

  it('does not treat unknown usage as proof that an alternative is within the limit', () => {
    const unknown = withUsageStatus(env, 'unknown', ['claude']);
    const d = route({ tier: 'advanced', agents: ['codex', 'claude'] }, unknown, prefer({ advanced: { agent: 'codex' } }));
    expect(d.route?.agent).toBe('codex');
    expect(d.warnings.join('\n')).toContain('known usage');
  });

  it('does not replace the favorite based on a very stale within-limit projection', () => {
    const stale = withUsageUpdatedAt(env, env.now - 121 * 60_000, ['claude']);
    const d = route({ tier: 'advanced', agents: ['codex', 'claude'] }, stale, prefer({ advanced: { agent: 'codex' } }));
    expect(d.route?.agent).toBe('codex');
    expect(d.warnings.join('\n')).toContain('retained');
  });

  it('still excludes a blocked or banned favorite when every alternative is risky', () => {
    const competing = withPool(env, 'claude', 'weekly', { usedPercent: 70, resetsAt: env.now + 0.6 * 10080 * 60_000 });
    const blocked = withPool(competing, 'codex', 'weekly', { usedPercent: 97 });
    const request: RouteRequest = { tier: 'advanced', agents: ['codex', 'claude'] };
    const pinned = prefer({ advanced: { agent: 'codex', model: 'gpt-6.1-sol' } });
    expect(route(request, blocked, pinned).route?.agent).toBe('claude');
    // Terra also clears the mini fixture's mid cuts (77.5/70/78), so it can replace banned Sol.
    const banned = route(request, competing, { ...pinned, banModels: ['gpt-6.1-sol'] });
    expect(banned.route?.model).toBe('gpt-6.1-terra');
    expect(banned.warnings.join('\n')).toContain('preferred codex gpt-6.1-sol skipped: not available (banned by you)');
  });

  it('uses the preference when its projected usage is within the limit', () => {
    const d = route({ tier: 'frontier' }, env, prefer({ frontier: { agent: 'claude', model: 'claude-opus-5-5' } }));
    expect(d.route).toEqual({ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect(d.reasons).toContain('preferred route, on pace for 55%');
    expect(d.warnings).toEqual([]);
  });

  it('skips a preference on pace to exceed the limit and says why', () => {
    const d = route({ tier: 'advanced' }, env, prefer({ advanced: { agent: 'codex', model: 'gpt-6.1-sol' } }));
    expect(d.route?.agent).toBe('claude');
    expect(d.warnings).toContain('preferred codex gpt-6.1-sol skipped: weekly on pace for 120% (limit 100%), resets in 5d');
    expect(d.reasons).not.toContain(expect.stringMatching(/^preferred route/));
    expect(route({ tier: 'advanced' }, env, prefer({ advanced: { agent: 'codex', model: 'gpt-6.1-sol' } }, { preferRiskLimit: 120 })).route?.agent).toBe('codex');
  });

  it('with an agent only, prefers that agent\'s best model by quota and job score', () => {
    const d = route({ tier: 'frontier' }, env, prefer({ frontier: { agent: 'claude' } }));
    expect(d.route).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5' });
    expect(d.reasons).toContain('preferred route, on pace for 55%');
  });

  it('applies only after request flags and bans', () => {
    const pin = prefer({ frontier: { agent: 'claude', model: 'claude-fable-5-1' } });
    const excluded = route({ tier: 'frontier', excludeAgents: ['claude'] }, env, pin);
    expect(excluded.route?.agent).toBe('cursor');
    expect(excluded.warnings).toContain('preferred claude claude-fable-5-1 skipped: not available (excluded by request)');
    const banned = route({ tier: 'frontier' }, env, { ...pin, banModels: ['claude-fable-5-1'] });
    expect(banned.route?.model).not.toMatch(/fable/);
    expect(banned.warnings).toContain('preferred claude claude-fable-5-1 skipped: not available (banned by you)');
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
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5.5', effort: null }, confidence: 'low' });
    expect(d.launchArgs).toEqual(['--agent', 'opencode', '--model', 'openrouter/anthropic/claude-sonnet-5.5']);
    expect(d.reasons[0]).toBe('opencode openrouter/anthropic/claude-sonnet-5.5: no usage window: pay per use through openrouter');
    expect(d.reasons).toContain('opencode: Orca takes --model for OpenCode only in an existing worktree (--worktree current or a selector)');
    expect(d.warnings).toContain('opencode is a last-resort agent (lastResortAgents), used as nothing else can take it: pay per use through openrouter');
  });

  it('come after a downgrade, but before waiting', () => {
    const blocked = withPool(onlyModels(withOc, 'claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']), 'claude', 'fableWeekly', { usedPercent: 96 });
    const req = { needs: fableNeeds, excludeAgents: ['codex', 'cursor'] };
    expect(route(req, blocked, DEFAULT_CONFIG)).toMatchObject({ downgraded: true, route: { agent: 'claude', model: 'claude-sonnet-5-5' } });
    const d = route({ ...req, noDowngrade: true }, blocked, DEFAULT_CONFIG);
    expect(d.route).toMatchObject({ agent: 'opencode', model: 'openrouter/anthropic/claude-fable-5.1' });
    expect(d.warnings.some((w) => /^opencode is a last-resort agent \(lastResortAgents\), used instead of waiting \d+[mhd]: pay per use/.test(w))).toBe(true);
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
    expect(plain.alternatives.at(-1)?.agent).toBe('opencode');
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
    expect(d.route?.agent).toBe('claude');
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
