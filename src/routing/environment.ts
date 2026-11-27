import { join } from 'node:path';
import { readTextFile, type AgentDeps } from '../placements/agents/deps.js';
import { buildPlacements, installedAgents } from '../placements/build.js';
import { readTable, staleness, type Staleness } from '../placements/table.js';
import { cacheDir } from '../paths.js';
import { findExecutable, runCommand } from '../system/run.js';
import type { Config, Environment, OrcaAgents, PlacementTable } from '../types.js';
import { VERSION } from '../version.js';
import { syncReservations, workerStatesFor } from './allocate.js';
import { isLive, type Reservation } from './quota.js';
import { readOrcaAgents } from './orca-settings.js';
import { readOrcaUsage } from './orca-usage.js';
import { activeRejections } from './rejection.js';
import { readRejections } from './rejections.js';

// Part 2 of OrcaCompass: the placement table (rebuilt only when stale) plus what changes between
// calls: Orca's usage, the reservations of allocated workers, Orca's agent switches, and the models agents
// refused at launch.

export type GatherDeps = Partial<AgentDeps & {
  fetchImpl: typeof fetch;
  /** Rebuild the table and refetch the metadata sources whatever their age. */
  refresh: boolean;
  readOrcaAgents: () => Promise<OrcaAgents>;
  version: string;
  /** Tests point the bundled-snapshot fallback at a fixture. */
  bundled: string | URL;
  /** The bundled snapshot's manifest; a test that supplies `bundled` has none unless given here. */
  bundledManifest: string | URL;
}>;

export interface Gathered {
  env: Environment;
  /** Every reservation record in the ledger, live or recently ended, after reconciling with this call's usage. */
  reservations: Reservation[];
  /** Set when the reservation ledger could not be written. */
  ledgerError?: string;
  table: PlacementTable;
  /** Why the table was rebuilt on this call; undefined when the cached one was used. */
  rebuilt: Staleness | 'refresh' | undefined;
  /** Set when a rebuilt table could not be written; this call still used it. */
  saveError?: string;
}

/** The cached table when it is fresh, else a rebuilt one. */
export async function loadPlacements(config: Config, deps: GatherDeps = {}): Promise<Omit<Gathered, 'env' | 'reservations' | 'ledgerError'>> {
  const now = deps.now ?? Date.now();
  const find = deps.find ?? findExecutable;
  const dir = deps.cacheDir ?? cacheDir();
  const readFile = deps.readFile ?? readTextFile;
  const read = readTable(readFile, dir);
  let evidenceGeneratedAt: string | undefined;
  try {
    const check: unknown = JSON.parse(readFile(join(dir, 'evidence-check.json')) ?? '');
    if (typeof check === 'object' && check !== null && 'generatedAt' in check && typeof check.generatedAt === 'string' &&
      Number.isFinite(Date.parse(check.generatedAt))) evidenceGeneratedAt = check.generatedAt;
  } catch { /* Missing or corrupt check metadata does not invalidate a fresh table. */ }
  const onPath = installedAgents({ find, env: deps.env ?? process.env });
  const why = deps.refresh
    ? 'refresh'
    : staleness(read, { now, ttlHours: config.placementsTtlHours, version: deps.version ?? VERSION, config, onPath, evidenceGeneratedAt });
  if (why === undefined) return { table: read.table!, rebuilt: undefined };
  const built = await buildPlacements(config, { ...deps, now, cacheDir: dir });
  return { table: built.table, rebuilt: why, ...(built.saveError !== undefined ? { saveError: built.saveError } : {}) };
}

export async function gather(config: Config, deps: GatherDeps = {}): Promise<Gathered> {
  const now = deps.now ?? Date.now();
  const run = deps.run ?? runCommand;
  const dir = deps.cacheDir ?? cacheDir();
  const [placements, reported, orcaAgents, workers] = await Promise.all([
    loadPlacements(config, { ...deps, now }),
    readOrcaUsage(run),
    (deps.readOrcaAgents ?? readOrcaAgents)(),
    workerStatesFor(run, dir),
  ]);
  const { table } = placements;
  // Reported usage is never adjusted. Reservations travel next to it and the quota view is rebuilt from both.
  const synced = syncReservations(reported, now, config, dir, workers);
  const rejections = activeRejections(readRejections(deps.readFile ?? readTextFile, deps.cacheDir ?? cacheDir()), now, config.rejectionTtlHours);
  const env: Environment = {
    now,
    bands: table.bands,
    ...(table.topBands ? { topBands: table.topBands } : {}),
    discoveries: table.agents,
    usage: synced.usage,
    reservations: synced.reservations.filter(isLive),
    orcaAgents,
    placementsBuiltAt: table.builtAt,
    evidenceSource: table.sources.evidence.source,
    evidenceGeneratedAt: table.sources.evidence.generatedAt,
    catalogSource: table.sources.evidence.source,
    scoreSource: table.sources.evidence.source,
    ...(rejections.length > 0 ? { rejections } : {}),
  };
  return { env, reservations: synced.reservations, ...(synced.error ? { ledgerError: synced.error } : {}), ...placements };
}

export async function gatherEnvironment(config: Config, deps: GatherDeps = {}): Promise<Environment> {
  return (await gather(config, deps)).env;
}
