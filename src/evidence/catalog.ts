import type { ModelIndex, ModelMeta } from '../types.js';
import { normalizeModelId } from '../placements/ids.js';
import type { EvidenceSnapshot } from './snapshot.js';

export function toModelIndex(snapshot: EvidenceSnapshot): ModelIndex {
  const index: ModelIndex = {};
  for (const model of snapshot.models) {
    const meta: ModelMeta = { id: model.id, provider: model.provider, name: model.name,
      ...(model.family !== undefined ? { family: model.family } : {}),
      ...(model.releasedAt !== undefined ? { releaseDate: model.releasedAt } : {}) };
    index[model.id] = meta;
    for (const alias of model.aliases) index[normalizeModelId(alias)] = meta;
  }
  return index;
}
