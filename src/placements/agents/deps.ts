import { readdirSync, readFileSync } from 'node:fs';
import type { ModelIndex } from '../../types.js';
import type { findExecutable, Runner } from '../../system/run.js';

/** What finding an agent's executable needs: the PATH lookup and the environment naming its default folders. */
export type Locator = Pick<AgentDeps, 'find' | 'env'>;

/** Everything an agent adapter touches on the machine, injectable for tests. */
export interface AgentDeps {
  index: ModelIndex;
  run: Runner;
  find: typeof findExecutable;
  readFile: (p: string) => string | undefined;
  listDir: (p: string) => string[];
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  now: number;
  /** Orca's model catalog rows (each a probe's JSON), oldest first, or undefined when there is no catalog. Unset: not read. */
  readOrcaCatalog?: (dbPath: string) => Promise<string[] | undefined>;
}

/** Reads a UTF-8 file, or undefined when it is missing or unreadable. */
export function readTextFile(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Names in a directory, or none when it is missing or unreadable. */
export function listDirectory(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
