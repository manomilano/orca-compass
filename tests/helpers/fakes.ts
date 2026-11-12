import { readFileSync } from 'node:fs';
import { readTextFile } from '../../src/placements/agents/deps.js';
import type { Runner } from '../../src/system/run.js';
import type { GatherDeps } from '../../src/routing/environment.js';

// A fake machine for CLI, build and gather tests: Claude from a fixture catalog, Codex from its fixture
// cache, Cursor from a fixture listing, Grok and Antigravity absent, Orca usage from a fixture.

export const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
export const orcaFixture = fixture('orca-account-list.json');
export const cursorFixture = fixture('cursor-list-models.txt');
export const codexCache = fixture('codex-models-cache.json');

export const NOW = 1793232000000;

/** discoverCursor runs the resolved executable path, so dispatch on args, not the command name. */
export const fakeRunner =
  (orca: () => Awaited<ReturnType<Runner>>): Runner =>
  async (_cmd, args) => {
    if (args[0] === 'account') return orca();
    if (args[0] === 'models') return { code: 0, stdout: cursorFixture, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}` };
  };
export const runner = fakeRunner(() => ({ code: 0, stdout: orcaFixture, stderr: '' }));
export const orcaDownRunner = fakeRunner(() => ({ code: null, stdout: '', stderr: '', error: 'spawn orca ENOENT' }));

export const fakeDeps: GatherDeps = {
  run: runner,
  find: (name) => (['grok', 'agy'].includes(name) ? undefined : `/fake/bin/${name}`),
  readFile: (p) => {
    if (p.endsWith('models_cache.json')) return codexCache;
    if (p.endsWith('agent-model-catalog.json')) return undefined;
    return readTextFile(p);
  },
  // A fake home and Claude config dir keep this machine's real account catalog and agent caches out of the tests.
  env: { CODEX_HOME: '/fake/codex', CLAUDE_CONFIG_DIR: '/fake/claude', HOME: '/fake/home' },
  readOrcaAgents: async () => ({ known: true, disabled: [], source: '/fake/orca/profile-state.db' }),
  fetchImpl: async () => {
    throw new Error('offline');
  },
  // Offline, the loader falls back to the "bundled" snapshot: a frozen copy of the 2026-11-12 cost-tier
  // production snapshot, so the daily data refresh never moves the scores these tests assert.
  bundled: new URL('../fixtures/evidence-bundled.json', import.meta.url),
  now: NOW,
};
