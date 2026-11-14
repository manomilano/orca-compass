import { AXES } from '../evidence/snapshot.js';
import { coverage, cutFor, EVIDENCE_ORDER, jobEvidence, needWeightedScore } from './adequacy.js';
import { needsFromTier, tierOfNeeds, type Needs } from './needs.js';
import { DEMAND_EFFORT, snapEffort } from './effort.js';
import { poolState, projectPool, rankHeadroom } from './pace.js';
import type { Rejection } from './rejection.js';
import { FAMILY_TIERS, knownModelVersion, modelFamily } from '../placements/tiers.js';
import {
  AGENT_IDS,
  TIERS,
  type AgentId,
  type Alternative,
  type Quality,
  type Config,
  type Confidence,
  type Decision,
  type Effort,
  type EffortResolution,
  type Environment,
  type LaunchModel,
  type OrcaAgents,
  type PlacedAgent,
  type PlacedModel,
  type Risk,
  type RouteRequest,
  type Tier,
  type UsagePool,
} from '../types.js';

// Pure routing core: Environment + RouteRequest + Config → Decision. No I/O, deterministic.

interface Candidate {
  model: PlacedModel;
  tier: Tier | null;
  quality: Quality | null;
  below: ReturnType<typeof coverage>['below'];
  weightedScore: number;
  /**
   * Headroom of the ranked pool: the long pool, or session pool on pace to hit its block threshold before
   * it resets, with the lowest `rank`; the session pool when there is no long one.
   */
  headroom: number | null;
  /** The headroom ranked by: `headroom`, scaled down when its pool resets beyond the urgency horizon. */
  rank: number | null;
  /** The ranked pool with the least headroom, i.e. the one that constrains this route. */
  tightest?: { pool: UsagePool; elapsed: number };
  /** A session pool within 20 points of its block threshold: reported, and a tiebreak after headroom. */
  hotSession?: UsagePool;
  blocked: boolean;
  blockedPools: UsagePool[];
  expiredPools: string[];
  confidence: Confidence;
  handoutMinutes: number;
  handoutPercent: number;
  /** Set when usage could not be evaluated (unknown, very stale, no matching pool). */
  usageNote?: string;
  /** Set when usage is moderately stale: headroom is kept, confidence capped at medium. */
  staleNote?: string;
  /** Projection of every pool that ranks or blocks the route, and the worst of them. */
  projections: Record<string, Risk>;
  risk?: Risk;
}

interface Resolved {
  model: string;
  /** The --effort value; null for effort variants and provider defaults. */
  effort: Effort | null;
  /** The effort the launch asks for, by flag or variant id; null when the agent decides. */
  resolved: Effort | null;
  applied: EffortResolution['applied'];
  args: string[];
}

type EffortPlan = Pick<EffortResolution, 'source' | 'demand' | 'policy' | 'target'>;

/** The effort to ask for: an explicit --effort, else the demand through the policy, else the requested tier's default. */
function effortPlan(req: RoutingRequest, config: Config): EffortPlan {
  if (req.effort) return { source: 'explicit', target: req.effort };
  if (req.demand) {
    return { source: 'demand', demand: req.demand, policy: config.effortPolicy, target: DEMAND_EFFORT[config.effortPolicy][req.demand] };
  }
  return { source: 'tier-default', target: config.defaultEffort[req.tier] };
}

/** Whether a launch can apply exactly this effort (a flag the model supports, or an effort variant). */
export function canApplyEffort(model: LaunchModel, effort: Effort): boolean {
  return model.launch.kind === 'flag' ? model.efforts.includes(effort) : model.launch.ids[effort] !== undefined;
}

type Skipped = Decision['skipped'];

const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low'];

type RoutingRequest = Omit<RouteRequest, 'tier' | 'needs'> & { tier: Tier; needs: Needs; needsSource: 'need' | 'tier' };

/**
 * The route for a job. Last-resort agents (`lastResortAgents`, OpenCode by default) are left out first; they
 * are tried only when that finds no route in any allowed tier, and then with a warning. Naming one with
 * `--agent`, or preferring it for the requested tier, makes it an ordinary agent for that route.
 */
export function route(req: RouteRequest, env: Environment, config: Config): Decision {
  if ((req.tier === undefined) === (req.needs === undefined)) throw new Error('use exactly one of needs or tier');
  const needs = req.needs ?? needsFromTier(req.tier!);
  const request: RoutingRequest = { ...req, tier: req.tier ?? tierOfNeeds(needs), needs, needsSource: req.needs ? 'need' : 'tier' };
  const decision = selectRoute(request, env, config);
  if (Object.hasOwn(config.tierOverrides, 'auto')) decision.warnings.push('tierOverrides.auto is ignored: Cursor auto has no model profile');
  if (req.tierReason) {
    decision.tierReason = req.tierReason;
    decision.reasons.push(`task tier ${request.tier}: ${req.tierReason}`);
  }
  return decision;
}

function selectRoute(req: RoutingRequest, env: Environment, config: Config): Decision {
  const pinned = config.pins[req.tier]?.agent;
  const deferred = config.lastResortAgents.filter((a) => !req.agents?.includes(a) && a !== pinned);
  const usable = (a: AgentId) => env.discoveries.some((d) => d.agent === a && !agentSkipReason(d, env, config, req));
  if (!deferred.some(usable)) return routeOnce(req, env, config, [], true);
  const first = routeOnce(req, env, config, deferred, false);
  if (first.status === 'ok') return first;
  const second = routeOnce(req, env, config, [], false);
  if (second.status === 'ok' && second.route && deferred.includes(second.route.agent)) {
    const instead = first.status === 'wait' && first.waitUntil !== undefined ? `instead of waiting ${duration(first.waitUntil - env.now)}` : 'as nothing else can take it';
    second.warnings.push(`${second.route.agent} is a last-resort agent (lastResortAgents), used ${instead}: ${billingOf(second, env)}`);
    return second;
  }
  return routeOnce(req, env, config, deferred, true);
}

function billingOf(d: Decision, env: Environment): string {
  const m = env.discoveries.find((x) => x.agent === d.route?.agent)?.models.find((x) => launchIds(x).includes(d.route!.model));
  return m?.billing ?? 'no usage window';
}

function routeOnce(req: RoutingRequest, env: Environment, config: Config, deferred: readonly AgentId[], allowFallback: boolean): Decision {
  const skipped: Skipped = [];
  const agents = eligibleAgents(req, env, config, skipped, deferred);
  const { candidates: all, fallback } = collectCandidates(agents, env, config, req, skipped);
  const honors = (c: Candidate): boolean => !req.effort || canApplyEffort(c.model, req.effort);
  const named = all.filter((c) => c.tier !== null);
  const fitOf = (candidates: Candidate[]): Candidate[] => {
    const covering = candidates.filter((c) => c.quality?.covers && c.tier !== null);
    const lowest = TIERS.find((tier) => covering.some((c) => c.tier === tier));
    return covering.filter((c) => c.tier === lowest).sort(compareRanked);
  };
  const fit = fitOf(named.filter(honors));
  const requested = req.tier;
  const plan = effortPlan(req, config);
  const target = plan.target;
  const warnings: string[] = [];
  const overRisk = new Set<Candidate>();
  const needLine = `needs ${AXES.map((axis) => `${axis}=${req.needs[axis]}`).join(' ')}${req.needsSource === 'tier' ? ` from tier ${requested}` : ''}; fit group: ${fit[0]?.tier ?? 'none'} cost tier (${fit.length} models)`;
  for (const c of named) {
    for (const { axis, score, cut } of c.below) skipped.push({ agent: c.model.agent, model: c.model.modelId, reason: `below need on ${axis} (${score ?? 'unranked'} < ${cut})` });
  }
  const base = (): Decision => ({
    status: 'none', requestedTier: requested, needs: req.needs, needsSource: req.needsSource, downgraded: false, upgraded: false,
    reasons: [], warnings, alternatives: [], skipped,
  });
  const skippedLine = (): string[] => skipped.length ? [`skipped: ${skipped.map((s) => `${s.agent}${s.model ? ` ${s.model}` : ''} (${s.reason})`).join(', ')}`] : [];
  const why = fit.length ? `all ${requested} candidates blocked: ${fit.map((c) => `${c.model.agent} ${c.model.modelId} (${summary(c, env.now)})`).join(', ')}` : 'no model covers the job';

  const finish = (cand: Candidate, group: Candidate[], pinned = false): Decision => {
    const chosen = resolve(cand, target);
    const effort = effortResolution(cand, plan, chosen);
    const quality = cand.quality;
    const down = quality !== null && !quality.covers;
    const up = quality?.covers === true && cand.tier !== null && TIERS.indexOf(cand.tier) > TIERS.indexOf(requested);
    const others = group.filter((c) => c !== cand && !overRisk.has(c));
    const reasons = [`${cand.model.agent} ${chosen.model}: ${describe(cand, env.now)}`, needLine];
    if (quality?.cost) {
      const { tier, blended, source } = quality.cost;
      const sourceText = { override: 'your override', price: 'maker price', family: 'family hint', lineup: "provider's lineup", evidence: 'evidence class' }[source];
      const price = blended === null ? `${sourceText}, no price` : `$${blended.toFixed(2)}/M blended, ${sourceText}`;
      reasons.push(`cost: ${tier} (${price})`);
    }
    if (quality) reasons.push(AXES.map((axis) => `${axis} ${quality.axes[axis].score ?? 'unranked'} ${quality.axes[axis].evidence}`).join(', '));
    else reasons.push('cursor auto: fallback, no named model could be routed (Cursor picks the model)');
    if (cand.model.agent === 'opencode') reasons.push('opencode: Orca takes --model for OpenCode only in an existing worktree (--worktree current or a selector)');
    if (pinned) {
      reasons.push(`preferred route, ${cand.risk ? paceText(cand.risk) : 'usage unknown'}`);
      if (down) reasons.push(`preferred route does not cover the job: ${cand.below.map(({ axis, score, cut }) => `${axis} ${score ?? 'unranked'} < ${cut}`).join(', ')}`);
    }
    for (const name of cand.expiredPools) reasons.push(`${cand.model.agent} ${poolLabel(name)}: reset time already passed (expired), pool ignored`);
    reasons.push(effortText(effort, cand));
    if (down) {
      reasons.push(`downgraded from ${requested}: ${pinned ? 'preferred route does not cover the job' : why}`);
      warnings.push(`${cand.model.modelId} falls short of the job's needs by ${quality!.shortfall} band step${quality!.shortfall === 1 ? '' : 's'} (${cand.below.map(({ axis }) => axis).join(', ')}); effort is not raised to make up for it: split the job or add stronger checks`);
    }
    if (up) {
      reasons.push(`upgraded from ${requested}: no model in the ${requested} cost tier covers the job`);
      warnings.push(`no model in the ${requested} cost tier covers the job; using ${cand.tier}`);
    }
    const next = others.find((c) => !c.blocked);
    if (next) reasons.push(`next best: ${next.model.agent} ${resolve(next, target).model} (${summary(next, env.now)})`);
    reasons.push(...skippedLine());
    return {
      ...base(), status: 'ok', tier: cand.tier ?? undefined, quality,
      source: quality === null ? 'auto' : cand.model.profile.hint?.source ?? 'evidence',
      downgraded: down, upgraded: up,
      route: { agent: cand.model.agent, model: chosen.model, effort: chosen.effort },
      effort, launchArgs: chosen.args,
      confidence: quality === null && cand.confidence === 'high' ? 'medium' : cand.confidence,
      risk: cand.risk ?? null, reasons,
      alternatives: others.slice(0, 5).map((c) => alternative(c, target, env.now)),
    };
  };

  const pin = config.pins[requested];
  if (pin) {
    // Agent-only pins choose a ranked model; explicit model pins can name unranked models.
    const isPin = (c: Candidate) => c.model.agent === pin.agent && (pin.model ? launchIds(c.model).includes(pin.model) : c.tier !== null);
    const mine = all.filter((c) => isPin(c) && honors(c)).sort(compareRanked);
    const match = mine.find((c) => !c.blocked) ?? mine[0];
    const label = `preferred ${pin.agent}${pin.model ? ` ${pin.model}` : ''}`;
    if (!match && req.effort && all.some(isPin)) warnings.push(`${label} skipped: does not support effort ${req.effort}`);
    else if (!match) {
      const gone = skipped.find((s) => s.agent === pin.agent && (!s.model || !pin.model || s.model === pin.model));
      warnings.push(`${label} skipped: not available${gone ? ` (${gone.reason})` : ''}`);
    } else if (match.blocked) warnings.push(`${label} skipped: blocked (${blockers(match, env.now)})`);
    else if (match.risk && match.risk.projectedPercent > config.preferRiskLimit) {
      const safer = fit.find((c) => !c.blocked && c.rank !== null && c.risk && c.risk.projectedPercent <= config.preferRiskLimit);
      if (!safer) {
        warnings.push(`${label} retained: no unblocked alternative with known usage within the ${config.preferRiskLimit}% risk limit`);
        return finish(match, fit, true);
      }
      for (const c of mine) if (c.risk && c.risk.projectedPercent > config.preferRiskLimit) overRisk.add(c);
      const risk = match.risk;
      warnings.push(`${label} skipped: ${poolLabel(risk.pool)} on pace for ${percent(Math.round(risk.projectedPercent))} (limit ${config.preferRiskLimit}%), resets in ${duration(risk.resetsAt - env.now)}`);
      return finish(safer, fit, isPin(safer));
    } else return finish(match, fit, true);
  }

  if (req.effort) {
    const unconstrainedFit = fitOf(named);
    if (unconstrainedFit.length && !unconstrainedFit.some(honors)) {
      const offered = unconstrainedFit.slice(0, 6).map((c) => `${c.model.agent} ${c.model.modelId} (${supportedEfforts(c.model)})`).join(', ');
      return { ...base(), alternatives: unconstrainedFit.slice(0, 5).map((c) => alternative(c, target, env.now)), reasons: [`no ${requested} route supports effort ${req.effort}: ${offered}`, 'choose one of these efforts, or route without --effort', needLine, ...skippedLine()] };
    }
  }
  const best = fit.find((c) => !c.blocked && !overRisk.has(c));
  if (best) return finish(best, fit);
  const downgrades = named.filter((c) => !c.quality!.covers && honors(c));
  if (!req.noDowngrade) {
    const shortfalls = [...new Set(downgrades.map((c) => c.quality!.shortfall))].sort((a, b) => a - b);
    for (const shortfall of shortfalls) {
      const group = downgrades.filter((c) => c.quality!.shortfall === shortfall).sort(compareRanked);
      const pick = group.find((c) => !c.blocked && !overRisk.has(c));
      if (pick) return finish(pick, group);
    }
    if (allowFallback && fallback && !fallback.blocked) return finish(fallback, []);
  }
  const waitUntil = earliestUnblock([...fit, ...(!req.noDowngrade ? downgrades : [])]);
  const reasons = [agents.length === 0 ? 'no usable agent' : why, needLine];
  if (waitUntil !== undefined) reasons.push(`waiting until ${new Date(waitUntil).toISOString()} (${duration(waitUntil - env.now)})`);
  reasons.push(...skippedLine());
  return { ...base(), status: waitUntil === undefined ? 'none' : 'wait', waitUntil, reasons, alternatives: fit.slice(0, 5).map((c) => alternative(c, target, env.now)) };
}

/** The coordinator's launch command for a decision, or undefined when there is no route. */
export function formatLaunch(d: Decision): string | undefined {
  if (!d.launchArgs) return undefined;
  return `orca orchestration worker-start --spec "<task>" ${d.launchArgs.join(' ')}`;
}

// --- candidate collection -------------------------------------------------------------------

function eligibleAgents(req: RoutingRequest, env: Environment, config: Config, skipped: Skipped, deferred: readonly AgentId[]): PlacedAgent[] {
  const known = new Set(env.discoveries.map((d) => d.agent));
  for (const agent of req.agents ?? []) {
    if (!known.has(agent)) skipped.push({ agent, reason: 'unknown agent' });
  }
  return env.discoveries.filter((d) => {
    const reason = agentSkipReason(d, env, config, req) ?? (deferred.includes(d.agent) ? 'last resort: used only when no other agent can take the job' : undefined);
    if (reason) skipped.push({ agent: d.agent, reason });
    return reason === undefined;
  });
}

/**
 * Why an agent is not used, strongest reason first: the user's choice (config, then request), Orca's
 * "not enabled", Orca's "unavailable", not installed, signed out of its model list, no models. Undefined
 * when the agent is used.
 */
export function agentSkipReason(
  d: PlacedAgent,
  env: Environment,
  config: Config,
  req: Pick<RouteRequest, 'agents' | 'excludeAgents'> = {},
): string | undefined {
  const agent = d.agent;
  const usage = env.usage[agent];
  if (config.denyAgents.includes(agent) || (config.allowAgents && !config.allowAgents.includes(agent))) return 'excluded by config';
  if ((req.agents && !req.agents.includes(agent)) || req.excludeAgents?.includes(agent)) return 'excluded by request';
  if (env.orcaAgents?.known && env.orcaAgents.disabled.includes(agent)) return 'not enabled in Orca';
  if (usage?.status === 'unavailable') return `not signed in or unavailable${usage.error ? `: ${usage.error}` : ''}`;
  if (!d.installed) return 'not installed';
  if (d.signedOut) return d.note ?? 'not signed in';
  if (d.models.length === 0) return `no models${d.note ? `: ${d.note}` : ''}`;
  return undefined;
}

/** Orca's own switch for an agent; unknown when the setting could not be read. */
export const enabledInOrca = (o: OrcaAgents | undefined, agent: AgentId): 'yes' | 'no' | 'unknown' =>
  !o?.known ? 'unknown' : o.disabled.includes(agent) ? 'no' : 'yes';

/** The user's ban entry matching a model by its base id or catalog/recognized family, if any. */
export function banEntry(model: LaunchModel, banModels: readonly string[]): string | undefined {
  const family = modelFamily(model.modelId, model.meta);
  return banModels.find((b) => b === model.modelId || (family !== undefined && b === family));
}

/** The first ban entry that names an agent and no model family: that takes `agents disable`, not a ban. */
export function agentNotFamily(entries: string[], matches: ReturnType<typeof banMatches>): string | undefined {
  return entries.find((e) => AGENT_IDS.includes(e) && !Object.hasOwn(FAMILY_TIERS, e) && (matches[e]?.length ?? 0) === 0);
}

/** Discovered models each ban entry matches, as agent + base model id. */
export function banMatches(entries: string[], env: Environment): Record<string, { agent: AgentId; model: string }[]> {
  return Object.fromEntries(entries.map((entry) => [
    entry,
    env.discoveries.flatMap((d) => d.models.filter((m) => banEntry(m, [entry])).map((m) => ({ agent: d.agent, model: m.modelId }))),
  ]));
}

/** The agent's recent refusal of this model under any of its launch ids, if any. */
export function rejectionOf(model: LaunchModel, rejections: readonly Rejection[] | undefined): Rejection | undefined {
  if (!rejections?.length) return undefined;
  const ids = launchIds(model);
  return rejections.find((r) => r.agent === model.agent && ids.includes(r.model));
}

/** e.g. 'refused by codex 2h ago: "The 'x' model is not supported when using Codex with a ChatGPT account."' */
export const rejectedText = (r: Rejection, now: number): string => `refused by ${r.agent} ${duration(now - r.at)} ago: "${r.message}"`;

/** Collect ranked named models, explicit unranked pins, and the separate Cursor fallback. */
function collectCandidates(agents: PlacedAgent[], env: Environment, config: Config, req: RoutingRequest, skipped: Skipped): { candidates: Candidate[]; fallback?: Candidate } {
  const models: PlacedModel[] = [];
  let fallback: Candidate | undefined;
  for (const d of agents) {
    for (const model of d.models) {
      if (model.noZdr && config.excludeNoZdr) continue;
      const rejected = rejectionOf(model, env.rejections);
      const leftOut = banEntry(model, config.banModels) ? 'banned by you' : rejected ? rejectedText(rejected, env.now) : undefined;
      if (leftOut) {
        skipped.push({ agent: model.agent, model: model.modelId, reason: leftOut });
        continue;
      }
      if (model.agent === 'cursor' && model.modelId === 'auto') {
        if (config.cursorAuto && (!req.effort || canApplyEffort(model, req.effort))) fallback = evaluate(model, env, config, req.needs, true);
        continue;
      }
      if (model.profile.class === null) {
        skipped.push({ agent: model.agent, model: model.modelId, reason: 'unranked: no evidence or estimate' });
        const pin = config.pins[req.tier];
        if (pin?.agent !== model.agent || !pin.model || !launchIds(model).includes(pin.model)) continue;
      }
      models.push(model);
    }
  }
  return { candidates: newestPerFamilyTier(models).map((model) => evaluate(model, env, config, req.needs)), fallback };
}

/**
 * Keep the newest release of each family per agent and cost tier. A day-0 release replaces
 * its older sibling in the same cost tier; an older release in a different cost tier stays
 * routable there (Advanced-cost Sonnet 4.6 alongside Daily-cost Sonnet 5.5).
 */
function newestPerFamilyTier(models: PlacedModel[]): PlacedModel[] {
  const newest = new Map<string, PlacedModel>();
  const key = (model: PlacedModel) =>
    `${model.agent}\u0000${modelFamily(model.modelId, model.meta) ?? `model:${model.modelId}`}\u0000${model.profile.cost?.tier ?? 'unclassified'}`;
  for (const model of models) {
    const previous = newest.get(key(model));
    if (!previous || compareRelease(model, previous) > 0) newest.set(key(model), model);
  }
  return models.filter((model) => compareRelease(model, newest.get(key(model))!) === 0);
}

/** Within a family, explicit numeric releases precede unversioned aliases, then versions and actual dates decide. */
function compareRelease(a: LaunchModel, b: LaunchModel): number {
  const family = modelFamily(a.modelId, a.meta);
  if (family !== undefined && family === modelFamily(b.modelId, b.meta)) {
    const av = knownModelVersion(a.modelId);
    const bv = knownModelVersion(b.modelId);
    const aVersioned = av?.family === family;
    const bVersioned = bv?.family === family;
    if (aVersioned !== bVersioned) return aVersioned ? 1 : -1;
    if (av?.family === family && bv?.family === family) {
      for (let i = 0; i < Math.max(av.version.length, bv.version.length); i++) {
        const difference = (av.version[i] ?? 0) - (bv.version[i] ?? 0);
        if (difference !== 0) return difference;
      }
    }
  }
  const ad = a.meta?.releaseDate ?? '';
  const bd = b.meta?.releaseDate ?? '';
  return ad < bd ? -1 : ad > bd ? 1 : 0;
}


function evaluate(model: PlacedModel, env: Environment, config: Config, needs: Needs, auto = false): Candidate {
  const adequacy = coverage(model.profile, needs, env.bands);
  const quality: Quality = {
    class: model.profile.class, cost: model.profile.cost, covers: adequacy.covers, shortfall: adequacy.shortfall, overshoot: adequacy.overshoot,
    evidence: jobEvidence(model.profile, needs),
    axes: Object.fromEntries(AXES.map((axis) => {
      const p = model.profile.axes[axis];
      return [axis, { score: p.score, band: p.band, evidence: p.label, benchmarks: p.benchmarks, need: needs[axis], cut: cutFor(needs[axis], env.bands[axis]) }];
    })) as Quality['axes'],
  };
  const base: Candidate = {
    model, tier: model.profile.cost?.tier ?? null, quality: auto ? null : quality, below: adequacy.below, weightedScore: needWeightedScore(model.profile, needs),
    headroom: null, rank: null, blocked: false, blockedPools: [], expiredPools: [], confidence: 'low', projections: {}, handoutMinutes: config.handoutMinutes, handoutPercent: config.handoutPercent,
  };
  if (model.poolNames.length === 0) return { ...base, usageNote: `no usage window: ${model.billing ?? 'limits not tracked'}` };
  const usage = env.usage[model.agent];
  if (!usage || usage.status !== 'ok') return { ...base, usageNote: 'usage unknown (Orca not reachable)' };

  // Blocking is evaluated even on stale data: within a window usedPercent only grows, so a stale
  // "blocked" is a valid lower bound. Staleness only degrades the ranking signal (see below).
  let lowered = false;
  type Ranked = { pool: UsagePool; headroom: number; rank: number; elapsed: number };
  const lower = (a: Ranked | undefined, b: Ranked): Ranked => (!a || b.rank < a.rank ? b : a);
  let long: Ranked | undefined;
  let session: Ranked | undefined;
  let bindingSession: Ranked | undefined;
  for (const name of model.poolNames) {
    const pool = usage.pools[name];
    if (!pool) continue;
    const state = poolState(pool, env.now, config.thresholds);
    if (state.expired) {
      base.expiredPools.push(name);
      lowered = true;
      continue;
    }
    if (state.blocked) {
      base.blocked = true;
      base.blockedPools.push(pool);
    } else if (pool.kind === 'session' && pool.usedPercent >= config.thresholds.sessionPercent - 20) {
      base.hotSession = pool;
    }
    const projected = projectPool(pool, env.now);
    base.projections[name] = projected;
    if (!base.risk || projected.projectedPercent > base.risk.projectedPercent) base.risk = projected;
    const ranked = { pool, headroom: state.headroom, rank: rankHeadroom(state.headroom, pool.resetsAt, env.now), elapsed: state.elapsed };
    if (pool.kind === 'long') {
      long = lower(long, ranked);
    } else {
      session = lower(session, ranked);
      // A session counts once its pace would hit the block threshold before it resets.
      if (!projected.tooEarly && projected.projectedPercent >= config.thresholds.sessionPercent) bindingSession = lower(bindingSession, ranked);
    }
  }
  const ranked = long ? (bindingSession ? lower(long, bindingSession) : long) : session;
  if (!ranked) return { ...base, usageNote: 'usage unknown (no matching usage pool)' };
  base.headroom = ranked.headroom;
  base.rank = ranked.rank;
  base.tightest = { pool: ranked.pool, elapsed: ranked.elapsed };
  // Confidence describes usage only; quality carries the certainty of the profile.
  base.confidence = lowered ? 'low' : ranked.pool.handouts ? 'medium' : 'high';

  const age = usage.updatedAt === undefined ? 0 : env.now - usage.updatedAt;
  const staleMs = config.usageStaleMinutes * 60_000;
  if (age > 4 * staleMs) {
    return { ...base, headroom: null, rank: null, tightest: undefined, confidence: 'low', usageNote: `usage stale (updated ${duration(age)} ago)` };
  }
  if (age > staleMs) {
    base.staleNote = `usage ${duration(age)} old`;
    if (base.confidence === 'high') base.confidence = 'medium';
  }
  return base;
}

// --- ranking --------------------------------------------------------------------------------

/** Within a tier: unblocked first, then most headroom, ending in a total order for determinism. */
function compareRanked(a: Candidate, b: Candidate): number {
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1;
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return b.rank - a.rank;
  if (!!a.hotSession !== !!b.hotSession) return a.hotSession ? 1 : -1;
  const conf = CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence);
  if (conf !== 0) return conf;
  const evidence = EVIDENCE_ORDER.indexOf(a.quality?.evidence ?? 'unranked') - EVIDENCE_ORDER.indexOf(b.quality?.evidence ?? 'unranked');
  if (evidence !== 0) return evidence;
  if (a.weightedScore !== b.weightedScore) return b.weightedScore - a.weightedScore;
  if (!!a.model.fast !== !!b.model.fast) return a.model.fast ? 1 : -1;
  const da = a.model.meta?.releaseDate ?? '';
  const db = b.model.meta?.releaseDate ?? '';
  if (da !== db) return da < db ? 1 : -1;
  if (a.model.agent !== b.model.agent) return a.model.agent < b.model.agent ? -1 : 1;
  return a.model.modelId < b.model.modelId ? -1 : a.model.modelId > b.model.modelId ? 1 : 0;
}

/** Earliest moment at which some blocked candidate has all of its blocking pools reset. */
function earliestUnblock(cands: Candidate[]): number | undefined {
  const times = cands.filter((c) => c.blocked).map((c) => Math.max(...c.blockedPools.map((p) => p.resetsAt)));
  return times.length ? Math.min(...times) : undefined;
}

// --- launch resolution ----------------------------------------------------------------------

export function launchIds(m: LaunchModel): string[] {
  const ids = m.launch.kind === 'flag' ? [m.launch.model] : [...Object.values(m.launch.ids), ...(m.launch.defaultId ? [m.launch.defaultId] : [])];
  return [m.modelId, ...ids];
}

/** Launch for a target effort: the target if offered, else the nearest lower one, else the lowest higher one. */
function resolve(c: Candidate, target: Effort): Resolved {
  const { agent, launch, efforts, modelId } = c.model;
  if (launch.kind === 'flag') {
    const effort = snapEffort(target, efforts);
    const args = ['--agent', agent, '--model', launch.model, ...(effort ? ['--effort', effort] : [])];
    return { model: launch.model, effort, resolved: effort, applied: effort ? 'flag' : 'provider-default', args };
  }
  const variant = snapEffort(target, Object.keys(launch.ids) as Effort[]);
  const model = (variant && launch.ids[variant]) ?? launch.defaultId ?? modelId;
  return { model, effort: null, resolved: variant, applied: variant ? 'model-id' : 'provider-default', args: ['--agent', agent, '--model', model] };
}

function effortResolution(c: Candidate, plan: EffortPlan, r: Resolved): EffortResolution {
  return {
    ...plan,
    resolved: r.resolved,
    applied: r.applied,
    adjusted: r.resolved !== null && r.resolved !== plan.target,
    supportSource: c.model.effortSource ?? 'unknown',
    ...(c.model.defaultEffort ? { providerDefault: c.model.defaultEffort } : {}),
  };
}

/** "low/medium/high", or "provider-controlled" when the launch cannot set an effort. */
function supportedEfforts(m: LaunchModel): string {
  const efforts = m.launch.kind === 'flag' ? m.efforts : (Object.keys(m.launch.ids) as Effort[]);
  return efforts.length ? efforts.join('/') : 'provider-controlled';
}

/** e.g. "effort: high from high reasoning demand (balanced policy), passed as --effort". */
function effortText(e: EffortResolution, c: Candidate): string {
  const why = e.source === 'explicit' ? 'request' : e.source === 'demand' ? `${e.demand} reasoning demand (${e.policy} policy)` : 'tier default';
  if (e.applied === 'provider-default') {
    const own = e.providerDefault ? ` (${e.providerDefault})` : '';
    const who = `${c.model.agent} uses its own default${own}`;
    return `effort: not set, ${who}; ${e.target} wanted from ${why}`;
  }
  const how = e.applied === 'flag' ? 'passed as --effort' : 'chosen through the model id';
  const snapped = e.adjusted ? ` (${e.target} not offered, nearest supported)` : '';
  const assumed = e.supportSource === 'assumed' ? '; supported levels assumed, not reported by the provider' : '';
  return `effort: ${e.resolved} from ${why}${snapped}, ${how}${assumed}`;
}

function alternative(c: Candidate, target: Effort, now: number): Alternative {
  const r = resolve(c, target);
  return {
    agent: c.model.agent, model: r.model, effort: r.effort, tier: c.tier!, quality: c.quality!,
    headroom: c.headroom, confidence: c.confidence, blocked: c.blocked, risk: c.risk ?? null, reason: describe(c, now),
  };
}

// --- explanations ---------------------------------------------------------------------------

/** Full one-line account of a candidate's usage, e.g. "weekly 20% used, 56% of window elapsed (headroom 60%) → on pace for 36% before reset in 3d". */
function describe(c: Candidate, now: number): string {
  if (c.blocked) return `blocked: ${blockers(c, now)}`;
  if (c.usageNote || !c.tightest || c.headroom === null) return c.usageNote ?? 'usage unknown';
  const { pool, elapsed } = c.tightest;
  const own = c.projections[pool.name];
  const pace = (r: Risk | undefined, resetsAt: number) =>
    r && !r.tooEarly ? ` → ${paceText(r)} before reset in ${duration(resetsAt - now)}` : `, resets in ${duration(resetsAt - now)}${r ? ' (too early to project)' : ''}`;
  const parts = [`${poolLabel(pool.name)} ${percent(pool.usedPercent)} used, ${Math.round(elapsed * 100)}% of window elapsed (headroom ${headroomText(c.headroom)}${scaled(c)})${pace(own, pool.resetsAt)}`];
  // The pool on pace to end most used, when it is not the ranked one (usually a hot session).
  const worst = c.risk && c.risk.pool !== pool.name && !c.risk.tooEarly ? c.risk : undefined;
  if (worst) parts.push(`${poolLabel(worst.pool)} ${percent(worst.usedPercent)} used${pace(worst, worst.resetsAt)}`);
  else if (c.hotSession && c.hotSession !== pool) parts.push(`session ${percent(c.hotSession.usedPercent)} used, resets in ${duration(c.hotSession.resetsAt - now)}`);
  if (c.staleNote) parts.push(c.staleNote);
  if (pool.handouts) parts.push(handoutNote(c, pool));
  return parts.join('; ');
}

/** Short form used for runner-ups and blocked lists, e.g. "fableWeekly headroom 47%, resets in 14h". */
function summary(c: Candidate, now: number): string {
  if (c.blocked) return blockers(c, now);
  if (c.model.poolNames.length === 0 && c.usageNote) return c.usageNote;
  if (c.usageNote || !c.tightest || c.headroom === null) return 'usage unknown';
  return `${poolLabel(c.tightest.pool.name)} headroom ${headroomText(c.headroom)}${scaled(c)}, resets in ${duration(c.tightest.pool.resetsAt - now)}${c.tightest.pool.handouts ? `; ${handoutNote(c, c.tightest.pool)}` : ''}`;
}

function handoutNote(c: Candidate, pool: UsagePool): string {
  const n = pool.handouts ?? 0;
  return `${n} worker${n === 1 ? '' : 's'} routed in the last ${c.handoutMinutes}m, counted as +${n * c.handoutPercent}%`;
}

function blockers(c: Candidate, now: number): string {
  return c.blockedPools.map((p) => `${poolLabel(p.name)} ${percent(p.usedPercent)} used, resets in ${duration(p.resetsAt - now)}${p.handouts ? `; ${handoutNote(c, p)}` : ''}`).join('; ');
}

const poolLabel = (name: string): string => name.replace(/^bucket:/, '');
/** "on pace for 118%", or for an early window "too early to project (weekly 3% used)". */
const paceText = (r: Risk): string =>
  r.tooEarly ? `too early to project (${poolLabel(r.pool)} ${percent(r.usedPercent)} used)` : `on pace for ${percent(Math.round(r.projectedPercent))}`;
const percent = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
/** ", counted as 21% for a reset beyond 7d" when the ranked headroom was scaled for a distant reset. */
const scaled = (c: Candidate): string =>
  c.rank !== null && c.headroom !== null && headroomText(c.rank) !== headroomText(c.headroom) ? `, counted as ${headroomText(c.rank)} for a reset beyond 7d` : '';
/** Headroom as a whole percent of the window, e.g. "60%" or "-19%". */
export const headroomText = (h: number): string => `${Math.round(h * 100)}%`;

function duration(ms: number): string {
  if (ms <= 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(ms / 60_000)}m`;
}
