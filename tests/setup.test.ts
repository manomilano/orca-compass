import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTextFile } from '../src/placements/agents/deps.js';
import type { Runner } from '../src/system/run.js';
import { main, type MainDeps } from '../src/cli.js';
import { configPath } from '../src/paths.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const orcaFixture = fixture('orca-account-list.json');
const cursorFixture = fixture('cursor-list-models.txt');
const codexCache = fixture('codex-models-cache.json');

const runner: Runner = async (_cmd, args) => {
  if (args[0] === 'account') return { code: 0, stdout: orcaFixture, stderr: '' };
  if (args.includes('--list-models')) return { code: 0, stdout: cursorFixture, stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
};

const deps: MainDeps = {
  run: runner,
  find: (name) => (['grok', 'agy'].includes(name) ? undefined : `/fake/bin/${name}`),
  readFile: (p) => {
    if (p.endsWith('models_cache.json')) return codexCache;
    if (p.endsWith('agent-model-catalog.json')) return undefined;
    return readTextFile(p);
  },
  env: { CODEX_HOME: '/fake/codex', CLAUDE_CONFIG_DIR: '/fake/claude', HOME: '/fake/home' },
  readOrcaAgents: async () => ({ known: true, disabled: ['cursor'], source: '/fake/orca/profile-state.db' }),
  fetchImpl: async () => {
    throw new Error('offline');
  },
  now: 1793232000000,
};

let stdout: string[];
let stderr: string[];
const io = { out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) };
const savedHome = process.env.ORCACOMPASS_HOME;
const config = () => JSON.parse(readFileSync(configPath(), 'utf8'));
const AMBIENT_MODEL = 'claude-synthetic-ambient-9';

beforeEach(() => {
  process.env.ORCACOMPASS_HOME = mkdtempSync(join(tmpdir(), 'oc-setup-'));
  // homedir() follows these variables, so this synthetic catalog fails any test that reaches past the fake machine.
  const ambientHome = mkdtempSync(join(tmpdir(), 'oc-ambient-home-'));
  const catalogDir = join(ambientHome, '.claude', 'cache', 'model-catalog');
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, 'synthetic-account-cc.json'), JSON.stringify({ fetchedAt: deps.now, catalog: { config: { models: [{ id: AMBIENT_MODEL }] } } }));
  vi.stubEnv('HOME', ambientHome);
  vi.stubEnv('USERPROFILE', ambientHome);
  stdout = [];
  stderr = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (savedHome === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = savedHome;
});

/** Runs `setup` with the answers typed one per line; returns the exit code and everything the wizard printed. */
async function wizard(answers: string[], extra: MainDeps = {}): Promise<{ code: number; screen: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk) => (screen += String(chunk)));
  input.end(answers.map((a) => `${a}\n`).join(''));
  const code = await main(['setup'], io, { ...deps, ...extra, terminal: { input, output } });
  return { code, screen };
}

const INITIAL = '{\n  "cursorAuto": false,\n  "banModels": ["grok-9"]\n}\n';
const CONFIGURED = {
  denyAgents: ['codex'],
  pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' } },
  preferRiskLimit: 120,
  banModels: ['claude-haiku'],
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('fake machine', () => {
  it('keeps a Claude catalog in the ambient home out of discovery', async () => {
    expect(await main(['status', '--json'], io, deps)).toBe(0);
    expect(stdout.join('\n')).not.toContain(AMBIENT_MODEL);
  });
});

describe('setup --json', () => {
  it('prints one document with agents, tiers, families and the current config', async () => {
    writeFileSync(configPath(), JSON.stringify(CONFIGURED));
    expect(await main(['setup', '--json'], io, deps)).toBe(0);
    const j = JSON.parse(stdout.join('\n'));
    expect(Object.keys(j)).toEqual(['configPath', 'configExists', 'orcaAgents', 'config', 'defaultPreferRiskLimit', 'agents', 'tiers', 'families']);
    expect(j).toMatchObject({ configPath: configPath(), configExists: true, defaultPreferRiskLimit: 100 });
    expect(j.orcaAgents).toEqual({ known: true, disabled: ['cursor'], source: '/fake/orca/profile-state.db' });
    expect(j.config).toEqual({ allowAgents: null, ...CONFIGURED });

    expect(j.agents.map((a: { agent: string }) => a.agent)).toEqual(['claude', 'codex', 'cursor', 'grok', 'antigravity', 'opencode', 'muse']);
    for (const a of j.agents) {
      expect(a).toEqual({
        agent: expect.any(String),
        installed: expect.any(Boolean),
        enabledInOrca: expect.stringMatching(/^(yes|no|unknown)$/),
        orcaUsage: expect.stringMatching(/^(ok|unavailable|unknown)$/),
        models: expect.any(Number),
        chosen: expect.any(Boolean),
        preselected: expect.any(Boolean),
        verdict: expect.stringMatching(/^(used|not used: .+)$/),
      });
    }
    const agent = (id: string) => j.agents.find((a: { agent: string }) => a.agent === id);
    expect(agent('claude')).toMatchObject({ chosen: true, preselected: true, verdict: 'used' });
    expect(agent('codex')).toMatchObject({ chosen: false, preselected: false, verdict: 'not used: excluded by config' });
    expect(agent('cursor')).toMatchObject({ enabledInOrca: 'no', chosen: true, preselected: false });
    expect(agent('muse')).toMatchObject({ installed: true, models: 0, preselected: false });

    expect(Object.keys(j.tiers)).toEqual(['light', 'daily', 'advanced', 'frontier']);
    for (const t of Object.values(j.tiers) as Record<string, unknown>[]) {
      expect(Object.keys(t)).toEqual(['pick', 'preferred', 'options', 'warnings']);
      if (t.pick !== null) {
        expect(t.pick).toEqual({ agent: expect.any(String), model: expect.any(String), effort: expect.toBeOneOf([null, expect.any(String)]) });
      }
      for (const o of t.options as unknown[]) {
        expect(o).toEqual({
          agent: expect.any(String), model: expect.any(String), blocked: expect.any(Boolean),
          onPacePercent: expect.toBeOneOf([null, expect.any(Number)]), reason: expect.any(String),
        });
      }
      expect(t.warnings).toEqual(expect.any(Array));
    }
    expect(j.tiers.daily).toMatchObject({
      pick: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      preferred: { agent: 'claude', model: 'claude-sonnet-5-5' },
      options: [{ agent: 'claude', model: 'claude-sonnet-5-5', blocked: false, onPacePercent: 55 }],
    });
    expect(j.tiers.light.preferred).toBeNull();

    for (const f of j.families) expect(f).toEqual({ family: expect.any(String), models: expect.any(Array), banned: expect.any(Boolean) });
    const families = j.families.map((f: { family: string }) => f.family);
    expect(families).toEqual([...families].sort());
    expect(j.families.find((f: { family: string }) => f.family === 'claude-haiku')).toMatchObject({
      banned: true, models: expect.arrayContaining([{ agent: 'claude', model: 'claude-haiku-5-5' }]),
    });
  });

  it('works without a terminal and reports a missing config', async () => {
    expect(await main(['setup', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ configExists: false, config: { allowAgents: null, denyAgents: [], pins: {}, banModels: [] } });
  });
});

describe('setup --skip', () => {
  it('creates the config without changing any setting, so setup is not offered again', async () => {
    expect(await main(['setup', '--skip', '--json'], io, deps)).toBe(0);
    const j = JSON.parse(stdout.join('\n'));
    expect(j.agentsUsed).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(j.agentsUsed).not.toContain('cursor'); // switched off in Orca in the fixture
    expect(config()).toEqual({});
    stdout = [];
    expect(await main(['setup', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(stdout.join('\n')).configExists).toBe(true);
  });

  it('keeps an existing config as it is', async () => {
    writeFileSync(configPath(), INITIAL);
    expect(await main(['setup', '--skip'], io, deps)).toBe(0);
    expect(readFileSync(configPath(), 'utf8')).toBe(INITIAL);
    expect(stdout.join('\n')).toMatch(/Setup skipped; defaults kept in .*\nAgents used now: claude, codex \(they follow the agents enabled in Orca\)\./);
  });
});

describe('setup --complete', () => {
  it('finishes chat setup with defaults and preserves existing settings on repeat', async () => {
    expect(await main(['setup', '--complete', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(stdout.join('\n')).configExists).toBe(true);
    expect(config()).toEqual({});
    writeFileSync(configPath(), INITIAL);
    stdout = [];
    expect(await main(['setup', '--complete'], io, deps)).toBe(0);
    expect(readFileSync(configPath(), 'utf8')).toBe(INITIAL);
    expect(stdout.join('\n')).toContain('Setup complete');
  });

  it('rejects completing and skipping together', async () => {
    expect(await main(['setup', '--complete', '--skip'], io, deps)).toBe(1);
  });
});

describe('setup wizard', () => {
  it('exits 1 without a terminal and points to the chat flow and the commands', async () => {
    expect(await main(['setup'], io, deps)).toBe(1);
    expect(stderr.join('\n')).toMatch(/orcacompass setup --json/);
    expect(stderr.join('\n')).toMatch(/orcacompass agents, orcacompass prefer, orcacompass ban/);
  });

  it('keeps every default on a first run and saves a config that changes nothing', async () => {
    const { code, screen } = await wizard(['', '', '', '']);
    expect(code).toBe(0);
    expect(screen).toMatch(/^ {2}#\s+agent\s+installed\s+enabled in Orca\s+Orca usage\s+models$/m);
    expect(screen).toMatch(/^ {2}3\s+cursor\s+yes\s+no\s+ok\s+\d+$/m);
    expect(screen).toMatch(/Use which agents\? Numbers or names, separated by commas \[claude, codex\]: /);
    expect(screen).toMatch(/100% \(the default\) projected usage, a known within-limit alternative replaces it/);
    expect(screen).toMatch(/Set favorites\? \[y\/N\]: /);
    expect(screen).toMatch(/^ {2}\d+\s+claude-haiku\s+claude-haiku-5-5, /m);
    expect(screen).toMatch(/^Agents used: claude, codex$/m);
    expect(screen).toMatch(/^Not used: cursor \(not enabled in Orca\), grok \(not signed in or unavailable\), /m);
    expect(screen).toMatch(/^Favorites: none; every tier takes the route with the most room$/m);
    expect(screen).toMatch(/^Never used: nothing$/m);
    expect(screen).toMatch(/^ {2}light\s+claude · claude-haiku-5-5 · low$/m);
    expect(screen).toMatch(/^ {2}frontier\s+claude · claude-fable-5-2 · high$/m);
    expect(screen).toMatch(new RegExp(`Saved ${escape(configPath())}$`, 'm'));
    expect(config()).toEqual({});
  });

  it('writes the answers exactly as the agents, prefer and ban commands do, keeping other keys', async () => {
    writeFileSync(configPath(), INITIAL);
    // claude only; favorites: Daily → option 1, limit 120%; bans: family 2 (claude-haiku) and grok-9; save.
    const { code, screen } = await wizard(['1', 'y', '', '1', '', '', '120%', '2, grok-9', 'y']);
    expect(code).toBe(0);
    expect(screen).toMatch(/^Daily: now claude · claude-sonnet-5-5 · medium; favorite: none$/m);
    expect(screen).toMatch(/^ {2}1\s+claude claude-sonnet-5-5\s+on pace for 55%$/m);
    expect(screen).toMatch(/^Favorites: Daily claude claude-sonnet-5-5; above 120%, switch only to a known within-limit alternative$/m);
    expect(screen).toMatch(/^Never used: claude-haiku, grok-9$/m);
    // Haiku is banned and Codex is off, so Light has no model left.
    expect(screen).toMatch(/^ {2}light\s+claude · claude-sonnet-5-5 · low \(upgraded to daily\)\n\s+warning: no light-tier model installed; using daily$/m);
    const fromWizard = config();
    expect(fromWizard).toEqual({
      cursorAuto: false, banModels: ['claude-haiku', 'grok-9'], denyAgents: ['codex'],
      pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' } }, preferRiskLimit: 120,
    });

    process.env.ORCACOMPASS_HOME = mkdtempSync(join(tmpdir(), 'oc-setup-'));
    writeFileSync(configPath(), INITIAL);
    await main(['agents', 'disable', 'codex'], io, deps);
    await main(['prefer', 'daily', 'claude', 'claude-sonnet-5-5'], io, deps);
    await main(['prefer', '--risk-limit', '120'], io, deps);
    await main(['unban', 'grok-9'], io, deps);
    await main(['ban', 'claude-haiku', 'grok-9'], io, deps);
    expect(config()).toEqual(fromWizard);
  });

  it('starts from the current config and writes nothing when every answer is kept', async () => {
    const text = JSON.stringify(CONFIGURED, null, 2);
    writeFileSync(configPath(), text);
    const { code, screen } = await wizard(['', '', '', '', '', '', '', '']);
    expect(code).toBe(0);
    expect(screen).toMatch(/Use which agents\? Numbers or names, separated by commas \[claude\]: /);
    expect(screen).toMatch(/120% \(the default is 100%\)/);
    expect(screen).toMatch(/Set favorites\? \[Y\/n\]: /);
    expect(screen).toMatch(/^Daily: now claude · claude-sonnet-5-5 · medium; favorite: claude claude-sonnet-5-5$/m);
    expect(screen).toMatch(/Favorite for Daily\? Number, 0 for none \[keep\]: /);
    expect(screen).toMatch(/more than what percent\? \[120\]: /);
    expect(screen).toMatch(/"none" for no bans \[claude-haiku\]: /);
    expect(screen).toMatch(/^Nothing changed\. Config: /m);
    expect(screen).not.toMatch(/Save to/);
    expect(readFileSync(configPath(), 'utf8')).toBe(text);
  });

  it('asks again after a bad answer, notes an agent Orca has switched off, refuses an agent as a ban, and clears', async () => {
    writeFileSync(configPath(), JSON.stringify(CONFIGURED));
    const { code, screen } = await wizard(['8', 'gemini', 'claude cursor', 'maybe', 'y', '0', '', '', 'codex', '99', 'none', 'y']);
    expect(code).toBe(0);
    expect(screen).toMatch(/"8" is not one of the agents above\./);
    expect(screen).toMatch(/"gemini" is not one of the agents above\./);
    expect(screen).toMatch(/note: cursor is switched off in Orca; switch it on in Orca's settings \(Agents\) to use it\./);
    expect(screen).toMatch(/Please answer y or n\./);
    expect(screen).not.toMatch(/more than what percent/);
    expect(screen).toMatch(/"codex" is an agent, not a model family; leave it out in question 1/);
    expect(screen).toMatch(/Numbers go from 1 to \d+\./);
    expect(config()).toEqual({ denyAgents: ['codex'], preferRiskLimit: 120 });
  });

  it('lets Enter through when no agent can be used', async () => {
    const allOff: MainDeps = { readOrcaAgents: async () => ({ known: true, disabled: ['claude', 'codex', 'cursor', 'grok', 'antigravity', 'opencode', 'muse'], source: '/fake/db' }) };
    const { code, screen } = await wizard(['', '', '', ''], allOff);
    expect(code).toBe(0);
    expect(screen).toMatch(/separated by commas \[none\]: /);
    expect(screen).toMatch(/^Agents used: none$/m);
    expect(screen).toMatch(/^ {2}daily\s+no route$/m);
  });

  it('cancels without saving when the input ends before the last question', async () => {
    const { code, screen } = await wizard(['1']);
    expect(code).toBe(1);
    expect(screen).toMatch(/Setup canceled; nothing was saved\.$/m);
    expect(() => readFileSync(configPath())).toThrow();
  });
});
