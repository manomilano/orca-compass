// Shared types for the routing core and its adapters. The core never does I/O;
// adapters turn the machine into an Environment and the router turns that into a Decision.

export type { Axis } from './evidence/snapshot.js';
export type { AxisProfile, CostSource, CostTier, EvidenceLabel, Profile } from './placements/profiles.js';
import type { Axis, EvidenceSnapshot } from './evidence/snapshot.js';
import type { CostTier, EvidenceLabel, Profile } from './placements/profiles.js';
import type { Need, Needs } from './routing/needs.js';
export type { Need, Needs } from './routing/needs.js';

import type { Rejection } from './routing/rejection.js';

export type Tier = 'light' | 'daily' | 'advanced' | 'frontier';
export const TIERS: readonly Tier[] = ['light', 'daily', 'advanced', 'frontier'];

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** How much reasoning a job needs, separate from how capable a model it needs (the tier). */
export type Demand = 'low' | 'moderate' | 'high' | 'exceptional';
export const DEMANDS: readonly Demand[] = ['low', 'moderate', 'high', 'exceptional'];
/** How a reasoning demand maps to effort: `balanced` is the default. */
export type EffortPolicy = 'efficient' | 'balanced' | 'quality';
export const EFFORT_POLICIES: readonly EffortPolicy[] = ['efficient', 'balanced', 'quality'];
export type Confidence = 'high' | 'medium' | 'low';
export type AgentId = string;
/** Every agent OrcaCompass knows, in display order (Muse is detected only, never routed). */
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

export interface UsagePool {
  name: string;
  kind: 'session' | 'long';
  usedPercent: number;
  handouts?: number;
  windowMinutes: number;
  resetsAt: number; // epoch ms
}

export interface AgentUsage {
  agent: AgentId;
  status: 'ok' | 'unavailable' | 'unknown';
  pools: Record<string, UsagePool>;
  updatedAt?: number;
  error?: string;
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
  schemaVersion: 4;
  version: string;
  builtAt: number;
  builtWith: BuiltWith;
  sources: {
    evidence: SourceInfo & { generatedAt: string };
  };
  bands: EvidenceSnapshot['bands'];
  agents: PlacedAgent[];
}

/** Orca's agent on/off setting (settings.disabledTuiAgents), or why it could not be read. */
export type OrcaAgents =
  | { known: true; disabled: AgentId[]; source: string }
  | { known: false; reason: string };

export interface Environment {
  now: number;
  bands: EvidenceSnapshot['bands'];
  /** Every agent with its models already placed (the placement table's rows). */
  discoveries: PlacedAgent[];
  usage: Record<AgentId, AgentUsage>;
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
  noDowngrade?: boolean;
  agents?: AgentId[];
  excludeAgents?: AgentId[];
  /** An explicit effort: only routes that can apply exactly this effort are used. */
  effort?: Effort;
  /** The job's reasoning demand; the effort follows it through `effortPolicy`. */
  demand?: Demand;
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
  /** The model does not offer the target, so the nearest supported effort is used. */
  adjusted: boolean;
  /** Where the model's supported efforts come from. */
  supportSource: EffortSource | 'unknown';
  /** The effort the agent uses when none is passed, when the provider says so. */
  providerDefault?: Effort;
}

/**
 * Where a route's usage is heading: the pool projected to end its window most used, at the current pace
 * (used% / elapsed fraction). Early in a window (under 10% elapsed) it is not extrapolated: projected = used.
 */
export interface Risk {
  pool: string;
  usedPercent: number;
  elapsedPercent: number;
  projectedPercent: number;
  tooEarly: boolean;
  resetsAt: number;
}

export interface Alternative {
  agent: AgentId;
  model: string;
  effort: Effort | null;
  tier: Tier;
  quality: Quality;
  /** Share of the ranked window expected to be left unused at reset; null when usage is unknown. */
  headroom: number | null;
  confidence: Confidence;
  blocked: boolean;
  /** Null when usage is unknown. */
  risk: Risk | null;
  reason: string;
}

export interface Quality {
  class: Tier | null;
  cost: CostTier | null;
  covers: boolean;
  shortfall: number;
  overshoot: number;
  evidence: EvidenceLabel;
  axes: Record<Axis, { score: number | null; band: Tier | null; evidence: EvidenceLabel; benchmarks: number; need: Need; cut: number | null }>;
}

export interface Decision {
  status: 'ok' | 'wait' | 'none';
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
  route?: { agent: AgentId; model: string; effort: Effort | null };
  /** How the route's effort was chosen and applied; present with `route`. */
  effort?: EffortResolution;
  launchArgs?: string[];
  confidence?: Confidence;
  /** The route's consumption risk; null when usage is unknown. */
  risk?: Risk | null;
  reasons: string[];
  warnings: string[];
  alternatives: Alternative[];
  /** Agents left out, and with `model` set, single models (banned by the user, or refused by the agent at launch). */
  skipped: { agent: AgentId; model?: string; reason: string }[];
  waitUntil?: number;
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
  /** Above this projected usage, replace the favorite only with a known within-limit alternative. */
  preferRiskLimit: number;
  /** Model ids or families the user never wants routed. */
  banModels: string[];
  /**
   * Agents used only when no other agent can take the job in any allowed tier (OpenCode: API keys cost per
   * token, local models take this machine). `--agent` or a preference for the tier lifts it for that route.
   */
  lastResortAgents: AgentId[];
  tierOverrides: Record<string, Tier>; // keyed by model id or family
  thresholds: { longPercent: number; sessionPercent: number };
  /** Effort per requested tier when the route call gives neither --effort nor --demand. */
  defaultEffort: Record<Tier, Effort>;
  /** How a reasoning demand (--demand) maps to effort. */
  effortPolicy: EffortPolicy;
  /** Ascending blended maker-price cuts in USD per million tokens (3:1 input/output). */
  costBands: [number, number, number];
  handoutMinutes: number;
  handoutPercent: number;
  evidenceTtlHours: number;
  /** How long the placement table (every model's tiers, built from every source) is reused; 0 rebuilds on every command. */
  placementsTtlHours: number;
  usageStaleMinutes: number;
  /** How long a model an agent refused at launch is skipped. */
  rejectionTtlHours: number;
  excludeNoZdr: boolean;
  /** Offer Cursor's `auto` as a fallback when no named model can be routed. */
  cursorAuto: boolean;
}
