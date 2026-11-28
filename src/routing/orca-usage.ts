import { createHash } from 'node:crypto';
import type { AgentId, AgentUsage, UsagePool } from '../types.js';
import type { Runner } from '../system/run.js';
import { poolKey } from './quota.js';

// Orca is the only source of usage. `orca account list --json` returns the snapshot Orca holds, and asks Orca
// to refresh it first when that cached data is stale (the command passes `refreshStaleUsage: true`); data
// still fresh is returned as it is, so reading again does not force a new snapshot. Orca also refreshes on its
// own schedule (every few minutes while its window is in use, far less often in the background), and stamps
// each provider's snapshot with `updatedAt`. That stamp is what tells a fresh snapshot from the same one read
// again, even when the percentages did not move.
//
// Not read: `rateLimits.opencodeGo` (the OpenCode Go subscription, which needs a cookie configured in Orca).
// Supporting it means mapping it to the `opencode` agent and giving pools only to the models billed to that
// subscription, whose provider prefix must first be checked against a live `opencode models` listing. Until
// then OpenCode keeps "no usage window", and the key is ignored on purpose.

// Muse is read like any provider with a session and a weekly window: Orca's rate limits have a `muse` entry
// with both (seen `unavailable` on a machine where Muse is not set up). An Orca without that entry leaves Muse
// `unknown` with "Orca reports no usage for muse", which listing it here gives instead of "not reachable".
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
/** A trimmed, non-empty name. */
const nameOf = (x: unknown): string | undefined => (typeof x === 'string' ? text(x.trim()) : undefined);
const record = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const hash = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

interface OrcaUsage {
  status?: string;
  error?: unknown;
  updatedAt?: number;
  planType?: unknown;
  usageMetadata?: unknown;
  session?: OrcaPool | null;
  weekly?: OrcaPool | null;
  fableWeekly?: OrcaPool | null;
  monthly?: OrcaPool | null;
  buckets?: unknown;
}

/**
 * The account a reading belongs to, hashed with its runtime and WSL distro, so the ledger holds no account id.
 * The account id is, first that exists:
 * 1. `usageMetadata.readingAccount.accountId`, with its own runtime and distro (set on `ok` readings of managed accounts);
 * 2. the selection for the target runtime: `activeAccountIdsByRuntime.wsl[<distro>]` (case-insensitive) for WSL,
 *    `activeAccountIdsByRuntime.host`, else `activeAccountId`, for the host;
 * 3. `selectedAccountId`, `systemDefault.providerAccountId`, `currentAccount.subject`, `usageMetadata.authProvenance`,
 *    then `system`.
 */
function accountOf(agent: AgentId, result: Record<string, unknown>, source: OrcaUsage): string {
  const entry = record(result[agent]);
  const metadata = record(source.usageMetadata);
  const reading = record(metadata.readingAccount);
  const target = record(record(result.rateLimits)[`${agent}Target`]);
  let id = text(reading.accountId);
  const where = id !== undefined ? reading : target;
  const runtime = text(where.runtime) ?? 'host';
  const distro = runtime === 'wsl' ? (text(where.wslDistro) ?? '').toLowerCase() : '';
  if (id === undefined) {
    const byRuntime = record(entry.activeAccountIdsByRuntime);
    if (runtime === 'wsl') {
      const wsl = record(byRuntime.wsl);
      const key = Object.keys(wsl).find((k) => k.toLowerCase() === distro);
      id = key === undefined ? undefined : text(wsl[key]);
    } else {
      id = text(byRuntime.host) ?? text(entry.activeAccountId);
    }
    id ??= text(entry.selectedAccountId) ?? text(record(entry.systemDefault).providerAccountId) ?? text(record(entry.currentAccount).subject) ??
      text(metadata.authProvenance) ?? 'system';
  }
  return hash([agent, id, runtime, distro]);
}

/**
 * A usage window as reported. A missing or invalid percentage stays unknown (null), never 0; a valid 0 stays 0.
 * A reset time of `0` or `null` means Orca has none (the window has not started): null, never "already expired".
 */
function toPool(poolName: string, pool: OrcaPool, kind: UsagePool['kind'], group?: string): UsagePool {
  const { usedPercent, windowMinutes, resetsAt } = pool;
  return {
    name: poolName, kind,
    usedPercent: isNumber(usedPercent) && usedPercent >= 0 ? Math.min(100, usedPercent) : null,
    windowMinutes: isNumber(windowMinutes) && windowMinutes > 0 ? windowMinutes : null,
    resetsAt: isNumber(resetsAt) && resetsAt > 0 ? resetsAt : null,
    ...(group !== undefined ? { group } : {}),
  };
}

/** A window length as a short label: `1d`, `12h` or `90m`. */
const windowLabel = (minutes: number): string =>
  minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

/** One provider's entry of the account list. Throws on a shape it cannot read; the caller isolates that agent. */
function readAgent(agent: AgentId, rateLimits: Record<string, unknown>, account: string): AgentUsage {
  const source: OrcaUsage = record(rateLimits[agent]);
  const buckets: (OrcaPool | null)[] = Array.isArray(source.buckets) ? source.buckets : [];
  const pools: Record<string, UsagePool> = {};
  const addPool = (poolName: string, pool: OrcaPool | null | undefined, kind: UsagePool['kind'] = poolName === 'session' ? 'session' : 'long', group?: string) => {
    // null: the provider has no such window. A window that exists with a bad number is kept as unknown.
    if (pool == null || typeof pool !== 'object') return;
    const next = toPool(poolName, pool, kind, group);
    // Two names for one window (aliases differing in case or spacing, or an agy group with two windows of the
    // same length) are one bucket: the tighter known reading stands.
    const twin = Object.keys(pools).find((existing) => poolKey(existing) === poolKey(poolName));
    if (twin !== undefined) {
      const current = pools[twin];
      if (next.usedPercent === null || (current.usedPercent !== null && current.usedPercent >= next.usedPercent)) return;
      delete pools[twin];
    }
    pools[poolName] = next;
  };
  if (agent === 'cursor') {
    addPool('monthly', source.monthly);
    for (const bucket of buckets) {
      const bucketName = nameOf(bucket?.name);
      if (bucketName !== undefined) addPool(`bucket:${bucketName}`, bucket);
    }
  } else if (agent === 'grok') {
    addPool('weekly', source.weekly);
    addPool('monthly', source.monthly);
  } else if (agent === 'antigravity' && buckets.some((b) => nameOf(b?.group) !== undefined)) {
    // agy bills each quota group ("Gemini Models", "Claude and GPT models") separately, so each group gets
    // its own pools; Orca's session and weekly are only the tightest across groups, aliases of those. The
    // 5-hour window is the group's session, the weekly one its long window, and any other length (none with
    // Orca 1.4) a window of its own, so readings of different lengths are never folded into one.
    for (const bucket of buckets) {
      const group = nameOf(bucket?.group);
      const minutes = bucket?.windowMinutes;
      if (group === undefined || !isNumber(minutes) || minutes <= 0) continue;
      if (minutes === 300) addPool(`bucket:${group} 5h`, bucket, 'session', group);
      else if (minutes === 10080) addPool(`bucket:${group}`, bucket, 'long', group);
      else addPool(`bucket:${group} ${windowLabel(minutes)}`, bucket, 'long', group);
    }
  } else {
    // Without quota groups (older Orca), Antigravity falls back to Orca's tightest session and weekly.
    addPool('session', source.session);
    addPool('weekly', source.weekly);
    if (agent === 'claude') {
      addPool('fableWeekly', source.fableWeekly);
      // Set only when both the 5-hour and the weekly window are absent: a monthly-only account.
      addPool('monthly', source.monthly);
    }
  }
  // Only an explicit 'unavailable' (signed out / CLI missing) excludes the agent. When a refresh fails Orca
  // reports 'error' and keeps its last good windows with their old updatedAt: still valid usage, only older,
  // so they are marked retained. Anything else is unknown: a low-confidence candidate, never 0% used. An
  // 'error' with no window left to keep is such an unknown, with the account it was read for: a failed fetch,
  // not a sign-out, so the ledger lets its last valid snapshot of that account stand in (see `mergeReading`).
  const kept = source.status === 'error' && Object.keys(pools).length > 0;
  const status = source.status === 'ok' || kept ? 'ok' : source.status === 'unavailable' ? 'unavailable' : 'unknown';
  const plan = text(source.planType);
  const from = text(record(source.usageMetadata).source);
  return {
    agent,
    status,
    pools,
    account,
    scope: hash([account, plan ?? '']),
    ...(plan ? { plan } : {}),
    ...(from ? { source: from } : {}),
    ...(isNumber(source.updatedAt) ? { updatedAt: source.updatedAt } : {}),
    ...(kept ? { retained: true as const } : {}),
    ...(status !== 'ok' || kept
      ? { error: text(source.error) ?? (rateLimits[agent] ? `Orca usage ${source.status ?? 'status missing'}` : `Orca reports no usage for ${agent}`) }
      : {}),
  };
}

export async function readOrcaUsage(run: Runner): Promise<Record<AgentId, AgentUsage>> {
  let result: Record<string, unknown>;
  let rateLimits: Record<string, unknown>;
  try {
    const answer = await run('orca', ['account', 'list', '--json'], { timeoutMs: 20_000 });
    if (answer.code !== 0 || answer.error) {
      throw new Error(answer.error || answer.stderr.trim() || `command exited with code ${answer.code}`);
    }
    const data = JSON.parse(answer.stdout);
    if (data?.ok !== true) {
      const error = data?.error;
      throw new Error(typeof error === 'string' ? error : error?.message || 'account list failed');
    }
    const limits = data.result?.rateLimits;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new Error('account list response has no rate limits');
    }
    result = record(data.result);
    rateLimits = limits;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(agents.map((agent) => [agent, {
      agent, status: 'unknown', pools: {}, error: `Orca not reachable: ${message}`, unreachable: true,
    }]));
  }
  // Each agent on its own: one provider's unexpected shape leaves the others readable. An agent that cannot be
  // read counts as unreachable, so the ledger's snapshot of the same account stands in for it.
  return Object.fromEntries(agents.map((agent): [AgentId, AgentUsage] => {
    let account: string | undefined;
    try {
      account = accountOf(agent, result, record(rateLimits[agent]));
      return [agent, readAgent(agent, rateLimits, account)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [agent, {
        agent, status: 'unknown', pools: {}, ...(account !== undefined ? { account } : {}),
        error: `Orca usage for ${agent} could not be read: ${message}`, unreachable: true,
      }];
    }
  }));
}
