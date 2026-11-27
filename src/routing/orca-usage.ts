import { createHash } from 'node:crypto';
import type { AgentId, AgentUsage, UsagePool } from '../types.js';
import type { Runner } from '../system/run.js';
import { poolKey } from './quota.js';

// Orca is the only source of usage. `orca account list --json` returns the snapshot Orca already holds: it
// never triggers a refresh. Orca refreshes on its own schedule (every few minutes while its window is in
// use, far less often in the background), and stamps each provider's snapshot with `updatedAt`. That stamp
// is what tells a fresh snapshot from the same one read again, even when the percentages did not move.

// Orca has no usage entry for Muse; listing it reports that instead of "not reachable".
const agents = ['claude', 'codex', 'cursor', 'grok', 'antigravity', 'muse'] as const;

interface OrcaPool {
  name?: unknown;
  group?: unknown;
  usedPercent?: unknown;
  windowMinutes?: unknown;
  resetsAt?: unknown;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
const record = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

interface OrcaUsage {
  status?: string;
  error?: string | null;
  updatedAt?: number;
  planType?: unknown;
  usageMetadata?: unknown;
  session?: OrcaPool | null;
  weekly?: OrcaPool | null;
  fableWeekly?: OrcaPool | null;
  monthly?: OrcaPool | null;
  buckets?: (OrcaPool | null)[] | null;
}

/**
 * The quota identity of an agent's usage: the account Orca launches it with, the runtime it runs in and the
 * plan. Hashed, so the ledger holds no account id. A change of any part is a different set of quota buckets.
 */
function scopeOf(agent: AgentId, result: Record<string, unknown>, source: OrcaUsage): string {
  const account = record(result[agent]);
  const limits = record(result.rateLimits);
  const target = record(limits[`${agent}Target`]);
  const current = record(account.currentAccount);
  const identity = [
    agent,
    text(account.selectedAccountId) ?? text(account.activeAccountId) ?? text(record(account.systemDefault).providerAccountId) ?? text(current.subject) ?? 'system',
    text(target.runtime) ?? 'host',
    text(target.wslDistro) ?? '',
    text(record(source.usageMetadata).authProvenance) ?? '',
    text(source.planType) ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
}

/**
 * A usage window as reported. A missing or invalid percentage stays unknown (null), never 0; a valid 0 stays 0.
 * A reset time of `0` or `null` means Orca has none (the window has not started): null, never "already expired".
 */
function toPool(name: string, pool: OrcaPool, kind: UsagePool['kind']): UsagePool {
  const { usedPercent, windowMinutes, resetsAt } = pool;
  return {
    name, kind,
    usedPercent: isNumber(usedPercent) && usedPercent >= 0 ? Math.min(100, usedPercent) : null,
    windowMinutes: isNumber(windowMinutes) && windowMinutes > 0 ? windowMinutes : null,
    resetsAt: isNumber(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

export async function readOrcaUsage(run: Runner): Promise<Record<AgentId, AgentUsage>> {
  try {
    const result = await run('orca', ['account', 'list', '--json'], { timeoutMs: 20_000 });
    if (result.code !== 0 || result.error) {
      throw new Error(result.error || result.stderr.trim() || `command exited with code ${result.code}`);
    }
    const data = JSON.parse(result.stdout);
    if (data?.ok !== true) {
      const error = data?.error;
      throw new Error(typeof error === 'string' ? error : error?.message || 'account list failed');
    }
    const rateLimits = data.result?.rateLimits;
    if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
      throw new Error('account list response has no rate limits');
    }
    return Object.fromEntries(agents.map((agent) => {
      const source: OrcaUsage = rateLimits[agent] ?? {};
      const pools: Record<string, UsagePool> = {};
      const addPool = (name: string, pool: OrcaPool | null | undefined, kind: UsagePool['kind'] = name === 'session' ? 'session' : 'long') => {
        // null: the provider has no such window. A window that exists with a bad number is kept as unknown.
        if (pool == null || typeof pool !== 'object') return;
        const next = toPool(name, pool, kind);
        // Two names for one window (aliases differing in case or spacing, or an agy group with two weekly
        // limits) are one bucket: the tighter known reading stands.
        const twin = Object.keys(pools).find((existing) => poolKey(existing) === poolKey(name));
        if (twin !== undefined) {
          const current = pools[twin];
          if (next.usedPercent === null || (current.usedPercent !== null && current.usedPercent >= next.usedPercent)) return;
          delete pools[twin];
        }
        pools[name] = next;
      };
      if (agent === 'cursor') {
        addPool('monthly', source.monthly);
        for (const bucket of source.buckets ?? []) {
          if (typeof bucket?.name === 'string') addPool(`bucket:${bucket.name}`, bucket);
        }
      } else if (agent === 'grok') {
        addPool('weekly', source.weekly);
        addPool('monthly', source.monthly);
      } else if (agent === 'antigravity' && (source.buckets ?? []).some((b) => typeof b?.group === 'string')) {
        // agy bills each quota group ("Gemini Models", "Claude and GPT models") separately, so each group gets
        // its own pools; Orca's session and weekly are only the tightest across groups, aliases of those.
        for (const bucket of source.buckets ?? []) {
          if (typeof bucket?.group !== 'string') continue;
          if (bucket.windowMinutes === 300) addPool(`bucket:${bucket.group} 5h`, bucket, 'session');
          else if (isNumber(bucket.windowMinutes) && bucket.windowMinutes > 0) addPool(`bucket:${bucket.group}`, bucket, 'long');
        }
      } else {
        // Without quota groups (older Orca), Antigravity falls back to Orca's tightest session and weekly.
        addPool('session', source.session);
        addPool('weekly', source.weekly);
        if (agent === 'claude') addPool('fableWeekly', source.fableWeekly);
      }
      // Only an explicit 'unavailable' (signed out / CLI missing) excludes the agent. When a refresh fails Orca
      // reports 'error' and keeps its last good windows with their old updatedAt: those are still valid usage,
      // just older. Anything else is unknown: a low-confidence candidate, never 0% used.
      const kept = source.status === 'error' && Object.keys(pools).length > 0;
      const status = source.status === 'ok' || kept ? 'ok' : source.status === 'unavailable' ? 'unavailable' : 'unknown';
      const plan = text(source.planType);
      const usage: AgentUsage = {
        agent,
        status,
        pools,
        scope: scopeOf(agent, record(data.result), source),
        ...(plan ? { plan } : {}),
        ...(isNumber(source.updatedAt) ? { updatedAt: source.updatedAt } : {}),
        ...(status !== 'ok' || kept
          ? { error: source.error || (rateLimits[agent] ? `Orca usage ${source.status ?? 'status missing'}` : `Orca reports no usage for ${agent}`) }
          : {}),
      };
      return [agent, usage];
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(agents.map((agent) => [agent, {
      agent, status: 'unknown', pools: {}, error: `Orca not reachable: ${message}`, unreachable: true,
    }]));
  }
}
