import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type MainDeps } from '../src/cli.js';
import type { Runner } from '../src/system/run.js';
import { fakeDeps, NOW, runner } from './helpers/fakes.js';

// The Skill is the product's interface to coordinator agents: an agent runs exactly what it says and
// reads exactly the fields it names. These tests fail when the Skill and the CLI drift apart.
const skill = readFileSync(new URL('../skills/orcacompass/SKILL.md', import.meta.url), 'utf8').replaceAll('\r', '');

/** Inline code spans and fenced `sh` lines, with wrapped lines joined. */
function codeSpans(markdown: string): string[] {
  const fenced = [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n'));
  const inline = [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  return [...fenced, ...inline].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const spans = codeSpans(skill);
const commands = [...new Set(spans.filter((s) => s.startsWith('orcacompass ')))];

// A value for every placeholder the Skill uses; a new placeholder must be added here.
const PLACEHOLDERS: Record<string, string[]> = {
  '<id>...': ['codex'], '<id>': ['codex'], '<tier>': ['daily'], '<agent>': ['codex'], '<model>': ['gpt-6.1-terra'],
  '[model]': [], '<percent>': ['80'], '<model-or-family>...': ['gpt-6.1-terra'], '<entry>...': ['gpt-6.1-terra'],
  '<dispatchId>': ['ctx_1'],
};
// Named in prose without being a complete call from an agent: these exit 1 with this explanation.
const NOT_RUN_AS_WRITTEN: Record<string, RegExp> = {
  'orcacompass unban': /^use "unban /,
  'orcacompass setup': /asks its questions in a terminal/,
};

/** Splits a command line into arguments, honoring double quotes, and fills in the placeholders. */
function argv(command: string): string[] {
  const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  return words.slice(1).flatMap((word) => {
    if (word in PLACEHOLDERS) return PLACEHOLDERS[word]!;
    expect(word, `unknown placeholder in \`${command}\``).not.toMatch(/^[<[]/);
    return [word];
  });
}

// `verify` asks Orca about a worker; this one accepted its model.
const orca: Runner = async (cmd, args, opts) => {
  if (args[0] !== 'orchestration') return runner(cmd, args, opts);
  if (args[1] === 'worker-show') {
    const launch = { agent: 'claude', model: 'claude-sonnet-5-5' };
    return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { dispatch: { taskId: 'task_1' }, worker: { startOptions: { launch: { effective: launch } } } } }) };
  }
  const projection = { stage: { activity: 'working', detail: 'tool_use' }, outcome: 'in_progress', liveness: { verdict: 'live' } };
  return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { projection, terminal: { tail: ['=== TASK ===', 'Reading files'] } } }) };
};
let elapsed = 0;
const deps: MainDeps = { ...fakeDeps, run: orca, sleep: async (ms) => { elapsed += ms; }, clock: () => NOW + elapsed };

let stdout: string[];
let stderr: string[];
const io = { out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) };
const savedHome = process.env.ORCACOMPASS_HOME;

async function runJson(args: string[]): Promise<Record<string, unknown>> {
  stdout = [];
  expect(await main(args, io, deps), stderr.join('\n')).toBe(0);
  return JSON.parse(stdout.join('\n'));
}

beforeEach(() => {
  process.env.ORCACOMPASS_HOME = mkdtempSync(join(tmpdir(), 'oc-skill-'));
  const home = mkdtempSync(join(tmpdir(), 'oc-skill-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  stdout = [];
  stderr = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (savedHome === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = savedHome;
});

describe('SKILL.md', () => {
  it('has the front matter agents load it by', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('orcacompass');
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('names enough commands for this check to mean something', () => {
    expect(commands.length).toBeGreaterThan(15);
    for (const start of ['route', 'verify', 'setup', 'agents', 'prefer', 'ban', 'status', 'refresh']) {
      expect(commands.some((c) => c.startsWith(`orcacompass ${start}`)), start).toBe(true);
    }
  });

  it.each(commands)('`%s` is a command the CLI accepts', async (command) => {
    const code = await main(argv(command), io, deps);
    const explained = NOT_RUN_AS_WRITTEN[command];
    if (explained) {
      expect(stderr.join('\n')).toMatch(explained);
      expect(code).toBe(1);
      return;
    }
    // Warnings are fine; a usage error prints the help text.
    expect(stderr.join('\n')).not.toContain('usage: orcacompass');
    expect(code).toBe(0);
  });

  it('names only flags the CLI or Orca has', async () => {
    await main(['--help'], io, deps);
    const cliFlags = new Set(stdout.join('\n').match(/--[a-z][a-z-]*/g));
    // Flags of `orca orchestration worker-start`, which the Skill tells the coordinator to keep or avoid.
    const orcaFlags = new Set(['--spec', '--worktree', '--model', '--task', '--retry-of']);
    const named = new Set(spans.flatMap((s) => s.match(/--[a-z][a-z-]*/g) ?? []));
    expect(named.size).toBeGreaterThan(10);
    for (const flag of named) expect(cliFlags.has(flag) || orcaFlags.has(flag), `${flag} is not a flag of orcacompass --help`).toBe(true);
  });

  // The Skill tells the agent to read these fields; each must be named in the Skill and present in the output.
  const named = (field: string) => expect(spans.some((s) => new RegExp(`\\b${field}\\b`).test(s)), `SKILL.md no longer names ${field}`).toBe(true);

  it('reads fields the route output has', async () => {
    const d = await runJson(['route', '--need', 'coding=mid,agentic=low,reasoning=low', '--demand', 'moderate', '--tier-reason', 'Multi-file change with tests.', '--json']);
    expect(d.status).toBe('ok');
    for (const field of ['status', 'reasons', 'warnings', 'confidence', 'downgraded', 'upgraded', 'launchArgs', 'launch', 'route', 'effort', 'alternatives', 'quality', 'evidenceSource', 'catalogSource']) {
      named(field);
      expect(d, field).toHaveProperty(field);
    }
    expect(Array.isArray(d.launchArgs)).toBe(true);
    expect(d.effort).toHaveProperty('applied');
    for (const field of ['tier', 'blended', 'source']) expect((d.quality as { cost: object }).cost, field).toHaveProperty(field);
    named('waitUntil');
  });

  it('reads fields the setup output has', async () => {
    const s = await runJson(['setup', '--json']);
    for (const field of ['configExists', 'agents', 'tiers', 'families', 'config', 'configPath', 'defaultPreferRiskLimit']) {
      named(field);
      expect(s, field).toHaveProperty(field);
    }
    const agent = (s.agents as Record<string, unknown>[])[0]!;
    for (const field of ['enabledInOrca', 'orcaUsage', 'models', 'preselected']) {
      named(field);
      expect(agent, field).toHaveProperty(field);
    }
    const tier = (s.tiers as Record<string, Record<string, unknown>>).daily!;
    for (const field of ['pick', 'preferred', 'options']) {
      named(field);
      expect(tier, field).toHaveProperty(field);
    }
    expect((tier.options as object[])[0]).toHaveProperty('onPacePercent');
  });

  it('reads fields and verdicts the verify output has', async () => {
    const v = await runJson(['verify', '--dispatch', 'ctx_1', '--json']);
    expect(v.status).toBe('started');
    for (const field of ['next', 'cleanup']) {
      named(field);
      expect(v, field).toHaveProperty(field);
    }
    for (const verdict of ['started', 'reported', 'rejected', 'stalled', 'failed', 'unknown']) named(verdict);
  });
});
