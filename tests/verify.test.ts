import { describe, expect, it } from 'vitest';
import type { RunResult } from '../src/system/run.js';
import { verifyWorker, type VerifyDeps } from '../src/verify.js';

const show = (agent: string, model: string) => JSON.stringify({
  ok: true,
  result: {
    dispatch: { id: 'ctx_1', taskId: 'task_1' },
    worker: { startOptions: { agent, launch: { requested: { agent, model }, effective: { agent, model } } } },
  },
});

interface Frame { activity?: string; outcome?: string; liveness?: string; detail?: string; tail?: string[] }
const read = (f: Frame) => JSON.stringify({
  ok: true,
  result: {
    terminal: { status: f.liveness === 'exited' ? 'exited' : 'running', tail: f.tail ?? [] },
    projection: { stage: { activity: f.activity ?? 'unknown', detail: f.detail ?? 'input_accepted' }, outcome: f.outcome ?? 'in_progress', liveness: { verdict: f.liveness ?? 'live' } },
  },
});

/** A fake Orca: worker-show once, then one worker-read frame per poll (the last frame repeats); 1.5s per poll. */
function fake(showOut: string, frames: Frame[]) {
  let t = 0;
  let i = 0;
  const calls: string[][] = [];
  const deps: VerifyDeps = {
    run: async (_cmd, args): Promise<RunResult> => {
      calls.push(args);
      if (args[1] === 'worker-show') return { code: 0, stdout: showOut, stderr: '' };
      const f = frames[Math.min(i++, frames.length - 1)];
      return { code: 0, stdout: read(f), stderr: '' };
    },
    sleep: async (ms) => {
      t += ms;
    },
    clock: () => t,
  };
  return { deps, calls };
}

const PREAMBLE = ['=== TASK ===', 'Probe task.'];
const opts = { waitMs: 45_000 };

describe('verifyWorker', () => {
  it('includes worker-show and slow reads in the total deadline', async () => {
    let elapsed = 0;
    const deps: VerifyDeps = {
      clock: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
      run: async (_cmd, args, options) => {
        const duration = Math.min(20_000, options?.timeoutMs ?? 20_000);
        elapsed += duration;
        return { code: 0, stderr: '', stdout: args[1] === 'worker-show' ? show('codex', 'gpt-6-luna') : read({}) };
      },
    };
    expect((await verifyWorker('ctx_1', deps, { waitMs: 25_000 })).status).toBe('unknown');
    expect(elapsed).toBe(25_000);
  });

  it('caps the total wait at sixty seconds and trims the final polling delay', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', deps, { waitMs: 90_000 })).status).toBe('unknown');
    expect(deps.clock()).toBe(60_000);
    const short = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', short.deps, { waitMs: 1_000 })).status).toBe('unknown');
    expect(short.deps.clock()).toBe(1_000);
  });

  it('returns immediately for a zero wait without calling Orca', async () => {
    const { deps, calls } = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', deps, { waitMs: 0 })).status).toBe('unknown');
    expect(calls).toEqual([]);
  });
  it('codex refusing a Claude model: rejected while live, stop then release', async () => {
    const { deps, calls } = fake(show('codex', 'claude-opus-5-5'), [
      { activity: 'working', tail: PREAMBLE },
      { activity: 'done', tail: [...PREAMBLE, '■ The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.', '› Ask Codex to do anything'] },
    ]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({
      status: 'rejected', dispatchId: 'ctx_1', taskId: 'task_1', agent: 'codex', model: 'claude-opus-5-5',
      message: 'The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.',
    });
    expect(v.cleanup).toEqual([
      ['orca', 'orchestration', 'worker-stop', '--dispatch', 'ctx_1', '--json'],
      ['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_1', '--json'],
    ]);
    expect(calls[1]).toEqual(['orchestration', 'worker-read', '--source', 'terminal', '--limit', '80', '--dispatch', 'ctx_1', '--json']);
  });

  it('cursor exiting on an unknown model: rejected after Orca failed the start, release only', async () => {
    const { deps } = fake(show('cursor', 'claude-opus-9-9'), [
      { outcome: 'failed', liveness: 'unverifiable', detail: 'agent_readiness', tail: ['Cannot use this model: claude-opus-9-9. Available models: auto, gpt-5.3-codex-low', '❯'] },
    ]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'rejected', message: 'Cannot use this model: claude-opus-9-9.' });
    expect(v.cleanup).toEqual([['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_1', '--json']]);
  });

  it('remembers the refusal when the exited terminal comes back empty', async () => {
    const { deps } = fake(show('grok', 'grok-9-fake'), [
      { activity: 'done', tail: ['Error: Couldn\'t set model \'grok-9-fake\': Invalid params: "unknown model id".'] },
      { outcome: 'failed', liveness: 'exited', tail: [] },
    ]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'rejected' });
  });

  it('an agent working for 8s with no refusal has started', async () => {
    const { deps } = fake(show('claude', 'claude-haiku-5-5'), [{ activity: 'working', tail: PREAMBLE }]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'started', cleanup: [] });
    expect(v.detail).toMatch(/^working for 9s with no refusal$/);
  });

  it('a quick worker that already reported is fine', async () => {
    const { deps } = fake(show('claude', 'claude-haiku-5-5'), [{ activity: 'working' }, { activity: 'working', outcome: 'succeeded', detail: 'settled' }]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported' });
  });

  it('a turn that ends without worker_done or a known refusal is stalled, with the tail', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{ activity: 'done', tail: [...PREAMBLE, '■ You have hit your usage limit.', ''] }]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'stalled', cleanup: [] });
    expect(v.tail).toEqual(['=== TASK ===', 'Probe task.', '■ You have hit your usage limit.']);
  });

  it('an idle agent that never got the task is not stalled: it waits, then says the prompt was probably not sent', async () => {
    const banner = ['  >_ OpenAI Codex (v0.169.0)', '›', '  GPT-6.1-Sol medium'];
    const { deps } = fake(show('codex', 'gpt-6.1-sol'), [{ activity: 'done', tail: banner }]);
    const v = await verifyWorker('ctx_1', deps, { waitMs: 9_000 });
    expect(v).toMatchObject({ status: 'unknown', unsent: true, cleanup: [], tail: banner.map((l) => l.trimEnd()) });
    expect(v.detail).toBe('the agent is idle and the task is not in its terminal after 9s: the prompt was probably not sent yet');
  });

  it('a prompt that arrives late still gives started', async () => {
    const idle = { activity: 'done', tail: ['›'] };
    const working = { activity: 'working', tail: [...PREAMBLE, 'Reading files'] };
    const { deps } = fake(show('codex', 'gpt-6.1-sol'), [idle, idle, idle, idle, working]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'started' });
  });

  it('an exit without a known refusal is failed', async () => {
    const { deps } = fake(show('antigravity', 'gemini-3.8-flash-high'), [{ outcome: 'failed', liveness: 'exited', detail: 'process_exited', tail: ['panic'] }]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'failed', detail: 'the worker ended without worker_done (process exited)', tail: ['panic'] });
  });

  it('gives up as unknown after the wait', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{ activity: 'unknown' }]);
    expect(await verifyWorker('ctx_1', deps, { waitMs: 6_000 })).toMatchObject({ status: 'unknown', detail: 'no verdict within 6s' });
  });

  it('reports a worker-show failure as unknown', async () => {
    const { deps } = fake(JSON.stringify({ ok: false, error: { code: 'dispatch_not_found', message: 'no such dispatch' } }), []);
    expect(await verifyWorker('ctx_9', deps, opts)).toEqual({ status: 'unknown', dispatchId: 'ctx_9', detail: 'orca worker-show failed: no such dispatch', cleanup: [] });
  });
});
