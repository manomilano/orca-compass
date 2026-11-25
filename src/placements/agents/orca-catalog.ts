import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../../paths.js';
import { orcaUserDataPath } from '../../routing/orca-settings.js';
import { importSqlite } from '../../system/sqlite.js';
import type { AgentDeps } from './deps.js';

export interface RawModel {
  id: string;
  efforts: string[];
  defaultEffort?: string;
  /** The provider's one-line description of the model's place in its lineup. */
  description?: string;
}

/**
 * The agents whose catalog entries are read: Claude Code's and Codex's model lists, and Antigravity's effort menus
 * (its models still come from agy, which names the ids it launches).
 */
export type OrcaCatalogAgent = 'claude' | 'codex' | 'antigravity';

export const description = (v: unknown): { description: string } | Record<string, never> =>
  typeof v === 'string' && v.trim() !== '' ? { description: v.trim() } : {};

export const parseJson = (text: string | undefined): any => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The models of an agent's newest Orca probe that found any, from catalog entries in the order Orca wrote them.
 * Aliases (Claude's "opus") resolve to the model they launch and are listed once.
 */
export function fromOrcaEntries(entries: unknown[], agent: string): RawModel[] {
  const models: any[] | undefined = (entries as any[])
    .filter((e) => e?.agent === agent && Array.isArray(e?.discovered?.models) && e.discovered.models.length > 0)
    .at(-1)?.discovered.models;
  const byId = new Map<string, RawModel>();
  for (const m of models ?? []) {
    if (typeof m?.id !== 'string') continue;
    const id = typeof m.resolvedModel === 'string' ? m.resolvedModel : m.id;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      efforts: (Array.isArray(m.efforts) ? m.efforts : []).map((e: { value?: unknown }) => String(e?.value)),
      ...(typeof m.defaultEffort === 'string' ? { defaultEffort: m.defaultEffort } : {}),
      ...description(m.description),
    });
  }
  return [...byId.values()];
}

/** The JSON catalog older Orca versions wrote: { entries: [...] }, newest last. */
export function fromOrcaCatalog(text: string | undefined, agent: string): RawModel[] {
  const entries = parseJson(text)?.entries;
  return Array.isArray(entries) ? fromOrcaEntries(entries, agent) : [];
}

/** Orca's userData folder; a Windows machine without APPDATA gets the usual location. */
function orcaDir(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  return orcaUserDataPath(env, process.platform, home) ?? join(home, 'AppData', 'Roaming', 'orca');
}

/** Orca's model catalog: a SQLite database with one row per agent probe. */
export const orcaCatalogPath = (env: NodeJS.ProcessEnv): string => join(orcaDir(env), 'agent-model-catalog.db');

/** The JSON catalog Orca wrote before it moved to SQLite. */
export const orcaLegacyCatalogPath = (env: NodeJS.ProcessEnv): string => join(orcaDir(env), 'agent-model-catalog.json');

/**
 * Every probe in Orca's catalog database as its JSON text, in the order Orca wrote them, or undefined when there
 * is no database. Opened read-only and closed at once; Orca may be writing to it.
 */
export async function readOrcaCatalogRows(dbPath: string): Promise<string[] | undefined> {
  if (!existsSync(dbPath)) return undefined;
  const { DatabaseSync } = await importSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT value FROM rows ORDER BY seq').all()
      .map((row) => row.value)
      .filter((value): value is string => typeof value === 'string');
  } finally {
    db.close();
  }
}

export interface OrcaModels {
  /** The catalog the models came from; unset when Orca lists none for the agent. */
  path?: string;
  models: RawModel[];
  /** Why the catalog database could not be read, e.g. a Node.js without node:sqlite. */
  skipped?: string;
}

/**
 * An agent's models as Orca lists them for its model picker, with each model's efforts: Orca's
 * catalog database, then the JSON file older Orca versions wrote. These are the models Orca can launch, so they
 * come first.
 */
export async function orcaModels(deps: AgentDeps, agent: OrcaCatalogAgent): Promise<OrcaModels> {
  const db = orcaCatalogPath(deps.env);
  let skipped: string | undefined;
  if (deps.readOrcaCatalog) {
    try {
      const rows = await deps.readOrcaCatalog(db);
      const models = rows === undefined ? [] : fromOrcaEntries(rows.map(parseJson), agent);
      if (models.length > 0) return { path: db, models };
    } catch (e) {
      skipped = `Orca's model catalog skipped: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const legacy = orcaLegacyCatalogPath(deps.env);
  const models = fromOrcaCatalog(deps.readFile(legacy), agent);
  if (models.length > 0) return { path: legacy, models };
  return { models: [], ...(skipped ? { skipped } : {}) };
}

/** A discovery note that also says why Orca's catalog was skipped, when it was. */
export const withSkipped = (note: string, orca: OrcaModels): string => (orca.skipped ? `${note}; ${orca.skipped}` : note);

