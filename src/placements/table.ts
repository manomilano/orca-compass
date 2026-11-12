import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AXES } from '../evidence/snapshot.js';
import { AGENT_IDS, CLASSIFICATION_SOURCES, TIERS, type AgentId, type BuiltWith, type Config, type PlacementTable } from '../types.js';

// The placement table: every model's profile, computed from the snapshot and reused until stale.

export const PLACEMENTS_FILE = 'placements.json';
export const PLACEMENTS_SCHEMA = 4;

export const builtWith = (config: Config): BuiltWith =>
  structuredClone({ tierOverrides: config.tierOverrides, costBands: config.costBands });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function validSource(v: unknown): boolean {
  return isObj(v) && ['network', 'cache', 'snapshot'].includes(v.source as string) && isInt(v.fetchedAt) && isInt(v.models);
}

/** A launch the router can act on: a flag with a model id, or a variant map (ids may be empty, as for Cursor Auto). */
function validLaunch(v: unknown): boolean {
  return isObj(v) && ((v.kind === 'flag' && typeof v.model === 'string') || (v.kind === 'variant' && isObj(v.ids)));
}

const nullableScore = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
const nullableTier = (v: unknown): boolean => v === null || TIERS.includes(v as never);
const validHint = (v: unknown): boolean => v === null || (isObj(v) && TIERS.includes(v.tier as never) &&
  CLASSIFICATION_SOURCES.includes(v.source as never) && (v.detail === undefined || typeof v.detail === 'string'));

const validCost = (v: unknown): boolean => v === null || (isObj(v) && TIERS.includes(v.tier as never) &&
  (v.blended === null || (typeof v.blended === 'number' && Number.isFinite(v.blended) && v.blended >= 0)) &&
  ['override', 'price', 'family', 'lineup', 'evidence'].includes(v.source as string));

const validCostBands = (v: unknown): boolean => Array.isArray(v) && v.length === 3 &&
  v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) && v[0] < v[1] && v[1] < v[2];

function validProfile(v: unknown): boolean {
  if (!isObj(v) || !nullableTier(v.class) || !validCost(v.cost) || !validHint(v.hint) || !isObj(v.axes)) return false;
  const axes = v.axes;
  return AXES.every((axis) => {
    const p = axes[axis];
    return isObj(p) && nullableScore(p.score) && nullableScore(p.evidence) && isInt(p.benchmarks) &&
      ['measured', 'partial', 'estimated', 'assumed', 'unranked'].includes(p.label as string) && nullableTier(p.band) &&
      (p.inheritedFrom === undefined || typeof p.inheritedFrom === 'string');
  });
}

function validBands(v: unknown): boolean {
  return isObj(v) && AXES.every((axis) => {
    const cuts = v[axis];
    return Array.isArray(cuts) && cuts.length === 3 && cuts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100) &&
      cuts[0] < cuts[1] && cuts[1] < cuts[2];
  });
}

function validModel(v: unknown): boolean {
  if (!isObj(v)) return false;
  return typeof v.agent === 'string' && typeof v.modelId === 'string' && Array.isArray(v.efforts) && validLaunch(v.launch) &&
    Array.isArray(v.poolNames) && validProfile(v.profile);
}

function validAgent(v: unknown): boolean {
  return isObj(v) && typeof v.agent === 'string' && typeof v.installed === 'boolean' && Array.isArray(v.models) && v.models.every(validModel);
}

/** The table a file holds, or undefined when it is missing, not JSON, or not the shape this version writes. */
export function parseTable(text: string | undefined): PlacementTable | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(raw) || raw.schemaVersion !== PLACEMENTS_SCHEMA || typeof raw.version !== 'string' || !isInt(raw.builtAt)) return undefined;
  const b = raw.builtWith;
  if (!isObj(b) || !isObj(b.tierOverrides) || !validCostBands(b.costBands)) return undefined;
  const s = raw.sources;
  if (!isObj(s) || !validSource(s.evidence) || !isObj(s.evidence) || typeof s.evidence.generatedAt !== 'string' || !Number.isFinite(Date.parse(s.evidence.generatedAt)) || !validBands(raw.bands)) return undefined;
  if (!Array.isArray(raw.agents) || !raw.agents.every(validAgent)) return undefined;
  return raw as unknown as PlacementTable;
}

/** `present` is whether a file was there at all, so a missing file and a corrupt one are told apart. */
export interface ReadTable {
  table: PlacementTable | undefined;
  present: boolean;
}

export function readTable(readFile: (p: string) => string | undefined, dir: string): ReadTable {
  const text = readFile(join(dir, PLACEMENTS_FILE));
  return { table: parseTable(text), present: text !== undefined };
}

export type Staleness = 'missing' | 'invalid' | 'version' | 'expired' | 'config' | 'agent-appeared' | 'evidence';

const canonical = (b: BuiltWith): string =>
  JSON.stringify({ costBands: b.costBands, tierOverrides: Object.fromEntries(Object.entries(b.tierOverrides).sort()) });

/** Why the table must be rebuilt, or undefined when it can be used as is. */
export function staleness(read: ReadTable, opts: {
  now: number;
  ttlHours: number;
  version: string;
  config: Config;
  /** Agents whose executable is found now (looked up as discovery does), checked only against table entries with installed: false. */
  onPath: AgentId[];
  evidenceGeneratedAt?: string;
}): Staleness | undefined {
  if (!read.present) return 'missing';
  if (!read.table) return 'invalid';
  const t = read.table;
  if (t.version !== opts.version) return 'version';
  // A build time in the future (clock set back, hand edit) is as untrustworthy as an old one.
  if (t.builtAt > opts.now || opts.now - t.builtAt >= opts.ttlHours * 3_600_000) return 'expired';
  if (canonical(t.builtWith) !== canonical(builtWith(opts.config))) return 'config';
  if (opts.evidenceGeneratedAt !== undefined && t.sources.evidence.generatedAt !== opts.evidenceGeneratedAt) return 'evidence';
  if (t.agents.some((a) => !a.installed && AGENT_IDS.includes(a.agent) && opts.onPath.includes(a.agent))) return 'agent-appeared';
  return undefined;
}

/** Writes the file atomically; returns the error message when it could not be written. */
export function writeTable(table: PlacementTable, dir: string): string | undefined {
  const file = join(dir, PLACEMENTS_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, JSON.stringify(table, null, 2) + '\n');
    renameSync(temporary, file);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never written */ }
  }
}

export const tableAge = (table: PlacementTable, now: number): number => now - table.builtAt;
