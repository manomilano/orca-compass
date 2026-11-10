import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_IDS, CLASSIFICATION_SOURCES, TIERS, type AgentId, type BuiltWith, type Config, type PlacementTable } from '../types.js';

// The placement table: every model's tiers, computed once from every source and reused until stale.

export const PLACEMENTS_FILE = 'placements.json';
export const PLACEMENTS_SCHEMA = 2;

export const builtWith = (config: Config): BuiltWith =>
  structuredClone({ tierOverrides: config.tierOverrides, cursorAuto: config.cursorAuto, classWeight: config.classWeight });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function validSource(v: unknown): boolean {
  return isObj(v) && ['network', 'cache', 'snapshot'].includes(v.source as string) && isInt(v.fetchedAt) && isInt(v.models);
}

/** A launch the router can act on: a flag with a model id, or a variant map (ids may be empty, as for Cursor Auto). */
function validLaunch(v: unknown): boolean {
  return isObj(v) && ((v.kind === 'flag' && typeof v.model === 'string') || (v.kind === 'variant' && isObj(v.ids)));
}

function validModel(v: unknown): boolean {
  if (!isObj(v)) return false;
  return typeof v.agent === 'string' && typeof v.modelId === 'string' && Array.isArray(v.efforts) && validLaunch(v.launch) &&
    Array.isArray(v.poolNames) && Array.isArray(v.tiers) &&
    Array.isArray(v.placements) && v.placements.every((p) => isObj(p) && TIERS.includes(p.tier as never) && CLASSIFICATION_SOURCES.includes(p.source as never));
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
  if (!isObj(b) || !isObj(b.tierOverrides) || typeof b.cursorAuto !== 'boolean' || typeof b.classWeight !== 'number') return undefined;
  const s = raw.sources;
  if (!isObj(s) || !validSource(s.catalog) || (s.scores !== null && !validSource(s.scores))) return undefined;
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

export type Staleness = 'missing' | 'invalid' | 'version' | 'expired' | 'config' | 'agent-appeared';

const canonical = (b: BuiltWith): string =>
  JSON.stringify({ cursorAuto: b.cursorAuto, classWeight: b.classWeight, tierOverrides: Object.fromEntries(Object.entries(b.tierOverrides).sort()) });

/** Why the table must be rebuilt, or undefined when it can be used as is. */
export function staleness(read: ReadTable, opts: {
  now: number;
  ttlHours: number;
  version: string;
  config: Config;
  /** Agents whose executable is found now (looked up as discovery does), checked only against table entries with installed: false. */
  onPath: AgentId[];
}): Staleness | undefined {
  if (!read.present) return 'missing';
  if (!read.table) return 'invalid';
  const t = read.table;
  if (t.version !== opts.version) return 'version';
  // A build time in the future (clock set back, hand edit) is as untrustworthy as an old one.
  if (t.builtAt > opts.now || opts.now - t.builtAt >= opts.ttlHours * 3_600_000) return 'expired';
  if (canonical(t.builtWith) !== canonical(builtWith(opts.config))) return 'config';
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
