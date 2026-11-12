import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  applyAgentChoice, DEFAULT_CONFIG, isChosen, parsePercent, setAgentChoice, setBans, setPin, setPreferRiskLimit, updateConfigFile, type AgentChoice,
} from './config.js';
import { agentNotFamily, agentSkipReason, banMatches, enabledInOrca, launchIds, route } from './routing/router.js';
import { TIERS, type AgentId, type Config, type Effort, type Environment, type Preference, type Risk, type Tier } from './types.js';
import { configPath } from './paths.js';

// `orcacompass setup`: four questions (agents, favorites, bans, summary) in a terminal, and the same
// facts as one JSON document so an orchestrator can ask them in chat. Answers are written with the
// config edits the agents, prefer and ban commands use.

export interface Terminal {
  input: Readable;
  output: Writable;
}

// --- what the questions need ----------------------------------------------------------------

export interface AgentRow {
  agent: AgentId;
  installed: boolean;
  enabledInOrca: 'yes' | 'no' | 'unknown';
  orcaUsage: 'ok' | 'unavailable' | 'unknown';
  models: number;
  /** Chosen by the user's config (allowAgents/denyAgents). */
  chosen: boolean;
  /** In question 1's default answer: installed with models, not switched off in Orca, and chosen. */
  preselected: boolean;
  verdict: string;
}

export interface TierOption {
  agent: AgentId;
  /** The id to prefer: `orcacompass prefer <tier> <agent> <model>`. */
  model: string;
  blocked: boolean;
  /** Where the route's usage is heading (used% / elapsed fraction of the window); null when unknown. */
  onPacePercent: number | null;
  reason: string;
}

export interface TierChoice {
  pick: { agent: AgentId; model: string; effort: Effort | null } | null;
  preferred: Preference | null;
  /** The pick first, then the alternatives, best first. */
  options: TierOption[];
  warnings: string[];
}

export interface FamilyRow {
  family: string;
  models: { agent: AgentId; model: string }[];
  banned: boolean;
}

function agentRows(env: Environment, config: Config): AgentRow[] {
  return env.discoveries.map((d) => {
    const reason = agentSkipReason(d, env, config);
    const orca = enabledInOrca(env.orcaAgents, d.agent);
    const chosen = isChosen(d.agent, config);
    return {
      agent: d.agent,
      installed: d.installed,
      enabledInOrca: orca,
      orcaUsage: env.usage[d.agent]?.status ?? 'unknown',
      models: d.models.length,
      chosen,
      preselected: d.installed && d.models.length > 0 && orca !== 'no' && chosen,
      verdict: reason === undefined ? 'used' : `not used: ${reason}`,
    };
  });
}

/** The discovered base id behind a launched model id (Cursor's `claude-opus-5-5-high` is `claude-opus-5-5`). */
function baseModel(env: Environment, agent: AgentId, launched: string): string {
  const d = env.discoveries.find((x) => x.agent === agent);
  return d?.models.find((m) => launchIds(m).includes(launched))?.modelId ?? launched;
}

const pace = (risk: Risk | null | undefined): number | null => (risk ? Math.round(risk.projectedPercent) : null);

function tierChoice(tier: Tier, env: Environment, config: Config): TierChoice {
  const d = route({ tier, noDowngrade: true }, env, config);
  // Cheaper covering picks belong here; structural upgrades still belong to another tier.
  const own = !d.upgraded;
  const options: TierOption[] = [];
  if (own && d.route) {
    const prefix = `${d.route.agent} ${d.route.model}: `;
    const reason = d.reasons[0] ?? '';
    options.push({
      agent: d.route.agent, model: baseModel(env, d.route.agent, d.route.model), blocked: false, onPacePercent: pace(d.risk),
      reason: reason.startsWith(prefix) ? reason.slice(prefix.length) : reason,
    });
  }
  if (own) {
    for (const a of d.alternatives) {
      options.push({ agent: a.agent, model: baseModel(env, a.agent, a.model), blocked: a.blocked, onPacePercent: pace(a.risk), reason: a.reason });
    }
  }
  return {
    pick: own && d.route ? d.route : null,
    preferred: config.pins[tier] ?? null,
    options,
    warnings: own ? d.warnings : [],
  };
}

function familyRows(env: Environment, config: Config): FamilyRow[] {
  const byFamily = new Map<string, { agent: AgentId; model: string }[]>();
  for (const d of env.discoveries) {
    for (const m of d.models) {
      const family = m.meta?.family;
      if (!family) continue;
      const models = byFamily.get(family) ?? [];
      if (!models.some((x) => x.agent === d.agent && x.model === m.modelId)) models.push({ agent: d.agent, model: m.modelId });
      byFamily.set(family, models);
    }
  }
  const newestFirst = (a: { model: string }, b: { model: string }) => b.model.localeCompare(a.model, 'en', { numeric: true });
  return [...byFamily.keys()].sort().map((family) => ({
    family, models: byFamily.get(family)!.sort(newestFirst), banned: config.banModels.includes(family),
  }));
}

/** `orcacompass setup --json`: everything an orchestrator needs to ask the setup questions in chat. */
export function setupInfo(env: Environment, config: Config) {
  return {
    configPath: configPath(),
    configExists: existsSync(configPath()),
    orcaAgents: env.orcaAgents ?? null,
    config: {
      allowAgents: config.allowAgents ?? null,
      denyAgents: config.denyAgents,
      pins: config.pins,
      preferRiskLimit: config.preferRiskLimit,
      banModels: config.banModels,
    },
    defaultPreferRiskLimit: DEFAULT_CONFIG.preferRiskLimit,
    agents: agentRows(env, config),
    tiers: Object.fromEntries(TIERS.map((t) => [t, tierChoice(t, env, config)])) as Record<Tier, TierChoice>,
    families: familyRows(env, config),
  };
}

// --- the terminal wizard --------------------------------------------------------------------

class Canceled extends Error {}

const TIER_NAMES: Record<Tier, string> = { light: 'Light', daily: 'Daily', advanced: 'Advanced', frontier: 'Frontier' };
const prefLabel = (p: Preference | undefined | null): string => (!p ? 'none' : p.model ? `${p.agent} ${p.model}` : `${p.agent} (its best model)`);
const paceLabel = (o: TierOption): string => (o.blocked ? 'blocked' : o.onPacePercent === null ? 'usage unknown' : `on pace for ${o.onPacePercent}%`);
const samePin = (a: Preference | undefined, b: Preference | undefined): boolean => a?.agent === b?.agent && a?.model === b?.model;
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`.trimEnd());
}

/** Numbers (1-based) or names from `items`, separated by commas or spaces; or the first token that is neither. */
function pickMany(answer: string, items: readonly string[]): { picked: string[] } | { bad: string } {
  const picked: string[] = [];
  for (const token of answer.split(/[\s,]+/).filter(Boolean)) {
    const n = /^\d+$/.test(token) ? Number(token) : NaN;
    const item = Number.isNaN(n) ? items.find((i) => i === token.toLowerCase()) : items[n - 1];
    if (item === undefined) return { bad: token };
    if (!picked.includes(item)) picked.push(item);
  }
  return { picked };
}

/** Runs the four setup questions and writes the answers when the user agrees. Returns the exit code. */
export async function setupWizard(term: Terminal, env: Environment, config: Config): Promise<number> {
  const rl = createInterface({ input: term.input, output: term.output });
  // Queue lines typed ahead of their question; Ctrl+C or the end of input cancels the setup.
  const typed: string[] = [];
  let closed = false;
  let wake = () => {};
  rl.on('line', (line) => {
    typed.push(line);
    wake();
  });
  rl.on('close', () => {
    closed = true;
    wake();
  });
  rl.on('SIGINT', () => rl.close());
  const say = (s = '') => term.output.write(`${s}\n`);
  const ask = async (question: string): Promise<string> => {
    // Input that has already ended (answers piped in) still has typed lines to read.
    if (closed) term.output.write(question);
    else {
      rl.setPrompt(question);
      rl.prompt();
    }
    while (typed.length === 0 && !closed) await new Promise<void>((resolve) => (wake = resolve));
    const line = typed.shift();
    if (line === undefined) throw new Canceled();
    return line.trim();
  };
  const yesNo = async (question: string, yes: boolean): Promise<boolean> => {
    for (;;) {
      const a = (await ask(`${question} [${yes ? 'Y/n' : 'y/N'}]: `)).toLowerCase();
      if (a === '') return yes;
      if (['y', 'yes'].includes(a)) return true;
      if (['n', 'no'].includes(a)) return false;
      say('  Please answer y or n.');
    }
  };

  try {
    const path = configPath();
    const exists = existsSync(path);
    say('OrcaCompass setup: three questions, then a summary. Press Enter to keep the answer in [brackets].');
    say(`Nothing is saved until you confirm at the end. Config: ${path}${exists ? '' : ' (not created yet)'}`);

    // 1. Agents
    say();
    say('1/4  Agents');
    const rows = agentRows(env, config);
    const yes = (b: boolean) => (b ? 'yes' : 'no');
    for (const line of table([
      ['#', 'agent', 'installed', 'enabled in Orca', 'Orca usage', 'models'],
      ...rows.map((r, i) => [String(i + 1), r.agent, yes(r.installed), r.enabledInOrca, r.orcaUsage, String(r.models)]),
    ])) say(line);
    const before = rows.filter((r) => r.preselected).map((r) => r.agent);
    let selected = before;
    for (;;) {
      const a = await ask(`Use which agents? Numbers or names, separated by commas [${before.join(', ') || 'none'}]: `);
      if (a === '') break;
      const got = pickMany(a, rows.map((r) => r.agent));
      if ('bad' in got) say(`  "${got.bad}" is not one of the agents above.`);
      else if (got.picked.length === 0) say('  Choose at least one agent.');
      else {
        selected = got.picked;
        break;
      }
    }
    // Only what the answer changed is written, as `agents disable` / `agents enable` would.
    let choice: AgentChoice = { ...(config.allowAgents ? { allowAgents: config.allowAgents } : {}), denyAgents: config.denyAgents };
    const removed = before.filter((a) => !selected.includes(a));
    const added = selected.filter((a) => !before.includes(a));
    if (removed.length > 0) choice = applyAgentChoice(choice, 'disable', removed);
    if (added.length > 0) choice = applyAgentChoice(choice, 'enable', added);
    for (const agent of added) {
      const row = rows.find((r) => r.agent === agent)!;
      if (!row.installed) say(`  note: ${agent} is not installed; it is used once it is installed.`);
      else if (row.enabledInOrca === 'no') say(`  note: ${agent} is switched off in Orca; switch it on in Orca's settings (Agents) to use it.`);
    }
    const working: Config = { ...config, ...choice };
    if (!choice.allowAgents) delete working.allowAgents;

    // 2. Favorites
    say();
    say('2/4  Favorite routes (optional)');
    const limitNote = config.preferRiskLimit === DEFAULT_CONFIG.preferRiskLimit ? 'the default' : `the default is ${DEFAULT_CONFIG.preferRiskLimit}%`;
    say('An available, unblocked favorite is used for its tier. Above');
    say(`${config.preferRiskLimit}% (${limitNote}) projected usage, a known within-limit alternative replaces it.`);
    say('If none exists, the favorite is retained with a warning. Without a favorite, the route with the most room wins.');
    const pins: Partial<Record<Tier, Preference>> = { ...config.pins };
    let riskLimit = config.preferRiskLimit;
    if (await yesNo('Set favorites?', Object.keys(config.pins).length > 0)) {
      for (const tier of TIERS) {
        const t = tierChoice(tier, env, working);
        say();
        const now = t.pick ? `${t.pick.agent} · ${t.pick.model}${t.pick.effort ? ` · ${t.pick.effort}` : ''}` : 'no route';
        say(`${TIER_NAMES[tier]}: now ${now}; favorite: ${prefLabel(pins[tier])}`);
        if (t.options.length === 0) {
          say('  No routes with these agents; skipped.');
          continue;
        }
        for (const line of table(t.options.map((o, i) => [String(i + 1), `${o.agent} ${o.model}`, paceLabel(o)]))) say(line);
        for (;;) {
          const a = await ask(`Favorite for ${TIER_NAMES[tier]}? Number, 0 for none [${pins[tier] ? 'keep' : 'none'}]: `);
          if (a === '') break;
          const n = /^\d+$/.test(a) ? Number(a) : NaN;
          if (n === 0) {
            delete pins[tier];
            break;
          }
          const o = t.options[n - 1];
          if (o) {
            pins[tier] = { agent: o.agent, model: o.model };
            break;
          }
          say(`  Answer a number from 0 to ${t.options.length}.`);
        }
      }
      if (Object.keys(pins).length > 0) {
        for (;;) {
          const a = await ask(`Skip a favorite when it is on pace for more than what percent? [${riskLimit}]: `);
          const n = a === '' ? riskLimit : parsePercent(a);
          if (n !== undefined) {
            riskLimit = n;
            break;
          }
          say('  Answer a number of percent, such as 100.');
        }
      }
    }

    // 3. Bans
    say();
    say('3/4  Models never to use (optional)');
    const families = familyRows(env, working);
    if (families.length > 0) {
      say('Model families found:');
      for (const line of table(families.map((f, i) => {
        const ids = [...new Set(f.models.map((m) => m.model))];
        return [String(i + 1), f.family, ids.slice(0, 4).join(', ') + (ids.length > 4 ? ', …' : '')];
      }))) say(line);
    }
    say('Your answer replaces the list. To stop using a whole agent, leave it out in question 1 instead.');
    let bans = config.banModels;
    for (;;) {
      const a = await ask(`Never use which? Numbers, families or model ids; "none" for no bans [${bans.join(', ') || 'none'}]: `);
      if (a === '') break;
      if (a.toLowerCase() === 'none') {
        bans = [];
        break;
      }
      const entries = [...new Set(a.split(/[\s,]+/).filter(Boolean).map((token) =>
        /^\d+$/.test(token) ? (families[Number(token) - 1]?.family ?? '') : token.toLowerCase()))];
      if (entries.includes('')) {
        say(`  Numbers go from 1 to ${families.length}.`);
        continue;
      }
      const matches = banMatches(entries, env);
      const agent = agentNotFamily(entries, matches);
      if (agent) {
        say(`  "${agent}" is an agent, not a model family; leave it out in question 1 (or run: orcacompass agents disable ${agent}).`);
        continue;
      }
      for (const e of entries) if (matches[e].length === 0) say(`  note: "${e}" matches no model found right now; it is kept anyway.`);
      bans = entries;
      break;
    }

    // 4. Summary
    const next: Config = { ...working, pins, preferRiskLimit: riskLimit, banModels: bans };
    say();
    say('4/4  Summary');
    const verdicts = env.discoveries.map((d) => ({ agent: d.agent, reason: agentSkipReason(d, env, next) }));
    say(`Agents used: ${verdicts.filter((v) => !v.reason).map((v) => v.agent).join(', ') || 'none'}`);
    const unused = verdicts.filter((v) => v.reason);
    // The short reason only: "not signed in or unavailable", without Orca's message.
    if (unused.length > 0) say(`Not used: ${unused.map((v) => `${v.agent} (${v.reason!.split(': ')[0]})`).join(', ')}`);
    const favs = TIERS.filter((t) => pins[t]).map((t) => `${TIER_NAMES[t]} ${prefLabel(pins[t])}`);
    say(favs.length > 0
      ? `Favorites: ${favs.join('; ')}; above ${riskLimit}%, switch only to a known within-limit alternative`
      : 'Favorites: none; every tier takes the route with the most room');
    say(`Never used: ${bans.join(', ') || 'nothing'}`);
    say('Example routes:');
    for (const tier of TIERS) {
      const d = route({ tier }, env, next);
      const r = d.route;
      const moved = d.tier && d.tier !== tier
        ? d.downgraded ? ` (downgraded to ${d.tier})` : d.upgraded ? ` (upgraded to ${d.tier})` : ` (${d.tier} cost tier)`
        : '';
      say(`  ${tier.padEnd(8)}  ${r ? `${r.agent} · ${r.model}${r.effort ? ` · ${r.effort}` : ''}${moved}` : 'no route'}`);
      for (const w of d.warnings) say(`  ${' '.repeat(8)}  warning: ${w}`);
    }

    const changedTiers = TIERS.filter((t) => !samePin(pins[t], config.pins[t]));
    const agentsChanged = !sameList(choice.allowAgents, config.allowAgents) || !sameList(choice.denyAgents, config.denyAgents);
    const changed = agentsChanged || changedTiers.length > 0 || riskLimit !== config.preferRiskLimit || !sameList(bans, config.banModels);
    say();
    if (!changed && exists) {
      say(`Nothing changed. Config: ${path}`);
      return 0;
    }
    if (!(await yesNo(`Save to ${path}?`, true))) {
      say('Not saved.');
      return 0;
    }
    updateConfigFile((raw) => {
      if (agentsChanged) setAgentChoice(raw, choice);
      for (const t of changedTiers) setPin(raw, t, pins[t]);
      if (riskLimit !== config.preferRiskLimit) setPreferRiskLimit(raw, riskLimit);
      if (!sameList(bans, config.banModels)) setBans(raw, bans);
    }, path);
    say(`Saved ${path}`);
    return 0;
  } catch (e) {
    if (!(e instanceof Canceled)) throw e;
    say();
    say('Setup canceled; nothing was saved.');
    return 1;
  } finally {
    rl.close();
  }
}
