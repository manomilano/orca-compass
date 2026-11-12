export type Axis = 'coding' | 'agentic' | 'reasoning';
export const AXES: readonly Axis[] = ['coding', 'agentic', 'reasoning'];
export type EvidenceKind = 'measured' | 'vendor' | 'reported';
export interface SnapshotResult { benchmark: string; value: number; unit: 'percent' | 'points' | 'elo'; setting?: string; kind: EvidenceKind; source: string; observedAt: string; url: string }
export interface SnapshotScore { score: number; benchmarks: number; kind: 'measured' | 'estimated' }
export interface SnapshotPricing { inputPerM: number; outputPerM: number; basis?: string }
export interface SnapshotModel { id: string; aliases: string[]; provider: string; name: string; family?: string; releasedAt?: string; results: SnapshotResult[]; scores: Partial<Record<Axis, SnapshotScore>>; pricing?: SnapshotPricing }
export interface SnapshotSource { id: string; label: string; url: string; license: string; fetchedAt: string; dataDate?: string }
export interface EvidenceSnapshot { schemaVersion: 1; generatedAt: string; sources: SnapshotSource[]; benchmarks: Record<string, { name: string; range: [number, number]; unit: 'percent' | 'points' | 'elo'; source: string }>; axes: Record<Axis, { weights: Record<string, number> }>; bands: Record<Axis, [number, number, number]>; models: SnapshotModel[] }
export const SNAPSHOT_SCHEMA = 1;
export const ALLOWED_LICENSES: readonly string[] = ['CC BY 4.0', 'CC0 1.0', 'MIT'];

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSnapshot(text: string | undefined): EvidenceSnapshot | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.schemaVersion !== SNAPSHOT_SCHEMA || typeof value.generatedAt !== 'string' ||
      !Array.isArray(value.sources) || !value.sources.every((s: unknown) => object(s) && typeof s.license === 'string' && ALLOWED_LICENSES.includes(s.license)) ||
      !Array.isArray(value.models) || !value.models.every((m: unknown) => object(m) && typeof m.id === 'string' && m.id.length > 0 && Array.isArray(m.aliases) && m.aliases.every((a: unknown) => typeof a === 'string') && typeof m.provider === 'string' && typeof m.name === 'string' && Array.isArray(m.results) && object(m.scores) && (m.pricing === undefined || (object(m.pricing) && typeof m.pricing.inputPerM === 'number' && Number.isFinite(m.pricing.inputPerM) && m.pricing.inputPerM >= 0 && typeof m.pricing.outputPerM === 'number' && Number.isFinite(m.pricing.outputPerM) && m.pricing.outputPerM >= 0 && (m.pricing.basis === undefined || typeof m.pricing.basis === 'string') && Object.keys(m.pricing).every((key) => ['inputPerM', 'outputPerM', 'basis'].includes(key))))) ||
      !object(value.benchmarks) || !object(value.axes) || !object(value.bands)) return undefined;
    const benchmarks = value.benchmarks, axes = value.axes, bands = value.bands;
    if (!AXES.every((axis) => {
      const band = bands[axis], entry = axes[axis];
      return Array.isArray(band) && band.length === 3 && band.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) && band[0] < band[1] && band[1] < band[2] &&
        object(entry) && object(entry.weights) && Object.keys(entry.weights).every((key) => Object.hasOwn(benchmarks, key));
    })) return undefined;
    return value as unknown as EvidenceSnapshot;
  } catch { return undefined; }
}
