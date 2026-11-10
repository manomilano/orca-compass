import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTextFile } from '../src/placements/agents/deps.js';
import { fakeDeps, fixture, NOW, orcaDownRunner, runner } from './helpers/fakes.js';
import { createHash } from 'node:crypto';
import { EVIDENCE_MANIFEST_URL } from '../src/evidence/source.js';
import type { Runner } from '../src/system/run.js';
import { main, type MainDeps } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { configPath } from '../src/paths.js';

const deps: MainDeps = fakeDeps;

let stdout: string[];
let stderr: string[];
const io = { out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) };
const out = () => stdout.join('\n');
const err = () => stderr.join('\n');
const savedHome = process.env.ORCACOMPASS_HOME;

beforeEach(() => {
  process.env.ORCACOMPASS_HOME = mkdtempSync(join(tmpdir(), 'oc-cli-'));
  // homedir() follows these variables, so this synthetic cache fails any test that reaches past the fake machine.
  const ambientHome = mkdtempSync(join(tmpdir(), 'oc-ambient-home-'));
  mkdirSync(join(ambientHome, '.grok'));
  writeFileSync(join(ambientHome, '.grok', 'models_cache.json'), JSON.stringify({ models: { 'grok-4.7': { info: { id: 'grok-4.7' } } } }));
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

describe('metadata output', () => {
  it.each(['status', 'refresh', 'tiers', 'ranking', 'route'])('%s omits the retired data providers from text and JSON', async (command) => {
    const args = command === 'route' ? [command, '--tier', 'daily'] : [command];
    expect(await main(args, io, deps)).toBe(0);
    expect(out()).not.toMatch(/models\.dev|model index/i);
    stdout = [];
    expect(await main([...args, '--json'], io, deps)).toBe(0);
    expect(out()).not.toMatch(/models\.dev|model index/i);
  });
});

describe('route', () => {
  it('caps need skips by model in text while retaining every JSON skip and other diagnostics', async () => {
    writeFileSync(configPath(), JSON.stringify({ banModels: ['gpt-6.1-terra'] }));
    expect(await main(['route', '--tier', 'frontier', '--json'], io, deps)).toBe(0);
    const decision = JSON.parse(out());
    const needSkips = decision.skipped.filter((s: { reason: string }) => /^(below need on |unranked:)/.test(s.reason));
    const models = new Set(needSkips.map((s: { agent: string; model: string }) => `${s.agent} ${s.model}`));
    expect(models.size).toBeGreaterThan(6);
    expect(needSkips.filter((s: { agent: string; model: string }) => s.agent === 'claude' && s.model === 'claude-haiku-5-5')).toHaveLength(3);
    stdout = [];
    expect(await main(['route', '--tier', 'frontier'], io, deps)).toBe(0);
    const line = out().split('\n').find((s) => s.trimStart().startsWith('skipped:'))!;
    expect(line).toBeDefined();
    expect(line.match(/\((?:below need on |unranked:)/g)).toHaveLength(6);
    expect(line).toContain(`… ${models.size - 6} more (route --json lists them)`);
    expect(line).toContain('claude claude-haiku-5-5 (below need on coding 64.2 < 84, agentic 50.7 < 80, reasoning 69.7 < 88)');
    for (const skip of decision.skipped.filter((s: { reason: string }) => !/^(below need on |unranked:)/.test(s.reason))) {
      expect(line).toContain(`${skip.agent}${skip.model ? ` ${skip.model}` : ''} (${skip.reason})`);
    }
    expect(line).toContain('banned by you');
  });
  it.each([
    'coding=high,agentic=mid', 'coding=high,agentic=mid,reasoning=low,coding=min',
    'coding=huge,agentic=mid,reasoning=low', 'coding = high, agentic=mid,reasoning=low',
    'CODING=high,agentic=mid,reasoning=low', 'coding=High,agentic=mid,reasoning=LOW',
  ])('rejects malformed --need %s with usage', async (need) => {
    expect(await main(['route', '--need', need], io, deps)).toBe(1);
    expect(err()).toMatch(/must name all three axes/);
    expect(err()).toContain('usage: orcacompass');
    expect(stdout).toEqual([]);
  });

  it('accepts reordered needs and preserves quality, sources and hand-outs', async () => {
    expect(await main(['route', '--need', 'reasoning=low,coding=high,agentic=mid', '--json'], io, deps)).toBe(0);
    const d = JSON.parse(out());
    expect(d).toMatchObject({ needs: { coding: 'high', agentic: 'mid', reasoning: 'low' }, needsSource: 'need', evidenceSource: 'snapshot', scoreSource: 'snapshot', catalogSource: 'snapshot', placementsBuiltAt: NOW });
    for (const quality of [d.quality, ...d.alternatives.map((a: { quality: unknown }) => a.quality)]) {
      expect(quality.axes.coding).toMatchObject({ score: expect.any(Number), band: expect.any(String), evidence: expect.any(String), benchmarks: expect.any(Number), need: 'high', cut: 84 });
    }
    const entries = JSON.parse(readFileSync(join(process.env.ORCACOMPASS_HOME!, 'cache', 'handouts.json'), 'utf8')).handouts;
    expect(entries).toHaveLength(1);
    expect(entries[0].needs).toEqual(d.needs);
  });

  it('requires exactly one of need and tier', async () => {
    expect(await main(['route'], io, deps)).toBe(1);
    expect(err()).toContain('--need is required (or --tier as a shorthand)');
    stderr = [];
    expect(await main(['route', '--tier', 'daily', '--need', 'coding=low,agentic=low,reasoning=low'], io, deps)).toBe(1);
    expect(err()).toContain('use either --need or --tier, not both');
  });

  it('warns once for each removed config key during routing', async () => {
    writeFileSync(configPath(), JSON.stringify({ scoreWeight: 0.5, modelsDevTtlHours: 12 }));
    expect(await main(['route', '--tier', 'light', '--json'], io, deps)).toBe(0);
    expect(stderr.filter((s) => s.startsWith('warning: scoreWeight is no longer used'))).toHaveLength(1);
    expect(stderr.filter((s) => s.startsWith('warning: modelsDevTtlHours is no longer used'))).toHaveLength(1);
  });
  it.each([
    { agent: 'cursor', exe: 'cursor-agent', listing: 'gpt-6.1-sol-high - Example\n', model: 'gpt-6.1-sol-high', base: 'gpt-6.1-sol', effort: undefined },
    { agent: 'antigravity', exe: 'agy', listing: 'gemini-3.8-flash-high\tExample\n', model: 'gemini-3.8-flash-high', base: 'gemini-3.8-flash', effort: undefined },
    { agent: 'grok', exe: 'grok', listing: 'Available models:\n  * grok-4.7\n', model: 'grok-4.7', base: 'grok-4.7', effort: 'high' },
    { agent: 'opencode', exe: 'opencode', listing: 'openai/gpt-6.1-sol\n', model: 'openai/gpt-6.1-sol', base: 'gpt-6.1-sol', effort: undefined },
  ])('passes $agent command output through JSON cache, status and launch arguments', async ({ agent, exe, listing, model, base, effort }) => {
    writeFileSync(configPath(), JSON.stringify({ allowAgents: [agent], tierOverrides: { [base]: 'daily' }, cursorAuto: false }));
    const calls: string[][] = [];
    let offline = false;
    const testDeps: MainDeps = {
      ...deps, readFile: readTextFile, find: (name) => name === exe ? `/fake/bin/${exe}` : undefined,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return args[0] === 'models' && !offline
          ? { code: 0, stdout: listing, stderr: '' }
          : { code: 1, stdout: '', stderr: 'offline' };
      },
    };
    const args = ['route', '--tier', 'daily', '--agent', agent, ...(agent === 'opencode' ? [] : ['--effort', 'high']), '--json'];
    expect(await main(args, io, testDeps)).toBe(0);
    const live = JSON.parse(out());
    expect(live.route, JSON.stringify(live)).toEqual({ agent, model, effort: effort ?? null });
    expect(live.launch).toBe(`orca orchestration worker-start --spec "<task>" --agent ${agent} --model ${model}${effort ? ` --effort ${effort}` : ''}`);
    expect(calls).toContainEqual([`/fake/bin/${exe}`, 'models']);
    const saved = JSON.parse(readFileSync(join(process.env.ORCACOMPASS_HOME!, 'cache', `${agent}-models.json`), 'utf8'));
    expect(saved).toMatchObject({ schemaVersion: 1, agent, fetchedAt: NOW, models: [{ id: model }] });
    offline = true;
    stdout = [];
    expect(await main(args, io, testDeps)).toBe(0);
    expect(JSON.parse(out()).route).toEqual(live.route);
    expect(JSON.parse(out()).launch).toBe(live.launch);
    stdout = [];
    expect(await main(['status', '--json'], io, testDeps)).toBe(0);
    // The listing command did not run again: the fresh placement table carries the model.
    expect(calls.filter((c) => c[1] === 'models')).toHaveLength(1);
    expect(JSON.parse(out()).agents.find((a: { agent: string }) => a.agent === agent)).toMatchObject({ models: 1 });
  });

  it('returns the coordinator tier reason in JSON and text without changing selection', async () => {
    const reason = 'Local endpoint change with clear acceptance tests.';
    const args = ['route', '--tier', 'daily', '--tier-reason', reason];
    expect(await main([...args, '--json'], io, deps)).toBe(0);
    const explained = JSON.parse(out());
    expect(explained.tierReason).toBe(reason);
    expect(explained.reasons).toContain(`task tier daily: ${reason}`);
    stdout = [];
    expect(await main(['route', '--tier', 'daily', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(out()).route).toEqual(explained.route);
    stdout = [];
    expect(await main(args, io, deps)).toBe(0);
    expect(out()).toContain(reason);
    expect(await main(['route', '--tier', 'daily', '--tier-reason', '  '], io, deps)).toBe(1);
  });
  it('prints one JSON document with the decision, launch command and catalog source', async () => {
    const code = await main(['route', '--tier', 'frontier', '--json'], io, deps);
    expect(code).toBe(0);
    const d = JSON.parse(out());
    expect(d).toMatchObject({
      status: 'ok',
      route: { agent: 'claude', model: 'claude-opus-5-5' },
      catalogSource: 'snapshot',
      scoreSource: 'snapshot',
    });
    expect(d.launch).toBe('orca orchestration worker-start --spec "<task>" --agent claude --model claude-opus-5-5 --effort high');
    expect(d.skipped.some((x: { agent: string }) => x.agent === 'gemini')).toBe(false);
    // Orca's "unavailable" outranks "not installed".
    expect(d.skipped).toContainEqual({ agent: 'grok', reason: 'not signed in or unavailable: Not signed in to Grok — run grok login' });
    expect(d.skipped).toContainEqual({ agent: 'muse', reason: 'no models: no model list available from Orca; not routed' });
  });

  it('prints a compact text decision', async () => {
    expect(await main(['route', '--tier', 'daily'], io, deps)).toBe(0);
    const lines = out().split('\n');
    expect(lines[0]).toBe('daily → codex · gpt-6.1-terra · medium (high confidence)');
    expect(lines.slice(1, -1).every((l) => l.startsWith('  '))).toBe(true);
    expect(lines.at(-1)).toBe('orca orchestration worker-start --spec "<task>" --agent codex --model gpt-6.1-terra --effort medium');
  });

  it('passes agent, exclude-agent, effort and no-downgrade through to the router', async () => {
    await main(['route', '--tier', 'frontier', '--agent', 'claude', '--effort', 'max', '--json'], io, deps);
    expect(JSON.parse(out()).route).toEqual({ agent: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    stdout = [];
    await main(['route', '--tier', 'frontier', '--exclude-agent', 'cursor', '--exclude-agent', 'codex', '--json'], io, deps);
    expect(JSON.parse(out()).route.agent).toBe('claude');
    stdout = [];
    await main(['route', '--tier', 'advanced', '--agent', 'codex', '--no-downgrade', '--json'], io, deps);
    expect(JSON.parse(out())).toMatchObject({ status: 'ok', tier: 'advanced', requestedTier: 'advanced', upgraded: false, downgraded: false, route: { agent: 'codex', model: 'gpt-6.1-sol' } });
  });

  it('routes cursor-only Daily to a named model', async () => {
    await main(['route', '--tier', 'daily', '--agent', 'cursor', '--json'], io, deps);
    const d = JSON.parse(out());
    expect(d).toMatchObject({ route: { agent: 'cursor', model: 'claude-sonnet-5-5-medium', effort: null }, launchArgs: ['--agent', 'cursor', '--model', 'claude-sonnet-5-5-medium'], confidence: 'high' });
  });

  it('routes on with a warning and a suggestion for an unknown agent id', async () => {
    expect(await main(['route', '--tier', 'daily', '--exclude-agent', 'cursor-agent', '--json'], io, deps)).toBe(0);
    const d = JSON.parse(out());
    expect(d.status).toBe('ok');
    expect(d.warnings).toContain('unknown agent "cursor-agent" in --exclude-agent: nothing excluded for it (did you mean cursor?)');

    stdout = [];
    expect(await main(['route', '--tier', 'daily', '--agent', 'Cusor', '--json'], io, deps)).toBe(0);
    const only = JSON.parse(out());
    expect(only.status).toBe('none');
    expect(only.warnings).toContain('unknown agent "Cusor" in --agent: not routed (did you mean cursor?)');

    stdout = [];
    await main(['route', '--tier', 'daily', '--agent', 'claude', '--agent', 'zzz', '--json'], io, deps);
    const mixed = JSON.parse(out());
    expect(mixed.route.agent).toBe('claude');
    expect(mixed.warnings.join('\n')).toMatch(/unknown agent "zzz" in --agent: not routed \(known: claude, codex/);
  });

  it('exits 1 on usage errors', async () => {
    expect(await main(['route', '--tier', 'huge'], io, deps)).toBe(1);
    expect(err()).toMatch(/tier/);
    expect(await main(['route'], io, deps)).toBe(1);
    expect(await main(['route', '--tier', 'daily', '--effort', 'turbo'], io, deps)).toBe(1);
    expect(await main(['route', '--tier', 'daily', '--bogus'], io, deps)).toBe(1);
    expect(await main(['launch'], io, deps)).toBe(1);
    expect(await main([], io, deps)).toBe(1);
    expect(stdout).toEqual([]);
  });

  it('still answers with low confidence when Orca is not reachable', async () => {
    expect(await main(['route', '--tier', 'daily', '--json'], io, { ...deps, run: orcaDownRunner })).toBe(0);
    const d = JSON.parse(out());
    expect(d.status).toBe('ok');
    expect(d.confidence).toBe('low');
    expect(d.reasons[0]).toMatch(/usage unknown/);
  });

  it('exits 2 with a one-line config error for malformed config.json', async () => {
    writeFileSync(configPath(), '{bad');
    expect(await main(['route', '--tier', 'light'], io, deps)).toBe(2);
    expect(err()).toMatch(/^config error: .*config\.json/);
    expect(err()).not.toMatch(/\n\s+at /);
    expect(stdout).toEqual([]);
  });
});

describe('status', () => {
  it('reports evidence and hand-outs without legacy score metadata', async () => {
    expect(await main(['status', '--json'], io, deps)).toBe(0);
    const s = JSON.parse(out());
    expect(s.evidence).toMatchObject({ source: 'snapshot', generatedAt: expect.any(String), models: expect.any(Number) });
    expect(s.handouts).toEqual([]);
    for (const key of ['catalog', 'scores', 'scored', 'scoreScale']) expect(s).not.toHaveProperty(key);
    expect(s.placements).not.toHaveProperty('scoreScale');
    stdout = [];
    await main(['status'], io, deps);
    expect(out()).toMatch(/^evidence: snapshot, \d+ models \(LLMBenchmark\.ai, CC BY 4\.0, data of \d{4}-\d{2}-\d{2}\), fetched /m);
  });
  it('reports agents, usage pools, tiers, unclassified models and evidence', async () => {
    expect(await main(['status', '--json'], io, deps)).toBe(0);
    const s = JSON.parse(out());
    expect(s.agents.find((a: { agent: string }) => a.agent === 'antigravity')).toMatchObject({ installed: false });
    expect(s.agents.some((a: { agent: string }) => a.agent === 'gemini')).toBe(false);
    const claude = s.agents.find((a: { agent: string }) => a.agent === 'claude');
    expect(claude).toMatchObject({ installed: true, usage: { status: 'ok' } });
    expect(claude.models).toBeGreaterThan(0);
    expect(claude.usage.pools.find((p: { name: string }) => p.name === 'fableWeekly')).toMatchObject({
      usedPercent: 75,
      resetsAt: 1793282400000,
      blocked: false,
      expired: false,
    });
    expect(s.tiers.frontier.pick).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5' });
    expect(s.tiers.light.pick.agent).toBeDefined();
    expect(s.unclassified.length).toBeGreaterThan(0);
    expect(s.evidence).toMatchObject({ source: 'snapshot' });
    expect(s.evidence.models).toBeGreaterThan(0);
    expect(s).not.toHaveProperty('scored');
    expect(s.unclassified).toContainEqual({ agent: 'cursor', model: 'auto' });
    for (const tier of ['light', 'daily', 'advanced', 'frontier']) {
      expect(s.tiers[tier].pick?.model).not.toBe('auto');
      expect(s.tiers[tier].alternatives.some((a: { model: string }) => a.model === 'auto'), tier).toBe(false);
    }
  });

  it('lists cursor auto as unclassified with cursorAuto: false', async () => {
    writeFileSync(configPath(), '{"cursorAuto":false}');
    expect(await main(['status', '--json'], io, deps)).toBe(0);
    const s = JSON.parse(out());
    expect(s.unclassified).toContainEqual({ agent: 'cursor', model: 'auto' });
    expect(s.tiers.daily.alternatives.some((a: { model: string }) => a.model === 'auto')).toBe(false);
  });

  it('prints readable text', async () => {
    expect(await main(['status'], io, deps)).toBe(0);
    expect(out()).not.toMatch(/^\s+gemini\s/m);
    expect(out()).toMatch(/grok\s+not installed \(grok not found\)/);
    expect(out()).toMatch(/antigravity\s+not installed \(agy not found\)/);
    expect(out()).toMatch(/muse\s+0 models, usage unknown: Orca reports no usage for muse — skipped: no models/);
    expect(out()).toMatch(/frontier/);
    expect(out()).toMatch(/evidence: snapshot/);
    expect(out()).toMatch(/evidence: snapshot, \d+ models/);
    expect(out()).toContain('unclassified (never routed):');
  });
});

describe('refresh', () => {
  it('reloads evidence and reports source and model counts', async () => {
    const snapshot = fixture('evidence-mini.json');
    const manifest = { schemaVersion: 1, generatedAt: JSON.parse(snapshot).generatedAt, bytes: Buffer.byteLength(snapshot), sha256: createHash('sha256').update(snapshot).digest('hex') };
    const fetchImpl = async (url: string | URL | Request) => new Response(String(url) === EVIDENCE_MANIFEST_URL ? JSON.stringify(manifest) : snapshot);
    const code = await main(['refresh'], io, { ...deps, fetchImpl: fetchImpl as typeof fetch });
    expect(code).toBe(0);
    expect(out()).toMatch(/^evidence: network, \d+ models \(snapshot of /);
    expect(err()).toBe('');
  });

  it('reports when the network is unavailable', async () => {
    expect(await main(['refresh'], io, deps)).toBe(0);
    expect(out()).toMatch(/snapshot/);
    expect(err()).toMatch(/could not reach the OrcaCompass repository/);
    expect(stderr).toHaveLength(1);
  });

  it('reports evidence and placements as JSON', async () => {
    expect(await main(['refresh', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ evidence: { source: 'snapshot', generatedAt: expect.any(String) }, placements: expect.any(Object) });
  });
});

describe('placement table in the CLI', () => {
  it('ranks deduplicated profiles and exposes the snapshot sources', async () => {
    expect(await main(['ranking'], io, deps)).toBe(0);
    expect(out()).toMatch(/^claude-opus-5-5\s+frontier\s+coding 86\.2 F measured\(5\)/m);
    expect(out()).toMatch(/auto\s+unranked.*coding unranked/);
    stdout = [];
    expect(await main(['ranking', '--json'], io, deps)).toBe(0);
    const r = JSON.parse(out());
    expect(r.models[0]).toMatchObject({ id: 'claude-fable-5-2', class: 'frontier' });
    expect(r.sources).toContainEqual(expect.objectContaining({ label: 'LLMBenchmark.ai', license: 'CC BY 4.0' }));
    expect(r.generatedAt).toEqual(expect.any(String));
    expect(r.bands.coding).toEqual([68, 76, 84]);
    expect(new Set(r.models.map((m: { id: string }) => m.id)).size).toBe(r.models.length);
    expect(r.models.find((m: { id: string }) => m.id === 'claude-opus-5-5')).toMatchObject({ class: 'frontier', axes: { coding: { score: 86.2, band: 'frontier', label: 'measured', benchmarks: 5 } }, agents: ['claude', 'cursor'] });
    stdout = [];
    expect(await main(['ranking', '--axis', 'coding'], io, deps)).toBe(0);
    expect(out()).not.toMatch(/agentic|reasoning/);
    expect(out().indexOf('claude-opus-5-5')).toBeLessThan(out().indexOf('claude-fable-5-1'));
  });

  it('uses cached snapshot provenance and data date after refresh', async () => {
    const snapshot = JSON.parse(fixture('evidence-mini.json'));
    snapshot.generatedAt = '2026-11-11T04:00:00Z';
    snapshot.sources[0].dataDate = '2026-11-09';
    const text = JSON.stringify(snapshot);
    const manifest = { schemaVersion: 1, generatedAt: snapshot.generatedAt, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
    const fetchImpl = async (url: string | URL | Request) => new Response(String(url) === EVIDENCE_MANIFEST_URL ? JSON.stringify(manifest) : text);
    expect(await main(['refresh', '--json'], io, { ...deps, fetchImpl: fetchImpl as typeof fetch })).toBe(0);
    stdout = [];
    expect(await main(['ranking', '--json'], io, deps)).toBe(0);
    const ranking = JSON.parse(out());
    expect(ranking.generatedAt).toBe(snapshot.generatedAt);
    expect(ranking.sources).toEqual(snapshot.sources);
    stdout = [];
    expect(await main(['status'], io, deps)).toBe(0);
    expect(out()).toContain('data of 2026-11-09');
    stdout = [];
    expect(await main(['refresh', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(out()).evidence.source).toBe('cache');
    expect(err()).toContain('still using the cache from');
  });

  it('selects tiers by axis and rejects unknown axes for both views', async () => {
    expect(await main(['tiers', '--axis', 'agentic'], io, deps)).toBe(0);
    expect(out()).toMatch(/^agentic: light < 60 ≤ daily < 70 ≤ advanced < 80 ≤ frontier$/m);
    expect(out()).not.toMatch(/^coding:|^reasoning:/m);
    for (const command of ['tiers', 'ranking']) {
      expect(await main([command, '--axis', 'Coding'], io, deps)).toBe(1);
      expect(err()).toMatch(/unknown axis/);
    }
  });
  const HOUR = 3_600_000;

  it('route runs only orca account list when the table is fresh and says when it was built', async () => {
    expect(await main(['status'], io, deps)).toBe(0);
    const calls: string[] = [];
    const run: Runner = async (cmd, args) => (calls.push(args[0]), runner(cmd, args));
    stdout = [];
    expect(await main(['route', '--tier', 'daily', '--json'], io, { ...deps, run, now: NOW + 60_000 })).toBe(0);
    expect(calls).toEqual(['account']);
    expect(JSON.parse(out()).placementsBuiltAt).toBe(NOW);
  });

  it('status reports the placement table', async () => {
    expect(await main(['status'], io, deps)).toBe(0);
    expect(out()).toContain(`placements: built now: no table yet (orcacompass ${VERSION})`);
    stdout = [];
    expect(await main(['status', '--json'], io, { ...deps, now: NOW + 2 * HOUR })).toBe(0);
    const s = JSON.parse(out());
    expect(s.placements).toMatchObject({ builtAt: NOW, age: 2 * HOUR, version: VERSION, rebuilt: null, saveError: null });
    expect(s.placements).not.toHaveProperty('scoreScale');
    expect(s).not.toHaveProperty('scored');
    stdout = [];
    expect(await main(['status'], io, { ...deps, now: NOW + 2 * HOUR })).toBe(0);
    expect(out()).toContain(`placements: built 2h ago (orcacompass ${VERSION})`);
  });

  it('tiers prints every model under its tier with the detail behind it', async () => {
    expect(await main(['tiers'], io, deps)).toBe(0);
    const text = out();
    expect(text).toContain(`placements: built now: no table yet (orcacompass ${VERSION})`);
    expect(text).toMatch(/^coding: light < 68 ≤ daily < 76 ≤ advanced < 84 ≤ frontier$/m);
    expect(text).toMatch(/^frontier:$/m);
    expect(text).toMatch(/^  codex gpt-6-astra  coding 85\.5 F measured\(5\)/m);
    expect(text).toMatch(/^  claude claude-haiku-5-5  /m);
    expect(text).toMatch(/^unclassified: \d+$/m);
    stdout = [];
    expect(await main(['tiers', '--json'], io, { ...deps, now: NOW + HOUR })).toBe(0);
    const t = JSON.parse(out());
    expect(t).toMatchObject({ schemaVersion: 3, version: VERSION, builtAt: NOW, age: HOUR });
    expect(t.agents.map((a: { agent: string }) => a.agent)).toContain('codex');
  });

  it('refresh rebuilds the table', async () => {
    expect(await main(['refresh'], io, deps)).toBe(0);
    expect(out()).toMatch(/\nplacements: \d+ models across 7 agents \(built now\)$/);
    stdout = [];
    expect(await main(['refresh', '--json'], io, deps)).toBe(0);
    const j = JSON.parse(out());
    expect(j.placements).toMatchObject({ builtAt: NOW, agents: 7 });
    expect(j.placements.models).toBeGreaterThan(0);
  });

  it('status and tiers say when the table could not be saved', async () => {
    writeFileSync(join(process.env.ORCACOMPASS_HOME!, 'cache'), 'a file where the cache folder should be');
    expect(await main(['status'], io, deps)).toBe(0);
    expect(out()).toMatch(/^placements: could not be saved: /m);
    stdout = [];
    expect(await main(['tiers'], io, deps)).toBe(0);
    expect(out()).toMatch(/^placements: could not be saved: /m);
  });
});

describe('Orca agent switches', () => {
  const disabled = (agents: string[]): MainDeps => ({ ...deps, readOrcaAgents: async () => ({ known: true, disabled: agents, source: '/fake/orca/profile-state.db' }) });
  const unknown: MainDeps = { ...deps, readOrcaAgents: async () => ({ known: false, reason: 'Orca profile index not found' }) };

  it('never routes an agent the user has not enabled in Orca', async () => {
    await main(['route', '--tier', 'daily', '--json'], io, disabled(['claude']));
    const d = JSON.parse(out());
    expect(d.route.agent).not.toBe('claude');
    expect(d.skipped).toContainEqual({ agent: 'claude', reason: 'not enabled in Orca' });
  });

  it('says in status where the switches came from, or that they are unknown', async () => {
    await main(['status'], io, disabled(['codex']));
    expect(out()).toMatch(/^orca agent switches: read from \/fake\/orca\/profile-state\.db \(experimental\); disabled: codex$/m);
    expect(out()).toMatch(/codex\s+\d+ models, .* — skipped: not enabled in Orca/);
    stdout = [];
    await main(['status', '--json'], io, unknown);
    const s = JSON.parse(out());
    expect(s.orcaAgents).toEqual({ known: false, reason: 'Orca profile index not found' });
    expect(s.agents.find((a: { agent: string }) => a.agent === 'claude').enabledInOrca).toBe('unknown');
    stdout = [];
    await main(['status'], io, unknown);
    expect(out()).toMatch(/^orca agent switches: unknown \(Orca profile index not found\); every installed agent counts as enabled$/m);
  });
});

describe('agents', () => {
  it('lists every known agent with installed, Orca switch, usage, choice and verdict', async () => {
    writeFileSync(configPath(), '{"denyAgents":["codex"]}');
    const withDisabled: MainDeps = { ...deps, readOrcaAgents: async () => ({ known: true, disabled: ['cursor'], source: '/fake/db' }) };
    expect(await main(['agents', '--json'], io, withDisabled)).toBe(0);
    const a = JSON.parse(out());
    expect(a.orcaAgents).toEqual({ known: true, disabled: ['cursor'], source: '/fake/db' });
    expect(a.configPath).toBe(configPath());
    expect(a.agents.map((x: { agent: string }) => x.agent)).toEqual(['claude', 'codex', 'cursor', 'grok', 'antigravity', 'opencode', 'muse']);
    const row = (agent: string) => a.agents.find((x: { agent: string }) => x.agent === agent);
    expect(row('claude')).toEqual({ agent: 'claude', installed: true, enabledInOrca: 'yes', orcaUsage: 'ok', chosen: true, used: true, verdict: 'used' });
    expect(row('codex')).toMatchObject({ chosen: false, used: false, verdict: 'not used: excluded by config' });
    expect(row('cursor')).toMatchObject({ enabledInOrca: 'no', chosen: true, verdict: 'not used: not enabled in Orca' });
    expect(row('grok')).toMatchObject({ installed: false, orcaUsage: 'unavailable', orcaUsageError: 'Not signed in to Grok — run grok login' });
    expect(row('grok').verdict).toMatch(/^not used: not signed in or unavailable/);
    expect(row('antigravity')).toMatchObject({ installed: false, verdict: expect.stringMatching(/^not used: not signed in or unavailable/) });

    stdout = [];
    expect(await main(['agents'], io, withDisabled)).toBe(0);
    const text = out();
    expect(text).toMatch(/^orca agent switches: read from \/fake\/db \(experimental\); disabled: cursor$/m);
    expect(text).toMatch(/^agent\s+installed\s+enabled in Orca\s+Orca usage\s+chosen\s+verdict$/m);
    expect(text).toMatch(/^claude\s+yes\s+yes\s+ok\s+yes\s+used$/m);
    expect(text).toMatch(/^codex\s+yes\s+yes\s+ok\s+no\s+not used: excluded by config$/m);
  });

  it('disable, enable, only and reset write the choice to the config file', async () => {
    writeFileSync(configPath(), '{\n  "cursorAuto": false\n}\n');
    expect(await main(['agents', 'disable', 'grok', 'Cursor'], io, deps)).toBe(0);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ cursorAuto: false, denyAgents: ['grok', 'cursor'] });
    expect(out()).toMatch(/^wrote .*config\.json$/m);
    expect(out()).toMatch(/^chosen: claude, codex, antigravity, opencode, muse$/m);
    expect(out()).toMatch(/^not chosen: cursor, grok$/m);

    stdout = [];
    await main(['agents', 'enable', 'cursor', '--json'], io, deps);
    expect(JSON.parse(out())).toMatchObject({ configPath: configPath(), denyAgents: ['grok'], chosen: ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'muse'] });

    await main(['agents', 'only', 'claude', 'codex'], io, deps);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ cursorAuto: false, denyAgents: ['grok'], allowAgents: ['claude', 'codex'] });
    stdout = [];
    await main(['route', '--tier', 'daily', '--json'], io, deps);
    expect(['claude', 'codex']).toContain(JSON.parse(out()).route.agent);

    await main(['agents', 'reset'], io, deps);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({ cursorAuto: false });
  });

  it('rejects unknown agent ids and missing ids without touching the config', async () => {
    writeFileSync(configPath(), '{"denyAgents":["codex"]}');
    expect(await main(['agents', 'disable', 'gpt'], io, deps)).toBe(1);
    expect(err()).toMatch(/unknown agent "gpt" \(known: claude, codex, cursor, grok, antigravity, opencode, muse\)/);
    expect(await main(['agents', 'enable', 'gemini'], io, deps)).toBe(1);
    expect(err()).toMatch(/unknown agent "gemini"/);
    expect(await main(['agents', 'only'], io, deps)).toBe(1);
    expect(await main(['agents', 'reset', 'claude'], io, deps)).toBe(1);
    expect(await main(['agents', 'shuffle'], io, deps)).toBe(1);
    expect(readFileSync(configPath(), 'utf8')).toBe('{"denyAgents":["codex"]}');
  });

  it('exits 2 and leaves a malformed config alone', async () => {
    writeFileSync(configPath(), '{bad');
    expect(await main(['agents', 'disable', 'grok'], io, deps)).toBe(2);
    expect(readFileSync(configPath(), 'utf8')).toBe('{bad');
  });
});

describe('prefer', () => {
  const config = () => JSON.parse(readFileSync(configPath(), 'utf8'));

  it('sets, lists and clears a preferred route per tier, keeping other keys', async () => {
    writeFileSync(configPath(), '{"cursorAuto":false}');
    expect(await main(['prefer', 'daily', 'claude', 'claude-sonnet-5-5'], io, deps)).toBe(0);
    expect(out()).toMatch(/^daily → claude claude-sonnet-5-5$/m);
    expect(await main(['prefer', 'frontier', 'codex'], io, deps)).toBe(0);
    expect(config()).toEqual({ cursorAuto: false, pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' }, frontier: { agent: 'codex' } } });

    stdout = [];
    expect(await main(['prefer', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ preferRiskLimit: 100, pins: { daily: { agent: 'claude', model: 'claude-sonnet-5-5' }, frontier: { agent: 'codex' } } });
    stdout = [];
    await main(['prefer'], io, deps);
    expect(out()).toMatch(/^ {2}light\s+none$/m);
    expect(out()).toMatch(/^ {2}frontier\s+codex \(its best model\)$/m);
    expect(out()).toMatch(/above 100% projected usage, switch only to a known within-limit alternative/);

    await main(['prefer', 'clear', 'daily'], io, deps);
    expect(config()).toEqual({ cursorAuto: false, pins: { frontier: { agent: 'codex' } } });
    await main(['prefer', 'clear', '--all'], io, deps);
    expect(config()).toEqual({ cursorAuto: false });
  });

  it('routes to the preference and explains a skipped one', async () => {
    await main(['prefer', 'frontier', 'claude', 'claude-fable-5-2'], io, deps);
    stdout = [];
    await main(['route', '--tier', 'frontier', '--json'], io, deps);
    const d = JSON.parse(out());
    expect(d.route).toMatchObject({ agent: 'claude', model: 'claude-fable-5-2' });
    expect(d.reasons).toContain('preferred route, on pace for 82%');
    expect(d.risk).toMatchObject({ pool: 'fableWeekly' });
    expect(d.alternatives[0].risk).toMatchObject({ projectedPercent: expect.any(Number) });

    await main(['prefer', 'advanced', 'codex', 'gpt-6.1-terra'], io, deps);
    stdout = [];
    await main(['route', '--tier', 'advanced'], io, deps);
    expect(out()).toMatch(/warning: preferred codex gpt-6\.1-terra skipped: weekly on pace for 120% \(limit 100%\), resets in 5d/);
  });

  it('validates tier, agent and the model of an installed agent, and warns for an agent not installed', async () => {
    expect(await main(['prefer', 'huge', 'claude'], io, deps)).toBe(1);
    expect(await main(['prefer', 'daily', 'gemini'], io, deps)).toBe(1);
    expect(err()).toMatch(/unknown agent "gemini"/);
    expect(await main(['prefer', 'daily', 'claude', 'claude-nope-9'], io, deps)).toBe(1);
    expect(err()).toMatch(/unknown model "claude-nope-9" for claude/);
    expect(await main(['prefer', 'daily'], io, deps)).toBe(1);
    expect(await main(['prefer', 'clear'], io, deps)).toBe(1);
    stderr = [];
    expect(await main(['prefer', 'light', 'grok', 'grok-4.7'], io, deps)).toBe(0);
    expect(err()).toMatch(/^warning: grok is not installed right now; saved without checking the model$/m);
    expect(JSON.parse(readFileSync(configPath(), 'utf8')).pins).toEqual({ light: { agent: 'grok', model: 'grok-4.7' } });
  });

  it('sets the risk limit, and the default removes the key', async () => {
    writeFileSync(configPath(), '{"cursorAuto":false}');
    expect(await main(['prefer', '--risk-limit', '120%'], io, deps)).toBe(0);
    expect(config()).toEqual({ cursorAuto: false, preferRiskLimit: 120 });
    expect(out()).toMatch(/above 120% projected usage, switch only to a known within-limit alternative/);
    stdout = [];
    expect(await main(['prefer', '--risk-limit', '100', '--json'], io, deps)).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ preferRiskLimit: 100 });
    expect(config()).toEqual({ cursorAuto: false });

    expect(await main(['prefer', '--risk-limit', 'lots'], io, deps)).toBe(1);
    expect(err()).toMatch(/--risk-limit must be a non-negative percent \(got "lots"\)/);
    expect(await main(['prefer', '--risk-limit', '-5'], io, deps)).toBe(1);
    expect(await main(['prefer', 'daily', 'claude', '--risk-limit', '90'], io, deps)).toBe(1);
    expect(config()).toEqual({ cursorAuto: false });
  });
});

describe('ban', () => {
  const config = () => JSON.parse(readFileSync(configPath(), 'utf8'));

  it('bans models and families, lists them with their matches, and unbans', async () => {
    expect(await main(['ban', 'claude-sonnet', 'Grok-9'], io, deps)).toBe(0);
    expect(config()).toEqual({ banModels: ['claude-sonnet', 'grok-9'] });
    expect(err()).toMatch(/^warning: "grok-9" matches no model discovered right now; saved anyway$/m);
    expect(err()).not.toMatch(/claude-sonnet"/);

    stdout = [];
    await main(['ban', '--json'], io, deps);
    const listed = JSON.parse(out());
    expect(listed.banModels).toEqual(['claude-sonnet', 'grok-9']);
    expect(listed.matches['claude-sonnet']).toContainEqual({ agent: 'claude', model: 'claude-sonnet-5-5' });
    expect(listed.matches['grok-9']).toEqual([]);

    stdout = [];
    await main(['route', '--tier', 'daily', '--json'], io, deps);
    const d = JSON.parse(out());
    expect(d.route.model).not.toMatch(/sonnet/);
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-sonnet-5-5', reason: 'banned by you' });

    stdout = [];
    await main(['status'], io, deps);
    expect(out()).toMatch(/^banned by you: .*claude claude-sonnet-5-5/m);

    await main(['unban', 'claude-sonnet'], io, deps);
    expect(config()).toEqual({ banModels: ['grok-9'] });
    await main(['unban', 'grok-9'], io, deps);
    expect(config()).toEqual({});
  });

  it('points agent ids to agents disable, but accepts an agent id that is also a model family', async () => {
    expect(await main(['ban', 'codex'], io, deps)).toBe(1);
    expect(err()).toMatch(/"codex" is an agent; to stop using it run: orcacompass agents disable codex/);
    stderr = [];
    expect(await main(['ban', 'grok'], io, deps)).toBe(0);
    expect(config()).toEqual({ banModels: ['grok'] });
    expect(err()).toMatch(/"grok" bans the grok model family; to stop using the Grok Build agent run: orcacompass agents disable grok/);
    expect(await main(['ban'], io, { ...deps })).toBe(0);
    expect(await main(['unban'], io, deps)).toBe(1);
  });
});

describe('verify and rejected', () => {
  it('uses a sixty-second total default and rejects longer waits', async () => {
    let elapsed = 0;
    const run: Runner = async (_cmd, args, options) => {
      if (args[1] === 'worker-show') {
        elapsed += Math.min(20_000, options?.timeoutMs ?? 20_000);
        return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: {} }) };
      }
      return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: {} }) };
    };
    const timing: MainDeps = { run, clock: () => elapsed, sleep: async (ms) => { elapsed += ms; } };
    expect(await main(['verify', '--dispatch', 'ctx_1', '--json'], io, timing)).toBe(0);
    expect(JSON.parse(out()).status).toBe('unknown');
    expect(elapsed).toBe(60_000);
    expect(await main(['verify', '--dispatch', 'ctx_1', '--wait', '61'], io, timing)).toBe(1);
    expect(err()).toContain('between 0 and 60');
  });
  const refusal = "There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it.";
  const orcaWorker: Runner = async (cmd, args, opts) => {
    if (args[0] !== 'orchestration') return runner(cmd, args, opts);
    if (args[1] === 'worker-show') {
      const launch = { agent: 'claude', model: 'claude-sonnet-5-5' };
      return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { dispatch: { taskId: 'task_1' }, worker: { startOptions: { launch: { effective: launch } } } } }) };
    }
    const projection = { stage: { activity: 'done', detail: 'input_accepted' }, outcome: 'in_progress', liveness: { verdict: 'live' } };
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { projection, terminal: { tail: ['=== TASK ===', `● ${refusal} Run`, '  /model to pick a different model.'] } } }) };
  };
  const verifyDeps: MainDeps = { ...deps, run: orcaWorker, sleep: async () => {}, clock: () => NOW };

  it('records a refusal, routes around it, lists it and forgets it on --clear', async () => {
    expect(await main(['verify', '--dispatch', 'ctx_1', '--json'], io, verifyDeps)).toBe(0);
    const v = JSON.parse(out());
    expect(v).toMatchObject({ status: 'rejected', agent: 'claude', model: 'claude-sonnet-5-5', taskId: 'task_1', message: refusal, skippedForHours: 168 });
    expect(v.next).toEqual([
      'clean up: orca orchestration worker-stop --dispatch ctx_1 --json, then orca orchestration worker-release --dispatch ctx_1 --json',
      'route again with the same flags; claude claude-sonnet-5-5 is skipped for 168h',
      'start the replacement on the same Task: orca orchestration worker-start --task task_1 --retry-of ctx_1 --worktree <same placement> <new launchArgs> --json',
    ]);

    stdout = [];
    await main(['route', '--tier', 'daily', '--agent', 'claude', '--json'], io, deps);
    const d = JSON.parse(out());
    expect(d.route?.model).not.toBe('claude-sonnet-5-5');
    expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-sonnet-5-5', reason: `refused by claude 0m ago: "${refusal}"` });

    stdout = [];
    await main(['rejected'], io, deps);
    expect(out()).toBe(`refused at launch, skipped for 168h after:\n  claude claude-sonnet-5-5: refused by claude 0m ago: "${refusal}"`);
    stdout = [];
    await main(['status'], io, deps);
    expect(out()).toMatch(/^skipped claude claude-sonnet-5-5, refused by claude 0m ago: .*\(orcacompass rejected --clear forgets it\)$/m);
    expect(out()).not.toMatch(/^banned by you/m);

    stdout = [];
    await main(['rejected', '--clear'], io, deps);
    expect(out()).toBe('forgot 1 refused model');
    stdout = [];
    await main(['route', '--tier', 'daily', '--agent', 'claude', '--json'], io, deps);
    expect(JSON.parse(out()).route.model).toBe('claude-sonnet-5-5');
  });

  it('prints the verdict and next steps as text, and needs --dispatch', async () => {
    await main(['verify', '--dispatch', 'ctx_1'], io, verifyDeps);
    expect(out()).toMatch(/^rejected: claude · claude-sonnet-5-5 — claude refused claude-sonnet-5-5\n  agent said: There's an issue/);
    expect(out()).toMatch(/\nnext:\n  1\. clean up: /);
    expect(await main(['verify'], io, verifyDeps)).toBe(1);
    expect(err()).toMatch(/^--dispatch <id> is required/);
    expect(await main(['verify', '--dispatch', 'x', '--wait', 'soon'], io, verifyDeps)).toBe(1);
  });

  it('tells the coordinator to report a failed start to the user, and records no skip', async () => {
    const failedWorker: Runner = async (cmd, args, opts) => {
      if (args[0] === 'orchestration' && args[1] === 'worker-read') {
        const projection = { stage: { activity: 'failed', detail: 'agent_readiness' }, outcome: 'failed', liveness: { verdict: 'exited' } };
        return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { projection, terminal: { tail: ['Choose a theme', '  enter Confirm'] } } }) };
      }
      return orcaWorker(cmd, args, opts);
    };
    await main(['verify', '--dispatch', 'ctx_1', '--json'], io, { ...verifyDeps, run: failedWorker });
    const v = JSON.parse(out());
    expect(v.status).toBe('failed');
    expect(v.next).toContain('tell the user which agent failed to start, why, and how they can fix it');

    stdout = [];
    await main(['rejected'], io, deps);
    expect(out()).not.toContain('claude-sonnet-5-5');
  });
});

it('records a route and shows live hand-outs in status', async () => {
  expect(await main(['route', '--tier', 'daily', '--agent', 'claude', '--json'], io, deps)).toBe(0);
  const decision = JSON.parse(out());
  const file = join(process.env.ORCACOMPASS_HOME!, 'cache', 'handouts.json');
  const entries = JSON.parse(readFileSync(file, 'utf8')).handouts;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ agent: 'claude', model: decision.route.model, needs: { coding: 'low', agentic: 'low', reasoning: 'low' } });
  expect(entries[0].pools).toContain('weekly');
  stdout = [];
  await main(['status', '--json'], io, deps);
  const status = JSON.parse(out());
  expect(status.handouts).toHaveLength(1);
  expect(status.agents.find((a: { agent: string }) => a.agent === 'claude').usage.pools.find((p: { name: string }) => p.name === 'weekly').handouts).toBe(1);
  stdout = [];
  await main(['status'], io, deps);
  expect(out()).toMatch(/hand-outs \(last 10m\): claude .*0m ago/);
});
