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
};

function tableFixture(patch: Partial<PlacementTable> = {}): PlacementTable {
  return {
    schemaVersion: 4,
    version: '0.1.0',
    builtAt: NOW,
    builtWith: builtWith(DEFAULT_CONFIG),
    sources: { evidence: { source: 'snapshot', fetchedAt: NOW - HOUR, models: 120, generatedAt: '2026-11-10T04:00:00Z' } },
    bands: { coding: [68, 76, 84], agentic: [60, 70, 80], reasoning: [70, 78, 86] },
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
  it('rejects a schema 3 table with the old builtWith shape', () => {
    expect(parseTable(JSON.stringify({ ...tableFixture(), schemaVersion: 3, builtWith: { classWeight: 0.1, tierOverrides: {} } }))).toBeUndefined();
  });

  it.each([undefined, null, [5, 1, 12], [1, 5], ['1', 5, 12], [-1, 5, 12], [1, 1, 12]])('rejects invalid cached costBands %j', (costBands) => {
    expect(parseTable(JSON.stringify({ ...tableFixture(), builtWith: { tierOverrides: {}, costBands } }))).toBeUndefined();
  });

  it.each([undefined, {}, { tier: 'ultra', blended: 4, source: 'price' }, { tier: 'daily', blended: -1, source: 'price' }, { tier: 'daily', blended: '4', source: 'price' }, { tier: 'daily', blended: null, source: 'unknown' }])('rejects invalid cached cost %j', (cost) => {
    const table = tableFixture();
    expect(parseTable(JSON.stringify({ ...table, agents: [{ ...table.agents[0], models: [{ ...fable, profile: { ...fable.profile, cost } }] }] }))).toBeUndefined();
  });

  it('accepts the written shape', () => {
    expect(parseTable(JSON.stringify(tableFixture()))).toEqual(tableFixture());
  });

  it.each([
    ['not JSON', 'not json'],
    ['legacy placement schema', JSON.stringify({ ...tableFixture(), schemaVersion: 2 })],
    ['a bare schema', '{"schemaVersion":1}'],
    ['another schema version', JSON.stringify({ ...tableFixture(), schemaVersion: 99 })],
    ['a row without a profile', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, profile: undefined } as unknown as PlacedModel] }] }))],
    ['a profile with an unknown class', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, profile: { ...fable.profile, class: 'ultra' } } as unknown as PlacedModel] }] }))],
    ['a missing evidence source', JSON.stringify({ ...tableFixture(), sources: { ...tableFixture().sources, evidence: undefined } })],
    ['a launch without a kind', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, launch: {} } as unknown as PlacedModel] }] }))],
    ['a flag launch without a model', JSON.stringify(tableFixture({ agents: [{ agent: 'claude', installed: true, models: [{ ...fable, launch: { kind: 'flag' } } as unknown as PlacedModel] }] }))],
    ['a variant launch without ids', JSON.stringify(tableFixture({ agents: [{ agent: 'cursor', installed: true, models: [{ ...fable, agent: 'cursor', launch: { kind: 'variant' } } as unknown as PlacedModel] }] }))],
  ])('rejects %s', (_name, text) => {
    expect(parseTable(text)).toBeUndefined();
  });

  it.each([
    ['missing axis', { ...fable.profile, axes: { ...fable.profile.axes, coding: undefined } }],
    ['unknown band', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, band: 'ultra' } } }],
    ['unknown label', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, label: 'certain' } } }],
    ['missing evidence', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, evidence: undefined } } }],
    ['out-of-range score', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, score: 101 } } }],
    ['negative benchmark count', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, benchmarks: -1 } } }],
    ['fractional benchmark count', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, benchmarks: 1.5 } } }],
    ['invalid inheritance', { ...fable.profile, axes: { ...fable.profile.axes, coding: { ...fable.profile.axes.coding, inheritedFrom: 9 } } }],
  ])('rejects a profile with %s', (_, profile) => {
    const raw = tableFixture();
    const text = JSON.stringify({ ...raw, agents: [{ ...raw.agents[0], models: [{ ...fable, profile }] }] });
    expect(parseTable(text)).toBeUndefined();
  });

  it('accepts an unranked profile', () => {
    const profile = { class: null, cost: null, hint: null, axes: Object.fromEntries(['coding', 'agentic', 'reasoning'].map((axis) =>
      [axis, { score: null, evidence: null, benchmarks: 0, label: 'unranked', band: null }])) };
    const raw = tableFixture();
    expect(parseTable(JSON.stringify({ ...raw, agents: [{ ...raw.agents[0], models: [{ ...fable, profile }] }] }))).toBeDefined();
  });

  it('rejects missing or invalid bands and evidence generation metadata', () => {
    for (const bands of [undefined, { coding: [84, 76, 68], agentic: [60, 70, 80], reasoning: [70, 78, 86] }]) {
      expect(parseTable(JSON.stringify({ ...tableFixture(), bands }))).toBeUndefined();
    }
    for (const generatedAt of [undefined, 'invalid']) {
      expect(parseTable(JSON.stringify({ ...tableFixture(), sources: { evidence: { ...tableFixture().sources.evidence, generatedAt } } }))).toBeUndefined();
    }
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
    ['config', read(), { config: { ...DEFAULT_CONFIG, costBands: [1, 3, 12] } }],
    ['agent-appeared', read(), { onPath: ['claude', 'muse'] }],
  ])('is %s', (expected, r, patch) => {
    expect(staleness(r, { ...fresh, ...patch })).toBe(expected);
  });

  it('rebuilds when the cached evidence generation changes', () => {
    expect(staleness(read(), { ...fresh, evidenceGeneratedAt: '2026-11-11T04:00:00Z' })).toBe('evidence');
    expect(staleness(read(), { ...fresh, evidenceGeneratedAt: '2026-11-10T04:00:00Z' })).toBeUndefined();
  });

  it('does not care about bans, pins or agent choice', () => {
    const config: Config = { ...DEFAULT_CONFIG, cursorAuto: false, banModels: ['claude-haiku'], denyAgents: ['grok'], pins: { daily: { agent: 'codex' } } };
    expect(staleness(read(), { ...fresh, config })).toBeUndefined();
  });

  it('ignores key order in builtWith', () => {
    const reordered = tableFixture({ builtWith: { costBands: [1, 5, 12], tierOverrides: {} } });
    expect(staleness({ table: reordered, present: true }, fresh)).toBeUndefined();
  });

  it('does not count an installed agent that left PATH', () => {
    expect(staleness(read(), { ...fresh, onPath: [] })).toBeUndefined();
  });
});

describe('builtWith and tableAge', () => {
  it('copies only the two placement keys', () => {
    expect(builtWith({ ...DEFAULT_CONFIG, banModels: ['x'] })).toEqual({ tierOverrides: {}, costBands: [1, 5, 12] });
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
