import type { AgentId, AgentUsage, Config, Effort, ReservationConfig, Tier, UsagePool } from '../types.js';

// Quota accounting, pure and deterministic. A quota bucket is one independently enforced limit: provider +
// account/runtime/plan scope + usage window. Three numbers are kept apart for each bucket:
//   reported   what Orca's latest valid snapshot says is used
//   reserved   the sum of the buffers of the workers currently reserving it, rebuilt from their records
//   effective  clamp(reported + reserved, 0, 100)
// Nothing here remembers a previous effective value, so a buffer can never accumulate across refreshes.

// --- buffer table ---------------------------------------------------------------------------

/** Rows of the buffer table: the four cost tiers, plus `minimal` for models mapped to it in `reservations.modelTiers`. */
export type BufferTier = 'minimal' | Tier;
export const BUFFER_TIERS: readonly BufferTier[] = ['minimal', 'light', 'daily', 'advanced', 'frontier'];
/** Columns of the buffer table. */
export type BufferEffort = 'low' | 'medium' | 'high' | 'xhigh';
export const BUFFER_EFFORTS: readonly BufferEffort[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Starting heuristics in percentage points per worker and bucket, not measured token costs. The design's
 * tiers map onto OrcaCompass cost tiers by name, with its `Standard` row being `daily`.
 */
export const DEFAULT_BUFFERS: Record<BufferTier, Record<BufferEffort, number>> = {
  minimal: { low: 0.5, medium: 0.5, high: 0.75, xhigh: 1 },
  light: { low: 0.5, medium: 1, high: 1.25, xhigh: 1.5 },
  daily: { low: 1, medium: 1.5, high: 1.75, xhigh: 2 },
  advanced: { low: 1.5, medium: 2, high: 2.5, xhigh: 3 },
  frontier: { low: 2, medium: 2.5, high: 3, xhigh: 3.5 },
};

/** A change to the buffer table for the workers and buckets it matches; every given field must match. */
export interface BufferOverride {
  agent?: AgentId;
  /** Orca's plan type, e.g. `max_5x`. */
  plan?: string;
  /** A usage window, e.g. `session`, `weekly` or `bucket:Other Models`. */
  pool?: string;
  /** Multiplies the buffer. */
  scale?: number;
  /** Replaces single cells of the table. */
  buffers?: Partial<Record<BufferTier, Partial<Record<BufferEffort, number>>>>;
}

/**
 * The buffer row of a model: its entry in `reservations.modelTiers` (by id or family), else its cost tier.
 * A model without a cost tier (Cursor auto, a preferred unranked model) reserves the largest row.
 */
export function bufferTierOf(model: { modelId: string; family?: string }, costTier: Tier | null, config: ReservationConfig): BufferTier {
  // Own keys only: a model called `constructor` or `toString` must not read a row off Object.prototype.
  const own = (key: string | undefined): BufferTier | undefined => (key !== undefined && Object.hasOwn(config.modelTiers, key) ? config.modelTiers[key] : undefined);
  return own(model.modelId) ?? own(model.family) ?? costTier ?? 'frontier';
}

/**
 * The buffer column of an applied effort: `none` and `minimal` use `low`, `max` uses `xhigh`. When the agent
 * decides the effort itself, its reported default is used, else `high`.
 */
export function bufferEffortOf(effort: Effort | null, providerDefault?: Effort): BufferEffort {
  const e = effort ?? providerDefault ?? 'high';
  if (e === 'none' || e === 'minimal') return 'low';
  if (e === 'max') return 'xhigh';
  return e;
}

/** Percentage points one worker reserves on one bucket. */
export function bufferFor(config: ReservationConfig, w: { agent: AgentId; plan?: string; pool: string; tier: BufferTier; effort: BufferEffort }): number {
  let value = config.buffers[w.tier][w.effort];
  for (const o of config.overrides) {
    if (o.agent !== undefined && o.agent !== w.agent) continue;
    if (o.plan !== undefined && o.plan !== w.plan) continue;
    if (o.pool !== undefined && poolKey(o.pool) !== poolKey(w.pool)) continue;
    const cell = o.buffers?.[w.tier]?.[w.effort];
    if (cell !== undefined) value = cell;
    if (o.scale !== undefined) value *= o.scale;
  }
  // A huge scale overflows to Infinity and a later scale of 0 makes NaN, which would classify as available.
  return Number.isFinite(value) ? clampPercent(value) : 100;
}

// --- reservations ---------------------------------------------------------------------------

/**
 * `pending` (reserved by `route`, launch not confirmed) → `running` → `completed` or
 * `cancelled_after_consumption`; these four count against their buckets. `failed_before_launch` (nothing was
 * consumed) and `released` (reconciled by a fresh snapshot) count for nothing and are pruned.
 */
export type ReservationState = 'pending' | 'running' | 'completed' | 'cancelled_after_consumption' | 'failed_before_launch' | 'released';
export const RESERVATION_STATES: readonly ReservationState[] = ['pending', 'running', 'completed', 'cancelled_after_consumption', 'failed_before_launch', 'released'];

/** One allocated worker. Its buffer is never stored: it is recalculated from `tier` and `effort` on every use. */
export interface Reservation {
  /** Stable unique id; a worker is counted once per bucket by it. */
  id: string;
  state: ReservationState;
  agent: AgentId;
  /** The launch model id. */
  model: string;
  tier: BufferTier;
  effort: BufferEffort;
  /** The quota identity (account, runtime, plan) it was reserved on. */
  scope: string;
  /**
   * Canonical keys of every usage window the model is declared to draw on; aliases are folded, so each bucket
   * appears once. A declared window Orca does not report now still counts once it appears.
   */
  pools: string[];
  /** Keys of `pools` a fresh reading already covers after the worker ended: they no longer count. */
  settled?: string[];
  /** The account (`AgentUsage.account`) the capacity was reserved on, when known. */
  account?: string;
  /** The plan (`AgentUsage.plan`) the capacity was reserved on, when known. */
  plan?: string;
  /** The Orca Dispatch of the worker, once known. */
  dispatchId?: string;
  createdAt: number;
  startedAt?: number;
  /** When the worker was seen finished or cancelled; a snapshot taken after it reconciles the reservation. */
  endedAt?: number;
  /**
   * The end was inferred from a timeout (`pendingMinutes`, `maxRunningHours`), not reported by anyone. Later
   * proof replaces it: a worker Orca confirms live is running again, an explicit end stands as given.
   */
  inferred?: true;
  /** The provider's snapshot time when the capacity was reserved. */
  snapshotAt: number | null;
  note?: string;
}

/** Whether a reservation still counts against its buckets. */
export const isLive = (r: Reservation): boolean =>
  r.state === 'pending' || r.state === 'running' || r.state === 'completed' || r.state === 'cancelled_after_consumption';

/**
 * Canonical key of a usage window name: aliases that differ in case or spacing fold into one bucket, and so do
 * `bucket: Other Models` and `bucket:Other Models`.
 */
export const poolKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase().replace(/^bucket:\s*/, 'bucket:');

/** The id of a quota bucket: provider, quota identity and window. */
export const bucketId = (agent: AgentId, scope: string, pool: string): string => `${agent}:${scope}:${poolKey(pool)}`;

/**
 * The scope of an agent's usage. Only a readable (`ok`) snapshot has a known quota identity; anything else, and
 * agents Orca gives no identity for, share the `default` scope, which a record adopts once a snapshot exists.
 */
export const scopeOf = (usage: Pick<AgentUsage, 'scope'> & Partial<Pick<AgentUsage, 'status'>> | undefined): string =>
  usage !== undefined && (usage.status === undefined || usage.status === 'ok') ? usage.scope ?? 'default' : 'default';

/**
 * Whether a usage window is one a declared window name draws on: the same window, or (Antigravity) any window
 * of the quota group the name designates, so `bucket:Gemini Models` draws on its 5-hour window too.
 */
export function drawsOn(declared: string, pool: Pick<UsagePool, 'name' | 'group'>): boolean {
  const key = poolKey(declared);
  return poolKey(pool.name) === key || (pool.group !== undefined && poolKey(`bucket:${pool.group}`) === key);
}

/**
 * Windows Orca copies forward instead of re-reading: Claude's status-line path (`live-session`) writes the
 * previous `fableWeekly` and `monthly` again with a new `updatedAt`. Their `updatedAt` does not prove a re-read.
 */
export const CARRIED_WINDOWS: Readonly<Record<AgentId, { source: string; keys: readonly string[] }>> = {
  claude: { source: 'live-session', keys: ['fableweekly', 'monthly'] },
};

/** Whether `name` is a window Orca carries forward for this agent and reading source. */
export function isCarried(agent: AgentId, source: string | undefined, name: string): boolean {
  const carried = Object.hasOwn(CARRIED_WINDOWS, agent) ? CARRIED_WINDOWS[agent] : undefined;
  return carried !== undefined && source === carried.source && carried.keys.includes(poolKey(name));
}

/**
 * A carried window whose value did not move settles a finished worker once a healthy snapshot (`ok`, not
 * retained) is this long past its end: a small worker may not move the integer percentage at all. During a
 * provider error Orca reports `error` and keeps its old windows (`retained`), so this never fires then.
 */
export const CARRIED_SETTLE_MS = 20 * 60_000;

// --- bucket view ----------------------------------------------------------------------------

/**
 * `reserved`: effective usage reaches 100% only through temporary reservations. `exhausted`: the reported
 * usage itself is 100%. `unknown` is never read as available or as exhausted.
 */
export type QuotaStatus = 'available' | 'caution' | 'high' | 'reserved' | 'exhausted' | 'unknown';

/** Least to most restrictive; `unknown` ranks between caution and high risk. */
const SEVERITY: Record<QuotaStatus, number> = { available: 0, caution: 1, unknown: 2, high: 3, reserved: 4, exhausted: 5 };
export const worseStatus = (a: QuotaStatus, b: QuotaStatus): QuotaStatus => (SEVERITY[b] > SEVERITY[a] ? b : a);

export interface BucketQuota {
  id: string;
  agent: AgentId;
  scope: string;
  /** The window's name as Orca reports it. */
  pool: string;
  kind: UsagePool['kind'];
  windowMinutes: number | null;
  /** Latest valid reported usage; null when unknown. */
  reported: number | null;
  /** Sum of the buffers of the workers reserving this bucket, in percentage points; not clamped. */
  reserved: number;
  /** Workers reserving this bucket, each counted once. */
  workers: number;
  /** clamp(reported + reserved, 0, 100); null when reported is unknown. */
  effective: number | null;
  /** 100 - effective; null when unknown. */
  remaining: number | null;
  status: QuotaStatus;
  /** Null when Orca reports no reset time: nothing is made up. */
  resetsAt: number | null;
  /** When Orca took the snapshot the reported usage comes from. */
  snapshotAt: number | null;
  /** The snapshot is older than `usageStaleMinutes`. */
  stale: boolean;
  /** Why the usage is unknown or what to know about it. */
  note?: string;
}

export interface QuotaView {
  /** Most remaining effective capacity first; unknown buckets last. */
  buckets: BucketQuota[];
}

export const clampPercent = (n: number): number => Math.min(100, Math.max(0, n));

/** The status of a bucket at `total` = reported + reserved (+ a prospective worker's buffer). */
export function classify(reported: number | null, total: number | null, thresholds: Config['riskThresholds']): QuotaStatus {
  if (reported === null || total === null) return 'unknown';
  if (reported >= 100) return 'exhausted';
  if (total >= 100) return 'reserved';
  if (total >= thresholds.highPercent) return 'high';
  if (total >= thresholds.cautionPercent) return 'caution';
  return 'available';
}

/**
 * The reservations counting against one bucket: each worker once, and each Dispatch once (the first record
 * stands). A record no longer counts on a window it has settled. `pool` is a window name or the window itself;
 * only the window carries its quota group.
 */
export function reservationsOn(reservations: readonly Reservation[], agent: AgentId, scope: string, pool: string | Pick<UsagePool, 'name' | 'group'>): Reservation[] {
  const target = typeof pool === 'string' ? { name: pool } : pool;
  const seen = new Set<string>();
  const dispatches = new Set<string>();
  return reservations.filter((r) => {
    if (!isLive(r) || r.agent !== agent || r.scope !== scope || seen.has(r.id)) return false;
    if (r.dispatchId !== undefined && dispatches.has(r.dispatchId)) return false;
    if (!countsOn(r, target)) return false;
    seen.add(r.id);
    if (r.dispatchId !== undefined) dispatches.add(r.dispatchId);
    return true;
  });
}

/**
 * Whether a record still holds capacity on one window: a declared window it has not settled draws on it, and
 * the window is not settled under its own name. Antigravity models declare a window (`bucket:gemini models 5h`)
 * and its group (`bucket:gemini models`): once the 5-hour window is settled, the group key, still open for the
 * weekly window, must not charge it a second way. The group keeps charging its other windows until all settle.
 */
export function countsOn(r: Pick<Reservation, 'pools' | 'settled'>, pool: Pick<UsagePool, 'name' | 'group'>): boolean {
  const settled = new Set((r.settled ?? []).map(poolKey));
  if (settled.has(poolKey(pool.name))) return false;
  return r.pools.some((p) => !settled.has(poolKey(p)) && drawsOn(p, pool));
}

/** One bucket, rebuilt from the latest snapshot and the live reservation records. */
export function bucketQuota(usage: AgentUsage, pool: UsagePool, reservations: readonly Reservation[], config: Config, now: number): BucketQuota {
  const scope = scopeOf(usage);
  const mine = reservationsOn(reservations, usage.agent, scope, pool);
  const reserved = mine.reduce((sum, r) => sum + bufferFor(config.reservations, { agent: usage.agent, plan: usage.plan, pool: pool.name, tier: r.tier, effort: r.effort }), 0);
  // A window the ledger kept from an earlier reading ages from the last snapshot that reported it.
  const snapshotAt = pool.seenAt ?? usage.updatedAt ?? null;
  const age = snapshotAt === null ? 0 : now - snapshotAt;
  const staleMs = config.usageStaleMinutes * 60_000;
  let reported = validPercent(pool.usedPercent);
  let resetsAt = pool.resetsAt !== null && pool.resetsAt > 0 ? pool.resetsAt : null;
  let note: string | undefined;
  if (reported === null) note = 'usage not reported';
  else if (age > 4 * staleMs) {
    reported = null;
    note = `usage unknown: the last snapshot is ${duration(age)} old`;
  } else if (resetsAt !== null && resetsAt <= now) {
    // The window rolled over. A snapshot taken after that still holds; one taken before describes the old window.
    if (snapshotAt !== null && snapshotAt >= resetsAt) resetsAt = null;
    else {
      reported = null;
      note = 'usage unknown: the window reset after the last snapshot';
    }
  }
  if (reported !== null && pool.resetsAt === null) note = 'no reset time reported (window not started or unknown)';
  // No snapshot time: the number is kept (a reported 100% still blocks) but its age is unknown, so it is stale.
  if (reported !== null && snapshotAt === null) note = note === undefined ? 'snapshot time not reported' : `${note}; snapshot time not reported`;
  const effective = reported === null ? null : clampPercent(reported + reserved);
  return {
    id: bucketId(usage.agent, scope, pool.name), agent: usage.agent, scope, pool: pool.name, kind: pool.kind, windowMinutes: pool.windowMinutes,
    reported, reserved, workers: mine.length, effective, remaining: effective === null ? null : 100 - effective,
    status: classify(reported, effective, config.riskThresholds), resetsAt, snapshotAt, stale: snapshotAt === null || age > staleMs,
    ...(note ? { note } : {}),
  };
}

function validPercent(n: number | null): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(100, n) : null;
}

/** Every bucket of every agent with a readable snapshot, most remaining capacity first. */
export function buildQuotaView(usage: Record<AgentId, AgentUsage>, reservations: readonly Reservation[], config: Config, now: number): QuotaView {
  const buckets: BucketQuota[] = [];
  for (const u of Object.values(usage)) {
    if (u.status !== 'ok') continue;
    const seen = new Set<string>();
    for (const pool of Object.values(u.pools)) {
      const b = bucketQuota(u, pool, reservations, config, now);
      // Two names for one window: the first stands for the bucket.
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      buckets.push(b);
    }
  }
  return { buckets: buckets.sort(byRemaining) };
}

/** Most remaining effective capacity first, unknown last, then by id so the order is total. */
export function byRemaining(a: Pick<BucketQuota, 'remaining' | 'id'>, b: Pick<BucketQuota, 'remaining' | 'id'>): number {
  if ((a.remaining === null) !== (b.remaining === null)) return a.remaining === null ? 1 : -1;
  if (a.remaining !== null && b.remaining !== null && a.remaining !== b.remaining) return b.remaining - a.remaining;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// --- a candidate's quota --------------------------------------------------------------------

export interface CandidateBucket extends BucketQuota {
  /** Percentage points this worker would reserve on the bucket. */
  buffer: number;
  /** clamp(reported + reserved + buffer, 0, 100); null when reported is unknown. */
  prospective: number | null;
  /** The status at the prospective usage: what routing checks against the thresholds. */
  prospectiveStatus: QuotaStatus;
}

export interface CandidateQuota {
  /** The most restrictive prospective status across every quota the route draws on. */
  status: QuotaStatus;
  /** The bucket with the least remaining effective capacity: it ranks the route. Null when none is known. */
  binding: string | null;
  /** Remaining effective capacity of the binding bucket, before this worker. */
  remaining: number | null;
  /** The highest prospective usage across the buckets; null when unknown. */
  prospective: number | null;
  buckets: CandidateBucket[];
  /** Why usage could not be evaluated. */
  note?: string;
}

/**
 * The quota of a route: each distinct bucket its model draws on, once, with the buffer this worker would add.
 * Windows are evaluated separately, never summed; the most restrictive one decides.
 */
export function candidateQuota(
  usage: AgentUsage | undefined,
  poolNames: readonly string[],
  worker: { tier: BufferTier; effort: BufferEffort },
  reservations: readonly Reservation[],
  config: Config,
  now: number,
): CandidateQuota {
  const unknown = (note: string): CandidateQuota => ({ status: 'unknown', binding: null, remaining: null, prospective: null, buckets: [], note });
  if (!usage || usage.status !== 'ok') return unknown(usage?.error ? `usage unknown (${usage.error})` : 'usage unknown (Orca not reachable)');
  const buckets: CandidateBucket[] = [];
  const seen = new Set<string>();
  for (const name of poolNames) {
    // Every window the declared name draws on (an Antigravity group name: each window of the group), each bucket once.
    for (const pool of Object.values(usage.pools).filter((p) => drawsOn(name, p))) {
      const b = bucketQuota(usage, pool, reservations, config, now);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const buffer = bufferFor(config.reservations, { agent: usage.agent, plan: usage.plan, pool: pool.name, ...worker });
      const prospective = b.reported === null ? null : clampPercent(b.reported + b.reserved + buffer);
      buckets.push({ ...b, buffer, prospective, prospectiveStatus: classify(b.reported, prospective, config.riskThresholds) });
    }
  }
  if (buckets.length === 0) return unknown('usage unknown (no matching usage pool)');
  // The most restrictive bucket: the one with the least remaining effective capacity.
  const known = buckets.filter((b) => b.remaining !== null).sort(byRemaining).reverse();
  const prospectives = buckets.map((b) => b.prospective).filter((p): p is number => p !== null);
  const firstUnknown = buckets.find((b) => b.reported === null);
  return {
    status: buckets.map((b) => b.prospectiveStatus).reduce(worseStatus),
    binding: known[0]?.id ?? null,
    remaining: known[0]?.remaining ?? null,
    prospective: prospectives.length === buckets.length ? Math.max(...prospectives) : null,
    buckets,
    ...(firstUnknown?.note ? { note: `${displayPool(firstUnknown.pool)}: ${firstUnknown.note}` } : {}),
  };
}

// --- reconciliation -------------------------------------------------------------------------

/** What Orca says about one worker's Dispatch. */
export interface WorkerState {
  dispatchId: string;
  /** `in_progress`, `succeeded`, `failed`, ... */
  outcome?: string;
  /** `live`, `unverifiable` or `exited`. */
  liveness?: string;
  terminalState?: string;
  /** The agent Orca launched the worker with, when it says (`agent/model` in the worker list). */
  agent?: string;
  /** The model Orca launched the worker with, when it says. */
  model?: string;
}

const TERMINAL_RETENTION_MS = 3_600_000;
const RECORD_RETENTION_MS = 7 * 86_400_000;

/** Whether Orca confirms a worker is still running: live, not settled, its terminal not released. */
export const isConfirmedLive = (w: WorkerState): boolean =>
  w.liveness === 'live' && (w.outcome === undefined || w.outcome === 'in_progress') && w.terminalState !== 'released';

/** The Dispatches Orca confirms are still running. */
export const confirmedLiveDispatches = (workers: readonly WorkerState[]): Set<string> =>
  new Set(workers.filter(isConfirmedLive).map((w) => w.dispatchId));

/**
 * Whether a fresh reading covers what a finished worker drew from one declared window (`key`):
 * - windows the key draws on exist: every one of them was observed at least `settleMs` after the worker ended
 *   and after the snapshot it was allocated on. A window without `observedAt` counts as observed at the
 *   snapshot's `updatedAt` (pure callers);
 * - a window Orca carries forward (see `CARRIED_WINDOWS`) whose value did not move also settles once a healthy
 *   snapshot that reported it is `CARRIED_SETTLE_MS` past the end;
 * - a window listed without a valid percentage (null, not finite) was not read: it settles nothing, whatever
 *   its time says;
 * - no window matches: the provider reported after the worker ended and has no such window.
 */
function windowSettled(key: string, r: Reservation, u: AgentUsage & { updatedAt: number }, endedAt: number, settleMs: number): boolean {
  const after = (t: number, wait: number): boolean => t >= endedAt + wait && (r.snapshotAt === null || t > r.snapshotAt);
  const matching = Object.values(u.pools).filter((p) => drawsOn(key, p));
  if (matching.length === 0) return after(u.updatedAt, settleMs);
  return matching.every((p) => validPercent(p.usedPercent) !== null && (after(p.observedAt ?? u.updatedAt, settleMs) ||
    (isCarried(r.agent, u.source, p.name) && after(p.seenAt ?? u.updatedAt, Math.max(settleMs, CARRIED_SETTLE_MS)))));
}

/**
 * Takes back an end that was only inferred from a timeout, on proof the worker is running: the record is
 * `running` again and counts on every window, including those settled meanwhile. Any other record is returned
 * as it is.
 */
export function revive(r: Reservation, now: number): Reservation {
  if (!r.inferred) return r;
  const { inferred: _inferred, endedAt: _endedAt, settled: _settled, note: _note, ...rest } = r;
  return { ...rest, state: 'running', startedAt: r.startedAt ?? now };
}

/**
 * Brings the records up to date with what is known now. Deterministic: the same records, snapshots and time
 * give the same result, and running it again changes nothing.
 *
 * - A pending reservation nobody confirmed within `pendingMinutes` is abandoned. Its worker may still have
 *   run, so it is held like a cancelled one until a fresh snapshot covers it.
 * - A running reservation older than `maxRunningHours` is closed the same way, unless its Dispatch is in
 *   `confirmedLive` (Orca reports it still running).
 * - Both of these ends are marked `inferred`. A record with an inferred end whose Dispatch is in `confirmedLive`
 *   is running again (see `revive`), even after a snapshot released it.
 * - A completed or cancelled reservation is settled window by window (see `windowSettled`), only by a
 *   readable, non-retained snapshot of its own provider and quota identity. The time is Orca's own: re-reading
 *   a cached snapshot never settles anything, and a fresh one settles even when it reports the same
 *   percentage. A window settled no longer counts; once every window is settled the record is released.
 * - A provider whose snapshot did not advance (a partial refresh, an error, another account) keeps its
 *   reservations.
 * - Records that count for nothing are dropped an hour after they ended; any record but a running one is
 *   dropped seven days after it ended (a held record nobody reconciled by then stops counting).
 */
export function reconcile(
  list: readonly Reservation[],
  usage: Record<AgentId, AgentUsage>,
  now: number,
  config: ReservationConfig,
  confirmedLive?: ReadonlySet<string>,
): Reservation[] {
  const pendingMs = config.pendingMinutes * 60_000;
  const settleMs = config.settleSeconds * 1000;
  const runningMs = config.maxRunningHours * 3_600_000;
  const out: Reservation[] = [];
  for (const original of list) {
    let r = original;
    const confirmed = r.dispatchId !== undefined && confirmedLive?.has(r.dispatchId) === true;
    if (confirmed) r = revive(r, now);
    if (r.state === 'pending' && now - r.createdAt >= pendingMs) {
      r = { ...r, state: 'cancelled_after_consumption', endedAt: r.createdAt + pendingMs, inferred: true, note: 'abandoned: the launch was never confirmed' };
    }
    if (r.state === 'running' && !confirmed && now - (r.startedAt ?? r.createdAt) >= runningMs) {
      r = { ...r, state: 'completed', endedAt: now, inferred: true, note: `closed: still running after ${config.maxRunningHours}h` };
    }
    if (r.state === 'completed' || r.state === 'cancelled_after_consumption') {
      const u = Object.hasOwn(usage, r.agent) ? usage[r.agent] : undefined;
      const endedAt = r.endedAt ?? r.createdAt;
      if (u && u.status === 'ok' && !u.retained && !u.standIn && scopeOf(u) === r.scope && u.updatedAt !== undefined) {
        const fresh = u as AgentUsage & { updatedAt: number };
        const keys = [...new Set(r.pools.map(poolKey))];
        const before = new Set((r.settled ?? []).map(poolKey));
        const settled = keys.filter((k) => before.has(k) || windowSettled(k, r, fresh, endedAt, settleMs));
        const all = keys.length === 0 ? windowSettled('', r, { ...fresh, pools: {} }, endedAt, settleMs) : settled.length === keys.length;
        if (all) {
          const { settled: _settled, ...rest } = r;
          r = { ...rest, state: 'released', endedAt, note: `reconciled by the usage snapshot of ${new Date(fresh.updatedAt).toISOString()}` };
        } else if (settled.some((k) => !before.has(k))) {
          r = { ...r, settled };
        }
      }
    }
    const age = now - (r.endedAt ?? r.createdAt);
    if (!isLive(r) && age >= TERMINAL_RETENTION_MS) continue;
    if (r.state !== 'running' && age >= RECORD_RETENTION_MS) continue;
    out.push(r);
  }
  return out;
}

/**
 * Applies Orca's view of the workers to the reservations bound to them. `complete` says the list holds every
 * worker Orca knows, so a bound worker missing from it is gone. A record whose end was only inferred from a
 * timeout is running again when Orca confirms its worker live; nothing else changes an ended record.
 */
export function applyWorkerStates(list: readonly Reservation[], workers: readonly WorkerState[], now: number, complete: boolean): Reservation[] {
  const byId = new Map(workers.map((w) => [w.dispatchId, w]));
  return list.map((r) => {
    if (!r.dispatchId) return r;
    const w = byId.get(r.dispatchId);
    if (r.inferred) return w !== undefined && isConfirmedLive(w) ? revive(r, now) : r;
    if (r.state !== 'pending' && r.state !== 'running') return r;
    if (!w) return complete ? { ...r, state: 'completed' as const, endedAt: now, note: 'closed: Orca no longer reports this worker' } : r;
    if (w.outcome === 'succeeded') return { ...r, state: 'completed' as const, endedAt: now };
    // Any other settled outcome, an exited agent or a released terminal: it ran and is over.
    if ((w.outcome !== undefined && w.outcome !== 'in_progress') || w.liveness === 'exited' || w.terminalState === 'released') {
      return { ...r, state: 'cancelled_after_consumption' as const, endedAt: now, note: 'the worker ended without reporting success' };
    }
    return r.state === 'pending' ? { ...r, state: 'running' as const, startedAt: now } : r;
  });
}

// --- text -----------------------------------------------------------------------------------

export const displayPool = (name: string): string => name.replace(/^bucket:/, '');
export const percentText = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
export const pointsText = (n: number): string => `${Number(n.toFixed(2))} pp`;

export function duration(ms: number): string {
  if (ms <= 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(ms / 60_000)}m`;
}

/** e.g. "weekly 50% reported + 5 pp reserved (2 workers) = 55% effective, available". */
export function bucketText(b: BucketQuota): string {
  if (b.reported === null) return `${displayPool(b.pool)} ${b.note ?? 'usage unknown'}${b.reserved > 0 ? `, ${pointsText(b.reserved)} reserved (${workersText(b.workers)})` : ''}`;
  const reserved = b.reserved > 0 ? ` + ${pointsText(b.reserved)} reserved (${workersText(b.workers)}) = ${percentText(b.effective!)} effective` : '';
  return `${displayPool(b.pool)} ${percentText(b.reported)} reported${reserved}, ${statusText(b.status)}`;
}

/** e.g. "weekly 50% reported + 5 pp reserved (2 workers) + 1.5 pp for this worker = 56.5% prospective (available)". */
export function candidateBucketText(b: CandidateBucket): string {
  if (b.reported === null || b.prospective === null) return `${displayPool(b.pool)} ${b.note ?? 'usage unknown'}`;
  const reserved = b.reserved > 0 ? ` + ${pointsText(b.reserved)} reserved (${workersText(b.workers)})` : '';
  return `${displayPool(b.pool)} ${percentText(b.reported)} reported${reserved} + ${pointsText(b.buffer)} for this worker = ${percentText(b.prospective)} prospective (${statusText(b.prospectiveStatus)})`;
}

const workersText = (n: number): string => `${n} worker${n === 1 ? '' : 's'}`;

export function statusText(s: QuotaStatus): string {
  return { available: 'available', caution: 'caution', high: 'high risk', reserved: 'fully reserved', exhausted: 'exhausted', unknown: 'unknown' }[s];
}
