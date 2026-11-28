import { AXES } from '../evidence/snapshot.js';
import { DEFAULT_TOP_BANDS } from '../evidence/refresh.js';
import { coverage, cutFor, EVIDENCE_ORDER, jobEvidence, needWeightedScore } from './adequacy.js';
import { needsFromTier, tierOfNeeds, type Needs } from './needs.js';
import { DEMAND_EFFORT, EFFORT_LADDER } from './effort.js';
import {
  bufferEffortOf, bufferTierOf, buildQuotaView, candidateBucketText, candidateQuota, displayPool, duration, percentText, pointsText, poolKey, scopeOf, statusText,
  type BufferEffort, type BufferTier, type CandidateBucket, type CandidateQuota, type QuotaStatus,
} from './quota.js';
import type { Rejection } from './rejection.js';
import { FAMILY_TIERS, knownModelVersion, modelFamily } from '../placements/tiers.js';
import {
  AGENT_IDS,
  DEMANDS,
  TIERS,
  type AgentId,
  type Alternative,
  type Quality,
  type Config,
  type Confidence,
  type Decision,
  type DecisionOptions,
  type Effort,
  type EffortResolution,
  type Environment,
  type LaunchModel,
  type OrcaAgents,
  type PlacedAgent,
  type PlacedModel,
  type Preference,
  type RouteOption,
  type RouteRequest,
  type Tier,
} from '../types.js';

// Pure routing core: Environment + RouteRequest + Config → Decision. No I/O, deterministic.
//
// The pipeline, in order:
//   1. Eligibility. A route is eligible only when its model meets all three capability needs and can apply
//      an effort that satisfies the request. Nothing is scored down for falling short: it is left out.
//   2. Quota. Each eligible route gets the reported, reserved, effective and prospective usage of every
//      quota bucket it draws on. The bucket with the least remaining capacity is its binding bucket.
//   3. Quota first. Buckets are ranked by remaining effective capacity. In the best bucket the most
//      economical route is taken whose prospective usage, on all of its buckets, is below the threshold;
//      a route over it is passed over for the next route in the same bucket, then for the next bucket.
//   4. No route below the automatic threshold: the decision goes back to the Orchestrator (WAIT, USE, LOWER).
// Usage is never extrapolated: only what is reported now and what is reserved now counts.

interface Candidate {
  model: PlacedModel;
  tier: Tier | null;
  quality: Quality | null;
  below: ReturnType<typeof coverage>['below'];
  unknown: ReturnType<typeof coverage>['unknown'];
  weightedScore: number;
  launch: Resolved;
  /** Why the model cannot apply an effort that satisfies the request; undefined when it can. */
  effortShort?: string;
  bufferTier: BufferTier;
  bufferEffort: BufferEffort;
  /** Null when the model has no usage window (pay per use, local). */
  quota: CandidateQuota | null;
  /** A quota it draws on is actually exhausted. */
  blocked: boolean;
  confidence: Confidence;
  /** Set when usage could not be evaluated (unknown, very stale, no matching pool, no usage window). */
  usageNote?: string;
  /** An older release kept only because a preference or --use names it: never routed automatically. */
  explicitOnly?: true;
  /** The launch effort is the one encoded in an effort-variant id named by --use or by the tier's preference, not the planned one. */
  effortNamedBy?: NamedLaunch['by'];
}

/** A launch id the Orchestrator (--use) or the user (the tier's preference) names, which may be an effort variant. */
interface NamedLaunch {
  id: string;
  by: 'use' | 'preference';
}

/** Informational reason for a manually preferred model whose benchmark data is missing on a needed axis (Fix #6). */
export const PREFERRED_UNVERIFIED = 'Manually preferred model; benchmark data unavailable. Task coverage could not be verified.';
/** The same for a model the Orchestrator names with --use and the user has not preferred. */
export const CHOSEN_UNVERIFIED = 'Explicitly chosen model (--use); benchmark data unavailable. Task coverage could not be verified.';

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

/** The capacity a decision reserves: what the reservation ledger records for the worker. */
export interface ReservationSpec {
  agent: AgentId;
  model: string;
  tier: BufferTier;
  effort: BufferEffort;
  scope: string;
  /** Every window the model is declared to draw on (canonical keys), whether or not it is reported now. */
  pools: string[];
  snapshotAt: number | null;
  /** The account and plan the usage was read for at allocation, when known. */
  account?: string;
  plan?: string;
}

/** The effort to ask for: an explicit --effort, else the demand through the policy, else the requested tier's default. */
function effortPlan(req: RoutingRequest, config: Config): EffortPlan {
  if (req.effort) return { source: 'explicit', target: req.effort };
  if (req.demand) {
    return { source: 'demand', demand: req.demand, policy: config.effortPolicy, target: DEMAND_EFFORT[config.effortPolicy][req.demand] };
  }
  return { source: 'tier-default', target: config.defaultEffort[req.tier] };
}

/** The efforts a launch can ask for: the flag values the model supports, or its effort variants. */
function offeredEfforts(model: LaunchModel): Effort[] {
  const efforts = model.launch.kind === 'flag' ? model.efforts : (Object.keys(model.launch.ids) as Effort[]);
  return [...efforts].sort((a, b) => EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b));
}

/** Whether a launch can apply exactly this effort (a flag the model supports, or an effort variant). */
export function canApplyEffort(model: LaunchModel, effort: Effort): boolean {
  return offeredEfforts(model).includes(effort);
}

/**
 * The effort a model would run a job at, and whether that satisfies the request. Each provider's own scale
 * is used: the target when the model offers it, else the next higher level it offers, never a lower one.
 * - An explicit --effort must be offered exactly.
 * - A demand (--demand) is satisfied only by an offered effort at or above its target. A model whose effort
 *   cannot be set satisfies it when its reported default is at or above the target; an unreported default
 *   satisfies only the lowest demand.
 * - Without either, the tier default is a preference, not a requirement: the nearest offered effort is used.
 */
export function chooseEffort(model: LaunchModel, plan: EffortPlan): { effort: Effort | null; short?: string } {
  const rank = (e: Effort) => EFFORT_LADDER.indexOf(e);
  const offered = offeredEfforts(model);
  const { target } = plan;
  if (plan.source === 'explicit') {
    if (offered.includes(target)) return { effort: target };
    return { effort: null, short: `does not support effort ${target} (${supportedEfforts(model)})` };
  }
  if (offered.length === 0) {
    const own = model.defaultEffort;
    // A known default must reach the target (a default of none or minimal does not satisfy a low demand);
    // an unreported default is trusted with the lowest demand only.
    const satisfied = plan.source === 'tier-default' || (own === undefined ? plan.demand === DEMANDS[0] : rank(own) >= rank(target));
    return satisfied ? { effort: null } : { effort: null, short: `effort cannot be set (${model.agent} decides, default ${own ?? 'not reported'}); ${target} needed` };
  }
  const atLeast = offered.find((e) => rank(e) >= rank(target));
  if (atLeast) return { effort: atLeast };
  const highest = offered[offered.length - 1];
  if (plan.source === 'tier-default') return { effort: highest };
  return { effort: highest, short: `highest effort ${highest} is below ${target} (${supportedEfforts(model)})` };
}

type Skipped = Decision['skipped'];

const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low'];

type RoutingRequest = Omit<RouteRequest, 'tier' | 'needs'> & { tier: Tier; needs: Needs; needsSource: 'need' | 'tier' };

export interface RoutePlan {
  decision: Decision;
  /** The capacity to reserve for the routed worker; absent when nothing was routed or the route has no usage window. */
  reserve?: ReservationSpec;
}

/**
 * The route for a job. Last-resort agents (`lastResortAgents`, OpenCode by default) are left out first; they
 * are tried only when that finds no route, and then with a warning. Naming one with `--agent`, or
 * preferring it for the requested tier, makes it an ordinary agent for that route.
 */
export function route(req: RouteRequest, env: Environment, config: Config): Decision {
  return planRoute(req, env, config).decision;
}

/** `route`, plus what the decision reserves. Reserving is the caller's job (see routing/allocate.ts). */
export function planRoute(req: RouteRequest, env: Environment, config: Config): RoutePlan {
  if ((req.tier === undefined) === (req.needs === undefined)) throw new Error('use exactly one of needs or tier');
  const needs = req.needs ?? needsFromTier(req.tier!);
  const request: RoutingRequest = { ...req, tier: req.tier ?? tierOfNeeds(needs), needs, needsSource: req.needs ? 'need' : 'tier' };
  const plan = selectRoute(request, env, config);
  const { decision } = plan;
  if (Object.hasOwn(config.tierOverrides, 'auto')) decision.warnings.push('tierOverrides.auto is ignored: Cursor auto has no model profile');
  if (req.tierReason) {
    decision.tierReason = req.tierReason;
    decision.reasons.push(`task tier ${request.tier}: ${req.tierReason}`);
  }
  return plan;
}

function selectRoute(req: RoutingRequest, env: Environment, config: Config): RoutePlan {
  const pinned = config.pins[req.tier]?.agent;
  const lifted = (a: AgentId) => req.agents?.includes(a) || a === pinned || req.use?.agent === a;
  const deferred = config.lastResortAgents.filter((a) => !lifted(a));
  const usable = (a: AgentId) => env.discoveries.some((d) => d.agent === a && !agentSkipReason(d, env, config, req));
  if (!deferred.some(usable)) return routeOnce(req, env, config, []);
  const first = routeOnce(req, env, config, deferred);
  if (first.decision.status === 'ok') return first;
  const second = routeOnce(req, env, config, []);
  if (first.decision.status === 'none' && second.decision.status === 'decide') {
    // Nothing else can take the job and the last resort cannot take it automatically either (high risk, lower
    // requirements): its WAIT, USE and LOWER go to the Orchestrator instead of "nothing can take the job".
    const offered = [...(second.decision.options?.use ?? []), ...(second.decision.options?.lower ?? [])].filter((o) => deferred.includes(o.agent));
    for (const o of offered) o.lastResort = true;
    const names = [...new Set(offered.map((o) => o.agent))];
    const who = names.length > 0 ? names : deferred.filter(usable);
    second.decision.warnings.push(`${who.join(', ')} ${who.length === 1 ? 'is a last-resort agent' : 'are last-resort agents'} (lastResortAgents), offered as nothing else can take the job`);
    return second;
  }
  const last = second.decision.route;
  if (second.decision.status !== 'ok' || !last || !deferred.includes(last.agent)) return first;
  const billing = billingOf(second.decision, env);
  const options = first.decision.options;
  if (options && options.use.length > 0) {
    // Another agent can still take the job at elevated risk: that is the Orchestrator's call, with the last resort as one more option.
    const fallback: RouteOption = {
      agent: last.agent, model: last.model, effort: last.effort, tier: second.decision.tier ?? null, quota: second.decision.quota ?? null,
      reason: `last-resort agent (lastResortAgents): ${billing}`, use: useFlag(last.agent, last.model), lastResort: true,
    };
    options.use.push(fallback);
    // The text output lists the options from the reasons: the new one goes after the other USE lines.
    const reasons = first.decision.reasons;
    const lastUse = reasons.map((line) => line.startsWith('USE: ')).lastIndexOf(true);
    const skippedAt = reasons.findIndex((line) => line.startsWith('skipped: '));
    reasons.splice(lastUse >= 0 ? lastUse + 1 : skippedAt >= 0 ? skippedAt : reasons.length, 0, useLine(fallback));
    return first;
  }
  const wait = options?.wait;
  const instead = wait?.until !== undefined ? `instead of waiting ${duration(wait.until - env.now)}` : 'as nothing else can take it';
  second.decision.warnings.push(`${last.agent} is a last-resort agent (lastResortAgents), used ${instead}: ${billing}`);
  return second;
}

function billingOf(d: Decision, env: Environment): string {
  const m = env.discoveries.find((x) => x.agent === d.route?.agent)?.models.find((x) => launchIds(x).includes(d.route!.model));
  return m?.billing ?? 'no usage window';
}

const useFlag = (agent: AgentId, model: string): string => `--use ${agent}/${model}`;

/**
 * Whether a decision's route is the one the tier's preference names: its agent, and its model (under any of its
 * launch ids) when the preference names one. Such a route is the user's own choice for the tier, also when it is
 * an upgrade; `status` and `setup` show it where they leave an automatic upgrade to its own tier.
 */
export function isPreferredRoute(d: Pick<Decision, 'route'>, pin: Preference | undefined, env: Pick<Environment, 'discoveries'>): boolean {
  const routed = d.route;
  if (!routed || !pin || routed.agent !== pin.agent) return false;
  if (!pin.model) return true;
  const model = env.discoveries.find((x) => x.agent === pin.agent)?.models.find((m) => launchIds(m).includes(routed.model));
  return model !== undefined && launchIds(model).includes(pin.model);
}

/** Statuses a route may be taken at without asking: below the high-risk threshold, or with usage that cannot be read. */
const AUTOMATIC: readonly Standing[] = ['available', 'caution', 'unknown', 'untracked'];
type Standing = QuotaStatus | 'untracked';
const STANDING_ORDER: readonly Standing[] = ['available', 'caution', 'unknown', 'untracked', 'high', 'reserved', 'exhausted'];
const standing = (c: Candidate): Standing => (c.quota === null ? 'untracked' : c.quota.status);

function routeOnce(req: RoutingRequest, env: Environment, config: Config, deferred: readonly AgentId[]): RoutePlan {
  const skipped: Skipped = [];
  const agents = eligibleAgents(req, env, config, skipped, deferred);
  const plan = effortPlan(req, config);
  const { candidates: all, fallback } = collectCandidates(agents, env, config, req, plan, skipped);
  // Ranked models that compete automatically; older releases kept for a preference or --use stay out.
  const named = all.filter((c) => !c.explicitOnly && c.tier !== null && c.model.profile.class !== null);
  const requested = req.tier;
  const warnings: string[] = [];
  // Eligible: meets every capability need and can apply an effort that satisfies the request.
  const eligible = rankCandidates(named.filter((c) => c.quality?.covers === true && !c.effortShort));
  const ineligible = named.filter((c) => c.unknown.length === 0 && (c.quality?.covers === false || !!c.effortShort));
  const needLine = `needs ${AXES.map((axis) => `${axis}=${req.needs[axis]}`).join(' ')}${req.needsSource === 'tier' ? ` from tier ${requested}` : ''}; eligible routes: ${eligible.length} across all cost tiers`;
  for (const c of named) {
    for (const { axis, score, cut } of c.below) skipped.push({ agent: c.model.agent, model: c.model.modelId, reason: `below need on ${axis} (${score ?? 'unranked'} < ${cut})` });
    if (c.unknown.length > 0) skipped.push({ agent: c.model.agent, model: c.model.modelId, reason: `unranked: no evidence or estimate (${c.unknown.join(', ')})` });
    if (c.quality?.covers === true && c.effortShort) skipped.push({ agent: c.model.agent, model: c.model.modelId, reason: c.effortShort });
  }
  const consideredAgents = new Set(agents.map((a) => a.agent));
  const buckets = buildQuotaView(env.usage, env.reservations ?? [], config, env.now).buckets.filter((b) => consideredAgents.has(b.agent));
  const base = (): Decision => ({
    status: 'none', requestedTier: requested, needs: req.needs, needsSource: req.needsSource, downgraded: false, upgraded: false,
    buckets, reasons: [], warnings, alternatives: [], skipped,
  });
  const skippedLine = (list: Skipped = skipped): string[] => list.length ? [`skipped: ${list.map((s) => `${s.agent}${s.model ? ` ${s.model}` : ''} (${s.reason})`).join(', ')}`] : [];

  const pin = config.pins[requested];
  // An explicit model preference for this tier names the candidate (an agent-only preference names no model).
  const pinned = (c: Candidate): boolean => !!pin?.model && c.model.agent === pin.agent && launchIds(c.model).includes(pin.model);
  // A preferred model held back only by preferRiskLimit, when automatic routing would never offer it: it goes
  // back to the Orchestrator as a USE option (and with WAIT), never into automatic routing or LOWER.
  let held: { cand: Candidate; over: CandidateBucket } | undefined;
  // A quota that would be fully reserved is never taken automatically, however high the user set the limit:
  // at 100% the preference goes back to the Orchestrator (WAIT or USE).
  const preferLimit = Math.min(config.preferRiskLimit, 100);
  const overPreferLimit = (b: CandidateBucket): boolean => b.prospectiveStatus === 'reserved' || (b.prospective !== null && b.prospective >= preferLimit);
  const preferLimitText = config.preferRiskLimit > 100 ? `limit 100%: preferRiskLimit ${config.preferRiskLimit}% never takes a fully reserved quota` : `limit ${preferLimit}%`;
  // A preference naming an effort variant (`claude-sonnet-5-5-high`) launches that variant. It is a candidate of
  // its own, so the model's automatic candidate keeps the planned effort when the preference is not taken.
  const automaticOf = new Map<Candidate, Candidate>();
  const asPreferred = (c: Candidate): Candidate => {
    if (!pin?.model || c.launch.model === pin.model || variantEffort(c.model, pin.model, plan) === undefined) return c;
    const variant: Candidate = { ...evaluate(c.model, env, config, req.needs, plan, { id: pin.model, by: 'preference' }), ...(c.explicitOnly ? { explicitOnly: true as const } : {}) };
    automaticOf.set(variant, c);
    return variant;
  };
  /** The model's automatic candidate: the candidate itself unless it is the variant a preference names. */
  const automaticSelf = (c: Candidate): Candidate => automaticOf.get(c) ?? c;
  /** The automatic candidate of the held preference's model, which is offered once: as the preference. */
  const heldModel = (): Candidate | undefined => (held ? automaticSelf(held.cand) : undefined);
  /** Why coverage could not be checked: benchmark data is missing on a needed axis. Undefined when it was checked. */
  const coverageNote = (c: Candidate, how: 'automatic' | 'preferred' | 'chosen'): string | undefined => {
    if (c.quality === null || c.unknown.length === 0 || how === 'automatic') return undefined;
    return how === 'preferred' || pinned(c) ? PREFERRED_UNVERIFIED : CHOSEN_UNVERIFIED;
  };

  const finish = (cand: Candidate, how: 'automatic' | 'preferred' | 'chosen'): RoutePlan => {
    const chosen = cand.launch;
    const effort = effortResolution(cand, plan, chosen);
    const quality = cand.quality;
    const down = quality !== null && quality.covers === false;
    const note = coverageNote(cand, how);
    const up = quality?.covers === true && cand.tier !== null && TIERS.indexOf(cand.tier) > TIERS.indexOf(requested)
      && !eligible.some((c) => TIERS.indexOf(c.tier!) <= TIERS.indexOf(requested));
    const others = eligible.filter((c) => c !== automaticSelf(cand));
    const finalSkipped = skipped.filter((s) => !(s.agent === cand.model.agent && s.model === cand.model.modelId));
    const reasons = [`${cand.model.agent} ${chosen.model}: ${describe(cand, env.now)}`, needLine];
    if (quality?.cost) {
      const { tier, blended, source } = quality.cost;
      const sourceText = { override: 'your override', price: 'maker price', family: 'family hint', lineup: "provider's lineup", evidence: 'evidence class' }[source];
      const price = blended === null ? `${sourceText}, no price` : `$${blended.toFixed(2)}/M blended, ${sourceText}`;
      reasons.push(`cost: ${tier} (${price})`);
    }
    if (quality) reasons.push(AXES.map((axis) => `${axis} ${quality.axes[axis].score ?? 'unranked'} ${quality.axes[axis].evidence}`).join(', '));
    else reasons.push('cursor auto: capability unknown, Cursor picks the model');
    if (cand.model.agent === 'opencode') reasons.push('opencode: Orca takes --model for OpenCode only in an existing worktree (--worktree current or a selector)');
    if (how === 'preferred') {
      reasons.push(`preferred route, ${cand.quota ? statusText(cand.quota.status) : 'no usage window'}`);
      if (note) reasons.push(note);
      if (down) reasons.push(`preferred route does not cover the job: ${cand.below.map(({ axis, score, cut }) => `${axis} ${score ?? 'unranked'} < ${cut}`).join(', ')}`);
    }
    if (how === 'chosen') {
      reasons.push(`chosen by the Orchestrator (${useFlag(cand.model.agent, chosen.model)}): risk thresholds and requirements were not applied`);
      if (note) reasons.push(note);
    }
    reasons.push(effortText(effort, cand));
    if (down) {
      reasons.push(`downgraded from ${requested}: ${how === 'preferred' ? 'preferred route does not cover the job' : 'chosen route does not cover the job'}`);
      warnings.push(`${cand.model.modelId} falls short of the job's needs by ${quality!.shortfall} band step${quality!.shortfall === 1 ? '' : 's'} (${cand.below.map(({ axis }) => axis).join(', ')}); effort is not raised to make up for it: split the job or add stronger checks`);
    }
    if (cand.effortShort && how !== 'automatic') warnings.push(`${cand.model.modelId} ${cand.effortShort}`);
    if (up) {
      reasons.push(`upgraded from ${requested}: no model in the ${requested} cost tier covers the job`);
      warnings.push(`no model in the ${requested} cost tier covers the job; using ${cand.tier}`);
    }
    const state = standing(cand);
    for (const b of cand.quota?.buckets ?? []) {
      if (b.prospectiveStatus === 'available' || b.prospectiveStatus === 'unknown') continue;
      warnings.push(`${displayPool(b.pool)} quota would be ${percentText(b.prospective!)} used with this worker (${statusText(b.prospectiveStatus)}); ${resetText(b, env.now)}`);
    }
    if (state === 'unknown') {
      const partial = cand.quota?.buckets.some((b) => b.reported !== null) ?? false;
      warnings.push(`usage of ${cand.model.agent} is unknown: ${cand.usageNote ?? 'not reported'}; routed without a ${partial ? 'complete ' : ''}quota check`);
    }
    if (how === 'automatic') reasons.push(selectionText(cand, eligible, config));
    const next = others.find((c) => AUTOMATIC.includes(standing(c)));
    if (next) {
      const price = next.quality?.cost?.blended;
      const cost = price == null ? `${next.tier} cost tier` : `$${price.toFixed(2)}/M blended`;
      reasons.push(`next best: ${next.model.agent} ${next.launch.model} (${summary(next)}, ${cost})`);
    }
    reasons.push(...skippedLine(finalSkipped));
    const usage = env.usage[cand.model.agent];
    // Every declared window, always: one missing from this snapshot still counts against the worker when it reappears.
    const pools = [...new Set(cand.model.poolNames.map(poolKey))];
    return {
      decision: {
        ...base(), skipped: finalSkipped, status: 'ok', tier: cand.tier ?? undefined, quality,
        source: quality === null ? 'auto' : cand.model.profile.hint?.source ?? 'evidence',
        downgraded: down, upgraded: up,
        ...(note ? { coverageNote: note } : {}),
        route: { agent: cand.model.agent, model: chosen.model, effort: chosen.effort },
        effort, launchArgs: chosen.args,
        confidence: quality === null && cand.confidence === 'high' ? 'medium' : cand.confidence,
        quota: cand.quota, reasons,
        alternatives: others.slice(0, 5).map((c) => alternative(c, env.now)),
      },
      ...(pools.length > 0 ? {
        reserve: {
          agent: cand.model.agent, model: chosen.model, tier: cand.bufferTier, effort: cand.bufferEffort,
          scope: scopeOf(usage), pools, snapshotAt: usage?.updatedAt ?? null,
          ...(usage?.account !== undefined ? { account: usage.account } : {}),
          ...(usage?.plan !== undefined ? { plan: usage.plan } : {}),
        },
      } : {}),
    };
  };

  // USE: the Orchestrator names the route itself.
  if (req.use) {
    const { agent, model } = req.use;
    const pick = [...all, ...(fallback ? [fallback] : [])].find((c) => c.model.agent === agent && launchIds(c.model).includes(model));
    if (!pick) {
      const gone = skipped.find((s) => s.agent === agent && (!s.model || s.model === model));
      return { decision: { ...base(), reasons: [`${useFlag(agent, model)}: not available${gone ? ` (${gone.reason})` : ''}`, needLine, ...skippedLine()] } };
    }
    if (!pick.blocked) return finish(pick, 'chosen');
    return { decision: { ...base(), status: 'decide', options: decisionOptions([pick], [], undefined), reasons: [`${useFlag(agent, model)}: quota exhausted (${blockers(pick, env.now)})`, needLine, ...skippedLine()] } };
  }

  const automatic = eligible.find((c) => AUTOMATIC.includes(standing(c)));

  if (pin) {
    // An explicit model preference may name an unranked or non-covering model; an agent-only one takes the agent's best eligible route.
    const isPin = (c: Candidate) => c.model.agent === pin.agent && (pin.model ? launchIds(c.model).includes(pin.model) : true);
    const mine = (pin.model ? all.filter(isPin) : eligible.filter(isPin)).map(asPreferred);
    const able = mine.filter((c) => !c.effortShort);
    const match = able.find((c) => !c.blocked) ?? able[0];
    const label = `preferred ${pin.agent}${pin.model ? ` ${pin.model}` : ''}`;
    if (!match && mine.length > 0) warnings.push(`${label} skipped: ${mine[0].effortShort}`);
    else if (!match) {
      const gone = skipped.find((s) => s.agent === pin.agent && (!s.model || !pin.model || s.model === pin.model));
      const none = !pin.model && named.some((c) => c.model.agent === pin.agent) ? 'none of its models is eligible for the job' : `not available${gone ? ` (${gone.reason})` : ''}`;
      warnings.push(`${label} skipped: ${none}`);
    } else if (match.blocked) warnings.push(`${label} skipped: quota exhausted (${blockers(match, env.now)})`);
    else {
      const over = match.quota?.buckets.find(overPreferLimit);
      if (!over) return finish(match, 'preferred');
      // Automatic routing never offers a preferred variant, nor a model that is not eligible: those are held for USE.
      if (automaticOf.has(match) || !eligible.includes(match)) held = { cand: match, over };
      warnings.push(`${label} skipped: ${displayPool(over.pool)} would be ${percentText(over.prospective!)} used with this worker (${preferLimitText}); ${resetText(over, env.now)}`);
    }
  }

  if (automatic) return finish(automatic, 'automatic');

  // Nothing can be routed automatically: the decision goes back to the Orchestrator.
  const lower = rankCandidates(ineligible.filter((c) => c !== heldModel())).sort((a, b) => shortfallOf(a) - shortfallOf(b));
  const options = decisionOptions(eligible, lower, config.cursorAuto ? fallback : undefined);
  const reasons: string[] = [];
  if (agents.length === 0) reasons.push('no usable agent');
  else if (held && eligible.length === 0) {
    reasons.push(`preferred ${pin!.agent} ${pin!.model} is over the ${preferLimit}% preference limit and no other route can take the job automatically`);
  } else if (eligible.length > 0) {
    reasons.push(`no eligible route is below the ${config.riskThresholds.highPercent}% risk threshold: ${eligible.slice(0, 6).map((c) => `${c.model.agent} ${c.model.modelId} (${summary(c)})`).join(', ')}`);
  } else if (req.effort && named.some((c) => c.quality?.covers)) {
    const offered = named.filter((c) => c.quality?.covers).slice(0, 6).map((c) => `${c.model.agent} ${c.model.modelId} (${supportedEfforts(c.model)})`).join(', ');
    reasons.push(`no ${requested} route supports effort ${req.effort}: ${offered}`, 'choose one of these efforts, or route without --effort');
  } else if (named.some((c) => c.quality?.covers)) {
    reasons.push(`no route that covers the job can apply effort ${plan.target}${plan.demand ? ` (${plan.demand} demand)` : ''}`);
  } else reasons.push('no model covers the job');
  reasons.push(needLine);
  const decide = options.wait !== null || options.use.length > 0 || options.lower.length > 0;
  if (decide) reasons.push(...optionLines(options, env.now));
  reasons.push(...skippedLine());
  return {
    decision: {
      ...base(), status: decide ? 'decide' : 'none', ...(decide ? { options } : {}), reasons,
      alternatives: eligible.slice(0, 5).map((c) => alternative(c, env.now)),
    },
  };

  function decisionOptions(suitable: Candidate[], lowerCandidates: Candidate[], auto: Candidate | undefined): DecisionOptions {
    const option = (c: Candidate, reason: string): RouteOption => ({
      agent: c.model.agent, model: c.launch.model, effort: c.launch.effort, tier: c.tier, quota: c.quota, reason, use: useFlag(c.model.agent, c.launch.model),
    });
    const others = suitable.filter((c) => c !== heldModel());
    const use = others.filter((c) => !c.blocked && !AUTOMATIC.includes(standing(c))).map((c) => option(c, summary(c)));
    if (held) {
      // The user's preference comes first: it is what they asked for, held back only by their own limit.
      const { cand, over } = held;
      const short = cand.below.length > 0 ? `; does not cover the job: ${shortfallText(cand)}` : '';
      const note = coverageNote(cand, 'preferred');
      use.unshift({
        ...option(cand, `preferred route, ${displayPool(over.pool)} ${percentText(over.prospective!)} prospective is at or above the ${preferLimit}% preference limit${short}`),
        preferred: true, ...(note ? { coverageNote: note } : {}),
      });
    }
    const lowerOptions = lowerCandidates.filter((c) => AUTOMATIC.includes(standing(c))).slice(0, 5)
      .map((c) => ({ ...option(c, summary(c)), shortfall: shortfallText(c) }));
    if (auto && AUTOMATIC.includes(standing(auto))) lowerOptions.push({ ...option(auto, summary(auto)), shortfall: 'capability unknown: Cursor picks the model' });
    const holding = others.filter((c) => c.quota !== null && !AUTOMATIC.includes(c.quota.status)).map((c) => ({ cand: c, buckets: blockingBuckets(c) }));
    if (held) holding.unshift({ cand: held.cand, buckets: held.cand.quota!.buckets.filter(overPreferLimit) });
    return { wait: waitOption(holding, env.now), use: use.slice(0, 5), lower: lowerOptions };
  }
}

/** Band steps a route falls short by; a route that only lacks the effort counts as one step. */
const shortfallOf = (c: Candidate): number => (c.quality?.shortfall ?? 0) + (c.effortShort ? 1 : 0);

function shortfallText(c: Candidate): string {
  const parts = c.below.map(({ axis, score, cut }) => `below need on ${axis} (${score ?? 'unranked'} < ${cut})`);
  if (c.effortShort) parts.push(c.effortShort);
  return parts.join('; ');
}

/** Buckets holding a route back from automatic routing: high risk, fully reserved or exhausted. */
const blockingBuckets = (c: Candidate): CandidateBucket[] =>
  c.quota!.buckets.filter((b) => b.prospectiveStatus === 'high' || b.prospectiveStatus === 'reserved' || b.prospectiveStatus === 'exhausted');

/**
 * WAIT: what waiting can bring, for each route held back with the buckets holding it back. A reset time is
 * named only when every bucket holding a route back reports one; otherwise no time is given. Capacity held
 * by reservations frees with a fresh usage snapshot.
 */
function waitOption(held: { cand: Candidate; buckets: CandidateBucket[] }[], now: number): DecisionOptions['wait'] {
  if (held.length === 0) return null;
  const times = held.map(({ buckets }) => {
    const resets = buckets.map((b) => b.resetsAt);
    return resets.length > 0 && resets.every((t): t is number => t !== null && t > now) ? Math.max(...resets) : undefined;
  }).filter((t): t is number => t !== undefined);
  const until = times.length > 0 ? Math.min(...times) : undefined;
  const reservedPoints = Math.max(0, ...held.flatMap(({ buckets }) => buckets.map((b) => b.reserved)));
  const parts: string[] = [];
  if (until !== undefined) parts.push(`the earliest quota reset is in ${duration(until - now)}`);
  else parts.push('no reset time is reported for the quota holding these routes back');
  if (reservedPoints > 0) parts.push(`up to ${pointsText(reservedPoints)} is temporarily reserved for allocated workers and frees with a fresh usage snapshot after they finish`);
  return { ...(until !== undefined ? { until } : {}), reason: parts.join('; ') };
}

/** One USE option as the text output shows it. */
const useLine = (u: RouteOption): string => `USE: ${u.agent} ${u.model} with ${u.use} (${u.reason})${u.coverageNote ? ` ${u.coverageNote}` : ''}`;

function optionLines(o: DecisionOptions, now: number): string[] {
  const lines: string[] = [];
  if (o.wait) lines.push(`WAIT: ${o.wait.until !== undefined ? `until ${new Date(o.wait.until).toISOString()} (${duration(o.wait.until - now)}); ` : ''}${o.wait.reason}`);
  for (const u of o.use) lines.push(useLine(u));
  for (const l of o.lower) lines.push(`LOWER: ${l.agent} ${l.model} takes the job with lower requirements: ${l.shortfall} (${l.reason})`);
  if (o.lower.length > 0) lines.push('to LOWER, route again with lower --need or --demand; to take one route as it is, add its --use flag');
  return lines;
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
function collectCandidates(agents: PlacedAgent[], env: Environment, config: Config, req: RoutingRequest, plan: EffortPlan, skipped: Skipped): { candidates: Candidate[]; fallback?: Candidate } {
  const models: PlacedModel[] = [];
  let fallback: Candidate | undefined;
  const pin = config.pins[req.tier];
  // The tier's explicit model preference, or the Orchestrator's --use, names this model.
  const named = (model: PlacedModel) => [pin, req.use].some((choice) => choice?.agent === model.agent && choice.model !== undefined && launchIds(model).includes(choice.model));
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
        // Cursor picks the model, so it is never eligible on its own: it is offered as an option, or taken with --use.
        const auto = evaluate(model, env, config, req.needs, plan, undefined, true);
        if ((config.cursorAuto || req.use) && !auto.effortShort) fallback = auto;
        continue;
      }
      if (model.profile.class === null && !named(model)) {
        skipped.push({ agent: model.agent, model: model.modelId, reason: 'unranked: no evidence or estimate' });
        continue;
      }
      models.push(model);
    }
  }
  // An older release the preference or --use names survives, but only for that explicit choice.
  const newest = new Set(newestPerFamilyTier(models));
  const candidates = models.filter((model) => newest.has(model) || named(model)).map((model) => {
    const c = evaluate(model, env, config, req.needs, plan, req.use?.agent === model.agent ? { id: req.use.model, by: 'use' } : undefined);
    return newest.has(model) ? c : { ...c, explicitOnly: true as const };
  });
  return { candidates, fallback };
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


/**
 * The effort encoded in an effort-variant id named by --use or by the tier's preference, with why it does not
 * satisfy the request. Undefined when the id is not one of the model's variant ids (or is its base id): the
 * plan decides then.
 */
function variantEffort(model: LaunchModel, id: string | undefined, plan: EffortPlan): { effort: Effort; short?: string } | undefined {
  const { launch } = model;
  if (id === undefined || id === model.modelId || launch.kind !== 'variant') return undefined;
  const effort = (Object.keys(launch.ids) as Effort[]).find((e) => launch.ids[e] === id);
  if (effort === undefined) return undefined;
  const rank = (e: Effort) => EFFORT_LADDER.indexOf(e);
  const { target } = plan;
  if (plan.source === 'explicit' && effort !== target) return { effort, short: `runs at effort ${effort} encoded in ${id}, not the requested ${target}` };
  if (plan.source === 'demand' && rank(effort) < rank(target)) {
    return { effort, short: `runs at effort ${effort} encoded in ${id}, below ${target} needed for the ${plan.demand} demand` };
  }
  return { effort };
}

function evaluate(model: PlacedModel, env: Environment, config: Config, needs: Needs, plan: EffortPlan, namedLaunch?: NamedLaunch, auto = false): Candidate {
  const top = env.topBands ?? DEFAULT_TOP_BANDS;
  const adequacy = coverage(model.profile, needs, env.bands, top);
  const quality: Quality = {
    class: model.profile.class, cost: model.profile.cost, covers: adequacy.covers, shortfall: adequacy.shortfall, overshoot: adequacy.overshoot,
    evidence: jobEvidence(model.profile, needs),
    axes: Object.fromEntries(AXES.map((axis) => {
      const p = model.profile.axes[axis];
      return [axis, { score: p.score, band: p.band, evidence: p.label, benchmarks: p.benchmarks, need: needs[axis], cut: cutFor(needs[axis], env.bands[axis], top[axis]) }];
    })) as Quality['axes'],
  };
  const tier = model.profile.cost?.tier ?? null;
  // --use or a preference naming an effort variant launches that variant: its effort replaces the planned one.
  const named = variantEffort(model, namedLaunch?.id, plan);
  const choice = named ?? chooseEffort(model, plan);
  const launch = resolve(model, choice.effort);
  const bufferTier = bufferTierOf({ modelId: model.modelId, family: modelFamily(model.modelId, model.meta) }, tier, config.reservations);
  const bufferEffort = bufferEffortOf(launch.resolved, model.defaultEffort);
  const base: Candidate = {
    model, tier, quality: auto ? null : quality, below: adequacy.below, unknown: adequacy.unknown, weightedScore: needWeightedScore(model.profile, needs),
    launch, ...(choice.short ? { effortShort: choice.short } : {}), ...(named ? { effortNamedBy: namedLaunch!.by } : {}), bufferTier, bufferEffort,
    quota: null, blocked: false, confidence: 'low',
  };
  if (model.poolNames.length === 0) return { ...base, usageNote: `no usage window: ${model.billing ?? 'limits not tracked'}` };
  const quota = candidateQuota(env.usage[model.agent], model.poolNames, { tier: bufferTier, effort: bufferEffort }, env.reservations ?? [], config, env.now);
  // Confidence describes usage only; quality carries the certainty of the profile.
  const confidence: Confidence = quota.status === 'unknown' ? 'low' : quota.buckets.some((b) => b.stale) || env.usage[model.agent]?.retained ? 'medium' : 'high';
  return { ...base, quota, blocked: quota.status === 'exhausted', confidence, ...(quota.status === 'unknown' ? { usageNote: quota.note ?? 'usage unknown' } : {}) };
}

// --- ranking --------------------------------------------------------------------------------

/** The blended price to compare by; a route without a known price sorts after the priced ones. */
function priceOf(c: Candidate): number {
  return c.quality?.cost?.blended ?? Infinity;
}

/** Percentage points the route would reserve on its binding bucket. */
function bindingBuffer(c: Candidate): number {
  return c.quota?.buckets.find((b) => b.id === c.quota!.binding)?.buffer ?? 0;
}

/**
 * Quota first. Routes that may be taken automatically come before the rest; among them the bucket with the
 * most remaining effective capacity comes first; inside a bucket the most economical route comes first (the
 * smallest reservation, then the lowest price). The order is total, so equal inputs give equal results.
 */
function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(compareRanked);
}

function compareRanked(a: Candidate, b: Candidate): number {
  const state = STANDING_ORDER.indexOf(standing(a)) - STANDING_ORDER.indexOf(standing(b));
  if (state !== 0) return state;
  const ra = a.quota?.remaining ?? null, rb = b.quota?.remaining ?? null;
  if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
  if (ra !== null && rb !== null && ra !== rb) return rb - ra;
  const ba = a.quota?.binding ?? '', bb = b.quota?.binding ?? '';
  if (ba !== bb) return ba < bb ? -1 : 1;
  const buffer = bindingBuffer(a) - bindingBuffer(b);
  if (buffer !== 0) return buffer;
  const pa = priceOf(a), pb = priceOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
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

// --- launch resolution ----------------------------------------------------------------------

export function launchIds(m: LaunchModel): string[] {
  const ids = m.launch.kind === 'flag' ? [m.launch.model] : [...Object.values(m.launch.ids), ...(m.launch.defaultId ? [m.launch.defaultId] : [])];
  return [m.modelId, ...ids];
}

/** The launch that applies an effort: the --effort flag, the effort variant's id, or nothing when the agent decides. */
function resolve(model: LaunchModel, effort: Effort | null): Resolved {
  const { agent, launch, modelId } = model;
  if (launch.kind === 'flag') {
    const args = ['--agent', agent, '--model', launch.model, ...(effort ? ['--effort', effort] : [])];
    return { model: launch.model, effort, resolved: effort, applied: effort ? 'flag' : 'provider-default', args };
  }
  const variant = effort !== null && launch.ids[effort] !== undefined ? effort : null;
  const id = (variant && launch.ids[variant]) ?? launch.defaultId ?? modelId;
  return { model: id, effort: null, resolved: variant, applied: variant ? 'model-id' : 'provider-default', args: ['--agent', agent, '--model', id] };
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

/** e.g. "effort: high from high effort demand (balanced policy), passed as --effort". */
function effortText(e: EffortResolution, c: Candidate): string {
  const why = e.source === 'explicit' ? 'request' : e.source === 'demand' ? `${e.demand} effort demand (${e.policy} policy)` : 'tier default';
  if (e.applied === 'provider-default') {
    const own = e.providerDefault ? ` (${e.providerDefault})` : '';
    const who = `${c.model.agent} uses its own default${own}`;
    return `effort: not set, ${who}; ${e.target} wanted from ${why}`;
  }
  if (c.effortNamedBy) return `effort: ${e.resolved}, encoded in the model id named by ${c.effortNamedBy === 'use' ? '--use' : 'your preference'}; ${e.target} wanted from ${why}`;
  const how = e.applied === 'flag' ? 'passed as --effort' : 'chosen through the model id';
  const snapped = e.adjusted ? ` (${e.target} not offered, ${EFFORT_LADDER.indexOf(e.resolved!) > EFFORT_LADDER.indexOf(e.target) ? 'next higher' : 'nearest'} supported)` : '';
  const assumed = e.supportSource === 'assumed' ? '; supported levels assumed, not reported by the provider' : '';
  return `effort: ${e.resolved} from ${why}${snapped}, ${how}${assumed}`;
}

function alternative(c: Candidate, now: number): Alternative {
  return {
    agent: c.model.agent, model: c.launch.model, effort: c.launch.effort, tier: c.tier!, quality: c.quality!,
    quota: c.quota, confidence: c.confidence, blocked: c.blocked, reason: describe(c, now),
  };
}

// --- explanations ---------------------------------------------------------------------------

/** "resets in 14h", or "no reset time reported" when Orca gives none: a wait is never made up. */
function resetText(b: Pick<CandidateBucket, 'resetsAt'>, now: number): string {
  return b.resetsAt === null ? 'no reset time reported' : `resets in ${duration(b.resetsAt - now)}`;
}

/** The binding bucket first, then the others. */
function orderedBuckets(q: CandidateQuota): CandidateBucket[] {
  return [...q.buckets].sort((a, b) => (a.id === q.binding ? -1 : b.id === q.binding ? 1 : 0));
}

/**
 * Full account of a route's quota: for every bucket it draws on, reported usage, what is reserved, what this
 * worker would add and the prospective result, e.g.
 * "weekly 50% reported + 2 pp reserved (1 worker) + 1.5 pp for this worker = 53.5% prospective (available), resets in 14h".
 */
function describe(c: Candidate, now: number): string {
  if (c.quota === null || c.quota.buckets.length === 0) return c.usageNote ?? 'usage unknown';
  const parts = orderedBuckets(c.quota).map((b) => `${candidateBucketText(b)}, ${resetText(b, now)}`);
  const age = c.quota.buckets.find((b) => b.stale && b.snapshotAt !== null);
  if (age) parts.push(`usage ${duration(now - age.snapshotAt!)} old`);
  return parts.join('; ');
}

/** Short form for runner-ups and option lists: the binding bucket only. */
function summary(c: Candidate): string {
  if (c.quota === null) return c.usageNote ?? 'no usage window';
  const worst = [...c.quota.buckets].sort((a, b) => (b.prospective ?? -1) - (a.prospective ?? -1))[0];
  if (!worst || c.quota.status === 'unknown') return c.usageNote ?? 'usage unknown';
  return `${displayPool(worst.pool)} ${percentText(worst.prospective!)} prospective, ${statusText(c.quota.status)}`;
}

function blockers(c: Candidate, now: number): string {
  return (c.quota?.buckets ?? []).filter((b) => b.prospectiveStatus === 'exhausted')
    .map((b) => `${displayPool(b.pool)} ${percentText(b.reported!)} used, ${resetText(b, now)}`).join('; ');
}

/** Why this route: where its bucket ranks and which threshold it passed. */
function selectionText(c: Candidate, eligible: Candidate[], config: Config): string {
  const state = standing(c);
  if (c.quota === null || c.quota.binding === null) return `selection: ${state === 'untracked' ? 'no usage window to rank by' : 'usage unknown'}; taken as no route with known quota is below the ${config.riskThresholds.highPercent}% threshold`;
  const ranked = [...new Set(eligible.filter((x) => x.quota?.binding).map((x) => x.quota!.binding!))];
  const binding = c.quota.buckets.find((b) => b.id === c.quota!.binding)!;
  const position = ranked.indexOf(c.quota.binding) + 1;
  // The binding bucket is described by its own status; the route's may be worse when another window is unreadable.
  const own = binding.prospectiveStatus;
  const caution = config.riskThresholds.cautionPercent;
  const limit = own === 'available' ? `below the ${caution}% caution threshold`
    : own === 'caution' ? `in the caution range${state === 'caution' ? ` (no route is below ${caution}%)` : ''}`
    : `at ${statusText(own)}`;
  const unread = c.quota.status === 'unknown' ? c.quota.buckets.filter((b) => b.prospectiveStatus === 'unknown') : [];
  const unreadText = unread.length > 0
    ? `; ${unread.length} other window${unread.length === 1 ? '' : 's'} could not be read (${unread.map((b) => displayPool(b.pool)).join(', ')}), so the route counts as unknown`
    : '';
  return `selection: quota bucket ${c.model.agent} ${displayPool(binding.pool)} has ${percentText(binding.remaining!)} effective capacity left (bucket ${position} of ${ranked.length} with an eligible route); most economical eligible route in it ${limit}${unreadText}`;
}
