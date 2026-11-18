import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../paths.js';
import type { OrcaAgents } from '../types.js';
import { readTextFile } from '../placements/agents/deps.js';
import { importSqlite } from '../system/sqlite.js';

// Orca has no CLI or documented file for its agent on/off switches (Settings → Agents). They live in
// settings.disabledTuiAgents of the active profile's state, which this reads strictly read-only.
// Anything unexpected means "unknown", never "all enabled".

export interface OrcaSettingsDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  readFile: (p: string) => string | undefined;
  exists: (p: string) => boolean;
  /** The JSON payload of the 'settings' row in profile-state.db, or undefined when there is none. */
  readSettingsPayload: (dbPath: string) => Promise<string | undefined>;
}

// Orca's own rule for profile ids (profile-state-active-location).
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Orca's userData folder, resolved as the Orca CLI does. */
export function orcaUserDataPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | undefined {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca');
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'orca') : undefined;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca');
}

function activeProfile(deps: OrcaSettingsDeps, userData: string): string | OrcaAgents {
  const index = join(userData, 'orca-profile-index.json');
  const texts = [index, `${index}.bak`].map(deps.readFile).filter((t): t is string => t !== undefined);
  if (texts.length === 0) return { known: false, reason: `Orca profile index not found (${index})` };
  for (const text of texts) {
    try {
      const data: unknown = JSON.parse(text);
      if (!isObj(data) || !Array.isArray(data.profiles)) continue;
      const id = data.activeProfileId;
      if (typeof id === 'string' && PROFILE_ID.test(id) && data.profiles.some((p) => isObj(p) && p.id === id)) return id;
    } catch {
      // try the backup copy
    }
  }
  return { known: false, reason: `cannot resolve the active Orca profile from ${index}` };
}

function fromSettings(settings: unknown, source: string): OrcaAgents {
  if (!isObj(settings) || !Array.isArray(settings.disabledTuiAgents)) {
    return { known: false, reason: `Orca settings in ${source} have no disabledTuiAgents list` };
  }
  return { known: true, disabled: settings.disabledTuiAgents.filter((a): a is string => typeof a === 'string'), source };
}

export async function readOrcaAgents(deps: OrcaSettingsDeps = defaultDeps()): Promise<OrcaAgents> {
  const userData = orcaUserDataPath(deps.env, deps.platform, deps.home);
  if (!userData) return { known: false, reason: 'APPDATA is not set, so the Orca folder is unknown' };
  const profile = activeProfile(deps, userData);
  if (typeof profile !== 'string') return profile;
  const dir = join(userData, 'profiles', profile);
  const db = join(dir, 'profile-state.db');
  const jsonFile = join(dir, 'orca-data.json');
  try {
    // Once the SQLite state exists Orca treats it as the authority; orca-data.json may be stale.
    if (deps.exists(db)) {
      const payload = await deps.readSettingsPayload(db);
      if (payload === undefined) return { known: false, reason: `no settings in ${db}` };
      return fromSettings(JSON.parse(payload), db);
    }
    const text = deps.readFile(jsonFile);
    if (text === undefined) return { known: false, reason: `Orca settings not found in ${dir}` };
    const data: unknown = JSON.parse(text);
    return fromSettings(isObj(data) ? data.settings : undefined, jsonFile);
  } catch (e) {
    return { known: false, reason: `cannot read Orca settings: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Opens profile-state.db read-only, reads the settings row and closes it at once. Needs node:sqlite (Node 22.13+). */
export async function readSettingsPayload(dbPath: string): Promise<string | undefined> {
  const { DatabaseSync } = await importSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM profile_state_documents WHERE domain = ?').get('settings');
    return typeof row?.payload === 'string' ? row.payload : undefined;
  } finally {
    db.close();
  }
}

function defaultDeps(): OrcaSettingsDeps {
  return {
    env: process.env,
    platform: process.platform,
    home: homeDir(),
    readFile: readTextFile,
    exists: existsSync,
    readSettingsPayload,
  };
}
