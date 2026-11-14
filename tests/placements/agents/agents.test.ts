import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toModelIndex } from '../../../src/evidence/catalog.js';
import { parseSnapshot } from '../../../src/evidence/snapshot.js';
import { discoverClaude } from '../../../src/placements/agents/claude.js';
import { discoverCodex } from '../../../src/placements/agents/codex.js';
import { discoverAntigravity, parseAgyModels } from '../../../src/placements/agents/antigravity.js';
import { discoverCursor, normalizeCursorId } from '../../../src/placements/agents/cursor.js';
import { readTextFile, type AgentDeps } from '../../../src/placements/agents/deps.js';
import { discoverGrok, parseGrokCache, parseGrokModels } from '../../../src/placements/agents/grok.js';
import { discoverMuse } from '../../../src/placements/agents/muse.js';
import { discoverOpencode, parseOpencodeModels, toOpencodeModels } from '../../../src/placements/agents/opencode.js';
import { orcaCatalogPath } from '../../../src/placements/agents/orca-catalog.js';
import type { Runner } from '../../../src/system/run.js';
import type { Effort, ModelIndex, ModelMeta } from '../../../src/types.js';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const cursorFixture = fixture('cursor-list-models.txt');
const codexCache = fixture('codex-models-cache.json');
const orcaCatalog = fixture('orca-agent-model-catalog.json');
// Public model-list formats for Grok and Antigravity, without account details.
const grokFixture = fixture('grok-models.txt');
const agyFixture = fixture('agy-models.txt');
// The same `grok models` format with every model Orca's grok catalog knows.
const grokMany = [
  'You are logged in with grok.com.', '', 'Default model: grok-4.7', '', 'Available models:',
  '  * grok-4.7 (default)', '  - grok-4.6', '  - grok-4.5', '  - grok-build', '', 'Use /model inside grok to switch models.', '',
].join('\n');

const NOW = 1793232000000;
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const meta = (id: string, provider: string, family: string, releaseDate: string): ModelMeta => ({
  id,
  provider,
  name: id,
  family,
  releaseDate,
});
// Keep older adapter identity fixtures beside the V2 snapshot catalog.
const index: ModelIndex = {
  ...Object.fromEntries(
  [
    meta('claude-fable-5', 'anthropic', 'claude-fable', '2026-06-01'),
    meta('gpt-5.6-sol', 'openai', 'gpt-sol', '2026-03-01'),
    meta('grok-4.7', 'xai', 'grok', '2026-09-21'),
    meta('gemini-3.8-flash', 'google', 'gemini-flash', '2026-09-02'),
    meta('claude-sonnet-4-6', 'anthropic', 'claude-sonnet', '2026-02-17'),
    meta('claude-opus-4-6', 'anthropic', 'claude-opus', '2026-02-05'),
  ].map((m) => [m.id, m]),
  ),
  ...toModelIndex(parseSnapshot(fixture('evidence-mini.json'))!),
};

const fakeRun =
  (stdout: string, calls: { cmd: string; args: string[]; timeoutMs?: number }[] = []): Runner =>
  async (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts?.timeoutMs });
    return { code: 0, stdout, stderr: '' };
  };
const failRun: Runner = async () => ({ code: 1, stdout: '', stderr: 'should not run' });

const fixtureFiles =
  (files: { codexCache?: string; orcaCatalog?: string }, reads: string[] = []) =>
  (p: string): string | undefined => {
    reads.push(p);
    if (p.endsWith('models_cache.json')) return files.codexCache;
    if (p.endsWith('agent-model-catalog.json')) return files.orcaCatalog;
    return undefined;
  };

const deps = (overrides: Partial<AgentDeps>): AgentDeps => ({
  index,
  run: failRun,
  find: () => '/bin/x',
  readFile: readTextFile,
  listDir: () => [],
  env: { CODEX_HOME: '/fake/codex', APPDATA: '/fake/appdata', HOME: '/fake/home', XDG_CONFIG_HOME: '/fake/config' },
  cacheDir: mkdtempSync(join(tmpdir(), 'oc-agents-')),
  now: NOW,
  ...overrides,
});

describe('where agents keep their files', () => {
  const readFrom = (seen: string[]): AgentDeps['readFile'] => (p) => (seen.push(p), undefined);
  // A fake home, so these checks read nothing from the machine running them.
  const env = { HOME: '/fake/home', APPDATA: '/fake/appdata' };

  it('treats an empty CODEX_HOME as unset', async () => {
    const seen: string[] = [];
    await discoverCodex(deps({ readFile: readFrom(seen), env: { ...env, CODEX_HOME: '' } }));
    expect(seen).toContain(join('/fake/home', '.codex', 'models_cache.json'));
  });

  it('treats an empty CLAUDE_CONFIG_DIR as unset', async () => {
    const dirs: string[] = [];
    await discoverClaude(deps({ listDir: (p) => (dirs.push(p), []), env: { ...env, CLAUDE_CONFIG_DIR: '' } }));
    expect(dirs).toEqual([join('/fake/home', '.claude', 'cache', 'model-catalog')]);
  });

  it('treats an empty GROK_HOME as unset', async () => {
    const seen: string[] = [];
    await discoverGrok(deps({ readFile: readFrom(seen), run: fakeRun(grokFixture), env: { ...env, GROK_HOME: '' } }));
    expect(seen).toContain(join('/fake/home', '.grok', 'models_cache.json'));
  });

  it('reads Orca\'s catalog from ORCA_USER_DATA_PATH, as Orca\'s own settings are', () => {
    expect(orcaCatalogPath({ ...env, ORCA_USER_DATA_PATH: '/custom/orca' })).toBe(join('/custom/orca', 'agent-model-catalog.json'));
  });

  it.skipIf(process.platform === 'win32')('finds Orca\'s catalog in its default folder when XDG_CONFIG_HOME is empty', () => {
    const expected = process.platform === 'darwin'
      ? join('/fake/home', 'Library', 'Application Support', 'orca', 'agent-model-catalog.json')
      : join('/fake/home', '.config', 'orca', 'agent-model-catalog.json');
    expect(orcaCatalogPath({ ...env, XDG_CONFIG_HOME: '' })).toBe(expected);
  });

  it.runIf(process.platform === 'win32')('finds Orca\'s catalog under the profile when APPDATA is missing', () => {
    expect(orcaCatalogPath({ USERPROFILE: '/fake/profile' })).toBe(join('/fake/profile', 'AppData', 'Roaming', 'orca', 'agent-model-catalog.json'));
  });
});

describe('normalizeCursorId', () => {
  it('strips fast, thinking, effort and the cursor- prefix', () => {
    expect(normalizeCursorId('claude-opus-5-thinking-high-fast')).toEqual({
      base: 'claude-opus-5',
      effort: 'high',
      fast: true,
      thinking: true,
    });
    expect(normalizeCursorId('claude-4.6-sonnet-medium-thinking')).toMatchObject({ base: 'claude-sonnet-4-6', effort: 'medium' });
    expect(normalizeCursorId('claude-4.5-opus-high-thinking')).toMatchObject({ base: 'claude-opus-4-5', effort: 'high', thinking: true });
    expect(normalizeCursorId('claude-4-sonnet')).toMatchObject({ base: 'claude-sonnet-4' });
    expect(normalizeCursorId('claude-opus-5-5-high')).toMatchObject({ base: 'claude-opus-5-5' });
    expect(normalizeCursorId('gpt-5.5-extra-high')).toMatchObject({ base: 'gpt-5.5', effort: 'xhigh' });
    expect(normalizeCursorId('cursor-grok-4.5-high')).toMatchObject({ base: 'grok-4.5', effort: 'high' });
    expect(normalizeCursorId('composer-2.5')).toEqual({ base: 'composer-2.5', fast: false, thinking: false });
  });
});

describe('discoverCursor', () => {
  it('stores only observations and applies current metadata to cached variants', async () => {
    const d = deps({ run: fakeRun('gpt-6.1-sol-high - Example NO ZDR\n') });
    await discoverCursor(d);
    const saved = JSON.parse(readFileSync(join(d.cacheDir, 'cursor-models.json'), 'utf8'));
    expect(saved.models).toEqual([{ id: 'gpt-6.1-sol-high', label: 'Example NO ZDR' }]);
    const updated = { ...index['gpt-6-1-sol'], family: 'updated-family' };
    const result = await discoverCursor({ ...d, run: failRun, index: { 'gpt-6.1-sol': updated } });
    expect(result.models[0]).toMatchObject({
      modelId: 'gpt-6.1-sol', meta: { family: 'updated-family' }, efforts: ['high'], noZdr: true,
      launch: { kind: 'variant', ids: { high: 'gpt-6.1-sol-high' } },
    });
  });

  it('matches dotted variants to normalized snapshot metadata', async () => {
    const snapshotIndex = toModelIndex(parseSnapshot(fixture('evidence-mini.json'))!);
    const result = await discoverCursor(deps({ index: snapshotIndex, run: fakeRun('gpt-6.1-sol-high - GPT-6.1 Sol High\n') }));
    expect(result.models[0].meta).toBe(snapshotIndex['gpt-6-1-sol']);
  });

  it('bills any Grok model to Cursor Models', async () => {
    const result = await discoverCursor(deps({ run: fakeRun('grok-4.7-high - Grok 4.7 High\nclaude-opus-5-5-high - Claude Opus 5.5 High\n') }));
    expect(result.models.find((m) => m.modelId === 'grok-4.7')!.poolNames).toEqual(['monthly', 'bucket:Cursor Models']);
    expect(result.models.find((m) => m.modelId === 'claude-opus-5-5')!.poolNames).toEqual(['monthly', 'bucket:Other Models']);
  });

  it('groups effort variants and prefers non-fast, then thinking ids', async () => {
    const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const cur = await discoverCursor(deps({ run: fakeRun(cursorFixture, calls) }));
    expect(cur).toMatchObject({ agent: 'cursor', installed: true });
    expect(calls).toEqual([{ cmd: '/bin/x', args: ['models'], timeoutMs: 30_000 }]);

    const fable = cur.models.find((m) => m.modelId === 'claude-fable-5-1')!;
    expect(fable.launch).toMatchObject({
      kind: 'variant',
      ids: { xhigh: 'claude-fable-5-1-thinking-xhigh', high: 'claude-fable-5-1-thinking-high' },
    });
    expect(fable.noZdr).toBe(true);
    expect(fable.efforts).toEqual(ALL);
    expect(fable.effortSource).toBe('provider');
    expect(fable.meta).toBe(index['claude-fable-5-1']);
    expect(fable.poolNames).toEqual(['monthly', 'bucket:Other Models']);

    const opus = cur.models.find((m) => m.modelId === 'claude-opus-5-5')!;
    expect(opus.launch).toMatchObject({ ids: { high: 'claude-opus-5-5-high' } });
    expect(opus.fast).toBeFalsy();
    expect(opus.noZdr).toBeFalsy();
    expect(cur.models.find((m) => m.modelId === 'claude-opus-5')!.launch).toMatchObject({
      ids: { high: 'claude-opus-5-thinking-high', max: 'claude-opus-5-thinking-max' },
    });

    expect(cur.models.find((m) => m.modelId === 'auto')).toMatchObject({
      efforts: [],
      launch: { kind: 'variant', ids: {}, defaultId: 'auto' },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
    expect(cur.models.find((m) => m.modelId === 'composer-2.5')).toMatchObject({
      launch: { defaultId: 'composer-2.5' },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
    expect(cur.models.find((m) => m.modelId === 'grok-4.5')).toBeDefined();
    expect(cur.models.find((m) => m.modelId === 'claude-sonnet-4-6')).toBeDefined();
  });

  it('maps Cursor-trained (cursor-*), composer and auto models to the Cursor Models bucket', async () => {
    const cur = await discoverCursor(deps({ run: fakeRun(cursorFixture) }));
    const bucket = (id: string) => cur.models.find((m) => m.modelId === id)!.poolNames[1];
    expect(bucket('grok-4.6')).toBe('bucket:Cursor Models');
    expect(bucket('grok-4.5')).toBe('bucket:Cursor Models');
    expect(bucket('composer-2.5')).toBe('bucket:Cursor Models');
    expect(bucket('auto')).toBe('bucket:Cursor Models');
    expect(bucket('grok-4.7')).toBe('bucket:Cursor Models');
    expect(bucket('claude-opus-5-5')).toBe('bucket:Other Models');
  });

  it('keeps colliding bases in one group that remembers the cursor- prefix', async () => {
    const list = 'cursor-grok-4.6-high - Grok 4.6\ngrok-4.6-low - Grok 4.6 Low\n';
    const cur = await discoverCursor(deps({ run: fakeRun(list) }));
    expect(cur.models).toHaveLength(1);
    expect(cur.models[0]).toMatchObject({
      modelId: 'grok-4.6',
      launch: { ids: { high: 'cursor-grok-4.6-high', low: 'grok-4.6-low' } },
      poolNames: ['monthly', 'bucket:Cursor Models'],
    });
  });

  it('registers an unsuffixed id as the medium variant when no explicit medium exists', async () => {
    const cur = await discoverCursor(deps({ run: fakeRun(cursorFixture) }));
    const codex = cur.models.find((m) => m.modelId === 'gpt-5.3-codex')!;
    expect(codex.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(codex.launch).toEqual({
      kind: 'variant',
      ids: { low: 'gpt-5.3-codex-low', medium: 'gpt-5.3-codex', high: 'gpt-5.3-codex-high', xhigh: 'gpt-5.3-codex-xhigh' },
      defaultId: 'gpt-5.3-codex',
    });
    expect(cur.models.find((m) => m.modelId === 'gpt-5.6-luna')!.launch).toMatchObject({ ids: { medium: 'gpt-5.6-luna-medium' } });
  });

  it('drops effort levels that only exist as a fast variant', async () => {
    const list = cursorFixture.split(/\r?\n/).filter((l) => !l.startsWith('gpt-5.6-luna-high ')).join('\n');
    const cur = await discoverCursor(deps({ run: fakeRun(list) }));
    const luna = cur.models.find((m) => m.modelId === 'gpt-5.6-luna')!;
    expect(luna.efforts).toEqual(['none', 'low', 'medium', 'xhigh', 'max']);
    expect(luna.launch).toMatchObject({ ids: { medium: 'gpt-5.6-luna-medium', xhigh: 'gpt-5.6-luna-xhigh' } });
    expect(Object.values(luna.launch.kind === 'variant' ? luna.launch.ids : {})).not.toContain('gpt-5.6-luna-high-fast');
    expect(luna.fast).toBeFalsy();

    const full = await discoverCursor(deps({ run: fakeRun(cursorFixture) }));
    expect(full.models.find((m) => m.modelId === 'gpt-5.6-luna')!.launch).toMatchObject({ ids: { high: 'gpt-5.6-luna-high' } });

    const fastOnly = await discoverCursor(deps({ run: fakeRun('turbo-high-fast - Turbo High Fast\nturbo-low-fast - Turbo Low Fast') }));
    expect(fastOnly.models).toMatchObject([
      { modelId: 'turbo', efforts: ['low', 'high'], fast: true, launch: { ids: { low: 'turbo-low-fast', high: 'turbo-high-fast' } } },
    ]);
  });

  it('reports a sign-in prompt as signed out and other failures with the reason', async () => {
    const signedOut = await discoverCursor(deps({ run: async () => ({ code: 1, stdout: '', stderr: 'Not logged in\nmore' }) }));
    expect(signedOut).toMatchObject({ installed: true, models: [], signedOut: true, note: 'not signed in: Not logged in' });
    const prompt = await discoverCursor(deps({ run: fakeRun('Please log in first') }));
    expect(prompt).toMatchObject({ models: [], signedOut: true });

    const timedOut = await discoverCursor(
      deps({ run: async () => ({ code: null, stdout: '', stderr: '', error: 'timed out after 30000 ms' }) }),
    );
    expect(timedOut).toMatchObject({ installed: true, models: [], note: 'cursor-agent models failed: timed out after 30000 ms' });
    expect(timedOut.signedOut).toBeUndefined();
    const garbage = await discoverCursor(deps({ run: fakeRun('something unexpected') }));
    expect(garbage).toMatchObject({ models: [], note: 'cursor-agent models failed: something unexpected' });
  });

  it('lists live on every call and falls back to the last good list only when the command fails', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'oc-cursor-cache-'));
    const calls: { cmd: string; args: string[] }[] = [];
    await discoverCursor(deps({ cacheDir, run: fakeRun(cursorFixture, calls) }));
    await discoverCursor(deps({ cacheDir, now: NOW + 60_000, run: fakeRun('auto - Auto\n', calls) }));
    expect(calls).toHaveLength(2);
    // The newest good list is the one saved: a failure now falls back to `auto` only, 5 days later.
    const fallback = await discoverCursor(deps({ cacheDir, now: NOW + 5 * 86_400_000, run: failRun }));
    expect(fallback.models.map((m) => m.modelId)).toEqual(['auto']);
    expect(fallback.note).toBe('cursor-agent models failed (should not run); using the list from 4d ago');
    // A sign-in prompt never falls back.
    const signedOut = await discoverCursor(deps({ cacheDir, run: fakeRun('Not logged in') }));
    expect(signedOut).toMatchObject({ models: [], signedOut: true });
  });

  it('does not run when cursor-agent is missing', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const cur = await discoverCursor(deps({ find: () => undefined, run: fakeRun(cursorFixture, calls) }));
    expect(cur).toMatchObject({ installed: false, models: [] });
    expect(calls).toEqual([]);
  });
});

describe('discoverCodex', () => {
  it('reads the Codex models cache, skipping hidden models and ultra', async () => {
    const reads: string[] = [];
    const cx = await discoverCodex(deps({ readFile: fixtureFiles({ codexCache }, reads) }));
    expect(reads[0]).toBe(join('/fake/codex', 'models_cache.json'));
    expect(cx).toMatchObject({ agent: 'codex', installed: true });
    expect(cx.models.map((m) => m.modelId)).toContain('gpt-6-astra');
    expect(cx.models.map((m) => m.modelId)).not.toContain('gpt-reserve');
    const astra = cx.models.find((m) => m.modelId === 'gpt-6-astra')!;
    expect(astra.efforts).not.toContain('ultra' as never);
    expect(astra).toMatchObject({
      efforts: ALL,
      launch: { kind: 'flag', model: 'gpt-6-astra' },
      poolNames: ['session', 'weekly'],
      meta: index['gpt-6-astra'],
    });
    expect(cx.models.find((m) => m.modelId === 'gpt-6.1-terra')!.meta).toBe(index['gpt-6-1-terra']);
    expect(cx.note).toMatch(/models_cache\.json/);
    // The provider's own words about each model's place in the lineup travel with it.
    expect(astra.lineup).toBe('Frontier intelligence for the most demanding work.');
    expect(cx.models.find((m) => m.modelId === 'gpt-6.1-terra')).not.toHaveProperty('lineup');
    // Codex's own cache names the supported levels and the default it uses when no effort is passed.
    expect(astra.effortSource).toBe('provider');
    expect(astra.defaultEffort).toBeDefined();
  });

  it('falls back to Orca agent-model-catalog.json', async () => {
    const cx2 = await discoverCodex(deps({ readFile: fixtureFiles({ orcaCatalog, codexCache: '{not json' }) }));
    expect(cx2.models.length).toBeGreaterThan(0);
    expect(cx2.note).toMatch(/agent-model-catalog/);
    expect(cx2.models.find((m) => m.modelId === 'gpt-6.1-sol')!.efforts).toEqual(ALL);
  });

  it('falls back to the Codex ladder families in the evidence catalog, skipping moving aliases', async () => {
    const alias = { id: 'gpt-daybreak-blue-latest', provider: 'openai', name: 'Daybreak', family: 'gpt-sol', releaseDate: '2026-10-20' };
    const image = { id: 'gpt-image-2', provider: 'openai', name: 'Image', family: 'gpt-image', releaseDate: '2026-10-20' };
    const cx = await discoverCodex(deps({ readFile: fixtureFiles({}), index: { ...index, [alias.id]: alias, [image.id]: image } }));
    expect(cx.models.map((m) => m.modelId).sort()).toEqual(['gpt-5.6-sol', 'gpt-6-1-sol', 'gpt-6-1-terra', 'gpt-6-astra', 'gpt-6-luna']);
    const sol = cx.models.find((m) => m.modelId === 'gpt-6-1-sol')!;
    expect(sol).toMatchObject({ meta: index['gpt-6-1-sol'], efforts: ALL, effortSource: 'assumed', launch: { kind: 'flag', model: 'gpt-6-1-sol' }, poolNames: ['session', 'weekly'] });
    expect(sol).not.toHaveProperty('lineup');
    expect(cx.note).toBe('models from the evidence catalog (Codex has not cached its model list yet)');
    expect((await discoverCodex(deps({ find: () => undefined, readFile: fixtureFiles({ codexCache }) }))).installed).toBe(false);
  });

  it('matches a provider id to normalized snapshot metadata', async () => {
    const snapshotIndex = toModelIndex(parseSnapshot(fixture('evidence-mini.json'))!);
    const result = await discoverCodex(deps({ index: snapshotIndex, readFile: fixtureFiles({ codexCache }) }));
    expect(result.models.find((m) => m.modelId === 'gpt-6.1-sol')!.meta).toBe(snapshotIndex['gpt-6-1-sol']);
  });

  it('reports when no model list exists anywhere', async () => {
    const cx = await discoverCodex(deps({ readFile: fixtureFiles({}), index: {} }));
    expect(cx).toMatchObject({ installed: true, models: [], note: 'no Codex model list found' });
  });
});

describe('discoverClaude', () => {
  it('lists Anthropic Claude models from the index', async () => {
    const cl = await discoverClaude(deps({}));
    expect(cl).toMatchObject({ agent: 'claude', installed: true });
    expect(cl.models.map((m) => m.modelId).sort()).toEqual(
      ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5'],
    );
    expect(cl.models.find((m) => m.modelId === 'claude-fable-5-1')!.poolNames).toEqual(['session', 'weekly', 'fableWeekly']);
    expect(cl.models.find((m) => m.modelId === 'claude-opus-5-5')).toMatchObject({
      launch: { kind: 'flag', model: 'claude-opus-5-5' },
      poolNames: ['session', 'weekly'],
      efforts: ALL,
      effortSource: 'assumed',
    });
    // Without a local effort list, the fallback is assumed.
    expect(cl.models.find((m) => m.modelId === 'claude-fable-5')).toMatchObject({ efforts: ALL, effortSource: 'assumed' });
    expect(cl.models.find((m) => m.modelId === 'claude-fable-5')!.efforts).toEqual(ALL);
  });

  it('reports a missing claude CLI', async () => {
    expect((await discoverClaude(deps({ find: () => undefined }))).installed).toBe(false);
  });

  const catalogDir = join('/fake/claude', 'cache', 'model-catalog');
  const claudeCache = (fetchedAt: number, models: unknown[]) => JSON.stringify({ version: 2, fetchedAt, catalog: { config: { models } } });
  const effortOptions = (...ids: string[]) => ({ type: 'effort', effort_options: ids.map((id) => ({ id })) });
  const files = (map: Record<string, string>) => (p: string) => map[p];

  it('prefers the account list in the newest Claude Code catalog', async () => {
    const cl = await discoverClaude(deps({
      env: { CLAUDE_CONFIG_DIR: '/fake/claude', APPDATA: '/fake/appdata', HOME: '/fake/home' },
      listDir: (p) => (p === catalogDir ? ['old-cc.json', 'new-cc.json', 'published-1.json'] : []),
      readFile: files({
        [join(catalogDir, 'old-cc.json')]: claudeCache(1, [{ id: 'claude-opus-4-6', thinking: effortOptions('low') }]),
        [join(catalogDir, 'new-cc.json')]: claudeCache(2, [
          { id: 'claude-opus-5-5', thinking: effortOptions('low', 'xhigh'), section: 'main', description: 'For complex work and everyday tasks' },
          { id: 'claude-fable-5-1', thinking: effortOptions('high'), description: '' },
          { id: 'claude-haiku-4-5-20251001', thinking: { type: 'none' }, section: 'overflow' },
        ]),
      }),
    }));
    expect(cl.models.map((m) => m.modelId)).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
    expect(cl.models[0]).toMatchObject({ efforts: ['low', 'xhigh'], effortSource: 'provider', launch: { kind: 'flag', model: 'claude-opus-5-5' }, poolNames: ['session', 'weekly'] });
    expect(cl.models[0].lineup).toBe('For complex work and everyday tasks');
    expect(cl.models[1]).not.toHaveProperty('lineup');
    expect(cl.models[2]).not.toHaveProperty('lineup');
    expect(cl.models[1].poolNames).toEqual(['session', 'weekly', 'fableWeekly']);
    expect(cl.models[2].efforts).toEqual([]);
    expect(cl.note).toBe(`models from ${join(catalogDir, 'new-cc.json')}`);
  });

  it('falls back to the last Claude entry in the Orca catalog, resolving aliases', async () => {
    const entry = (models: unknown[]) => ({ agent: 'claude', discovered: { models } });
    const catalog = JSON.stringify({ entries: [
      entry([{ id: 'claude-opus-4-6', efforts: [] }]),
      { agent: 'codex', discovered: { models: [{ id: 'gpt-6.1-terra', efforts: [] }] } },
      entry([
        { id: 'opus', resolvedModel: 'claude-opus-5-5', efforts: [{ value: 'high' }] },
        { id: 'claude-sonnet-5', efforts: [{ value: 'low' }] },
        { id: 'default', efforts: [] },
      ]),
    ] });
    const cl = await discoverClaude(deps({ readFile: (p) => (p.endsWith('agent-model-catalog.json') ? catalog : undefined) }));
    expect(cl.models.map((m) => m.modelId)).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
    expect(cl.models[0]).toMatchObject({ efforts: ['high'], effortSource: 'orca' });
    expect(cl.note).toContain('agent-model-catalog.json');
  });
});

describe('parseGrokModels', () => {
  it('reads bulleted ids under the header, stopping at the next blank line', () => {
    expect(parseGrokModels(grokFixture)).toEqual(['grok-4.7']);
    expect(parseGrokModels(grokMany)).toEqual(['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-build']);
  });

  it('needs the header, so a preamble default is never listed', () => {
    expect(parseGrokModels('Default model: grok-4.6\n  * grok-4.6 (default)\n')).toEqual([]);
    expect(parseGrokModels('Available models:\n\n  * grok-4.6\n  * grok-4.6 (default)\n')).toEqual(['grok-4.6']);
  });
});

describe('discoverGrok', () => {
  const grokCache = JSON.stringify({
    fetched_at: '2026-11-01T12:38:14Z',
    models: {
      'grok-4.7': {
        info: {
          id: 'grok-4.7', hidden: false, supports_reasoning_effort: true, reasoning_effort: 'high',
          reasoning_efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
        },
      },
      'grok-secret': { info: { id: 'grok-secret', hidden: true } },
      'grok-build': { info: { id: 'grok-build', supports_reasoning_effort: false } },
      'grok-4.7-multi-agent': { info: { id: 'grok-4.7-multi-agent', reasoning_efforts: [{ value: 'low' }, { value: 'high' }] } },
    },
  });

  it('reads grok\'s own model cache: ids, efforts and the default, without hidden models', () => {
    expect(parseGrokCache(grokCache)).toEqual([
      { id: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'grok-build', efforts: [] },
      // Effort there means agent count, so it is never set.
      { id: 'grok-4.7-multi-agent', efforts: [] },
    ]);
    expect(parseGrokCache('not json')).toEqual([]);
    expect(parseGrokCache(undefined)).toEqual([]);
  });

  it('prefers ~/.grok/models_cache.json (or $GROK_HOME) over running grok models', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const reads: string[] = [];
    const readFile = (p: string) => (reads.push(p), p.endsWith('models_cache.json') ? grokCache : undefined);
    const grok = await discoverGrok(deps({ run: fakeRun(grokMany, calls), readFile, env: { HOME: '/fake/home' } }));
    expect(calls).toEqual([]);
    expect(reads).toContain(join('/fake/home', '.grok', 'models_cache.json'));
    expect(grok.note).toBe(`models from ${join('/fake/home', '.grok', 'models_cache.json')}`);
    expect(grok.models.find((m) => m.modelId === 'grok-4.7')).toEqual({
      agent: 'grok',
      modelId: 'grok-4.7',
      meta: index['grok-4.7'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      effortSource: 'provider',
      defaultEffort: 'high',
      launch: { kind: 'flag', model: 'grok-4.7' },
      poolNames: ['weekly', 'monthly'],
    });
    await discoverGrok(deps({ readFile, env: { HOME: '/fake/home', GROK_HOME: '/fake/grok' } }));
    expect(reads).toContain(join('/fake/grok', 'models_cache.json'));
  });

  it('falls back to `grok models` as flag launches with Orca\'s effort ceilings', async () => {
    const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const grok = await discoverGrok(deps({ run: fakeRun(grokMany, calls) }));
    expect(calls).toEqual([{ cmd: '/bin/x', args: ['models'], timeoutMs: 30_000 }]);
    expect(grok).toMatchObject({ agent: 'grok', installed: true });
    expect(grok.models.find((m) => m.modelId === 'grok-4.7')).toEqual({
      agent: 'grok',
      modelId: 'grok-4.7',
      meta: index['grok-4.7'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      effortSource: 'orca',
      launch: { kind: 'flag', model: 'grok-4.7' },
      poolNames: ['weekly', 'monthly'],
    });
    expect(grok.models.find((m) => m.modelId === 'grok-4.5')!.efforts).toEqual(['low', 'medium', 'high']);
    const build = grok.models.find((m) => m.modelId === 'grok-build')!;
    expect(build.meta).toBeUndefined();
    expect(build.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('looks in $GROK_HOME/bin and ~/.grok/bin as well as on PATH', async () => {
    const extras: string[][] = [];
    const find: AgentDeps['find'] = (_name, extra = []) => (extras.push(extra), undefined);
    await discoverGrok(deps({ find }));
    await discoverGrok(deps({ find, env: { HOME: '/fake/home', GROK_HOME: '/fake/grok' } }));
    expect(extras).toEqual([[join('/fake/home', '.grok', 'bin')], [join('/fake/grok', 'bin'), join('/fake/home', '.grok', 'bin')]]);
  });

  it('returns no models with the reason when the listing fails or has no header', async () => {
    const broken = await discoverGrok(deps({ run: async () => ({ code: 1, stdout: '', stderr: 'Not signed in to Grok\nmore' }) }));
    expect(broken).toMatchObject({ installed: true, models: [], signedOut: true, note: 'not signed in: Not signed in to Grok' });
    const loggedOut = await discoverGrok(deps({ run: fakeRun('Please run grok login\n') }));
    expect(loggedOut).toMatchObject({ installed: true, models: [], signedOut: true, note: 'not signed in: Please run grok login' });
    const odd = await discoverGrok(deps({ run: fakeRun('No models here\n') }));
    expect(odd).toMatchObject({ installed: true, models: [], note: 'grok models failed: No models here' });
  });

  it('falls back to the last good `grok models` list when the command fails', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'oc-grok-cache-'));
    await discoverGrok(deps({ cacheDir, run: fakeRun(grokMany) }));
    const fallback = await discoverGrok(deps({ cacheDir, now: NOW + 25 * 3_600_000, run: failRun }));
    expect(fallback.models).toHaveLength(4);
    expect(fallback.note).toBe('grok models failed (should not run); using the list from 25h ago');
  });

  it('does not run when grok is missing', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const grok = await discoverGrok(deps({ find: () => undefined, run: fakeRun(grokFixture, calls) }));
    expect(grok).toMatchObject({ installed: false, models: [] });
    expect(calls).toEqual([]);
  });
});

describe('parseAgyModels', () => {
  it('reads id<TAB>label rows, skipping the progress line', () => {
    expect(parseAgyModels(agyFixture)).toEqual([
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ]);
  });

  it('skips an id/label header and repeats', () => {
    expect(parseAgyModels('id\tLabel\r\nturbo-low\tTurbo (Low)\r\nturbo-low\tTurbo (Low)\r\n')).toEqual(['turbo-low']);
  });

  it('ignores the display-name-only output of older agy versions', () => {
    expect(parseAgyModels('Gemini 3.5 Flash (Medium)\r\nClaude Opus 4.6 (Thinking)\r\n')).toEqual([]);
  });
});

describe('discoverAntigravity', () => {
  const gemini = ['bucket:Gemini Models 5h', 'bucket:Gemini Models', 'session', 'weekly'];
  const claudeGpt = ['bucket:Claude and GPT models 5h', 'bucket:Claude and GPT models', 'session', 'weekly'];

  it('keeps model discovery from forking the agy auto-updater', async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const run: Runner = async (_cmd, _args, opts) => {
      envs.push(opts?.env);
      return { code: 0, stdout: agyFixture, stderr: '' };
    };
    await discoverAntigravity(deps({ run }));
    expect(envs).toEqual([{ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }]);
  });

  it('groups effort-suffixed ids into variants and launches the rest with --effort', async () => {
    const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const agy = await discoverAntigravity(deps({ run: fakeRun(agyFixture, calls) }));
    expect(calls).toEqual([{ cmd: '/bin/x', args: ['models'], timeoutMs: 30_000 }]);
    expect(agy).toMatchObject({ agent: 'antigravity', installed: true });
    expect(agy.models.map((m) => m.modelId)).toEqual(['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-oss-120b']);

    expect(agy.models.find((m) => m.modelId === 'gemini-3.8-flash')).toEqual({
      agent: 'antigravity',
      modelId: 'gemini-3.8-flash',
      meta: index['gemini-3.8-flash'],
      efforts: ['low', 'medium', 'high'],
      effortSource: 'provider',
      launch: {
        kind: 'variant',
        ids: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' },
      },
      poolNames: gemini,
    });
    expect(agy.models.find((m) => m.modelId === 'claude-sonnet-4-6')).toMatchObject({
      meta: index['claude-sonnet-4-6'],
      efforts: ['low', 'medium', 'high'],
      effortSource: 'orca',
      launch: { kind: 'flag', model: 'claude-sonnet-4-6' },
      poolNames: claudeGpt,
    });
    expect(agy.models.find((m) => m.modelId === 'gpt-oss-120b')).toMatchObject({ poolNames: claudeGpt });
  });

  it('matches a -thinking id to its catalog model but launches the id agy listed', async () => {
    const agy = await discoverAntigravity(deps({ run: fakeRun(agyFixture) }));
    expect(agy.models.find((m) => m.modelId === 'claude-opus-4-6')).toMatchObject({
      meta: index['claude-opus-4-6'],
      launch: { kind: 'flag', model: 'claude-opus-4-6-thinking' },
    });
    const unknown = await discoverAntigravity(deps({ run: fakeRun('mystery-thinking\tMystery\n') }));
    expect(unknown.models).toMatchObject([{ modelId: 'mystery-thinking', launch: { kind: 'flag', model: 'mystery-thinking' } }]);
    expect(unknown.models[0].meta).toBeUndefined();
  });

  it('uses an unsuffixed sibling as the default and missing medium variant', async () => {
    const agy = await discoverAntigravity(deps({ run: fakeRun('turbo\tTurbo\nturbo-high\tTurbo (High)\n') }));
    expect(agy.models).toMatchObject([
      { modelId: 'turbo', efforts: ['medium', 'high'], launch: { kind: 'variant', ids: { medium: 'turbo', high: 'turbo-high' }, defaultId: 'turbo' } },
    ]);
    const pro = await discoverAntigravity(deps({ run: fakeRun('gemini-3.1-pro-low\tLow\ngemini-3.1-pro-high\tHigh\n') }));
    expect(pro.models).toMatchObject([{ modelId: 'gemini-3.1-pro', efforts: ['low', 'high'], poolNames: gemini }]);
  });

  it('returns no models with the reason when agy lists no launch ids', async () => {
    const old = await discoverAntigravity(deps({ run: fakeRun('Gemini 3.5 Flash (Medium)\n') }));
    expect(old).toMatchObject({ installed: true, models: [], note: 'agy models gave no model ids: Gemini 3.5 Flash (Medium)' });
    const broken = await discoverAntigravity(deps({ run: async () => ({ code: null, stdout: '', stderr: '', error: 'timed out after 30000 ms' }) }));
    expect(broken).toMatchObject({ installed: true, models: [], note: 'agy models gave no model ids: timed out after 30000 ms' });
  });

  it('looks in the agy installer\'s locations as well as on PATH', async () => {
    const extras: string[][] = [];
    const find: AgentDeps['find'] = (_name, extra = []) => (extras.push(extra), undefined);
    await discoverAntigravity(deps({ find, env: { HOME: '/fake/home', LOCALAPPDATA: '/fake/local' } }));
    await discoverAntigravity(deps({ find, env: { HOME: '/fake/home' } }));
    expect(extras).toEqual([
      [join('/fake/local', 'agy', 'bin'), join('/fake/home', '.local', 'bin')],
      [join('/fake/home', 'AppData', 'Local', 'agy', 'bin'), join('/fake/home', '.local', 'bin')],
    ]);
  });

  it('does not run when agy is missing', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const agy = await discoverAntigravity(deps({ find: () => undefined, run: fakeRun(agyFixture, calls) }));
    expect(agy).toMatchObject({ agent: 'antigravity', installed: false, models: [], note: 'agy not found' });
    expect(calls).toEqual([]);
  });
});

describe('discoverMuse', () => {
  it('detects muse but offers no models, since Orca has no Muse model list', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const muse = await discoverMuse(deps({ run: fakeRun('', calls) }));
    expect(muse).toEqual({ agent: 'muse', installed: true, models: [], note: 'no model list available from Orca; not routed' });
    expect(calls).toEqual([]);
    expect(await discoverMuse(deps({ find: () => undefined }))).toMatchObject({ installed: false, models: [] });
  });
});

// Real `opencode models` lines (opencode 2.2.5, 2026-11-01), trimmed.
const opencodeList = [
  'ollama/gemma4:12b',
  'opencode/big-pickle',
  'opencode/deepseek-v4.1-flash-free',
  'openrouter/~anthropic/claude-opus-latest',
  'openrouter/anthropic/claude-opus-5.5',
  'openrouter/anthropic/claude-sonnet-5.5',
  'openrouter/openai/gpt-6.1-sol',
  'openrouter/cohere/north-mini-code:free',
  'openrouter/deepseek/deepseek-v4-pro',
  'openrouter/anthropic/claude-sonnet-5.5',
  '',
].join('\n');

describe('discoverOpencode', () => {
  it('reads opencode models live, skips moving aliases and maps ids to the evidence catalog', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const found: { name: string; extra: string[] }[] = [];
    const d = await discoverOpencode(deps({
      run: fakeRun(opencodeList, calls),
      find: (name, extra = []) => {
        found.push({ name, extra });
        return '/home/u/.opencode/bin/opencode';
      },
    }));
    expect(found).toEqual([{ name: 'opencode', extra: [join('/fake/home', '.opencode', 'bin')] }]);
    expect(calls).toEqual([{ cmd: '/home/u/.opencode/bin/opencode', args: ['models'], timeoutMs: 30_000 }]);
    expect(d.installed).toBe(true);
    expect(d.models.map((m) => [m.modelId, m.launch.kind === 'flag' ? m.launch.model : '', m.billing])).toEqual([
      ['gemma4:12b', 'ollama/gemma4:12b', 'runs on this machine (ollama)'],
      ['big-pickle', 'opencode/big-pickle', 'pay per use through opencode'],
      ['deepseek-v4.1-flash', 'opencode/deepseek-v4.1-flash-free', 'free model through opencode'],
      ['claude-opus-5-5', 'openrouter/anthropic/claude-opus-5.5', 'pay per use through openrouter'],
      ['claude-sonnet-5-5', 'openrouter/anthropic/claude-sonnet-5.5', 'pay per use through openrouter'],
      ['gpt-6-1-sol', 'openrouter/openai/gpt-6.1-sol', 'pay per use through openrouter'],
      ['cohere/north-mini-code', 'openrouter/cohere/north-mini-code:free', 'free model through openrouter'],
      ['deepseek/deepseek-v4-pro', 'openrouter/deepseek/deepseek-v4-pro', 'pay per use through openrouter'],
    ]);
    const opus = d.models.find((m) => m.modelId === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ agent: 'opencode', meta: { family: 'claude-opus' }, efforts: [], effortSource: 'orca', poolNames: [] });
  });

  it('lists each id once and keeps one entry per model, from the cheapest way to run it', () => {
    expect(parseOpencodeModels('openrouter/a/x\nopenrouter/a/x\nopenrouter/~a/x-latest\nnot a model\n')).toEqual(['openrouter/a/x']);
    const twice = toOpencodeModels(['openrouter/anthropic/claude-opus-5.5', 'ollama/claude-opus-5-5'], { index });
    expect(twice.map((m) => [m.modelId, m.launch.kind === 'flag' && m.launch.model])).toEqual([['claude-opus-5-5', 'ollama/claude-opus-5-5']]);
  });

  it('reports a missing or failing opencode', async () => {
    expect(await discoverOpencode(deps({ find: () => undefined }))).toEqual({ agent: 'opencode', installed: false, models: [], note: 'opencode not found' });
    const failing: Runner = async () => ({ code: 1, stdout: '', stderr: 'connection refused' });
    expect(await discoverOpencode(deps({ run: failing }))).toMatchObject({ installed: true, models: [], note: 'opencode models failed: connection refused' });
  });
});
