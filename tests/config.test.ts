import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAgentChoice, ConfigError, DEFAULT_CONFIG, loadConfig, updateConfigFile, writeAgentChoice } from '../src/config.js';
import { configPath } from '../src/paths.js';

const saved = process.env.ORCACOMPASS_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
});

const write = (text: string) => writeFileSync(configPath(), text);

function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('DEFAULT_CONFIG', () => {
  it('holds the documented defaults', () => {
    expect(DEFAULT_CONFIG).toEqual({
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
        // Percentage points per worker and quota bucket: rows are buffer tiers, columns efforts.
        buffers: {
          minimal: { low: 0.5, medium: 0.5, high: 0.75, xhigh: 1 },
          light: { low: 0.5, medium: 1, high: 1.25, xhigh: 1.5 },
          daily: { low: 1, medium: 1.5, high: 1.75, xhigh: 2 },
          advanced: { low: 1.5, medium: 2, high: 2.5, xhigh: 3 },
          frontier: { low: 2, medium: 2.5, high: 3, xhigh: 3.5 },
        },
        overrides: [],
        modelTiers: {},
        pendingMinutes: 10,
        settleSeconds: 60,
        maxRunningHours: 24,
      },
      banModels: [],
      lastResortAgents: ['opencode'],
    });
  });
});

describe('loadConfig', () => {
  it('loads the documented example with its pin and tier override', () => {
    const cfg = loadConfig(fileURLToPath(new URL('../config.example.json', import.meta.url)));
    expect(cfg.pins).toEqual({ daily: { agent: 'claude', model: 'claude-sonnet-5-5' } });
    expect(cfg.tierOverrides).toEqual({ 'grok-4.7': 'advanced' });
    expect(cfg).toEqual({
      ...DEFAULT_CONFIG,
      allowAgents: ['claude', 'codex', 'cursor'],
      pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' } },
      tierOverrides: { 'grok-4.7': 'advanced' },
    });
  });

  it('returns the defaults when the file is missing', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('deep-merges the file over the defaults', () => {
    write('{"denyAgents":["cursor"],"riskThresholds":{"cautionPercent":80}}');
    const cfg = loadConfig();
    expect(cfg.denyAgents).toEqual(['cursor']);
    expect(cfg.riskThresholds).toEqual({ cautionPercent: 80, highPercent: 90 });
    expect(cfg.defaultEffort).toEqual(DEFAULT_CONFIG.defaultEffort);
  });

  it('accepts a full valid config', () => {
    write(JSON.stringify({
      allowAgents: ['claude', 'codex'],
      pins: { frontier: { agent: 'claude', model: 'claude-fable-5-1' } },
      tierOverrides: { 'grok-4.7': 'advanced' },
      defaultEffort: { light: 'minimal' },
      costBands: [0.5, 4, 10],
      riskThresholds: { cautionPercent: 70, highPercent: 82.5 },
      evidenceTtlHours: 1,
      usageStaleMinutes: 15,
      excludeNoZdr: true,
      cursorAuto: false,
    }));
    const cfg = loadConfig();
    expect(cfg.allowAgents).toEqual(['claude', 'codex']);
    expect(cfg.pins.frontier).toEqual({ agent: 'claude', model: 'claude-fable-5-1' });
    expect(cfg.tierOverrides).toEqual({ 'grok-4.7': 'advanced' });
    expect(cfg.defaultEffort).toEqual({ ...DEFAULT_CONFIG.defaultEffort, light: 'minimal' });
    expect(cfg).toMatchObject({ costBands: [0.5, 4, 10], riskThresholds: { cautionPercent: 70, highPercent: 82.5 }, evidenceTtlHours: 1, usageStaleMinutes: 15, excludeNoZdr: true, cursorAuto: false });
  });

  it('ignores the retired priceThresholds key', () => {
    write('{"priceThresholds":{"light":"cheap"},"classWeight":0}');
    const cfg = loadConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg).not.toHaveProperty('priceThresholds');
  });

  it('ignores removed keys and warns once per key', () => {
    write('{"scoreWeight":0.4,"modelsDevTtlHours":12}');
    const warnings: string[] = [];
    expect(loadConfig(configPath(), (message) => warnings.push(message))).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([
      'scoreWeight is no longer used (OrcaCompass 0.2.2 ranks models by benchmark evidence; see costBands)',
      'modelsDevTtlHours is no longer used (the evidence snapshot is the catalog; see evidenceTtlHours)',
    ]);
  });

  it.each([['costBands', [5, 1, 12]], ['costBands', [1, 5]], ['costBands', ['1', 5, 12]], ['costBands', [-1, 5, 12]], ['costBands', [1, 1, 12]], ['costBands', [1, 5, 1e309]], ['costBands', null], ['usageStaleMinutes', -1]])('reports invalid %s', (key, value) => {
    write(JSON.stringify({ [key]: value }));
    expect(configErrorOf(() => loadConfig()).message).toContain(key);
  });

  it('warns that classWeight is no longer used and ignores its value', () => {
    for (const value of [0.3, 7, null, 'old']) {
      write(JSON.stringify({ classWeight: value }));
      const warnings: string[] = [];
      expect(loadConfig(configPath(), (w) => warnings.push(w))).toEqual(DEFAULT_CONFIG);
      expect(warnings).toEqual(['classWeight is no longer used (OrcaCompass 0.2.2 scores models by evidence alone; cost tiers come from price, see costBands)']);
    }
  });

  it('reads an explicit path', () => {
    const dir = join(home, 'elsewhere');
    mkdirSync(dir);
    writeFileSync(join(dir, 'custom.json'), '{"denyAgents":["codex"]}');
    expect(loadConfig(join(dir, 'custom.json')).denyAgents).toEqual(['codex']);
  });

  it('does not let a loaded config mutate the defaults', () => {
    write('{"denyAgents":["cursor"]}');
    const loaded = loadConfig();
    loaded.riskThresholds.cautionPercent = 1;
    loaded.reservations.buffers.frontier.xhigh = 99;
    loaded.reservations.overrides.push({ agent: 'claude', scale: 2 });
    expect(DEFAULT_CONFIG.riskThresholds.cautionPercent).toBe(85);
    expect(DEFAULT_CONFIG.reservations.buffers.frontier.xhigh).toBe(3.5);
    expect(DEFAULT_CONFIG.reservations.overrides).toEqual([]);
    expect(DEFAULT_CONFIG.denyAgents).toEqual([]);
  });

  it('merges reservation buffers cell by cell and reads overrides, model rows and timings', () => {
    write(JSON.stringify({
      reservations: {
        buffers: { daily: { high: 2.25 }, minimal: { low: 0.25 } },
        overrides: [{ agent: 'claude', plan: 'max_5x', pool: 'session', scale: 3 }, { pool: 'bucket:Other Models', buffers: { frontier: { xhigh: 5 } } }],
        modelTiers: { 'claude-haiku-5-5': 'minimal', 'gpt-luna': 'minimal' },
        pendingMinutes: 5, settleSeconds: 120, maxRunningHours: 6,
      },
    }));
    const { reservations } = loadConfig();
    // Only the named cells change; the rest of the table keeps its defaults.
    expect(reservations.buffers.daily).toEqual({ low: 1, medium: 1.5, high: 2.25, xhigh: 2 });
    expect(reservations.buffers.minimal).toEqual({ low: 0.25, medium: 0.5, high: 0.75, xhigh: 1 });
    expect(reservations.buffers.frontier).toEqual(DEFAULT_CONFIG.reservations.buffers.frontier);
    expect(reservations.overrides).toEqual([{ agent: 'claude', plan: 'max_5x', pool: 'session', scale: 3 }, { pool: 'bucket:Other Models', buffers: { frontier: { xhigh: 5 } } }]);
    expect(reservations.modelTiers).toEqual({ 'claude-haiku-5-5': 'minimal', 'gpt-luna': 'minimal' });
    expect(reservations).toMatchObject({ pendingMinutes: 5, settleSeconds: 120, maxRunningHours: 6 });
  });

  it('ignores the keys of the removed headroom projection and flat hand-out buffer, with a warning each', () => {
    write('{"thresholds":{"longPercent":90},"usageRiskLimit":80,"handoutMinutes":5,"handoutPercent":"x","preferRiskLimit":95}');
    const warnings: string[] = [];
    const cfg = loadConfig(undefined, (m) => warnings.push(m));
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, preferRiskLimit: 95 });
    expect(warnings).toEqual([
      ...['thresholds', 'usageRiskLimit', 'handoutMinutes', 'handoutPercent']
        .map((key) => `${key} is no longer used (usage is no longer projected; see riskThresholds and reservations)`),
      // 95 is above the default high-risk threshold of 90.
      'preferRiskLimit (95%) is above riskThresholds.highPercent (90%): a preferred route is taken in the high-risk range up to 95%',
    ]);
    for (const key of ['thresholds', 'usageRiskLimit', 'handoutMinutes', 'handoutPercent']) expect(cfg).not.toHaveProperty(key);
  });

  it('keeps preferRiskLimit independent of riskThresholds.highPercent and warns when it is above it', () => {
    const load = (text: string) => {
      write(text);
      const warnings: string[] = [];
      return { cfg: loadConfig(undefined, (m) => warnings.push(m)), warnings };
    };
    // Defaults (90 and 90), or a limit at or below the threshold: no warning.
    expect(load('{}').warnings).toEqual([]);
    expect(load('{"preferRiskLimit":80}').warnings).toEqual([]);
    expect(load('{"riskThresholds":{"highPercent":95}}').warnings).toEqual([]);
    // A lowered threshold under the default limit warns, and neither value is changed.
    const lowered = load('{"riskThresholds":{"cautionPercent":70,"highPercent":80}}');
    expect(lowered.cfg).toMatchObject({ preferRiskLimit: 90, riskThresholds: { cautionPercent: 70, highPercent: 80 } });
    expect(lowered.warnings).toEqual(['preferRiskLimit (90%) is above riskThresholds.highPercent (80%): a preferred route is taken in the high-risk range up to 90%']);
    // An explicit limit above the default threshold warns too; it is not capped.
    const explicit = load('{"preferRiskLimit":150}');
    expect(explicit.cfg.preferRiskLimit).toBe(150);
    expect(explicit.warnings).toEqual(['preferRiskLimit (150%) is above riskThresholds.highPercent (90%): a preferred route is taken in the high-risk range up to 150%']);
  });

  it('accepts a reservation override scale between 0 and 100 and rejects anything else', () => {
    for (const scale of [0, 0.5, 100]) {
      write(JSON.stringify({ reservations: { overrides: [{ scale }] } }));
      expect(loadConfig().reservations.overrides).toEqual([{ scale }]);
    }
    for (const scale of ['101', '1e308', '-1', '"2"', 'null']) {
      write(`{"reservations":{"overrides":[{"agent":"claude","scale":${scale}}]}}`);
      expect(configErrorOf(() => loadConfig()).message, scale).toBe(
        `${configPath()}: reservations.overrides[0].scale must be a number between 0 and 100 (got ${JSON.stringify(JSON.parse(scale))})`,
      );
    }
  });

  it('rejects invalid JSON with a message starting with the path', () => {
    write('{bad json');
    const err = configErrorOf(() => loadConfig());
    expect(err.message.startsWith(configPath())).toBe(true);
    expect(err.message).toContain('config.json');
  });

  it('rejects unknown effort and tier values', () => {
    write('{"defaultEffort":{"light":"ultra"}}');
    expect(configErrorOf(() => loadConfig()).message).toMatch(/defaultEffort\.light/);
    write('{"tierOverrides":{"grok-4.7":"huge"}}');
    expect(configErrorOf(() => loadConfig()).message).toMatch(/tierOverrides/);
    write('{"defaultEffort":{"extreme":"high"}}');
    configErrorOf(() => loadConfig());
    write('{"pins":{"huge":{"agent":"claude","model":"x"}}}');
    configErrorOf(() => loadConfig());
  });

  it('accepts placementsTtlHours 0 (rebuild every command) and reports a negative value', () => {
    write('{"placementsTtlHours":0}');
    expect(loadConfig().placementsTtlHours).toBe(0);
    write('{"placementsTtlHours":-1}');
    expect(configErrorOf(() => loadConfig()).message).toBe(`${configPath()}: placementsTtlHours must be a non-negative number`);
  });

  it('rejects wrongly typed known keys', () => {
    for (const bad of [
      '[]',
      'null',
      '{"denyAgents":"cursor"}',
      '{"allowAgents":[1]}',
      '{"riskThresholds":{"cautionPercent":"85"}}',
      '{"riskThresholds":5}',
      '{"riskThresholds":{"highPercent":120}}',
      '{"riskThresholds":{"cautionPercent":95,"highPercent":90}}',
      '{"reservations":[]}',
      '{"reservations":{"buffers":{"huge":{"low":1}}}}',
      '{"reservations":{"buffers":{"daily":{"max":1}}}}',
      '{"reservations":{"buffers":{"daily":{"low":-1}}}}',
      '{"reservations":{"buffers":{"daily":{"low":"1"}}}}',
      '{"reservations":{"overrides":{}}}',
      '{"reservations":{"overrides":[{"agent":"claude"}]}}',
      '{"reservations":{"overrides":[{"pool":"","scale":2}]}}',
      '{"reservations":{"overrides":[{"scale":-1}]}}',
      '{"reservations":{"modelTiers":{"claude-haiku-5-5":"tiny"}}}',
      '{"reservations":{"pendingMinutes":"10"}}',
      '{"reservations":{"settleSeconds":-1}}',
      '{"placementsTtlHours":-1}',
      '{"placementsTtlHours":"5"}',
      '{"usageStaleMinutes":-1}',
      '{"rejectionTtlHours":"24"}',
      '{"excludeNoZdr":"yes"}',
      '{"cursorAuto":"no"}',
      '{"pins":{"daily":{"model":"claude-sonnet-5-5"}}}',
      '{"pins":{"daily":{"agent":"claude","model":5}}}',
      '{"tierOverrides":[]}',
      '{"preferRiskLimit":-1}',
      '{"preferRiskLimit":"100"}',
      '{"banModels":"grok"}',
      '{"lastResortAgents":"opencode"}',
    ]) {
      write(bad);
      expect(configErrorOf(() => loadConfig()).message.startsWith(configPath()), bad).toBe(true);
    }
  });
});

describe('applyAgentChoice', () => {
  const none = { denyAgents: [] };

  it('disable adds to denyAgents and drops the agent from an allow list', () => {
    expect(applyAgentChoice(none, 'disable', ['grok', 'cursor', 'grok'])).toEqual({ denyAgents: ['grok', 'cursor'] });
    expect(applyAgentChoice({ allowAgents: ['claude', 'grok'], denyAgents: ['codex'] }, 'disable', ['grok']))
      .toEqual({ allowAgents: ['claude'], denyAgents: ['codex', 'grok'] });
  });

  it('enable removes from denyAgents and adds to an existing allow list', () => {
    expect(applyAgentChoice({ denyAgents: ['grok', 'codex'] }, 'enable', ['grok'])).toEqual({ denyAgents: ['codex'] });
    expect(applyAgentChoice({ allowAgents: ['claude'], denyAgents: [] }, 'enable', ['codex', 'claude']))
      .toEqual({ allowAgents: ['claude', 'codex'], denyAgents: [] });
  });

  it('only sets the allow list and lifts those agents from denyAgents', () => {
    expect(applyAgentChoice({ denyAgents: ['codex', 'grok'] }, 'only', ['claude', 'codex']))
      .toEqual({ allowAgents: ['claude', 'codex'], denyAgents: ['grok'] });
  });

  it('reset goes back to all agents', () => {
    expect(applyAgentChoice({ allowAgents: ['claude'], denyAgents: ['grok'] }, 'reset', [])).toEqual({ denyAgents: [] });
  });
});

describe('writeAgentChoice', () => {
  const read = () => readFileSync(configPath(), 'utf8');

  it('creates the config file when there is none', () => {
    rmSync(home, { recursive: true, force: true });
    writeAgentChoice({ denyAgents: ['grok'] });
    expect(read()).toBe('{\n  "denyAgents": [\n    "grok"\n  ]\n}\n');
    expect(loadConfig().denyAgents).toEqual(['grok']);
  });

  it('keeps every other key, key order, indentation and line endings', () => {
    write('{\r\n    "pins": { "frontier": { "agent": "claude", "model": "claude-fable-5-1" } },\r\n    "denyAgents": ["codex"],\r\n    "scoreWeight": 0.5\r\n}');
    writeAgentChoice({ allowAgents: ['claude'], denyAgents: ['codex', 'grok'] });
    const text = read();
    expect(text).toBe([
      '{',
      '    "pins": {',
      '        "frontier": {',
      '            "agent": "claude",',
      '            "model": "claude-fable-5-1"',
      '        }',
      '    },',
      '    "denyAgents": [',
      '        "codex",',
      '        "grok"',
      '    ],',
      '    "scoreWeight": 0.5,',
      '    "allowAgents": [',
      '        "claude"',
      '    ]',
      '}',
    ].join('\r\n'));
    expect(loadConfig()).toMatchObject({ allowAgents: ['claude'], denyAgents: ['codex', 'grok'], costBands: [1, 5, 12] });
  });

  it('removes allowAgents and denyAgents on reset', () => {
    write('{"allowAgents":["claude"],"denyAgents":["grok"],"cursorAuto":false}\n');
    writeAgentChoice({ denyAgents: [] });
    expect(JSON.parse(read())).toEqual({ cursorAuto: false });
  });

  it('refuses to touch a file that is not a valid config', () => {
    write('{bad');
    expect(configErrorOf(() => writeAgentChoice({ denyAgents: ['grok'] })).message).toMatch(/invalid JSON/);
    expect(read()).toBe('{bad');
    write('{"costBands": [5, 1, 12]}');
    expect(configErrorOf(() => writeAgentChoice({ denyAgents: ['grok'] })).message).toMatch(/costBands/);
    expect(read()).toBe('{"costBands": [5, 1, 12]}');
  });
});

describe('preferences and bans in the config', () => {
  it('accepts a preference with an agent only, a risk limit and a ban list', () => {
    write('{"pins":{"daily":{"agent":"codex"}},"preferRiskLimit":150,"banModels":["grok","claude-opus-5"]}');
    expect(loadConfig()).toMatchObject({ pins: { daily: { agent: 'codex' } }, preferRiskLimit: 150, banModels: ['grok', 'claude-opus-5'] });
  });
});

describe('updateConfigFile', () => {
  it('applies a change to the raw file and refuses one that makes it invalid', () => {
    write('{\n  "cursorAuto": false\n}\n');
    updateConfigFile((raw) => {
      raw.pins = { daily: { agent: 'codex' } };
    });
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ cursorAuto: false, pins: { daily: { agent: 'codex' } } });
    expect(configErrorOf(() => updateConfigFile((raw) => {
      raw.preferRiskLimit = -5;
    })).message).toMatch(/preferRiskLimit/);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ cursorAuto: false, pins: { daily: { agent: 'codex' } } });
  });
});
