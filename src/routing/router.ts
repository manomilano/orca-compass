import { DEMAND_EFFORT, snapEffort } from './effort.js';
import { poolState, projectPool, rankHeadroom } from './pace.js';
import type { Rejection } from './rejection.js';
import { FAMILY_TIERS, knownModelVersion, modelFamily } from '../placements/tiers.js';
import {
  AGENT_IDS,
  TIERS,
  type AgentId,
  type Alternative,
  type Classification,
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
  tier: Tier;
  source: Classification['source'];
  /** Why a score-placed model got its tier. */
  scoreDetail?: string;
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
function effortPlan(req: RouteRequest, config: Config): EffortPlan {
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

/**
 * The route for a job. Last-resort agents (`lastResortAgents`, OpenCode by default) are left out first; they
 * are tried only when that finds no route in any allowed tier, and then with a warning. Naming one with
 * `--agent`, or preferring it for the requested tier, makes it an ordinary agent for that route.
 */
export function route(req: RouteRequest, env: Environment, config: Config): Decision {
  const decision = selectRoute(req, env, config);
  if (req.tierReason) {
    decision.tierReason = req.tierReason;
    decision.reasons.push(`task tier ${req.tier}: ${req.tierReason}`);
  }
  return decision;
}

function selectRoute(req: RouteRequest, env: Environment, config: Config): Decision {
  const pinned = config.pins[req.tier]?.agent;
  const deferred = config.lastResortAgents.filter((a) => !req.agents?.includes(a) && a !== pinned);
  const usable = (a: AgentId) => env.discoveries.some((d) => d.agent === a && !agentSkipReason(d, env, config, req));
  if (!deferred.some(usable)) return routeOnce(req, env, config, []);
  const first = routeOnce(req, env, config, deferred);
  if (first.status === 'ok') return first;
  const second = routeOnce(req, env, config, []);
  if (second.status !== 'ok' || !second.route || !deferred.includes(second.route.agent)) return first;
  const instead = first.status === 'wait' && first.waitUntil !== undefined ? `instead of waiting ${duration(first.waitUntil - env.now)}` : 'as nothing else can take it';
  second.warnings.push(`${second.route.agent} is a last-resort agent (lastResortAgents), used ${instead}: ${billingOf(second, env)}`);
  return second;
}

function billingOf(d: Decision, env: Environment): string {
  const m = env.discoveries.find((x) => x.agent === d.route?.agent)?.models.find((x) => launchIds(x).includes(d.route!.model));
  return m?.billing ?? 'no usage window';
}

function routeOnce(req: RouteRequest, env: Environment, config: Config, deferred: readonly AgentId[]): Decision {
  const skipped: Skipped = [];
  const agents = eligibleAgents(req, env, config, skipped, deferred);
  const all = collectCandidates(agents, env, config, req.tier, skipped);
  // An explicit effort is a constraint, like --agent: a route that cannot apply it exactly is not used.
  const honors = (c: Candidate): boolean => !req.effort || canApplyEffort(c.model, req.effort);
  const byTier = (tier: Tier): Candidate[] => all.filter((c) => c.tier === tier && honors(c)).sort(compareRanked);

  const requested = req.tier;
  const plan = effortPlan(req, config);
  const target = plan.target;
  const warnings: string[] = [];
  const overRisk = new Set<Candidate>();
  const choose = (tier: Tier): { cand: Candidate; pinned: boolean } | undefined => {
    const ranked = byTier(tier);
    const pin = config.pins[tier];
    if (pin) {
      // Bans and agent filters already removed their candidates, so a preference only chooses among the rest.
      const isPin = (c: Candidate) => c.model.agent === pin.agent && (!pin.model || launchIds(c.model).includes(pin.model));
      const mine = ranked.filter(isPin);
      const match = mine.find((c) => !c.blocked) ?? mine[0];
      const label = `preferred ${pin.agent}${pin.model ? ` ${pin.model}` : ''} skipped`;
      if (!match && req.effort && all.some((c) => c.tier === tier && isPin(c))) {
        warnings.push(`${label}: does not support effort ${req.effort}`);
      } else if (!match) {
        const gone = skipped.find((s) => s.agent === pin.agent && (!s.model || !pin.model || s.model === pin.model));
        warnings.push(`${label}: not available${gone ? ` (${gone.reason})` : ''}`);
      } else if (match.blocked) {
        warnings.push(`${label}: blocked (${blockers(match, env.now)})`);
      } else if (match.risk && match.risk.projectedPercent > config.preferRiskLimit) {
        const safer = ranked.find((c) => !c.blocked && c.rank !== null && c.risk && c.risk.projectedPercent <= config.preferRiskLimit);
        if (!safer) {
          warnings.push(`preferred ${pin.agent}${pin.model ? ` ${pin.model}` : ''} retained: no unblocked alternative with known usage within the ${config.preferRiskLimit}% risk limit`);
          return { cand: match, pinned: true };
        }
        for (const candidate of mine) {
          if (candidate.risk && candidate.risk.projectedPercent > config.preferRiskLimit) overRisk.add(candidate);
        }
        const r = match.risk;
        warnings.push(`${label}: ${poolLabel(r.pool)} on pace for ${percent(Math.round(r.projectedPercent))} (limit ${config.preferRiskLimit}%), resets in ${duration(r.resetsAt - env.now)}`);
        return { cand: safer, pinned: isPin(safer) };
      } else {
        return { cand: match, pinned: true };
      }
    }
    const first = ranked.find((c) => !c.blocked && !overRisk.has(c));
    return first ? { cand: first, pinned: false } : undefined;
  };

  const base = (): Decision => ({
    status: 'none', requestedTier: requested, downgraded: false, upgraded: false,
    reasons: [], warnings, alternatives: [], skipped,
  });
  const skippedLine = (): string[] =>
    skipped.length ? [`skipped: ${skipped.map((s) => `${s.agent}${s.model ? ` ${s.model}` : ''} (${s.reason})`).join(', ')}`] : [];

  const finish = (pick: { cand: Candidate; pinned: boolean }, tier: Tier, move: 'same' | 'down' | 'up', why?: string): Decision => {
    const { cand } = pick;
    // Effort follows the work, not the model: a fallback to another tier keeps the target.
    const chosen = resolve(cand, target);
    const effort = effortResolution(cand, plan, chosen);
    const others = byTier(tier).filter((c) => c !== cand && !overRisk.has(c));
    const reasons = [`${cand.model.agent} ${chosen.model}: ${describe(cand, env.now)}`];
    if (cand.scoreDetail) reasons.push(`${cand.model.modelId}: tier ${cand.tier} from ${cand.scoreDetail}`);
    if (cand.model.agent === 'opencode') reasons.push('opencode: Orca takes --model for OpenCode only in an existing worktree (--worktree current or a selector)');
    if (pick.pinned) reasons.push(`preferred route, ${cand.risk ? paceText(cand.risk) : 'usage unknown'}`);
    for (const name of cand.expiredPools) reasons.push(`${cand.model.agent} ${poolLabel(name)}: reset time already passed (expired), pool ignored`);
    reasons.push(effortText(effort, cand));
    if (move === 'down') {
      reasons.push(`downgraded from ${requested}: ${why}`);
      warnings.push(`a ${tier} model is doing ${requested} work; effort is not raised to make up for it: split the job or add stronger checks`);
    }
    if (move === 'up') {
      reasons.push(`upgraded from ${requested}: no ${requested}-tier or lower model installed`);
      warnings.push(`no ${requested}-tier model installed; using ${tier}`);
    }
    const next = others.find((c) => !c.blocked);
    if (next) reasons.push(`next best: ${next.model.agent} ${resolve(next, target).model} (${summary(next, env.now)})`);
    reasons.push(...skippedLine());
    return {
      status: 'ok',
      requestedTier: requested,
      tier,
      downgraded: move === 'down',
      upgraded: move === 'up',
      route: { agent: cand.model.agent, model: chosen.model, effort: chosen.effort },
      effort,
      launchArgs: chosen.args,
      confidence: cand.confidence,
      risk: cand.risk ?? null,
      reasons,
      warnings,
      alternatives: others.slice(0, 5).map((c) => alternative(c, target, env.now)),
      skipped,
    };
  };

  if (req.effort) {
    const inTier = all.filter((c) => c.tier === requested).sort(compareRanked);
    if (inTier.length > 0 && !inTier.some(honors)) {
      const offered = inTier.slice(0, 6).map((c) => `${c.model.agent} ${c.model.modelId} (${supportedEfforts(c.model)})`).join(', ');
      return {
        ...base(),
        alternatives: inTier.slice(0, 5).map((c) => alternative(c, target, env.now)),
        reasons: [`no ${requested} route supports effort ${req.effort}: ${offered}`, 'choose one of these efforts, or route without --effort', ...skippedLine()],
      };
    }
  }

  const same = choose(requested);
  if (same) return finish(same, requested, 'same');

  const idx = TIERS.indexOf(requested);
  const lower = TIERS.slice(0, idx).reverse();
  const higher = TIERS.slice(idx + 1);
  const requestedCands = byTier(requested);
  const structural = requestedCands.length === 0 && lower.every((t) => byTier(t).length === 0);
  const blockedSummary = requestedCands.map((c) => `${c.model.agent} ${c.model.modelId} (${summary(c, env.now)})`).join(', ');
  const why = requestedCands.length > 0 ? `all ${requested} candidates blocked: ${blockedSummary}` : `no ${requested}-tier model installed`;
  const waitUntil = earliestUnblock(requestedCands);

  if (!req.noDowngrade) {
    for (const t of lower) {
      const pick = choose(t);
      if (pick) return finish(pick, t, 'down', why);
    }
  }
  if (structural) {
    for (const t of higher) {
      const pick = choose(t);
      if (pick) return finish(pick, t, 'up');
    }
  }

  const alternatives = requestedCands.filter((c) => !overRisk.has(c)).slice(0, 5).map((c) => alternative(c, target, env.now));
  if (req.noDowngrade && requestedCands.length > 0 && waitUntil !== undefined) {
    return {
      ...base(), status: 'wait', waitUntil, alternatives,
      reasons: [why, `waiting until ${new Date(waitUntil).toISOString()} (${duration(waitUntil - env.now)})`, ...skippedLine()],
    };
  }
  const reasons = [agents.length === 0 ? 'no usable agent' : why];
  if (!req.noDowngrade && !structural && agents.length > 0) reasons.push('no eligible unblocked model in any lower tier');
  reasons.push(...skippedLine());
  return { ...base(), alternatives, reasons, ...(waitUntil !== undefined ? { waitUntil } : {}) };
}

/** The coordinator's launch command for a decision, or undefined when there is no route. */
export function formatLaunch(d: Decision): string | undefined {
  if (!d.launchArgs) return undefined;
  return `orca orchestration worker-start --spec "<task>" ${d.launchArgs.join(' ')}`;
}

// --- candidate collection -------------------------------------------------------------------

function eligibleAgents(req: RouteRequest, env: Environment, config: Config, skipped: Skipped, deferred: readonly AgentId[]): PlacedAgent[] {
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

/** Candidates of every tier; banned or refused models placed in `tier` are reported as skipped. */
function collectCandidates(agents: PlacedAgent[], env: Environment, config: Config, tier: Tier, skipped: Skipped): Candidate[] {
  const classified: { model: PlacedModel; cls: Classification }[] = [];
  for (const d of agents) {
    for (const model of d.models) {
      if (model.noZdr && config.excludeNoZdr) continue;
      // The table already holds the placement (built from every source); the route only reads it.
      const placed = model.placements;
      const rejected = rejectionOf(model, env.rejections);
      const leftOut = banEntry(model, config.banModels) ? 'banned by you' : rejected ? rejectedText(rejected, env.now) : undefined;
      if (leftOut) {
        const inTier = placed.some((c) => c.tier === tier);
        if (inTier && !skipped.some((s) => s.agent === model.agent && s.model === model.modelId)) {
          skipped.push({ agent: model.agent, model: model.modelId, reason: leftOut });
        }
        continue;
      }
      for (const cls of placed) classified.push({ model, cls });
    }
  }
  return newestPerFamily(classified).map(({ model, cls }) => evaluate(model, cls, env, config));
}

/**
 * Keep only the newest release per (agent, family, tier), using known family versions before catalog dates.
 * Table families share one tier; score placement can split a family (grok-4.6 Daily, grok-4.5 Light).
 */
function newestPerFamily<T extends { model: PlacedModel; cls: Classification }>(items: T[]): T[] {
  const newest = new Map<string, PlacedModel>();
  const key = ({ model, cls }: T) => {
    const family = modelFamily(model.modelId, model.meta);
    return `${model.agent}\u0000${family === undefined ? `model:${model.modelId}` : `family:${family}`}\u0000${cls.tier}`;
  };
  for (const item of items) {
    const k = key(item);
    const previous = newest.get(k);
    if (!previous || compareRelease(item.model, previous) > 0) newest.set(k, item.model);
  }
  return items.filter((item) => compareRelease(item.model, newest.get(key(item))!) === 0);
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

function evaluate(model: PlacedModel, cls: Classification, env: Environment, config: Config): Candidate {
  const base: Candidate = {
    model, tier: cls.tier, source: cls.source, headroom: null, rank: null, blocked: false, blockedPools: [], expiredPools: [], confidence: 'low', projections: {},
    ...(cls.detail ? { scoreDetail: cls.detail } : {}),
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
  // The provider's own lineup and the family table are firm; a score placement is an estimate.
  base.confidence = lowered ? 'low' : cls.source === 'family' || cls.source === 'lineup' ? 'high' : 'medium';

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
    agent: c.model.agent, model: r.model, effort: r.effort, tier: c.tier,
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
  return parts.join('; ');
}

/** Short form used for runner-ups and blocked lists, e.g. "fableWeekly headroom 47%, resets in 14h". */
function summary(c: Candidate, now: number): string {
  if (c.blocked) return blockers(c, now);
  if (c.model.poolNames.length === 0 && c.usageNote) return c.usageNote;
  if (c.usageNote || !c.tightest || c.headroom === null) return 'usage unknown';
  return `${poolLabel(c.tightest.pool.name)} headroom ${headroomText(c.headroom)}${scaled(c)}, resets in ${duration(c.tightest.pool.resetsAt - now)}`;
}

function blockers(c: Candidate, now: number): string {
  return c.blockedPools.map((p) => `${poolLabel(p.name)} ${percent(p.usedPercent)} used, resets in ${duration(p.resetsAt - now)}`).join('; ');
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
