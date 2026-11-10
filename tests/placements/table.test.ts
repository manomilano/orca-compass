import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { parseSnapshot } from '../../src/evidence/snapshot.js';
import { buildProfile } from '../../src/placements/profiles.js';
import { readTextFile } from '../../src/placements/agents/deps.js';
import { builtWith, parseTable, PLACEMENTS_FILE, readTable, staleness, tableAge, writeTable, type ReadTable } from '../../src/placements/table.js';
import type { Config, PlacementTable, PlacedModel } from '../../src/types.js';
import { fixture } from '../helpers/fakes.js';

const NOW = 1793232000000;
const HOUR = 3_600_000;

const fable: PlacedModel = {
  agent: 'claude',
  modelId: 'claude-fable-5-1',
  meta: { id: 'claude-fable-5-1', provider: 'anthropic', name: 'Claude Fable 5.1', family: 'claude-fable', releaseDate: '2026-09-01' },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  effortSource: 'provider',
  launch: { kind: 'flag', model: 'claude-fable-5-1' },
  poolNames: ['session', 'weekly', 'fableWeekly'],
  lineup: 'For your toughest challenges',
  profile: buildProfile('claude-fable-5-1', undefined, undefined, parseSnapshot(fixture('evidence-mini.json'))!, DEFAULT_CONFIG),
  placements: [
    { tier: 'frontier', source: 'lineup', detail: 'the provider\'s lineup ("For your toughest challenges")' },
  ],
  tiers: ['frontier'],
};

function tableFixture(patch: Partial<PlacementTable> = {}): PlacementTable {
  return {
    schemaVersion: 2,
    version: '0.1.0',
    builtAt: NOW,
    builtWith: builtWith(DEFAULT_CONFIG),
    sources: {
      catalog: { source: 'snapshot', fetchedAt: NOW - HOUR, models: 120 },
      scores: { source: 'cache', fetchedAt: NOW - 2 * HOUR, models: 30 },
      scoreScale: { cuts: [0.34, 0.72, 0.9] },
    },
    agents: [
      { agent: 'claude', installed: true, models: [fable], note: 'models from a fixture' },
      { agent: 'muse', installed: false, models: [] },
    ],
    ...patch,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-table-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const fresh = { now: NOW + HOUR, ttlHours: 5, version: '0.1.0', config: DEFAULT_CONFIG, onPath: ['claude'] };

describe('writeTable and readTable', () => {
  it('round-trips the table and leaves no temp file behind', () => {
    const table = tableFixture();
    expect(writeTable(table, dir)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([PLACEMENTS_FILE]);
    expect(readTable(readTextFile, dir)).toEqual({ table, present: true });
  });

  it('reports a missing file as absent', () => {
    expect(readTable(readTextFile, dir)).toEqual({ table: undefined, present: false });
  });

  it('reports an unwritable directory instead of throwing', () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, '');
    const error = writeTable(tableFixture(), file);
    expect(error).toMatch(/ENOTDIR|EEXIST|ENOENT/);
  });
});

describe('parseTable', () => {
  it('accepts the written shape', () => {
    expect(parseTable(JSON.stringify(tableFixture()))).toEqual(tableFixture());
  });

  it.each([
    ['not JSON', 'not json'],
    ['legacy placement schema', JSON.stringify({ ...tableFixture(), schemaVersion: 1 })],
    ['a bare schema', '{"schemaVersion":1}'],
    ['another schema version', JSON.stringify({ ...tableFixture(), schemaVersion: 99 })],
    ['a row without placements', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, placements: undefined } as unknown as PlacedModel] }] }))],
    ['a placement with an unknown tier', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, placements: [{ tier: 'ultra', source: 'lineup' }] } as unknown as PlacedModel] }] }))],
    ['a missing catalog source', JSON.stringify({ ...tableFixture(), sources: { ...tableFixture().sources, catalog: undefined } })],
    ['a launch without a kind', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, launch: {} } as unknown as PlacedModel] }] }))],
    ['a flag launch without a model', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, launch: { kind: 'flag' } } as unknown as PlacedModel] }] }))],
    ['a variant launch without ids', JSON.stringify(tableFixture({ agents: [{ agent: 'cursor', installed: true, models: [{ ...fable, agent: 'cursor', launch: { kind: 'variant' } } as unknown as PlacedModel] }] }))],
  ])('rejects %s', (_name, text) => {
    expect(parseTable(text)).toBeUndefined();
  });

  it('accepts a variant launch', () => {
    const variant = { ...fable, agent: 'cursor', launch: { kind: 'variant', ids: { high: 'claude-fable-5-1-high' }, defaultId: 'claude-fable-5-1' } } as PlacedModel;
    const table = tableFixture({ agents: [{ agent: 'cursor', installed: true, models: [variant] }] });
    expect(parseTable(JSON.stringify(table))).toEqual(table);
  });

  it('is undefined for no text', () => {
    expect(parseTable(undefined)).toBeUndefined();
  });
});

describe('staleness', () => {
  const read = (patch: Partial<PlacementTable> = {}): ReadTable => ({ table: tableFixture(patch), present: true });

  it('is fresh at 4h59 with the same config and no new agent on PATH', () => {
    expect(staleness(read(), { ...fresh, now: NOW + 5 * HOUR - 60_000 })).toBeUndefined();
  });

  it.each<[string, ReadTable, Partial<typeof fresh>]>([
    ['missing', { table: undefined, present: false }, {}],
    ['invalid', { table: undefined, present: true }, {}],
    ['version', read(), { version: '9.9.9' }],
    ['expired', read(), { now: NOW + 5 * HOUR }],
    ['expired', read(), { ttlHours: 0 }],
    ['expired', read({ builtAt: NOW + 48 * HOUR }), {}],
    ['config', read(), { config: { ...DEFAULT_CONFIG, tierOverrides: { 'claude-opus-5-5': 'frontier' } } }],
    ['config', read(), { config: { ...DEFAULT_CONFIG, cursorAuto: false } }],
    ['config', read(), { config: { ...DEFAULT_CONFIG, classWeight: 0.5 } }],
    ['agent-appeared', read(), { onPath: ['claude', 'muse'] }],
  ])('is %s', (expected, r, patch) => {
    expect(staleness(r, { ...fresh, ...patch })).toBe(expected);
  });

  it('does not care about bans, pins or agent choice', () => {
    const config: Config = { ...DEFAULT_CONFIG, banModels: ['claude-haiku'], denyAgents: ['grok'], pins: { daily: { agent: 'codex' } } };
    expect(staleness(read(), { ...fresh, config })).toBeUndefined();
  });

  it('ignores key order in builtWith', () => {
    const reordered = tableFixture({ builtWith: { classWeight: 0.1, cursorAuto: true, tierOverrides: {} } });
    expect(staleness({ table: reordered, present: true }, fresh)).toBeUndefined();
  });

  it('does not count an installed agent that left PATH', () => {
    expect(staleness(read(), { ...fresh, onPath: [] })).toBeUndefined();
  });
});

describe('builtWith and tableAge', () => {
  it('copies only the three placement keys', () => {
    expect(builtWith({ ...DEFAULT_CONFIG, banModels: ['x'] })).toEqual({ tierOverrides: {}, cursorAuto: true, classWeight: 0.1 });
  });

  it('measures the age in milliseconds', () => {
    expect(tableAge(tableFixture(), NOW + 90_000)).toBe(90_000);
  });

  it('does not share tierOverrides with the config', () => {
    const config = { ...DEFAULT_CONFIG, tierOverrides: { a: 'light' as const } };
    const b = builtWith(config);
    config.tierOverrides.a = 'daily';
    expect(b.tierOverrides.a).toBe('light');
  });
});
