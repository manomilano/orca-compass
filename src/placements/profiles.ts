import { AXES, type Axis, type EvidenceSnapshot, type SnapshotModel, type SnapshotScore } from '../evidence/snapshot.js';
import { TIERS, type AgentDiscovery, type Classification, type Config, type ModelMeta, type PlacedAgent, type Tier } from '../types.js';
import { compact, normalizeModelId, stripVersion } from './ids.js';
import { FAMILY_TIERS, lineupTier, MODEL_LINE_TIERS, modelFamily } from './tiers.js';

export type EvidenceLabel = 'measured' | 'partial' | 'estimated' | 'assumed' | 'unranked';
export interface AxisProfile {
  score: number | null;
  evidence: number | null;
  benchmarks: number;
  label: EvidenceLabel;
  band: Tier | null;
  inheritedFrom?: string;
}
export interface Profile {
  class: Tier | null;
  hint: Classification | null;
  axes: Record<Axis, AxisProfile>;
}

export const CLASS_POINTS: Record<Tier, number> = { light: 25, daily: 50, advanced: 75, frontier: 100 };

/** Overrides, built-in model lines and families, then the provider's description. */
export function hintFor(modelId: string, meta: ModelMeta | undefined, lineup: string | undefined, config: Config): Classification | undefined {
  const id = normalizeModelId(modelId);
  const overrideId = [modelId, id, meta?.id].find((key) => key !== undefined && Object.hasOwn(config.tierOverrides, key));
  if (overrideId !== undefined) return { tier: config.tierOverrides[overrideId], source: 'override' };
  const family = modelFamily(modelId, meta);
  if (family !== undefined && Object.hasOwn(config.tierOverrides, family)) return { tier: config.tierOverrides[family], source: 'override' };
  const line = MODEL_LINE_TIERS.find(({ pattern }) => pattern.test(id));
  if (line) return { tier: line.tier, source: 'family' };
  if (family !== undefined && Object.hasOwn(FAMILY_TIERS, family)) return { tier: FAMILY_TIERS[family], source: 'family' };
  const tier = lineupTier(lineup);
  return tier === undefined ? undefined : { tier, source: 'lineup', detail: `the provider's lineup ("${lineup}")` };
}

export function bandOf(score: number, bands: [number, number, number]): Tier {
  return TIERS[bands.filter((cut) => score >= cut).length];
}

/** Resolve exact identities before considering progressively looser equivalent spellings. */
export function findSnapshotModel(modelId: string, snapshot: EvidenceSnapshot): SnapshotModel | undefined {
  const id = normalizeModelId(modelId);
  const names = (model: SnapshotModel): string[] => [model.id, ...model.aliases].map(normalizeModelId);
  return snapshot.models.find((model) => model.id === modelId)
    ?? snapshot.models.find((model) => normalizeModelId(model.id) === id)
    ?? snapshot.models.find((model) => model.aliases.some((alias) => normalizeModelId(alias) === id))
    ?? snapshot.models.find((model) => names(model).some((name) => stripVersion(name) === stripVersion(id)))
    ?? snapshot.models.find((model) => names(model).some((name) => compact(stripVersion(name)) === compact(stripVersion(id))))
    ?? (/-\d{8}$/.test(id) ? findSnapshotModel(id.replace(/-\d{8}$/, ''), snapshot) : undefined);
}

export function vendorOfFamily(family: string | undefined): string | undefined {
  if (family?.startsWith('claude-')) return 'anthropic';
  if (family?.startsWith('gpt-')) return 'openai';
  if (family?.startsWith('gemini')) return 'google';
  if (family?.startsWith('grok')) return 'xai';
  return undefined;
}

const metaOf = (model: SnapshotModel): ModelMeta => ({
  id: model.id, provider: model.provider, name: model.name, family: model.family, releaseDate: model.releasedAt,
});
const unranked = (): AxisProfile => ({ score: null, evidence: null, benchmarks: 0, label: 'unranked', band: null });
const emptyProfile = (): Profile => ({ class: null, hint: null, axes: { coding: unranked(), agentic: unranked(), reasoning: unranked() } });
const round1 = (score: number): number => Math.round(score * 10) / 10;

function inherit(axis: Axis, family: string | undefined, vendor: string | undefined, hint: Classification, snapshot: EvidenceSnapshot, config: Config): SnapshotModel | undefined {
  if (vendor === undefined) return undefined;
  const familyConfig = { ...config, tierOverrides: {} };
  return snapshot.models.filter((model) => {
    if (model.provider !== vendor || !model.scores[axis]) return false;
    const ownFamily = modelFamily(model.id, metaOf(model));
    if (family !== undefined && ownFamily === family) return true;
    const ownHint = hintFor(model.id, metaOf(model), undefined, familyConfig);
    return ownHint !== undefined && TIERS.indexOf(ownHint.tier) <= TIERS.indexOf(hint.tier);
  }).sort((a, b) => b.scores[axis]!.score - a.scores[axis]!.score
    || (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '')
    || a.id.localeCompare(b.id))[0];
}

/** A model's independent evidence, nudged by its class hint and cut into per-axis bands. */
export function buildProfile(modelId: string, meta: ModelMeta | undefined, lineup: string | undefined, snapshot: EvidenceSnapshot, config: Config): Profile {
  const matched = findSnapshotModel(modelId, snapshot);
  const identity = meta ?? (matched ? metaOf(matched) : undefined);
  const hint = hintFor(modelId, identity, lineup, config);
  const family = modelFamily(modelId, identity);
  const vendor = identity?.provider ?? vendorOfFamily(family);
  const profile = emptyProfile();
  profile.hint = hint ?? null;
  for (const axis of AXES) {
    const direct = matched?.scores[axis];
    const inherited = !direct && hint ? inherit(axis, family, vendor, hint, snapshot, config) : undefined;
    const evidence: SnapshotScore | undefined = direct ?? inherited?.scores[axis];
    const score = evidence ? round1(hint ? (1 - config.classWeight) * evidence.score + config.classWeight * CLASS_POINTS[hint.tier] : evidence.score) : null;
    profile.axes[axis] = {
      score, evidence: evidence?.score ?? null, benchmarks: evidence?.benchmarks ?? 0,
      label: inherited ? 'assumed' : !evidence ? 'unranked' : evidence.kind === 'estimated' ? 'estimated' : evidence.benchmarks >= 3 ? 'measured' : 'partial',
      band: hint?.source === 'override' ? hint.tier : score === null ? null : bandOf(score, snapshot.bands[axis]),
      ...(inherited ? { inheritedFrom: inherited.id } : {}),
    };
  }
  profile.class = [...TIERS].reverse().find((tier) => AXES.some((axis) => profile.axes[axis].band === tier)) ?? null;
  return profile;
}

/** Routes share a single profile and the first non-empty provider description for their model. */
export function profileModels(discoveries: AgentDiscovery[], snapshot: EvidenceSnapshot, config: Config): PlacedAgent[] {
  const lineups = new Map<string, string>();
  const metadata = new Map<string, ModelMeta>();
  for (const discovery of discoveries) {
    for (const model of discovery.models) {
      if (model.lineup?.trim() && !lineups.has(model.modelId)) lineups.set(model.modelId, model.lineup);
      if (model.meta && !metadata.has(model.modelId)) metadata.set(model.modelId, model.meta);
    }
  }
  const profiles = new Map<string, Profile>();
  return discoveries.map((discovery) => ({
    ...discovery,
    models: discovery.models.map((model) => {
      let profile: Profile;
      if (model.agent === 'cursor' && model.modelId === 'auto') profile = emptyProfile();
      else {
        profile = profiles.get(model.modelId) ?? buildProfile(model.modelId, metadata.get(model.modelId), lineups.get(model.modelId), snapshot, config);
        profiles.set(model.modelId, profile);
      }
      return { ...model, profile, placements: profile.hint ? [profile.hint] : [], tiers: profile.class ? [profile.class] : [] };
    }),
  }));
}
