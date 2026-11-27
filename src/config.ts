import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EFFORT_LADDER } from './routing/effort.js';
import { BUFFER_EFFORTS, BUFFER_TIERS, DEFAULT_BUFFERS, type BufferEffort, type BufferOverride, type BufferTier } from './routing/quota.js';
import { EFFORT_POLICIES, TIERS, type AgentId, type Config, type Effort, type EffortPolicy, type Preference, type Tier } from './types.js';
import { configPath } from './paths.js';

export const DEFAULT_CONFIG: Config = {
  denyAgents: [],
  pins: {},
  tierOverrides: {},
  defaultEffort: { light: 'low', daily: 'medium', advanced: 'medium', frontier: 'high' },
  effortPolicy: 'balanced',
  costBands: [1, 5, 12],
  evidenceTtlHours: 24,
  placementsTtlHours: 5,
  usageStaleMinutes: 30,
  rejectionTtlHours: 168,
  excludeNoZdr: false,
  cursorAuto: true,
  preferRiskLimit: 90,
  riskThresholds: { cautionPercent: 85, highPercent: 90 },
  reservations: {
    buffers: DEFAULT_BUFFERS,
    overrides: [],
    modelTiers: {},
    pendingMinutes: 10,
    settleSeconds: 60,
    maxRunningHours: 24,
  },
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
      if (Object.hasOwn(raw, 'scoreWeight')) warn?.('scoreWeight is no longer used (OrcaCompass 0.2.2 ranks models by benchmark evidence; see costBands)');
      if (Object.hasOwn(raw, 'classWeight')) warn?.('classWeight is no longer used (OrcaCompass 0.2.2 scores models by evidence alone; cost tiers come from price, see costBands)');
      if (Object.hasOwn(raw, 'modelsDevTtlHours')) warn?.('modelsDevTtlHours is no longer used (the evidence snapshot is the catalog; see evidenceTtlHours)');
      for (const key of REMOVED_QUOTA_KEYS) {
        if (Object.hasOwn(raw, key)) warn?.(`${key} is no longer used (usage is no longer projected; see riskThresholds and reservations)`);
      }
    }
    return merge(raw);
  } catch (e) {
    if (e instanceof Invalid) throw new ConfigError(path, e.message);
    throw e;
  }
}

/** Keys of the predictive headroom and flat hand-out buffer, ignored since the quota redesign. */
const REMOVED_QUOTA_KEYS = ['thresholds', 'usageRiskLimit', 'handoutMinutes', 'handoutPercent'] as const;

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

function bands(v: unknown, key: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
      v[0] >= v[1] || v[1] >= v[2]) {
    throw new Invalid(`${key} must be three ascending non-negative numbers`);
  }
  return [v[0], v[1], v[2]];
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

function percent(v: unknown, key: string): number {
  const n = num(v, key);
  if (n > 100) throw new Invalid(`${key} must be between 0 and 100`);
  return n;
}

function bufferTier(v: unknown, key: string): BufferTier {
  if (!BUFFER_TIERS.includes(v as BufferTier)) throw new Invalid(`${key} must be one of ${BUFFER_TIERS.join(', ')} (got ${JSON.stringify(v)})`);
  return v as BufferTier;
}

/** A partial buffer table: rows are buffer tiers, columns low, medium, high and xhigh, cells percentage points. */
function bufferCells(v: unknown, key: string): Partial<Record<BufferTier, Partial<Record<BufferEffort, number>>>> {
  const out: Partial<Record<BufferTier, Partial<Record<BufferEffort, number>>>> = {};
  for (const [row, cells] of Object.entries(obj(v, key))) {
    const tier = bufferTier(row, `${key} key`);
    const target: Partial<Record<BufferEffort, number>> = {};
    for (const [column, value] of Object.entries(obj(cells, `${key}.${row}`))) {
      if (!BUFFER_EFFORTS.includes(column as BufferEffort)) {
        throw new Invalid(`${key}.${row} key must be one of ${BUFFER_EFFORTS.join(', ')} (got ${JSON.stringify(column)})`);
      }
      target[column as BufferEffort] = percent(value, `${key}.${row}.${column}`);
    }
    out[tier] = target;
  }
  return out;
}

function bufferOverride(v: unknown, key: string): BufferOverride {
  const o = obj(v, key);
  const out: BufferOverride = {};
  for (const field of ['agent', 'plan', 'pool'] as const) {
    if (o[field] === undefined) continue;
    if (typeof o[field] !== 'string' || o[field] === '') throw new Invalid(`${key}.${field} must be a non-empty string`);
    out[field] = o[field];
  }
  if (o.scale !== undefined) out.scale = num(o.scale, `${key}.scale`);
  if (o.buffers !== undefined) out.buffers = bufferCells(o.buffers, `${key}.buffers`);
  if (out.scale === undefined && out.buffers === undefined) throw new Invalid(`${key} must have "scale" or "buffers"`);
  return out;
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
  if (r.riskThresholds !== undefined) {
    const t = obj(r.riskThresholds, 'riskThresholds');
    for (const k of ['cautionPercent', 'highPercent'] as const) {
      if (t[k] !== undefined) c.riskThresholds[k] = percent(t[k], `riskThresholds.${k}`);
    }
    if (c.riskThresholds.cautionPercent > c.riskThresholds.highPercent) throw new Invalid('riskThresholds.cautionPercent must not exceed riskThresholds.highPercent');
  }
  if (r.reservations !== undefined) {
    const v = obj(r.reservations, 'reservations');
    if (v.buffers !== undefined) {
      for (const [tier, cells] of Object.entries(bufferCells(v.buffers, 'reservations.buffers'))) {
        c.reservations.buffers[tier as BufferTier] = { ...c.reservations.buffers[tier as BufferTier], ...cells };
      }
    }
    if (v.overrides !== undefined) {
      if (!Array.isArray(v.overrides)) throw new Invalid('reservations.overrides must be an array');
      c.reservations.overrides = v.overrides.map((o, i) => bufferOverride(o, `reservations.overrides[${i}]`));
    }
    if (v.modelTiers !== undefined) {
      for (const [k, tier] of Object.entries(obj(v.modelTiers, 'reservations.modelTiers'))) c.reservations.modelTiers[k] = bufferTier(tier, `reservations.modelTiers.${k}`);
    }
    for (const k of ['pendingMinutes', 'settleSeconds', 'maxRunningHours'] as const) {
      if (v[k] !== undefined) c.reservations[k] = num(v[k], `reservations.${k}`);
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
  if (r.costBands !== undefined) c.costBands = bands(r.costBands, 'costBands');
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
