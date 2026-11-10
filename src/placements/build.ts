import { readFileSync } from 'node:fs';
import { parseSnapshot, type EvidenceSnapshot } from '../evidence/snapshot.js';
import { cacheDir } from '../paths.js';
import { findExecutable, runCommand } from '../system/run.js';
import { AGENT_IDS, type AgentDiscovery, type AgentId, type Config, type PlacementTable } from '../types.js';
import { VERSION } from '../version.js';
import { discoverAntigravity, locateAntigravity } from './agents/antigravity.js';
import { discoverClaude, locateClaude } from './agents/claude.js';
import { discoverCodex, locateCodex } from './agents/codex.js';
import { discoverCursor, locateCursor } from './agents/cursor.js';
import { listDirectory, readTextFile, type AgentDeps, type Locator } from './agents/deps.js';
import { discoverGrok, locateGrok } from './agents/grok.js';
import { discoverMuse, locateMuse } from './agents/muse.js';
import { discoverOpencode, locateOpencode } from './agents/opencode.js';
import { loadRatings } from './sources/modelindex.js';
import { loadCatalog } from './sources/modelsdev.js';
import { builtWith, PLACEMENTS_SCHEMA, writeTable } from './table.js';
import { profileModels } from './profiles.js';

// Part 1 of OrcaCompass: every source at once, every model placed, one table written.

/** Each agent's executable lookup and discovery; the freshness check and the build use the same lookup. */
export const AGENTS: Record<AgentId, { locate: (deps: Locator) => string | undefined; discover: (deps: AgentDeps) => Promise<AgentDiscovery> }> = {
  claude: { locate: locateClaude, discover: discoverClaude },
  codex: { locate: locateCodex, discover: discoverCodex },
  cursor: { locate: locateCursor, discover: discoverCursor },
  grok: { locate: locateGrok, discover: discoverGrok },
  antigravity: { locate: locateAntigravity, discover: discoverAntigravity },
  opencode: { locate: locateOpencode, discover: discoverOpencode },
  muse: { locate: locateMuse, discover: discoverMuse },
};

/** The agents whose executable is found right now, looked up exactly as discovery does. */
export const installedAgents = (deps: Locator): AgentId[] => AGENT_IDS.filter((a) => AGENTS[a].locate(deps) !== undefined);

export type BuildDeps = Partial<AgentDeps> & {
  fetchImpl?: typeof fetch;
  refresh?: boolean;
  now?: number;
  version?: string;
  /** Transitional bundled evidence until the evidence loader owns the table build. */
  snapshot?: EvidenceSnapshot;
};

export interface Built {
  table: PlacementTable;
  /** Set when the table could not be written; the table is still complete and usable. */
  saveError?: string;
}

/** Loads the catalog and scores, discovers every agent, places every model and writes the table. */
export async function buildPlacements(config: Config, deps: BuildDeps = {}): Promise<Built> {
  const now = deps.now ?? Date.now();
  const env = deps.env ?? process.env;
  const opts = { ttlHours: config.evidenceTtlHours, now, fetchImpl: deps.fetchImpl, refresh: deps.refresh };
  const catalogP = loadCatalog(opts);
  // Keep source metadata for the transitional schema; profiles use only the evidence snapshot.
  const ratingsP = loadRatings(opts).catch(() => undefined);
  const catalog = await catalogP;
  const agentDeps: AgentDeps = {
    index: catalog.index,
    run: deps.run ?? runCommand,
    find: deps.find ?? findExecutable,
    readFile: deps.readFile ?? readTextFile,
    listDir: deps.listDir ?? listDirectory,
    env,
    cacheDir: deps.cacheDir ?? cacheDir(),
    now,
  };
  const [discoveries, ratings] = await Promise.all([
    Promise.all(AGENT_IDS.map((a) => AGENTS[a].discover(agentDeps))),
    ratingsP,
  ]);
  const snapshot = deps.snapshot ?? parseSnapshot(readFileSync(new URL('../../data/evidence-snapshot.json', import.meta.url), 'utf8'));
  if (!snapshot) throw new Error('bundled evidence snapshot unreadable');
  const table: PlacementTable = {
    schemaVersion: PLACEMENTS_SCHEMA,
    version: deps.version ?? VERSION,
    builtAt: now,
    builtWith: builtWith(config),
    sources: {
      catalog: { source: catalog.source, fetchedAt: catalog.fetchedAt, models: Object.keys(catalog.index).length },
      scores: ratings ? { source: ratings.source, fetchedAt: ratings.fetchedAt, models: ratings.ratings.length } : null,
      scoreScale: null,
    },
    agents: profileModels(discoveries, snapshot, config),
  };
  const saveError = writeTable(table, agentDeps.cacheDir);
  return { table, ...(saveError !== undefined ? { saveError } : {}) };
}
