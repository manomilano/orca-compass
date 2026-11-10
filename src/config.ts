import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EFFORT_LADDER } from './routing/effort.js';
import { EFFORT_POLICIES, TIERS, type AgentId, type Config, type Effort, type EffortPolicy, type Preference, type Tier } from './types.js';
import { configPath } from './paths.js';

export const DEFAULT_CONFIG: Config = {
  denyAgents: [],
  pins: {},
  tierOverrides: {},
  thresholds: { longPercent: 95, sessionPercent: 90 },
  defaultEffort: { light: 'low', daily: 'medium', advanced: 'medium', frontier: 'high' },
  effortPolicy: 'balanced',
  classWeight: 0.1,
  handoutMinutes: 10,
  handoutPercent: 5,
  evidenceTtlHours: 24,
  placementsTtlHours: 5,
  usageStaleMinutes: 30,
  rejectionTtlHours: 168,
  excludeNoZdr: false,
  cursorAuto: true,
  preferRiskLimit: 100,
  banModels: [],
  lastResortAgents: ['opencode'],
};

/** Message always starts with the config file path. */
export class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Missing file → defaults. Otherwise the file is deep-merged over the defaults; unknown keys are ignored. */
export function loadConfig(path = configPath(), warn?: (message: string) => void): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw new ConfigError(path, `cannot read: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(path, `invalid JSON: ${(e as Error).message}`);
  }
  try {
    if (isObj(raw)) {
      if (Object.hasOwn(raw, 'scoreWeight')) warn?.('scoreWeight is no longer used (OrcaCompass 0.3 ranks models by benchmark evidence; see classWeight)');
      if (Object.hasOwn(raw, 'modelsDevTtlHours')) warn?.('modelsDevTtlHours is no longer used (the evidence snapshot is the catalog; see evidenceTtlHours)');
    }
    return merge(raw);
  } catch (e) {
    if (e instanceof Invalid) throw new ConfigError(path, e.message);
    throw e;
  }
}

class Invalid extends Error {}

export type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, key: string): Obj {
  if (!isObj(v)) throw new Invalid(`${key} must be an object`);
  return v;
}

function strings(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new Invalid(`${key} must be an array of strings`);
  return [...v];
}

function num(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Invalid(`${key} must be a non-negative number`);
  return v;
}

function fraction(v: unknown, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Invalid(`${key} must be a number from 0 to 1`);
  return v;
}

function tier(v: unknown, key: string): Tier {
  if (!TIERS.includes(v as Tier)) throw new Invalid(`${key} must be one of ${TIERS.join(', ')} (got ${JSON.stringify(v)})`);
  return v as Tier;
}

function effort(v: unknown, key: string): Effort {
  if (!EFFORT_LADDER.includes(v as Effort)) {
    throw new Invalid(`${key} must be one of ${EFFORT_LADDER.join(', ')} (got ${JSON.stringify(v)})`);
  }
  return v as Effort;
}

function tierKey(k: string, key: string): Tier {
  return tier(k, `${key} key`);
}

function merge(raw: unknown): Config {
  const r = obj(raw, 'config');
  const c = structuredClone(DEFAULT_CONFIG);
  if (r.allowAgents !== undefined) c.allowAgents = strings(r.allowAgents, 'allowAgents');
  if (r.denyAgents !== undefined) c.denyAgents = strings(r.denyAgents, 'denyAgents');
  if (r.pins !== undefined) {
    for (const [k, v] of Object.entries(obj(r.pins, 'pins'))) {
      const pin = obj(v, `pins.${k}`);
      if (typeof pin.agent !== 'string' || (pin.model !== undefined && typeof pin.model !== 'string')) {
        throw new Invalid(`pins.${k} must have a string "agent" and an optional string "model"`);
      }
      c.pins[tierKey(k, 'pins')] = { agent: pin.agent, ...(pin.model !== undefined ? { model: pin.model } : {}) };
    }
  }
  if (r.tierOverrides !== undefined) {
    for (const [k, v] of Object.entries(obj(r.tierOverrides, 'tierOverrides'))) c.tierOverrides[k] = tier(v, `tierOverrides.${k}`);
  }
  if (r.thresholds !== undefined) {
    const t = obj(r.thresholds, 'thresholds');
    for (const k of ['longPercent', 'sessionPercent'] as const) {
      if (t[k] !== undefined) c.thresholds[k] = num(t[k], `thresholds.${k}`);
    }
  }
  if (r.defaultEffort !== undefined) {
    for (const [k, v] of Object.entries(obj(r.defaultEffort, 'defaultEffort'))) {
      c.defaultEffort[tierKey(k, 'defaultEffort')] = effort(v, `defaultEffort.${k}`);
    }
  }
  if (r.effortPolicy !== undefined) {
    if (!EFFORT_POLICIES.includes(r.effortPolicy as EffortPolicy)) throw new Invalid(`effortPolicy must be one of ${EFFORT_POLICIES.join(', ')}`);
    c.effortPolicy = r.effortPolicy as EffortPolicy;
  }
  if (r.classWeight !== undefined) c.classWeight = fraction(r.classWeight, 'classWeight');
  if (r.handoutMinutes !== undefined) c.handoutMinutes = num(r.handoutMinutes, 'handoutMinutes');
  if (r.handoutPercent !== undefined) c.handoutPercent = num(r.handoutPercent, 'handoutPercent');
  if (r.evidenceTtlHours !== undefined) c.evidenceTtlHours = num(r.evidenceTtlHours, 'evidenceTtlHours');
  if (r.placementsTtlHours !== undefined) c.placementsTtlHours = num(r.placementsTtlHours, 'placementsTtlHours');
  if (r.usageStaleMinutes !== undefined) c.usageStaleMinutes = num(r.usageStaleMinutes, 'usageStaleMinutes');
  if (r.rejectionTtlHours !== undefined) c.rejectionTtlHours = num(r.rejectionTtlHours, 'rejectionTtlHours');
  if (r.excludeNoZdr !== undefined) {
    if (typeof r.excludeNoZdr !== 'boolean') throw new Invalid('excludeNoZdr must be a boolean');
    c.excludeNoZdr = r.excludeNoZdr;
  }
  if (r.cursorAuto !== undefined) {
    if (typeof r.cursorAuto !== 'boolean') throw new Invalid('cursorAuto must be a boolean');
    c.cursorAuto = r.cursorAuto;
  }
  if (r.preferRiskLimit !== undefined) c.preferRiskLimit = num(r.preferRiskLimit, 'preferRiskLimit');
  if (r.banModels !== undefined) c.banModels = strings(r.banModels, 'banModels');
  if (r.lastResortAgents !== undefined) c.lastResortAgents = strings(r.lastResortAgents, 'lastResortAgents');
  return c;
}

// --- the user's agent choice -----------------------------------------------------------------

export type AgentChoice = Pick<Config, 'allowAgents' | 'denyAgents'>;
export type AgentAction = 'disable' | 'enable' | 'only' | 'reset';

const unique = (ids: AgentId[]): AgentId[] => [...new Set(ids)];

/** The allow/deny lists after `orcacompass agents <action> <ids>`. */
export function applyAgentChoice(choice: AgentChoice, action: AgentAction, ids: AgentId[]): AgentChoice {
  const deny = choice.denyAgents.filter((a) => !ids.includes(a));
  switch (action) {
    case 'disable':
      return {
        ...(choice.allowAgents ? { allowAgents: choice.allowAgents.filter((a) => !ids.includes(a)) } : {}),
        denyAgents: unique([...choice.denyAgents, ...ids]),
      };
    case 'enable':
      return { ...(choice.allowAgents ? { allowAgents: unique([...choice.allowAgents, ...ids]) } : {}), denyAgents: deny };
    case 'only':
      return { allowAgents: unique(ids), denyAgents: deny };
    case 'reset':
      return { denyAgents: [] };
  }
}

/** Whether the user's choice lets OrcaCompass use the agent. */
export const isChosen = (agent: AgentId, choice: AgentChoice): boolean =>
  !choice.denyAgents.includes(agent) && (!choice.allowAgents || choice.allowAgents.includes(agent));

/** Writes allowAgents/denyAgents; an empty denyAgents or an absent allowAgents removes the key. */
export function writeAgentChoice(choice: AgentChoice, path = configPath()): void {
  updateConfigFile((raw) => setAgentChoice(raw, choice), path);
}

// Edits of the raw config JSON, shared by the commands and `setup` so both write the same keys the same way.

export function setAgentChoice(raw: Obj, choice: AgentChoice): void {
  if (choice.allowAgents) raw.allowAgents = choice.allowAgents;
  else delete raw.allowAgents;
  if (choice.denyAgents.length > 0) raw.denyAgents = choice.denyAgents;
  else delete raw.denyAgents;
}

/** Sets the preferred route of one tier, or removes it without a preference; no preferences removes `pins`. */
export function setPin(raw: Obj, tier: Tier, pin: Preference | undefined): void {
  const pins = isObj(raw.pins) ? { ...raw.pins } : {};
  if (pin) pins[tier] = pin;
  else delete pins[tier];
  if (Object.keys(pins).length > 0) raw.pins = pins;
  else delete raw.pins;
}

export function setBans(raw: Obj, banModels: string[]): void {
  if (banModels.length > 0) raw.banModels = banModels;
  else delete raw.banModels;
}

/** A percent such as "120" or "120%" for `preferRiskLimit`, or undefined when it is not a non-negative number. */
export function parsePercent(text: string): number | undefined {
  const t = text.trim().replace(/%$/, '');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The default limit removes the key. */
export function setPreferRiskLimit(raw: Obj, percent: number): void {
  if (percent === DEFAULT_CONFIG.preferRiskLimit) delete raw.preferRiskLimit;
  else raw.preferRiskLimit = percent;
}

/**
 * Applies `change` to the config file's JSON, creating the file if needed. Every other key keeps its
 * value and position, and the file keeps its indentation and line endings. A file that is not a valid
 * config, or a change that would make it invalid, leaves the file untouched.
 */
export function updateConfigFile(change: (raw: Record<string, unknown>) => void, path = configPath()): void {
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(path, `cannot read: ${(e as Error).message}`);
  }
  let raw: Obj = {};
  if (text !== undefined) {
    try {
      raw = obj(JSON.parse(text), 'config');
      merge(raw);
    } catch (e) {
      if (e instanceof SyntaxError) throw new ConfigError(path, `invalid JSON: ${e.message}`);
      if (e instanceof Invalid) throw new ConfigError(path, e.message);
      throw e;
    }
  }
  change(raw);
  try {
    merge(raw);
  } catch (e) {
    if (e instanceof Invalid) throw new ConfigError(path, e.message);
    throw e;
  }

  const indent = (text && /^[ \t]+(?=")/m.exec(text)?.[0]) || '  ';
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text === undefined || /\n$/.test(text) ? eol : '';
  const out = JSON.stringify(raw, null, indent).replace(/\n/g, eol) + trailing;
  mkdirSync(dirname(path), { recursive: true });
  // Replace in one step so a crash never leaves half a config.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
}
