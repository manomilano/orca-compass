import type { RatedModel, Tier } from '../types.js';
import { TIERS } from '../types.js';

// Capability score: a model's Model Index score and output price, each normalized over the
// anchor models (whose tiers come from the family table), weighted, and cut into tiers.

export interface Anchor {
  tier: Tier;
  rating: RatedModel;
}

export interface ScoreScale {
  weight: number;
  score: { min: number; max: number };
  lnPrice: { min: number; max: number };
  /** cuts[i] separates TIERS[i] from TIERS[i + 1]. */
  cuts: number[];
  ratings: RatedModel[];
}

import { normalizeModelId, compact, stripVersion } from './ids.js';
export { normalizeModelId, compact, stripVersion } from './ids.js';

function keysOf(r: RatedModel): string[] {
  const keys = [normalizeModelId(r.id)];
  if (r.orId) {
    const or = normalizeModelId(r.orId);
    keys.push(or, or.replace(/-preview$/, ''));
  }
  return keys;
}

function lookup(id: string, ratings: RatedModel[]): RatedModel | undefined {
  // Exact keys first (entry id before OpenRouter id), then Cursor's dashless spelling (deepseek-v41-flash).
  return (
    ratings.find((r) => normalizeModelId(r.id) === id) ??
    ratings.find((r) => keysOf(r).includes(id)) ??
    ratings.find((r) => keysOf(r).some((k) => compact(k) === compact(id)))
  );
}

/** The Model Index entry for a routed model id, or undefined. */
export function matchRating(modelId: string, ratings: RatedModel[]): RatedModel | undefined {
  const id = normalizeModelId(modelId);
  const hit = lookup(id, ratings);
  if (hit) return hit;
  const stripped = stripVersion(id);
  return stripped !== id ? lookup(stripped, ratings) : undefined;
}

const unit = (v: number, range: { min: number; max: number }): number => (v - range.min) / (range.max - range.min);

/** c = w·score + (1 − w)·ln(price), both min-max normalized over the anchors. */
export function combinedScore(scale: ScoreScale, r: RatedModel): number {
  return scale.weight * unit(r.score, scale.score) + (1 - scale.weight) * unit(Math.log(r.out), scale.lnPrice);
}

const span = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });

/** Undefined unless every tier has an anchor and anchors differ in score and price. */
export function buildScale(anchors: Anchor[], weight: number, ratings: RatedModel[]): ScoreScale | undefined {
  if (!TIERS.every((t) => anchors.some((a) => a.tier === t))) return undefined;
  const score = span(anchors.map((a) => a.rating.score));
  const lnPrice = span(anchors.map((a) => Math.log(a.rating.out)));
  if (score.max === score.min || lnPrice.max === lnPrice.min) return undefined;
  const scale: ScoreScale = { weight, score, lnPrice, cuts: [], ratings };
  const cs = (t: Tier) => anchors.filter((a) => a.tier === t).map((a) => combinedScore(scale, a.rating));
  for (let i = 1; i < TIERS.length; i++) {
    scale.cuts.push((Math.max(...cs(TIERS[i - 1])) + Math.min(...cs(TIERS[i]))) / 2);
  }
  return scale;
}

/** Tier = number of cuts at or below c, capped at Advanced: a score never makes a model Frontier. */
export function scoreTier(scale: ScoreScale, c: number): Tier {
  const above = scale.cuts.filter((cut) => cut <= c).length;
  return TIERS[Math.min(above, TIERS.indexOf('advanced'))];
}
