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
      thresholds: { longPercent: 95, sessionPercent: 90 },
      defaultEffort: { light: 'low', daily: 'medium', advanced: 'medium', frontier: 'high' },
      effortPolicy: 'balanced',
      costBands: [1, 5, 12],
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
    write('{"denyAgents":["cursor"],"thresholds":{"longPercent":90}}');
    const cfg = loadConfig();
    expect(cfg.denyAgents).toEqual(['cursor']);
    expect(cfg.thresholds).toEqual({ longPercent: 90, sessionPercent: 90 });
    expect(cfg.defaultEffort).toEqual(DEFAULT_CONFIG.defaultEffort);
  });

  it('accepts a full valid config', () => {
    write(JSON.stringify({
      allowAgents: ['claude', 'codex'],
      pins: { frontier: { agent: 'claude', model: 'claude-fable-5-1' } },
      tierOverrides: { 'grok-4.7': 'advanced' },
      defaultEffort: { light: 'minimal' },
      costBands: [0.5, 4, 10],
      handoutMinutes: 0,
      handoutPercent: 12.5,
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
    expect(cfg).toMatchObject({ costBands: [0.5, 4, 10], handoutMinutes: 0, handoutPercent: 12.5, evidenceTtlHours: 1, usageStaleMinutes: 15, excludeNoZdr: true, cursorAuto: false });
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

  it.each([['costBands', [5, 1, 12]], ['costBands', [1, 5]], ['costBands', ['1', 5, 12]], ['costBands', [-1, 5, 12]], ['costBands', [1, 1, 12]], ['costBands', [1, 5, 1e309]], ['costBands', null], ['handoutMinutes', -1]])('reports invalid %s', (key, value) => {
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
    loadConfig().thresholds.longPercent = 1;
    expect(DEFAULT_CONFIG.thresholds.longPercent).toBe(95);
    expect(DEFAULT_CONFIG.denyAgents).toEqual([]);
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
      '{"thresholds":{"longPercent":"95"}}',
      '{"thresholds":5}',
      '{"handoutMinutes":-1}',
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
