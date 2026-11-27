// Shared types for the routing core and its adapters. The core never does I/O;
// adapters turn the machine into an Environment and the router turns that into a Decision.

export type { Axis } from './evidence/snapshot.js';
export type { AxisProfile, CostSource, CostTier, EvidenceLabel, Profile } from './placements/profiles.js';
import type { Axis, EvidenceSnapshot } from './evidence/snapshot.js';
import type { CostTier, EvidenceLabel, Profile } from './placements/profiles.js';
import type { Need, Needs } from './routing/needs.js';
export type { Need, Needs } from './routing/needs.js';

import type { Rejection } from './routing/rejection.js';
import type { BufferEffort, BufferOverride, BufferTier, CandidateQuota, QuotaView, Reservation } from './routing/quota.js';
export type { BucketQuota, BufferEffort, BufferOverride, BufferTier, CandidateQuota, QuotaStatus, QuotaView, Reservation, ReservationState } from './routing/quota.js';

export type Tier = 'light' | 'daily' | 'advanced' | 'frontier';
export const TIERS: readonly Tier[] = ['light', 'daily', 'advanced', 'frontier'];

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** How much reasoning a job needs, separate from how capable a model it needs (the tier). */
export type Demand = 'low' | 'moderate' | 'high' | 'exceptional';
export const DEMANDS: readonly Demand[] = ['low', 'moderate', 'high', 'exceptional'];
/** How an effort demand maps to effort: `balanced` is the default. */
export type EffortPolicy = 'efficient' | 'balanced' | 'quality';
export const EFFORT_POLICIES: readonly EffortPolicy[] = ['efficient', 'balanced', 'quality'];
export type Confidence = 'high' | 'medium' | 'low';
export type AgentId = string;
/** Every agent OrcaCompass knows, in display order. */
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'cursor', 'grok', 'antigravity', 'opencode', 'muse'];

export interface ModelMeta {
  id: string;
  provider: string;
  name: string;
  family?: string;
  releaseDate?: string;
}
export type ModelIndex = Record<string, ModelMeta>;

export type DataSource = 'network' | 'cache' | 'snapshot';

/** One usage window as Orca reports it. Never adjusted: reservations are kept apart (see routing/quota.ts). */
export interface UsagePool {
  name: string;
  kind: 'session' | 'long';
  /** Reported usage, 0..100. Null when Orca gave no valid number: unknown, never read as 0. */
  usedPercent: number | null;
  /** Null when Orca gave no window length. */
  windowMinutes: number | null;
  /** Epoch ms of the next reset. Null when Orca reports none (`0` or `null`): the window has not started or its reset is unknown. */
  resetsAt: number | null;
}

export interface AgentUsage {
  agent: AgentId;
  status: 'ok' | 'unavailable' | 'unknown';
  pools: Record<string, UsagePool>;
  /** When Orca took this snapshot (its own `updatedAt`): the snapshot's identity, new on every real refresh. */
  updatedAt?: number;
  error?: string;
  /**
   * The quota identity these pools belong to: account, runtime and plan, hashed. A different scope is a
   * different set of quota buckets, so reservations never move between accounts, runtimes or plans.
   */
  scope?: string;
  /** Orca's `planType`, when it reports one. */
  plan?: string;
  /** Set when Orca could not be read and the last valid snapshot stands in for it. */
  retained?: true;
  /** Set when Orca itself could not be read (not running, CLI error), as opposed to Orca reporting no usage. */
  unreachable?: true;
}

export type Launch =
  // claude, codex: --model <model> --effort <effort>
  | { kind: 'flag'; model: string }
  // cursor: effort is baked into the model id
  | { kind: 'variant'; ids: Partial<Record<Effort, string>>; defaultId?: string };

/**
 * Where a model's supported efforts come from, most trusted first: the agent CLI's own model list or cache
 * (`provider`), Orca's catalog or effort menu (`orca`), or a built-in guess (`assumed`).
 */
export type EffortSource = 'provider' | 'orca' | 'assumed';

export interface LaunchModel {
  agent: AgentId;
  modelId: string; // Canonical snapshot id when known, otherwise the raw id
  meta?: ModelMeta;
  efforts: Effort[];
  effortSource?: EffortSource;
  /** The effort the agent uses when none is passed, when the provider says so. */
  defaultEffort?: Effort;
  launch: Launch;
  poolNames: string[];
  fast?: boolean;
  noZdr?: boolean;
  /** How a model without a usage window is paid for, e.g. "pay per use through openrouter" (OpenCode). */
  billing?: string;
  /** The provider's own one-line description of the model's place in its lineup, e.g. "For your toughest challenges". */
  lineup?: string;
}

/** One tier a model may serve and why; `detail` carries the numbers or words behind it. */
export interface Classification {
  tier: Tier;
  source: 'override' | 'lineup' | 'family';
  /** The numbers or provider description behind a placement. */
  detail?: string;
}
export const CLASSIFICATION_SOURCES: readonly Classification['source'][] = ['override', 'lineup', 'family'];

export interface AgentDiscovery {
  agent: AgentId;
  installed: boolean;
  models: LaunchModel[];
  note?: string;
  /** The agent's model listing asked the user to sign in. */
  signedOut?: boolean;
}

/** A discovered model with its placement result, as stored in the placement table. */
export interface PlacedModel extends LaunchModel {
  profile: Profile;
}

export interface PlacedAgent {
  agent: AgentId;
  installed: boolean;
  models: PlacedModel[];
  note?: string;
  signedOut?: boolean;
}

/** What a metadata source contributed to a table build. */
export interface SourceInfo {
  source: DataSource;
  fetchedAt: number;
  models: number;
}

/** The config keys that move a model between tiers; a change rebuilds the table. */
export type BuiltWith = Pick<Config, 'tierOverrides' | 'costBands'>;

/** Every discovered model's profile, cached for `placementsTtlHours`. */
export interface PlacementTable {
  schemaVersion: 5;
  version: string;
  builtAt: number;
  builtWith: BuiltWith;
  sources: {
    evidence: SourceInfo & { generatedAt: string };
  };
  bands: EvidenceSnapshot['bands'];
  /** The `top` need cuts; absent in tables built before 0.2.3. */
  topBands?: EvidenceSnapshot['topBands'];
  agents: PlacedAgent[];
}

/** Orca's agent on/off setting (settings.disabledTuiAgents), or why it could not be read. */
export type OrcaAgents =
  | { known: true; disabled: AgentId[]; source: string }
  | { known: false; reason: string };

export interface Environment {
  now: number;
  bands: EvidenceSnapshot['bands'];
  topBands?: EvidenceSnapshot['topBands'];
  /** Every agent with its models already placed (the placement table's rows). */
  discoveries: PlacedAgent[];
  usage: Record<AgentId, AgentUsage>;
  /** Live reservations of allocated workers, already reconciled against `usage`; the quota view is rebuilt from them. */
  reservations?: Reservation[];
  /** Absent or unknown: every installed agent counts as enabled in Orca. */
  orcaAgents?: OrcaAgents;
  /** When the placement table the discoveries come from was built. */
  placementsBuiltAt: number;
  evidenceSource: DataSource;
  evidenceGeneratedAt: string;
  /** Compatibility alias of evidenceSource for one release. */
  catalogSource: DataSource;
  /** Compatibility alias of evidenceSource for one release. */
  scoreSource: DataSource;
  /** Models an agent refused at launch recently (see `orcacompass verify`); routing skips them. */
  rejections?: Rejection[];
}

export type RouteRequest = RouteOptions & ({ tier: Tier; needs?: never } | { needs: Needs; tier?: never });

interface RouteOptions {
  /** The coordinator's short explanation of the task classification. */
  tierReason?: string;
  agents?: AgentId[];
  excludeAgents?: AgentId[];
  /** An explicit effort: only routes that can apply exactly this effort are used. */
  effort?: Effort;
  /** The job's effort demand; the effort follows it through `effortPolicy`. */
  demand?: Demand;
  /**
   * The Orchestrator's explicit choice of one route (USE after a `decide`): taken despite risk thresholds and
   * capability or effort shortfalls, never when a quota it draws on is actually exhausted.
   */
  use?: { agent: AgentId; model: string };
}

/** How a route's effort was chosen and how the launch applies it. */
export interface EffortResolution {
  /** `explicit` (--effort), `demand` (--demand through effortPolicy) or `tier-default` (defaultEffort of the requested tier). */
  source: 'explicit' | 'demand' | 'tier-default';
  demand?: Demand;
  policy?: EffortPolicy;
  /** The effort asked for. */
  target: Effort;
  /** The effort the launch asks the agent for; null when the agent decides. */
  resolved: Effort | null;
  /** `flag` (--effort), `model-id` (an effort variant such as claude-fable-5-1-high), or `provider-default` (nothing passed). */
  applied: 'flag' | 'model-id' | 'provider-default';
  /** The model does not offer the target, so another supported effort is used: the next higher one; a lower one only for a tier default. */
  adjusted: boolean;
  /** Where the model's supported efforts come from. */
  supportSource: EffortSource | 'unknown';
  /** The effort the agent uses when none is passed, when the provider says so. */
  providerDefault?: Effort;
}

export interface Alternative {
  agent: AgentId;
  model: string;
  effort: Effort | null;
  tier: Tier;
  quality: Quality;
  /** Reported, reserved, effective and prospective usage of every quota the route draws on; null without a usage window. */
  quota: CandidateQuota | null;
  confidence: Confidence;
  /** A quota it draws on is actually exhausted. */
  blocked: boolean;
  reason: string;
}

/** A route the Orchestrator may choose itself after a `decide`. */
export interface RouteOption {
  agent: AgentId;
  model: string;
  effort: Effort | null;
  tier: Tier | null;
  quota: CandidateQuota | null;
  /** Why it was not routed automatically. */
  reason: string;
  /** The flag that makes this choice on the same route call: `--use <agent>/<model>`. */
  use: string;
  lastResort?: true;
  /** The tier's preferred route, held back only by preferRiskLimit. */
  preferred?: true;
  /** Set when benchmark data is missing on a needed axis, so task coverage could not be verified. */
  coverageNote?: string;
}

/** What the Orchestrator can do when no suitable route is below the automatic-routing threshold. */
export interface DecisionOptions {
  /** WAIT: for a quota reset or a fresh usage snapshot. `until` is absent when no reset time is known. */
  wait: { until?: number; reason: string } | null;
  /** USE: suitable routes above the threshold whose quota is not actually exhausted. */
  use: RouteOption[];
  /** LOWER: routes that would take the job with lower capability or effort requirements. */
  lower: (RouteOption & { shortfall: string })[];
}

export interface Quality {
  class: Tier | null;
  cost: CostTier | null;
  /** True when all needed axes meet their cuts, false on measured shortfall, null when benchmark data is unavailable. */
  covers: boolean | null;
  shortfall: number;
  overshoot: number;
  evidence: EvidenceLabel;
  axes: Record<Axis, { score: number | null; band: Tier | null; evidence: EvidenceLabel; benchmarks: number; need: Need; cut: number | null }>;
}

export interface Decision {
  /** `ok`: routed and reserved. `decide`: the Orchestrator chooses WAIT, USE or LOWER (see `options`). `none`: nothing can take the job. */
  status: 'ok' | 'decide' | 'none';
  requestedTier: Tier;
  needs: Needs;
  needsSource: 'need' | 'tier';
  quality?: Quality | null;
  source?: Classification['source'] | 'evidence' | 'auto';
  tierReason?: string;
  /** The cost tier of the selected model; absent when no cost tier is known, including Cursor auto. */
  tier?: Tier;
  downgraded: boolean;
  upgraded: boolean;
  /**
   * Informational: benchmark data is missing on a needed axis of a manually preferred or --use model, so task
   * coverage could not be verified. Not a shortfall and not a downgrade; absent for routes whose coverage was checked.
   */
  coverageNote?: string;
  route?: { agent: AgentId; model: string; effort: Effort | null };
  /** How the route's effort was chosen and applied; present with `route`. */
  effort?: EffortResolution;
  launchArgs?: string[];
  confidence?: Confidence;
  /** The route's quota: every bucket it draws on, reported, reserved, effective and prospective; null without a usage window. */
  quota?: CandidateQuota | null;
  /** The capacity reserved for the routed worker; absent on a dry run and when nothing was routed. */
  reservation?: { id: string; state: 'pending'; buckets: { bucket: string; percentPoints: number }[]; expiresAt: number };
  /** Every quota bucket of the agents considered, most remaining capacity first. */
  buckets?: QuotaView['buckets'];
  /** With `decide`. */
  options?: DecisionOptions;
  reasons: string[];
  warnings: string[];
  alternatives: Alternative[];
  /** Agents left out, and with `model` set, single models (banned by the user, or refused by the agent at launch). */
  skipped: { agent: AgentId; model?: string; reason: string }[];
}

export interface Preference {
  agent: AgentId;
  model?: string;
}

export interface Config {
  allowAgents?: AgentId[];
  denyAgents: AgentId[];
  /** The user's preferred route per tier; without a model, the agent's best model in the tier. */
  pins: Partial<Record<Tier, Preference>>;
  /** A preferred route is used while its prospective usage stays below this percentage on every quota it draws on. */
  preferRiskLimit: number;
  /**
   * Risk thresholds on prospective usage (reported + reserved + this worker's buffer), per quota bucket.
   * Below `cautionPercent`: available. From it to below `highPercent`: caution, used only when no available
   * route exists. From `highPercent`: high risk, never routed automatically.
   */
  riskThresholds: { cautionPercent: number; highPercent: number };
  /** Temporary per-quota reservations for allocated workers. */
  reservations: ReservationConfig;
  /** Model ids or families the user never wants routed. */
  banModels: string[];
  /**
   * Agents used only when no other agent can take the job in any allowed tier (OpenCode: API keys cost per
   * token, local models take this machine). `--agent` or a preference for the tier lifts it for that route.
   */
  lastResortAgents: AgentId[];
  tierOverrides: Record<string, Tier>; // keyed by model id or family
  /** Effort per requested tier when the route call gives neither --effort nor --demand. */
  defaultEffort: Record<Tier, Effort>;
  /** How an effort demand (--demand) maps to effort. */
  effortPolicy: EffortPolicy;
  /** Ascending blended maker-price cuts in USD per million tokens (3:1 input/output). */
  costBands: [number, number, number];
  evidenceTtlHours: number;
  /** How long the placement table (every model's tiers, built from every source) is reused; 0 rebuilds on every command. */
  placementsTtlHours: number;
  /** A usage snapshot older than this is stale: still used, with lower confidence. Four times older: unknown. */
  usageStaleMinutes: number;
  /** How long a model an agent refused at launch is skipped. */
  rejectionTtlHours: number;
  excludeNoZdr: boolean;
  /** Offer Cursor's `auto` as a fallback when no named model can be routed. */
  cursorAuto: boolean;
}

export interface ReservationConfig {
  /** Percentage points a worker reserves on each quota bucket it draws on, by buffer tier and effort column. */
  buffers: Record<BufferTier, Record<BufferEffort, number>>;
  /** Quota-, provider- or plan-specific changes to `buffers`, applied in order. */
  overrides: BufferOverride[];
  /** Model ids or families that use another buffer row than their cost tier's, e.g. `minimal`. */
  modelTiers: Record<string, BufferTier>;
  /** A reservation not confirmed as launched (see `orcacompass verify`) is abandoned after this long. */
  pendingMinutes: number;
  /** A finished worker's reservation is reconciled by a snapshot taken at least this long after it ended. */
  settleSeconds: number;
  /** A running reservation Orca no longer reports is closed after this long. */
  maxRunningHours: number;
}
