import { DEFAULT_BANDS } from '../evidence/refresh.js';
import { AXES, type Axis, type EvidenceSnapshot } from '../evidence/snapshot.js';
import type { EvidenceLabel, Profile } from '../placements/profiles.js';
import { TIERS } from '../types.js';
import type { Need, Needs } from './needs.js';

export const NEED_STEP: Record<Need, number> = { min: 0, low: 1, mid: 2, high: 3 };
export const EVIDENCE_ORDER: readonly EvidenceLabel[] = ['measured', 'partial', 'estimated', 'assumed', 'unranked'];

export function cutFor(need: Need, bands: [number, number, number]): number | null {
  return need === 'min' ? null : bands[NEED_STEP[need] - 1];
}

/** Stored bands are authoritative, including explicit overrides; cuts explain any shortfall. */
export function coverage(profile: Profile, needs: Needs, bands: EvidenceSnapshot['bands'] = DEFAULT_BANDS): {
  covers: boolean; shortfall: number; overshoot: number; below: { axis: Axis; score: number | null; cut: number }[];
} {
  let shortfall = 0;
  let overshoot = 0;
  const below: { axis: Axis; score: number | null; cut: number }[] = [];
  for (const axis of AXES) {
    const { band, score } = profile.axes[axis];
    const step = band === null ? -1 : TIERS.indexOf(band);
    const needed = NEED_STEP[needs[axis]];
    const cut = cutFor(needs[axis], bands[axis]);
    if (cut !== null && step < needed) {
      shortfall += needed - step;
      below.push({ axis, score, cut });
    }
    overshoot += Math.max(0, step - needed);
  }
  return { covers: below.length === 0, shortfall, overshoot, below };
}

export function jobEvidence(profile: Profile, needs: Needs): EvidenceLabel {
  return EVIDENCE_ORDER[Math.max(0, ...AXES.filter((axis) => needs[axis] !== 'min').map((axis) => EVIDENCE_ORDER.indexOf(profile.axes[axis].label)))];
}

export function needWeightedScore(profile: Profile, needs: Needs): number {
  return AXES.reduce((sum, axis) => sum + NEED_STEP[needs[axis]] * (profile.axes[axis].score ?? 0), 0);
}
