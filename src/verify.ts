import type { Runner } from './system/run.js';
import { findRejection } from './routing/rejection.js';

// Watches a worker Orca just started and says whether its agent accepted the model. Orca does not check:
// worker-start reports the requested model as effective, and an agent that refuses it either exits (cursor,
// grok, antigravity) or prints the refusal and idles at its prompt without worker_done (codex, claude),
// which Orca shows as a live worker with nothing to do.

export type VerifyStatus = 'started' | 'reported' | 'rejected' | 'stalled' | 'failed' | 'unknown';

export interface Verdict {
  status: VerifyStatus;
  dispatchId: string;
  taskId?: string;
  agent?: string;
  model?: string;
  /** The agent's refusal, with `rejected`. */
  message?: string;
  /** What was seen, in one line. */
  detail: string;
  /** The last lines of the worker's terminal, with `stalled`, `failed` and `unknown`. */
  tail?: string[];
  /** With `unknown`: the agent sat idle and Orca's task header never showed in its terminal, so the prompt was probably not sent yet. */
  unsent?: true;
  /** Orca commands that clean up the worker before a replacement starts, in order. */
  cleanup: string[][];
}

export interface VerifyOptions {
  /** Give up after this long, ms. */
  waitMs: number;
  /** An agent working this long without a refusal has accepted the model, ms. */
  workingMs?: number;
  pollMs?: number;
}

export interface VerifyDeps {
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

interface Observation {
  activity?: string;
  outcome?: string;
  liveness?: string;
  stage?: string;
  tail: string[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function orcaResult(stdout: string, code: number | null, error?: string): Parsed<any> {
  try {
    const data = JSON.parse(stdout);
    if (data?.ok === true) return { ok: true, value: data.result ?? {} };
    const e = data?.error;
    return { ok: false, error: typeof e === 'string' ? e : e?.message ?? e?.code ?? 'orca reported an error' };
  } catch {
    return { ok: false, error: error ?? (code === 0 ? 'orca printed no JSON' : `orca exited with code ${code}`) };
  }
}

/** `orca orchestration worker-show --json`: the effective launch (agent, model) and the Task. */
export function parseWorkerShow(stdout: string, code: number | null = 0, error?: string): Parsed<{ agent?: string; model?: string; taskId?: string }> {
  const r = orcaResult(stdout, code, error);
  if (!r.ok) return r;
  const launch = r.value.worker?.startOptions?.launch ?? {};
  const effective = launch.effective ?? launch.requested ?? {};
  const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined);
  return {
    ok: true,
    value: {
      agent: str(effective.agent) ?? str(r.value.worker?.startOptions?.agent),
      model: str(effective.model),
      taskId: str(r.value.dispatch?.taskId) ?? str(r.value.dispatch?.task_id),
    },
  };
}

/** `orca orchestration worker-read --source terminal --json`: the fleet projection and the terminal tail. */
export function parseWorkerRead(stdout: string, code: number | null = 0, error?: string): Parsed<Observation> {
  const r = orcaResult(stdout, code, error);
  if (!r.ok) return r;
  const p = r.value.projection ?? {};
  const tail = Array.isArray(r.value.terminal?.tail) ? r.value.terminal.tail.filter((l: unknown): l is string => typeof l === 'string') : [];
  return {
    ok: true,
    value: { activity: p.stage?.activity, outcome: p.outcome, liveness: p.liveness?.verdict, stage: p.stage?.detail, tail },
  };
}

/** The header Orca puts on a worker's prompt. Without it in the terminal, the agent has not been given the task. */
const TASK_HEADER = /===\s*TASK\s*===/;

const lastLines = (tail: string[], n = 12): string[] => tail.map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-n);

export async function verifyWorker(dispatchId: string, deps: VerifyDeps, opts: VerifyOptions): Promise<Verdict> {
  const waitMs = Math.min(60_000, Math.max(0, opts.waitMs));
  const deadline = deps.clock() + waitMs;
  const remaining = () => Math.max(0, deadline - deps.clock());
  const timeoutDetail = `no verdict within ${waitMs / 1000}s`;
  if (waitMs === 0) return { status: 'unknown', dispatchId, detail: timeoutDetail, cleanup: [] };
  const workingMs = opts.workingMs ?? 8_000;
  const pollMs = opts.pollMs ?? 1_500;
  const orca = (args: string[]) => deps.run('orca', ['orchestration', ...args, '--dispatch', dispatchId, '--json'], { timeoutMs: Math.min(20_000, remaining()) });
  const stop = ['orca', 'orchestration', 'worker-stop', '--dispatch', dispatchId, '--json'];
  const release = ['orca', 'orchestration', 'worker-release', '--dispatch', dispatchId, '--json'];

  const shown = await orca(['worker-show']);
  const launch = parseWorkerShow(shown.stdout, shown.code, shown.error);
  if (!launch.ok) return { status: 'unknown', dispatchId, detail: `orca worker-show failed: ${launch.error}`, cleanup: [] };
  const { agent, model, taskId } = launch.value;
  const base = { dispatchId, ...(taskId ? { taskId } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) };

  let tail: string[] = [];
  let workingSince: number | undefined;
  let doneSince: number | undefined;
  let lastError: string | undefined;
  let promptSeen = false;
  for (;;) {
    if (remaining() === 0) {
      const unsent = !lastError && doneSince !== undefined && !promptSeen;
      const detail = lastError ? `orca worker-read failed: ${lastError}`
        : unsent ? `the agent is idle and the task is not in its terminal after ${waitMs / 1000}s: the prompt was probably not sent yet`
        : timeoutDetail;
      return { ...base, status: 'unknown', detail, ...(tail.length ? { tail: lastLines(tail) } : {}), ...(unsent ? { unsent: true as const } : {}), cleanup: [] };
    }
    const read = await orca(['worker-read', '--source', 'terminal', '--limit', '80']);
    const obs = parseWorkerRead(read.stdout, read.code, read.error);
    const now = deps.clock();
    if (!obs.ok) {
      lastError = obs.error;
    } else {
      lastError = undefined;
      const o = obs.value;
      // An exited terminal can come back empty: keep the last output that was seen.
      if (o.tail.length > 0) tail = o.tail;
      promptSeen ||= tail.some((l) => TASK_HEADER.test(l));
      const settled = o.liveness === 'exited' || o.outcome === 'failed';
      const message = model ? findRejection(model, tail) : undefined;
      if (message) {
        return { ...base, status: 'rejected', message, detail: `${agent ?? 'the agent'} refused ${model}`, cleanup: settled ? [release] : [stop, release] };
      }
      if (o.outcome === 'succeeded') return { ...base, status: 'reported', detail: 'the worker already reported worker_done', cleanup: [] };
      if (settled) {
        const why = o.stage ? ` (${o.stage.replace(/_/g, ' ')})` : '';
        return { ...base, status: 'failed', detail: `the worker ended without worker_done${why}`, tail: lastLines(tail), cleanup: [release] };
      }
      workingSince = o.activity === 'working' ? (workingSince ?? now) : undefined;
      if (workingSince !== undefined && now - workingSince >= workingMs) {
        return { ...base, status: 'started', detail: `working for ${Math.round((now - workingSince) / 1000)}s with no refusal`, cleanup: [] };
      }
      // The agent's turn ended without worker_done: a refusal not recognized, an error, or a question in its own prompt.
      // An agent idle at an empty prompt, with no task header in its terminal, has not been given the task yet:
      // keep polling, since Orca can deliver the prompt late.
      doneSince = o.activity === 'done' && o.outcome === 'in_progress' ? (doneSince ?? now) : undefined;
      if (doneSince !== undefined && promptSeen && now - doneSince >= 3_000) {
        return { ...base, status: 'stalled', detail: 'the agent stopped without worker_done', tail: lastLines(tail), cleanup: [] };
      }
    }
    await deps.sleep(Math.min(pollMs, remaining()));
  }
}
