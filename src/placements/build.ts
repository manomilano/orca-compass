import { loadEvidence } from '../evidence/source.js';
import { toModelIndex } from '../evidence/catalog.js';
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
  /** Tests point the bundled-snapshot fallback at a fixture; production uses the packaged file. */
  bundled?: string | URL;
};

export interface Built {
  table: PlacementTable;
  /** Set when the table could not be written; the table is still complete and usable. */
  saveError?: string;
}

/** Loads the evidence, discovers every agent, profiles every model and writes the table. */
export async function buildPlacements(config: Config, deps: BuildDeps = {}): Promise<Built> {
  const now = deps.now ?? Date.now();
  const env = deps.env ?? process.env;
  const directory = deps.cacheDir ?? cacheDir();
  const evidence = await loadEvidence({ ttlHours: config.evidenceTtlHours, now, fetchImpl: deps.fetchImpl, refresh: deps.refresh, cacheDir: directory, bundled: deps.bundled });
  const { snapshot } = evidence;
  const agentDeps: AgentDeps = {
    index: toModelIndex(snapshot),
    run: deps.run ?? runCommand,
    find: deps.find ?? findExecutable,
    readFile: deps.readFile ?? readTextFile,
    listDir: deps.listDir ?? listDirectory,
    env,
    cacheDir: directory,
    now,
  };
  const discoveries = await Promise.all(AGENT_IDS.map((a) => AGENTS[a].discover(agentDeps)));
  const table: PlacementTable = {
    schemaVersion: PLACEMENTS_SCHEMA,
    version: deps.version ?? VERSION,
    builtAt: now,
    builtWith: builtWith(config),
    sources: { evidence: { source: evidence.source, fetchedAt: evidence.fetchedAt, models: snapshot.models.length, generatedAt: snapshot.generatedAt } },
    bands: snapshot.bands,
    agents: profileModels(discoveries, snapshot, config),
  };
  const saveError = writeTable(table, agentDeps.cacheDir);
  return { table, ...(saveError !== undefined ? { saveError } : {}) };
}
