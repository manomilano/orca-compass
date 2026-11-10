#!/usr/bin/env node
import { recordHandout } from './routing/handouts.js';
import { cacheDir } from './paths.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AXES, parseSnapshot, type Axis, type SnapshotSource } from './evidence/snapshot.js';
import { readTextFile } from './placements/agents/deps.js';
import { modelFamily } from './placements/tiers.js';
import type { AxisProfile, Profile } from './placements/profiles.js';
import { parseNeeds } from './routing/needs.js';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  applyAgentChoice, ConfigError, isChosen, loadConfig, parsePercent, setBans, setPin, setPreferRiskLimit, updateConfigFile, writeAgentChoice, type AgentAction,
} from './config.js';
import { parseEffort } from './routing/effort.js';
import { poolState } from './routing/pace.js';
import { activeRejections } from './routing/rejection.js';
import { agentNotFamily, agentSkipReason, banMatches, enabledInOrca, formatLaunch, headroomText, launchIds, rejectedText, route } from './routing/router.js';
import {
  AGENT_IDS, DEMANDS, TIERS, type AgentId, type Demand, type Alternative, type Config, type Decision, type Effort, type Environment, type OrcaAgents,
  type PlacementTable, type Preference, type RouteRequest, type Tier,
} from './types.js';
import { gather, gatherEnvironment, loadPlacements, type Gathered, type GatherDeps } from './routing/environment.js';
import type { Staleness } from './placements/table.js';
import { runCommand } from './system/run.js';
import { configPath } from './paths.js';
import { readRejections, recordRejection, writeRejections } from './routing/rejections.js';
import { install, update, uninstall, type InstallDeps } from './install.js';
import { setupInfo, setupWizard, type Terminal } from './setup.js';
import { verifyWorker, type Verdict } from './verify.js';

export type MainDeps = GatherDeps & {
  /** The interactive terminal for `setup`; absent when stdin or stdout is not a TTY. */
  terminal?: Terminal;
  /** `verify` polls Orca with these; tests replace them. */
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  /** `install` runs its installers with these; tests replace them. */
  install?: InstallDeps;
};

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `usage: orcacompass <command> [options]

commands:
  install [-g|--global | -l|--local] [-y|--yes] [-a|--agent <name>]... [--skill-only]
                                       install or update the CLI, then its matching Skill
  update [same options as install]     get the latest release and matching Skill
  uninstall [same options as install]  remove the selected Skill; --global also removes the shared CLI
  route --need coding=<l>,agentic=<l>,reasoning=<l> | --tier <light|daily|advanced|frontier> [--no-downgrade] [--agent <id>]...
        [--exclude-agent <id>]... [--demand <low|moderate|high|exceptional>]
        [--effort <effort>] [--tier-reason <reason>] [--json]
  verify --dispatch <id> [--wait <seconds>] [--json]
                                       did a new worker's agent accept its model
  rejected [--clear] [--json]          models agents refused at launch (skipped)
  status [--json]
  ranking [--axis <coding|agentic|reasoning>] [--json]
                                       model profiles, strongest first
  tiers [--axis <axis>] [--json]       bands and models on each axis
  agents [--json]                     which agents are used, and why not
  agents disable|enable|only <id>... [--json]
  agents reset [--json]                use every agent again
  prefer [--json]                      preferred route per tier
  prefer <tier> <agent> [model] [--json]
  prefer clear <tier>|--all [--json]
  prefer --risk-limit <percent> [--json]
  ban [<model-or-family>...] [--json]  never route these models
  unban <model-or-family>... [--json]
  refresh [--json]                     refetch metadata and rebuild the placement table
  setup                                answer a few questions (needs a terminal)
  setup --json                         what the setup questions need, for a chat setup
  setup --complete [--json]            finish chat setup, including unchanged defaults
  setup --skip [--json]                keep the defaults and stop offering setup`;

class UsageError extends Error {}

function readConfig(io: IO): Config {
  return loadConfig(undefined, (m) => io.err(`warning: ${m}`));
}

/** Runs one command and returns the exit code: 0 answered, 1 usage error, 2 config error. */
export async function main(argv: string[], io: IO, deps: MainDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      io.out(USAGE);
      return 0;
    }
    if (command === 'route') return await routeCommand(rest, io, deps);
    if (command === 'verify') return await verifyCommand(rest, io, deps);
    if (command === 'rejected') return await rejectedCommand(rest, io, deps);
    if (command === 'status') return await statusCommand(rest, io, deps);
    if (command === 'ranking') return await rankingCommand(rest, io, deps);
    if (command === 'tiers') return await tiersCommand(rest, io, deps);
    if (command === 'agents') return await agentsCommand(rest, io, deps);
    if (command === 'prefer') return await preferCommand(rest, io, deps);
    if (command === 'ban') return await banCommand(rest, io, deps);
    if (command === 'unban') return await unbanCommand(rest, io, deps);
    if (command === 'refresh') return await refreshCommand(rest, io, deps);
    if (command === 'setup') return await setupCommand(rest, io, deps);
    if (command === 'install' || command === 'update' || command === 'uninstall') return await installCommand(command, rest, io, deps);
    throw new UsageError(command ? `unknown command: ${command}` : 'missing command');
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 1;
    }
    if (e instanceof ConfigError) {
      io.err(`config error: ${e.message}`);
      return 2;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

// --- route ----------------------------------------------------------------------------------

async function routeCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, {
    tier: { type: 'string' },
    need: { type: 'string' },
    'tier-reason': { type: 'string' },
    'no-downgrade': { type: 'boolean' },
    agent: { type: 'string', multiple: true },
    'exclude-agent': { type: 'string', multiple: true },
    effort: { type: 'string' },
    demand: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (v.tier === undefined && v.need === undefined) throw new UsageError('--need is required (or --tier as a shorthand)');
  if (v.tier !== undefined && v.need !== undefined) throw new UsageError('use either --need or --tier, not both');
  let request: RouteRequest;
  if (v.need !== undefined) {
    try { request = { needs: parseNeeds(v.need) }; }
    catch (e) { throw new UsageError((e as Error).message); }
  } else {
    const tier = v.tier!.toLowerCase() as Tier;
    if (!TIERS.includes(tier)) throw new UsageError(`unknown tier "${v.tier}" (expected ${TIERS.join(', ')})`);
    request = { tier };
  }
  const tierReason = v['tier-reason']?.trim();
  if (tierReason === '') throw new UsageError('--tier-reason must contain a short explanation');
  let effort: Effort | undefined;
  if (v.effort !== undefined) {
    effort = parseEffort(v.effort);
    if (!effort) throw new UsageError(`unknown effort "${v.effort}"`);
  }
  let demand: Demand | undefined;
  if (v.demand !== undefined) {
    demand = v.demand.toLowerCase() as Demand;
    if (!DEMANDS.includes(demand)) throw new UsageError(`unknown demand "${v.demand}" (expected ${DEMANDS.join(', ')})`);
  }
  // An unknown id is not an error: the route goes on and a warning suggests the id that was probably meant.
  const unknownAgents: string[] = [];
  const agentIds = (raw: string[] | undefined, flag: string, effect: string): AgentId[] | undefined => raw?.map((r) => {
    const id = r.toLowerCase() as AgentId;
    if (!AGENT_IDS.includes(id)) {
      const guess = suggestAgent(id);
      unknownAgents.push(`unknown agent "${r}" in ${flag}: ${effect} (${guess ? `did you mean ${guess}?` : `known: ${AGENT_IDS.join(', ')}`})`);
    }
    return id;
  });
  const agents = agentIds(v.agent, '--agent', 'not routed');
  const excludeAgents = agentIds(v['exclude-agent'], '--exclude-agent', 'nothing excluded for it');
  const req: RouteRequest = {
    ...request,
    ...(tierReason ? { tierReason } : {}),
    ...(v['no-downgrade'] ? { noDowngrade: true } : {}),
    ...(agents ? { agents } : {}),
    ...(excludeAgents ? { excludeAgents } : {}),
    ...(effort ? { effort } : {}),
    ...(demand ? { demand } : {}),
  };

  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  const d = route(req, env, config);
  d.warnings.push(...unknownAgents);
  if (d.status === 'ok' && d.route) {
    const chosen = d.route;
    const model = env.discoveries.find((a) => a.agent === chosen.agent)?.models.find((m) => launchIds(m).includes(chosen.model));
    if (model) {
      try { recordHandout({ at: env.now, agent: chosen.agent, model: chosen.model, pools: model.poolNames, needs: d.needs }, config.handoutMinutes, deps.cacheDir ?? cacheDir()); }
      catch (e) { d.warnings.push(`hand-out could not be saved: ${(e as Error).message}`); }
    }
  }
  if (v.json) {
    const sources = {
      evidenceSource: env.evidenceSource, catalogSource: env.evidenceSource, scoreSource: env.evidenceSource,
      placementsBuiltAt: env.placementsBuiltAt,
    };
    io.out(JSON.stringify({ ...d, launch: formatLaunch(d) ?? null, ...sources }, null, 2));
  }
  else io.out(decisionText(d, env.now).join('\n'));
  return 0;
}

/** Executable names people use for an agent, e.g. Cursor's CLI is `cursor-agent`. */
const AGENT_ALIASES: Record<string, AgentId> = { 'cursor-agent': 'cursor', agy: 'antigravity', 'claude-code': 'claude' };

/** The agent id an unknown id most likely meant: an executable alias, or a known id within two edits. */
function suggestAgent(id: string): AgentId | undefined {
  if (AGENT_ALIASES[id]) return AGENT_ALIASES[id];
  const distance = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  };
  let best: { id: AgentId; d: number } | undefined;
  for (const known of AGENT_IDS) {
    const d = distance(id, known);
    if (d <= 2 && (!best || d < best.d)) best = { id: known, d };
  }
  return best?.id;
}

function decisionText(d: Decision, now: number): string[] {
  let head: string;
  if (d.status === 'ok' && d.route) {
    const { agent, model, effort } = d.route;
    head = `${d.tier ?? d.requestedTier} → ${agent} · ${model}${effort ? ` · ${effort}` : ''} (${d.confidence} confidence)`;
  } else if (d.status === 'wait' && d.waitUntil !== undefined) {
    head = `${d.requestedTier} → wait until ${new Date(d.waitUntil).toISOString()} (in ${duration(d.waitUntil - now)})`;
  } else {
    head = `${d.requestedTier} → no route`;
  }
  const launch = formatLaunch(d);
  return [head, ...d.reasons.map((r) => `  ${r.startsWith('skipped:') ? skippedText(d.skipped) : r}`), ...d.warnings.map((w) => `  warning: ${w}`), ...(launch ? [launch] : [])];
}

/** Keep operational skips visible while bounding profile diagnostics in text only. */
function skippedText(skipped: Decision['skipped']): string {
  const full: string[] = [];
  const needs = new Map<string, string[]>();
  for (const s of skipped) {
    const name = `${s.agent}${s.model ? ` ${s.model}` : ''}`;
    if (/^(below need on |unranked:)/.test(s.reason)) {
      const reasons = needs.get(name) ?? [];
      reasons.push(s.reason);
      needs.set(name, reasons);
    } else full.push(`${name} (${s.reason})`);
  }
  for (const [name, reasons] of [...needs].slice(0, 6)) {
    const below = reasons.every((r) => r.startsWith('below need on '));
    const reason = below ? `below need on ${reasons.map((r) => r.replace(/^below need on (\w+) \((.*)\)$/, '$1 $2')).join(', ')}` : reasons.join(', ');
    full.push(`${name} (${reason})`);
  }
  if (needs.size > 6) full.push(`… ${needs.size - 6} more (route --json lists them)`);
  return `skipped: ${full.join(', ')}`;
}

// --- verify and rejected --------------------------------------------------------------------

async function verifyCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { dispatch: { type: 'string' }, wait: { type: 'string' }, json: { type: 'boolean' } });
  if (!v.dispatch) throw new UsageError('--dispatch <id> is required (the dispatchId worker-start printed)');
  const wait = v.wait === undefined ? 60 : Number(v.wait);
  if (!Number.isFinite(wait) || wait < 0 || wait > 60) throw new UsageError(`--wait must be between 0 and 60 seconds (got "${v.wait}")`);
  const config = readConfig(io);
  const clock = deps.clock ?? Date.now;
  const verdict = await verifyWorker(v.dispatch, {
    run: deps.run ?? runCommand,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    clock,
  }, { waitMs: wait * 1000 });
  let skipHours: number | undefined;
  if (verdict.status === 'rejected' && verdict.agent && verdict.model && verdict.message) {
    recordRejection({ agent: verdict.agent, model: verdict.model, message: verdict.message, at: clock() }, config.rejectionTtlHours);
    skipHours = config.rejectionTtlHours;
  }
  const next = verifyNext(verdict, skipHours);
  if (v.json) io.out(JSON.stringify({ ...verdict, ...(skipHours !== undefined ? { skippedForHours: skipHours } : {}), next }, null, 2));
  else io.out(verifyText(verdict, next).join('\n'));
  return 0;
}

/** What the coordinator does next, in order. */
function verifyNext(d: Verdict, skipHours: number | undefined): string[] {
  const retry = `start the replacement on the same Task: orca orchestration worker-start --task ${d.taskId ?? '<task_id>'} --retry-of ${d.dispatchId} --worktree <same placement> <new launchArgs> --json`;
  const cleanup = d.cleanup.map((argv) => argv.join(' ')).join(', then ');
  const exclude = `--exclude-agent ${d.agent ?? '<agent>'}`;
  switch (d.status) {
    case 'started':
    case 'reported':
      return ['nothing: wait for worker_done as usual'];
    case 'rejected':
      return [
        `clean up: ${cleanup}`,
        `route again with the same flags; ${d.agent} ${d.model} is skipped${skipHours !== undefined ? ` for ${skipHours}h` : ''}`,
        retry,
      ];
    case 'failed':
      return [
        `clean up: ${cleanup}`,
        `if the tail shows the agent failing to start, route again with ${exclude} for this job`,
        retry,
        'tell the user which agent failed to start, why, and how they can fix it',
      ];
    case 'stalled':
      return [
        'read the tail: the agent ended its turn without worker_done',
        `if it reports an error (model, account, limits): orca orchestration worker-stop --dispatch ${d.dispatchId} --json, then route again with ${exclude} and start the replacement with --retry-of ${d.dispatchId}`,
        'if it asks a question, answer it in its terminal; otherwise keep waiting',
      ];
    default:
      return ['keep waiting as usual; run verify again later or read the terminal'];
  }
}

function verifyText(d: Verdict, next: string[]): string[] {
  const who = d.agent && d.model ? `${d.agent} · ${d.model}` : d.dispatchId;
  const lines = [`${d.status}: ${who} — ${d.detail}`];
  if (d.message) lines.push(`  agent said: ${d.message}`);
  for (const l of d.tail ?? []) lines.push(`  | ${l}`);
  lines.push('next:', ...next.map((n, i) => `  ${i + 1}. ${n}`));
  return lines;
}

async function rejectedCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { clear: { type: 'boolean' }, json: { type: 'boolean' } });
  const config = readConfig(io);
  const now = deps.now ?? Date.now();
  const all = readRejections();
  if (v.clear) writeRejections([]);
  const active = v.clear ? [] : activeRejections(all, now, config.rejectionTtlHours);
  if (v.json) {
    io.out(JSON.stringify({ rejectionTtlHours: config.rejectionTtlHours, cleared: v.clear ? all.length : 0, rejections: active }, null, 2));
    return 0;
  }
  if (v.clear) io.out(`forgot ${all.length} refused model${all.length === 1 ? '' : 's'}`);
  else if (active.length === 0) io.out('no refused models');
  else {
    io.out([
      `refused at launch, skipped for ${config.rejectionTtlHours}h after:`,
      ...active.map((r) => `  ${r.agent} ${r.model}: ${rejectedText(r, now)}`),
    ].join('\n'));
  }
  return 0;
}

// --- status ---------------------------------------------------------------------------------

interface TierView {
  status: Decision['status'];
  pick?: { agent: string; model: string; effort: Effort | null; confidence?: string; reason: string };
  alternatives: Alternative[];
  warnings: string[];
  waitUntil?: number;
}

function buildStatus(gathered: Gathered, config: Config) {
  const { env, table } = gathered;
  const skipped = new Map<string, string>();
  const banned = new Map<string, { agent: string; model: string }>();
  const tiers = {} as Record<Tier, TierView>;
  for (const tier of TIERS) {
    const d = route({ tier, noDowngrade: true }, env, config);
    for (const s of d.skipped) {
      if (s.model) {
        if (s.reason === 'banned by you') banned.set(`${s.agent} ${s.model}`, { agent: s.agent, model: s.model });
      } else {
        skipped.set(s.agent, s.reason);
      }
    }
    // A structural upgrade belongs to another tier; this view lists only the tier's own candidates.
    const own = d.tier === undefined || d.tier === tier;
    const view: TierView = { status: own ? d.status : 'none', alternatives: own ? d.alternatives : [], warnings: own ? d.warnings : [] };
    if (own && d.route) {
      const prefix = `${d.route.agent} ${d.route.model}: `;
      const reason = d.reasons[0] ?? '';
      view.pick = { ...d.route, confidence: d.confidence, reason: reason.startsWith(prefix) ? reason.slice(prefix.length) : reason };
    }
    if (own && d.waitUntil !== undefined) view.waitUntil = d.waitUntil;
    tiers[tier] = view;
  }

  const agents = env.discoveries.map((disc) => {
    const u = env.usage[disc.agent];
    const usage = u && {
      status: u.status,
      ...(u.updatedAt !== undefined ? { updatedAt: u.updatedAt } : {}),
      ...(u.error ? { error: u.error } : {}),
      pools: Object.values(u.pools).map((p) => {
        const s = poolState(p, env.now, config.thresholds);
        return { ...p, headroom: Math.round(s.headroom * 100) / 100, expired: s.expired, blocked: s.blocked };
      }),
    };
    const reason = skipped.get(disc.agent);
    return {
      agent: disc.agent,
      installed: disc.installed,
      enabledInOrca: enabledInOrca(env.orcaAgents, disc.agent),
      models: disc.models.length,
      usage: usage ?? null,
      ...(disc.note ? { note: disc.note } : {}),
      ...(reason ? { skipped: reason } : {}),
    };
  });

  const unclassified: { agent: string; model: string }[] = [];
  for (const disc of env.discoveries) {
    for (const m of disc.models) {
      if (m.profile.class === null) unclassified.push({ agent: disc.agent, model: m.modelId });
    }
  }

  return {
    now: env.now,
    handouts: gathered.handouts,
    handoutMinutes: config.handoutMinutes,
    handoutPercent: config.handoutPercent,
    evidence: table.sources.evidence,
    placements: placementsView(gathered, env.now),
    orcaAgents: env.orcaAgents ?? null,
    agents,
    banned: [...banned.values()],
    rejected: env.rejections ?? [],
    tiers,
    unclassified,
  };
}

type Status = ReturnType<typeof buildStatus>;

function statusText(s: Status, sources: SnapshotSource[]): string[] {
  const { evidence, now } = s;
  const attribution = sources.length ? sources.map((s) => `${s.label}, ${s.license}, data of ${(s.dataDate ?? evidence.generatedAt).slice(0, 10)}`).join('; ')
    : `LLMBenchmark.ai, CC BY 4.0, data of ${evidence.generatedAt.slice(0, 10)}`;
  const lines = [
    `evidence: ${evidence.source}, ${evidence.models} models (${attribution}), fetched ${duration(now - evidence.fetchedAt)} ago`,
    ...placementsLines(s.placements, now),
    orcaAgentsLine(s.orcaAgents ?? undefined),
    'agents:',
  ];
  const width = Math.max(...s.agents.map((a) => a.agent.length));
  for (const a of s.agents) {
    const name = a.agent.padEnd(width);
    if (!a.installed) {
      lines.push(`  ${name}  not installed${a.note ? ` (${a.note})` : ''}`);
      continue;
    }
    const u = a.usage;
    const usage = !u ? 'no usage data' : u.status === 'ok' ? `usage ok${u.updatedAt !== undefined ? `, updated ${duration(now - u.updatedAt)} ago` : ''}` : `usage ${u.status}${u.error ? `: ${u.error}` : ''}`;
    lines.push(`  ${name}  ${a.models} models, ${usage}${a.skipped ? ` — skipped: ${a.skipped}` : ''}`);
    if (a.note) lines.push(`  ${' '.repeat(width)}  ${a.note}`);
    for (const p of u?.pools ?? []) {
      const state = p.expired ? ' (expired)' : p.blocked ? ' (blocked)' : '';
      lines.push(`    ${p.name.replace(/^bucket:/, '')}: ${percent(p.usedPercent)} used, resets in ${duration(p.resetsAt - now)}, headroom ${headroomText(p.headroom)}${state}`);
    }
  }
  if (s.handouts.length) lines.push(`hand-outs (last ${s.handoutMinutes}m): ${s.handouts.map((h) => `${h.agent} ${h.model} ${duration(now - h.at)} ago (${h.pools.map((p) => `${p.replace(/^bucket:/, '')} +${s.handoutPercent}%`).join(', ')})`).join('; ')}`);
  lines.push('tiers:');
  for (const tier of TIERS) {
    const t = s.tiers[tier];
    const label = tier.padEnd(8);
    if (t.pick) {
      const { agent, model, effort, confidence, reason } = t.pick;
      lines.push(`  ${label}  ${agent} · ${model}${effort ? ` · ${effort}` : ''} (${confidence}) — ${reason}`);
    } else if (t.status === 'wait' && t.waitUntil !== undefined) {
      lines.push(`  ${label}  all blocked; wait ${duration(t.waitUntil - now)}`);
    } else {
      lines.push(`  ${label}  no candidates`);
    }
    for (const w of t.warnings) lines.push(`  ${' '.repeat(8)}    warning: ${w}`);
    for (const alt of t.alternatives.slice(0, 3)) {
      lines.push(`  ${' '.repeat(8)}    alt: ${alt.agent} · ${alt.model}${alt.effort ? ` · ${alt.effort}` : ''}${alt.blocked ? ' (blocked)' : ''} — ${alt.reason}`);
    }
  }
  if (s.banned.length > 0) lines.push(`banned by you: ${s.banned.map((b) => `${b.agent} ${b.model}`).join(', ')}`);
  for (const r of s.rejected) lines.push(`skipped ${r.agent} ${r.model}, ${rejectedText(r, now)} (orcacompass rejected --clear forgets it)`);
  if (s.unclassified.length > 0) {
    lines.push(`unclassified (never routed): ${s.unclassified.length}`);
    const byAgent = new Map<string, string[]>();
    for (const u of s.unclassified) byAgent.set(u.agent, [...(byAgent.get(u.agent) ?? []), u.model]);
    // OpenCode can list hundreds of OpenRouter models; status --json has them all.
    for (const [agent, models] of byAgent) {
      const more = models.length > 15 ? `, … ${models.length - 15} more` : '';
      lines.push(`  ${agent}: ${models.slice(0, 15).join(', ')}${more}`);
    }
  }
  return lines;
}

async function statusCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { json: { type: 'boolean' } });
  const config = readConfig(io);
  const gathered = await gather(config, deps);
  const s = buildStatus(gathered, config);
  io.out(v.json ? JSON.stringify(s, null, 2) : statusText(s, snapshotSources(gathered.table, deps)).join('\n'));
  return 0;
}

// --- agents ---------------------------------------------------------------------------------

const ACTIONS: AgentAction[] = ['disable', 'enable', 'only', 'reset'];

function orcaAgentsLine(o: OrcaAgents | undefined): string {
  if (!o) return 'orca agent switches: not read; every installed agent counts as enabled';
  if (!o.known) return `orca agent switches: unknown (${o.reason}); every installed agent counts as enabled`;
  return `orca agent switches: read from ${o.source} (experimental); disabled: ${o.disabled.join(', ') || 'none'}`;
}

async function agentsCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const json = parsed.values.json === true;
  const [action, ...rawIds] = parsed.positionals;
  if (action === undefined) return listAgents(json, io, deps);
  if (!ACTIONS.includes(action as AgentAction)) throw new UsageError(`unknown agents action "${action}" (expected ${ACTIONS.join(', ')})`);
  if (action === 'reset' && rawIds.length > 0) throw new UsageError('agents reset takes no agent ids');
  if (action !== 'reset' && rawIds.length === 0) throw new UsageError(`agents ${action} needs at least one agent id (${AGENT_IDS.join(', ')})`);
  const ids = rawIds.map((id) => id.toLowerCase());
  const bad = rawIds.find((_, i) => !AGENT_IDS.includes(ids[i]));
  if (bad !== undefined) throw new UsageError(`unknown agent "${bad}" (known: ${AGENT_IDS.join(', ')})`);

  const next = applyAgentChoice(readConfig(io), action as AgentAction, ids);
  writeAgentChoice(next);
  const chosen = AGENT_IDS.filter((a) => isChosen(a, next));
  const notChosen = AGENT_IDS.filter((a) => !isChosen(a, next));
  if (json) {
    io.out(JSON.stringify({ configPath: configPath(), allowAgents: next.allowAgents ?? null, denyAgents: next.denyAgents, chosen, notChosen }, null, 2));
  } else {
    io.out([`wrote ${configPath()}`, `chosen: ${chosen.join(', ') || 'none'}`, `not chosen: ${notChosen.join(', ') || 'none'}`].join('\n'));
  }
  return 0;
}

async function listAgents(json: boolean, io: IO, deps: MainDeps): Promise<number> {
  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  const agents = env.discoveries.map((d) => {
    const usage = env.usage[d.agent];
    const reason = agentSkipReason(d, env, config);
    return {
      agent: d.agent,
      installed: d.installed,
      enabledInOrca: enabledInOrca(env.orcaAgents, d.agent),
      orcaUsage: usage?.status ?? 'unknown',
      ...(usage && usage.status !== 'ok' && usage.error ? { orcaUsageError: usage.error } : {}),
      chosen: isChosen(d.agent, config),
      used: reason === undefined,
      verdict: reason !== undefined ? `not used: ${reason}` : config.lastResortAgents.includes(d.agent) ? 'used as last resort' : 'used',
    };
  });
  if (json) {
    const choice = { configPath: configPath(), allowAgents: config.allowAgents ?? null, denyAgents: config.denyAgents };
    io.out(JSON.stringify({ orcaAgents: env.orcaAgents ?? null, ...choice, agents }, null, 2));
    return 0;
  }
  const yes = (b: boolean) => (b ? 'yes' : 'no');
  const rows = [
    ['agent', 'installed', 'enabled in Orca', 'Orca usage', 'chosen', 'verdict'],
    ...agents.map((a) => [a.agent, yes(a.installed), a.enabledInOrca, a.orcaUsage, yes(a.chosen), a.verdict]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = [orcaAgentsLine(env.orcaAgents), `config: ${configPath()}`, ''];
  for (const r of rows) lines.push(r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  '));
  io.out(lines.join('\n'));
  return 0;
}

// --- prefer ---------------------------------------------------------------------------------

const prefLabel = (p: Preference | undefined): string => (!p ? 'none' : p.model ? `${p.agent} ${p.model}` : `${p.agent} (its best model)`);

function parsePositionals(args: string[], options: NonNullable<ParseArgsConfig['options']>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function agentId(raw: string): AgentId {
  const id = raw.toLowerCase();
  if (!AGENT_IDS.includes(id)) throw new UsageError(`unknown agent "${raw}" (known: ${AGENT_IDS.join(', ')})`);
  return id;
}

function tierOf(raw: string): Tier {
  const tier = raw.toLowerCase() as Tier;
  if (!TIERS.includes(tier)) throw new UsageError(`unknown tier "${raw}" (expected ${TIERS.join(', ')})`);
  return tier;
}

async function preferCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const { values, positionals } = parsePositionals(args, { json: { type: 'boolean' }, all: { type: 'boolean' }, 'risk-limit': { type: 'string' } });
  const json = values.json === true;
  const show = (config: Config) => {
    if (json) {
      io.out(JSON.stringify({ configPath: configPath(), preferRiskLimit: config.preferRiskLimit, pins: config.pins }, null, 2));
      return;
    }
    const lines = [`preferred routes (above ${config.preferRiskLimit}% projected usage, switch only to a known within-limit alternative):`];
    for (const tier of TIERS) lines.push(`  ${tier.padEnd(8)}  ${prefLabel(config.pins[tier])}`);
    io.out(lines.join('\n'));
  };

  const rawLimit = values['risk-limit'];
  if (typeof rawLimit === 'string') {
    if (positionals.length > 0 || values.all) throw new UsageError('use "prefer --risk-limit <percent>" on its own');
    const limit = parsePercent(rawLimit);
    if (limit === undefined) throw new UsageError(`--risk-limit must be a non-negative percent (got "${rawLimit}")`);
    readConfig(io);
    updateConfigFile((raw) => setPreferRiskLimit(raw, limit));
    if (!json) io.out(`wrote ${configPath()}`);
    show(readConfig(io));
    return 0;
  }
  if (positionals.length === 0) {
    if (values.all) throw new UsageError('--all only goes with "prefer clear"');
    show(readConfig(io));
    return 0;
  }
  if (positionals[0] === 'clear') {
    const rest = positionals.slice(1);
    if (values.all ? rest.length > 0 : rest.length !== 1) throw new UsageError('use "prefer clear <tier>" or "prefer clear --all"');
    const tier = values.all ? undefined : tierOf(rest[0]);
    readConfig(io);
    updateConfigFile((raw) => {
      for (const t of tier ? [tier] : TIERS) setPin(raw, t, undefined);
    });
    if (!json) io.out(`wrote ${configPath()}`);
    show(readConfig(io));
    return 0;
  }

  if (values.all) throw new UsageError('--all only goes with "prefer clear"');
  if (positionals.length < 2 || positionals.length > 3) throw new UsageError('use "prefer <tier> <agent> [model]"');
  const tier = tierOf(positionals[0]);
  const agent = agentId(positionals[1]);
  const model = positionals[2];

  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  const disc = env.discoveries.find((d) => d.agent === agent);
  if (!disc?.installed || disc.models.length === 0) {
    const state = disc?.installed ? 'lists no models' : 'is not installed';
    io.err(`warning: ${agent} ${state} right now; saved${model ? ' without checking the model' : ''}`);
  } else if (model && !disc.models.some((m) => launchIds(m).includes(model))) {
    const known = disc.models.map((m) => m.modelId);
    throw new UsageError(`unknown model "${model}" for ${agent} (known: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''})`);
  }
  const pin: Preference = { agent, ...(model ? { model } : {}) };
  updateConfigFile((raw) => setPin(raw, tier, pin));
  if (json) show(readConfig(io));
  else io.out([`wrote ${configPath()}`, `${tier} → ${prefLabel(pin)}`].join('\n'));
  return 0;
}

// --- ban ------------------------------------------------------------------------------------

async function banCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const { values, positionals } = parsePositionals(args, { json: { type: 'boolean' } });
  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  const entries = [...new Set(positionals.map((e) => e.trim().toLowerCase()))];
  const next = [...config.banModels];
  if (entries.length > 0) {
    const matches = banMatches(entries, env);
    // An agent id is refused unless it is also a model family (grok); check them all before saying anything.
    const agent = agentNotFamily(entries, matches);
    if (agent) throw new UsageError(`"${agent}" is an agent; to stop using it run: orcacompass agents disable ${agent}`);
    for (const entry of entries) {
      if (AGENT_IDS.includes(entry)) {
        io.err(`note: "${entry}" bans the ${entry} model family; to stop using the ${agentName(entry)} agent run: orcacompass agents disable ${entry}`);
      }
      if (matches[entry].length === 0) io.err(`warning: "${entry}" matches no model discovered right now; saved anyway`);
      if (!next.includes(entry)) next.push(entry);
    }
    writeBans(next);
  }
  showBans(next, env, values.json === true, entries.length > 0, io);
  return 0;
}

async function unbanCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const { values, positionals } = parsePositionals(args, { json: { type: 'boolean' } });
  if (positionals.length === 0) throw new UsageError('use "unban <model-or-family>..."');
  const entries = positionals.map((e) => e.trim().toLowerCase());
  const config = readConfig(io);
  for (const entry of entries) if (!config.banModels.includes(entry)) io.err(`warning: "${entry}" was not banned`);
  const next = config.banModels.filter((b) => !entries.includes(b));
  writeBans(next);
  showBans(next, await gatherEnvironment(config, deps), values.json === true, true, io);
  return 0;
}

const agentName = (id: AgentId): string => (id === 'grok' ? 'Grok Build' : id);

function writeBans(banModels: string[]): void {
  updateConfigFile((raw) => setBans(raw, banModels));
}

function showBans(banModels: string[], env: Environment, json: boolean, wrote: boolean, io: IO): void {
  const matches = banMatches(banModels, env);
  if (json) {
    io.out(JSON.stringify({ configPath: configPath(), banModels, matches }, null, 2));
    return;
  }
  const lines = wrote ? [`wrote ${configPath()}`] : [];
  if (banModels.length === 0) lines.push('banned by you: none');
  else {
    lines.push('banned by you:');
    for (const entry of banModels) {
      const found = matches[entry].map((m) => `${m.agent} ${m.model}`);
      lines.push(`  ${entry}  ${found.length ? found.join(', ') : '(matches nothing discovered right now)'}`);
    }
  }
  io.out(lines.join('\n'));
}

// --- refresh --------------------------------------------------------------------------------

async function refreshCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { json: { type: 'boolean' } });
  const config = readConfig(io);
  const { table, saveError } = await loadPlacements(config, { ...deps, refresh: true });
  const c = table.sources.evidence;
  const at = (t: number) => new Date(t).toISOString();
  if (c.source !== 'network') io.err(`could not reach the OrcaCompass repository; still using the ${c.source} from ${at(c.fetchedAt)}`);
  if (saveError !== undefined) io.err(`placements: could not be saved: ${saveError}`);
  const models = table.agents.reduce((n, a) => n + a.models.length, 0);
  const placements = { builtAt: table.builtAt, models, agents: table.agents.length };
  if (v.json) {
    io.out(JSON.stringify({ evidence: c, placements }, null, 2));
  } else {
    io.out([
      `evidence: ${c.source}, ${c.models} models (snapshot of ${c.generatedAt})`,
      `placements: ${models} models across ${table.agents.length} agents (built now)`,
    ].join('\n'));
  }
  return 0;
}

// --- tiers ----------------------------------------------------------------------------------

/** Plain words for why the table was rebuilt on this call. */
const REBUILT_WORDS: Record<Staleness | 'refresh', string> = {
  missing: 'no table yet',
  invalid: 'table unreadable',
  version: 'older version',
  expired: 'table expired',
  config: 'config changed',
  'agent-appeared': 'new agent on PATH',
  refresh: 'refresh asked',
  evidence: 'evidence changed',
};

function placementsView(g: Pick<Gathered, 'table' | 'rebuilt' | 'saveError'>, now: number) {
  const { table } = g;
  return {
    builtAt: table.builtAt,
    age: Math.max(0, now - table.builtAt),
    version: table.version,
    rebuilt: g.rebuilt ?? null,
    saveError: g.saveError ?? null,
  };
}

function placementsLines(p: ReturnType<typeof placementsView>, now: number): string[] {
  const built = p.rebuilt ? `built now: ${REBUILT_WORDS[p.rebuilt]}` : `built ${duration(now - p.builtAt)} ago`;
  const lines = [`placements: ${built} (orcacompass ${p.version})`];
  if (p.saveError) lines.push(`placements: could not be saved: ${p.saveError}`);
  return lines;
}

function axisOption(raw: string | undefined): Axis | undefined {
  if (raw !== undefined && !AXES.includes(raw as Axis)) throw new UsageError(`unknown axis "${raw}" (expected ${AXES.join(', ')})`);
  return raw as Axis | undefined;
}

function axisText(axis: Axis, p: AxisProfile): string {
  return p.score === null || p.band === null ? `${axis} unranked (no evidence or estimate)` : `${axis} ${p.score.toFixed(1)} ${p.band[0].toUpperCase()} ${p.label}(${p.benchmarks})`;
}

/** Match provenance to the placement generation without another network request. */
function snapshotSources(table: PlacementTable, deps: MainDeps): SnapshotSource[] {
  const read = deps.readFile ?? readTextFile;
  const cached = parseSnapshot(read(join(deps.cacheDir ?? cacheDir(), 'evidence-snapshot.json')));
  if (cached?.generatedAt === table.sources.evidence.generatedAt) return cached.sources;
  const bundled = parseSnapshot(readFileSync(new URL('../data/evidence-snapshot.json', import.meta.url), 'utf8'));
  return bundled?.generatedAt === table.sources.evidence.generatedAt ? bundled.sources : [];
}

function rankingModels(table: PlacementTable, axis?: Axis) {
  const models = new Map<string, { id: string; class: Profile['class']; hint: Profile['hint']; axes: Profile['axes']; agents: AgentId[]; family?: string }>();
  for (const agent of table.agents) for (const m of agent.models) {
    const existing = models.get(m.modelId);
    if (existing) {
      if (!existing.agents.includes(agent.agent)) existing.agents.push(agent.agent);
    } else models.set(m.modelId, { id: m.modelId, ...m.profile, agents: [agent.agent], family: modelFamily(m.modelId, m.meta) });
  }
  const score = (m: { axes: Profile['axes'] }) => axis ? m.axes[axis].score ?? -Infinity : AXES.reduce((n, a) => n + (m.axes[a].score ?? 0), 0);
  return [...models.values()].sort((a, b) =>
    (axis ? 0 : TIERS.indexOf(b.class!) - TIERS.indexOf(a.class!)) || score(b) - score(a) || a.id.localeCompare(b.id));
}

async function rankingCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { axis: { type: 'string' }, json: { type: 'boolean' } });
  const axis = axisOption(v.axis);
  const config = readConfig(io);
  const { table } = await loadPlacements(config, deps);
  const models = rankingModels(table, axis);
  if (v.json) {
    io.out(JSON.stringify({ generatedAt: table.sources.evidence.generatedAt, sources: snapshotSources(table, deps), bands: table.bands,
      models: models.map(({ family, ...model }) => model) }, null, 2));
  } else {
    const axes = axis ? [axis] : AXES;
    io.out(models.map((m) => `${m.id}  ${m.class ?? 'unranked'}  ${axes.map((a) => axisText(a, m.axes[a])).join('  ')}  agents: ${m.agents.join(', ')}${m.hint ? `  hint: ${m.hint.source}${m.family ? ` ${m.family}` : ''} (${m.hint.tier})${m.hint.detail ? ` ${m.hint.detail}` : ''}` : ''}`).join('\n'));
  }
  return 0;
}

function tiersText(table: PlacementTable, view: ReturnType<typeof placementsView>, now: number, axis?: Axis): string[] {
  const lines = placementsLines(view, now);
  const rows = table.agents.flatMap((a) => a.models.map((m) => ({ agent: a.agent, model: m.modelId, profile: m.profile })));
  rows.sort((a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
  for (const a of axis ? [axis] : AXES) {
    const [daily, advanced, frontier] = table.bands[a];
    lines.push(`${a}: light < ${daily} ≤ daily < ${advanced} ≤ advanced < ${frontier} ≤ frontier`);
    for (const tier of TIERS) {
      lines.push(`${tier}:`);
      for (const r of rows.filter((r) => r.profile.axes[a].band === tier)) lines.push(`  ${r.agent} ${r.model}  ${axisText(a, r.profile.axes[a])}`);
    }
    const unranked = rows.filter((r) => r.profile.axes[a].band === null);
    lines.push(`unclassified: ${unranked.length}`);
    for (const r of unranked) lines.push(`  ${r.agent} ${r.model}  ${a} unranked`);
  }
  return lines;
}

async function tiersCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { axis: { type: 'string' }, json: { type: 'boolean' } });
  const axis = axisOption(v.axis);
  const config = readConfig(io);
  const now = deps.now ?? Date.now();
  const loaded = await loadPlacements(config, { ...deps, now });
  const view = placementsView(loaded, now);
  io.out(v.json ? JSON.stringify({ ...loaded.table, age: view.age }, null, 2) : tiersText(loaded.table, view, now, axis).join('\n'));
  return 0;
}

// --- install --------------------------------------------------------------------------------

async function installCommand(command: 'install' | 'update' | 'uninstall', args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, {
    global: { type: 'boolean', short: 'g' },
    local: { type: 'boolean', short: 'l' },
    yes: { type: 'boolean', short: 'y' },
    agent: { type: 'string', short: 'a', multiple: true },
    'skill-only': { type: 'boolean' },
  });
  if (v.global && v.local) throw new UsageError('choose either --global or --local');
  // The installer asks which agents and where; without a terminal nobody can answer.
  if (!deps.terminal && !v.yes) {
    io.err(`orcacompass ${command} asks questions in a terminal, and this is not one. Run it in a terminal, or add --yes (with --global or --local and --agent <name> to choose).`);
    return 1;
  }
  return ({ install, update, uninstall })[command](
    { global: v.global, yes: v.yes, agents: v.agent, skillOnly: v['skill-only'] },
    { log: io.out, ...deps.install },
  );
}

// --- setup ----------------------------------------------------------------------------------

async function setupCommand(args: string[], io: IO, deps: MainDeps): Promise<number> {
  const v = parse(args, { json: { type: 'boolean' }, skip: { type: 'boolean' }, complete: { type: 'boolean' } });
  if (v.skip && v.complete) throw new UsageError('choose either --complete or --skip');
  if (v.skip) return skipSetup(v.json, io, deps);
  if (!v.json && !v.complete && !deps.terminal) {
    io.err([
      'orcacompass setup asks its questions in a terminal, and this is not one.',
      'In chat, ask your orchestrator to set up OrcaCompass: it reads `orcacompass setup --json` and asks the same questions.',
      'Or set things one at a time: orcacompass agents, orcacompass prefer, orcacompass ban.',
    ].join('\n'));
    return 1;
  }
  if (v.complete && !existsSync(configPath())) updateConfigFile(() => {});
  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  if (v.json) {
    io.out(JSON.stringify(setupInfo(env, config), null, 2));
    return 0;
  }
  if (v.complete) {
    io.out(`Setup complete. Config: ${configPath()}`);
    return 0;
  }
  return setupWizard(deps.terminal!, env, config);
}

/** The user declined setup: create an empty config file, if there is none, so setup is not offered again. */
async function skipSetup(json: boolean | undefined, io: IO, deps: MainDeps): Promise<number> {
  if (!existsSync(configPath())) updateConfigFile(() => {});
  const config = readConfig(io);
  const env = await gatherEnvironment(config, deps);
  const used = env.discoveries.filter((d) => !agentSkipReason(d, env, config)).map((d) => d.agent);
  const orca = env.orcaAgents?.known ? 'they follow the agents enabled in Orca' : "Orca's agent switches could not be read";
  if (json) {
    io.out(JSON.stringify({ configPath: configPath(), agentsUsed: used, orcaAgents: env.orcaAgents ?? null }, null, 2));
  } else {
    io.out(`Setup skipped; defaults kept in ${configPath()}.
Agents used now: ${used.join(', ') || 'none'} (${orca}).`);
  }
  return 0;
}

// --- formatting -----------------------------------------------------------------------------

const percent = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

function duration(ms: number): string {
  if (ms <= 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(ms / 60_000)}m`;
}

// --- entry ----------------------------------------------------------------------------------

// Only run when executed directly (also through npm's bin symlinks/shims), never on import.
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const io: IO = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };
  const terminal = process.stdin.isTTY && process.stdout.isTTY ? { input: process.stdin, output: process.stdout } : undefined;
  void main(process.argv.slice(2), io, terminal ? { terminal } : {}).then((code) => {
    process.exitCode = code;
  });
}
