---
description: Verify that a worker accepted its model, recognize launch refusals and replace a rejected worker.
---

# Verify and rejections

Run `orcacompass verify` right after starting a worker to learn whether its
agent accepted the model and how to recover if it did not. OrcaCompass saves
recognized refusals so later routes skip that agent and model temporarily.

Discovery is an estimate: a listed model may be unavailable to your account.
For example, Claude's cached catalog may be stale or discovery may fall back
to the evidence snapshot. A Codex model may be enterprise-only, or a Cursor
model may be disabled in the account.

`orca orchestration worker-start` reports the requested model as effective
without checking whether the agent can use it. `orcacompass verify` checks
the worker's output after launch. Code: `src/verify.ts`, `src/routing/rejection.ts`,
`src/routing/rejections.ts`.

## What goes wrong without it

These are observed agent behaviors; OrcaCompass's code does not verify the
behavior of the agents themselves:

| Agent | When launched with a model it cannot use |
| --- | --- |
| Codex | Prints the refusal and idles at its prompt; no `worker_done`. Orca shows a live worker needing nothing |
| Claude Code | Same: prints the refusal and idles |
| Cursor | `cursor-agent` exits 1; Orca fails the start after its 60 s readiness wait |
| Grok Build | Exits 1 |
| Antigravity | Exits 1 |
| OpenCode | Prints `Error: Model unavailable: …` |

## How `verify` works

```sh
orcacompass verify --dispatch <dispatchId> [--reservation <id>] [--wait 60] --json
```

1. `orca orchestration worker-show --dispatch <id> --json`: the effective
   agent and model, and the Task id.
2. With 1.5 s between polls, `orca orchestration worker-read --dispatch <id> --source
   terminal --limit 80 --json`: Orca's fleet projection (activity, outcome,
   liveness) and the terminal tail.
3. Decide:

| Verdict | Rule |
| --- | --- |
| `rejected` | A terminal line **names the model** Orca reports as effective and matches one of the known refusal phrases (below). Soft warnings that still run the model do not count |
| `reported` | Orca's outcome is `succeeded`: the worker already sent `worker_done` |
| `failed` | The terminal exited or the outcome is `failed`, with no recognized refusal |
| `started` | Activity has been `working` for 8 s (`workingMs`) with no refusal |
| `stalled` | The task header is in the terminal and activity is `done` while the outcome is still `in_progress` for 3 s: the agent ended its turn without `worker_done` (an unrecognized refusal, another error, or a question in its own prompt) |
| `unknown` | No verdict within `--wait` seconds (default and maximum 60), `worker-show` failed, or the last `worker-read` failed. With `unsent: true`: at the deadline the agent was idle and Orca's `=== TASK ===` header had never appeared in its terminal, so the prompt was probably not sent yet |

The rules are checked in the order of the table on every poll, so a refusal
wins over every other verdict.

The total timeout includes `worker-show`, reads, and polling delays. Each
command uses at most 20 s and is shortened to the time remaining. Verification
returns immediately when a verdict is available. `--wait` accepts 0–60 s;
0 returns `unknown` immediately, without calling Orca. After a timeout, report
it and continue normal Orca supervision instead of repeating startup
verification.

`verify` reads worker state and writes only detected refusals and reservation
updates to its local cache. It returns `cleanup` argument arrays for the
orchestrator (the agent coordinating workers) to run:

| Verdict | `cleanup` |
| --- | --- |
| `rejected`, worker still running | `worker-stop`, then `worker-release` |
| `rejected` after the worker exited or failed, or `failed` | `worker-release` |
| `started`, `reported`, `stalled`, `unknown` | none |

`verify` exits 0 for every verdict. A missing `--dispatch` or a `--wait`
outside 0–60 is a usage error (exit 1).

## Refusal phrases recognized

Seen in November 2026 with Codex 0.166, Claude Code, cursor-agent, grok 1.0.70,
agy 1.4.11 and opencode, launched with an unknown or unavailable model:

| Agent | Refusal (must be on a line that names the model) |
| --- | --- |
| Codex | `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.` |
| Claude Code | `There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.` |
| Cursor | `Cannot use this model: claude-opus-9-9. Available models: …` |
| Grok Build | `Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".` |
| Antigravity | `invalid model selection (--model "gemini-9-fake" …): model gemini-9-fake is not recognized as a known model …` |
| OpenCode | `Error: Model unavailable: openrouter/fake/nonexistent-9` |

Matching is case-insensitive on these fragments: `model is not supported`,
`issue with the selected model`, `cannot use this model`, `couldn't set model`,
`unknown model id`, `invalid model selection`, `not recognized as a known
model`, `model unavailable`. Long lines wrap in a terminal, so each line is
also tried joined with the next. The saved message drops the agent's
decoration (`■`, `ERROR:`), Cursor's list of available models, and a sentence
cut off by wrapping; it is capped at 240 characters.

Not refusals: Codex's ``Model metadata for `x` not found`` and Claude Code's
`doesn't recognize the model "x"`, which still run the model. A changed wording
in a newer agent version shows up as `stalled` or `failed` with the terminal
tail instead of `rejected`.

## What a rejection does

OrcaCompass saves each `rejected` verdict to `rejected-models.json` in the
cache: the agent, model (the launch id), refusal text and time. For `rejectionTtlHours`
(168 hours, a week, by default):

- every `route` skips that agent and model, in any tier, listing it under
  `skipped` as `refused by codex 2h ago: "The 'claude-opus-5-5' model is not
  supported when using Codex with a ChatGPT account."`;
- `status` shows the same;
- a rejection matches any of the model's launch ids, so Cursor's
  `claude-opus-5-5-high` and `claude-opus-5-5-low` are both skipped after one
  of them was refused;
- a new refusal of the same agent and model replaces the older entry, and
  entries older than `rejectionTtlHours` are dropped when the file is written.

```sh
orcacompass rejected           # what is skipped, with the agent's words and age
orcacompass rejected --clear   # forget everything (for example after upgrading a plan)
```

`rejected --json` returns `{ rejectionTtlHours, cleared, rejections }`, where
`cleared` is the number of entries `--clear` removed.

## What verify does to the reservation {#reservations}

Every route reserves quota for its worker (see
[Reservations](tiers-and-routing.md#reservations)). `verify` settles that
reservation with what it saw. Pass the route's `reservation.id` as
`--reservation`; without it, the worker is matched to the oldest unbound
pending reservation for the same agent and model (or, if none is pending, the
oldest unbound one abandoned after `pendingMinutes`).

| Verdict | Reservation |
| --- | --- |
| `started`, `stalled` | Bound to the Dispatch and marked `running` (reviving a record whose end was only inferred from a timeout). It is the same record: nothing is reserved twice |
| `unknown` | Bound to the Dispatch and left `pending`, so Orca's worker list moves it on at the next `route` or `status` (or `pendingMinutes` abandons it) |
| `reported` | `completed`: held until Orca's next usage refresh covers it |
| `rejected` | `failed_before_launch`: nothing ran, so the quota is free again at once, for the replacement route |
| `failed` | `cancelled_after_consumption`: the worker may have used quota, so it is held until a fresh snapshot |

The JSON carries the result as `reservation` (`{ id, state }`, or `null`
when no reservation matched, for example for a worker launched without
`orcacompass route`). A reservation already bound to another Dispatch is
never moved: `reservationError` reports the mismatch and changes nothing.
When the worker later finishes, end its reservation with
`orcacompass release --dispatch <dispatchId>`.

## The replacement flow

After `rejected`, the orchestrator:

1. runs each `cleanup` argv in order and checks it succeeded;
2. routes again with the same flags (the refused model is now skipped and its
   reservation released, so the route differs);
3. starts the replacement on the same Task:
   `orca orchestration worker-start --task <taskId> --retry-of <dispatchId> …`
   with the same placement and the new `launchArgs`;
4. tells the user which model was refused and what replaced it.

For `failed`, run the cleanup; if the tail shows the agent failing to start,
route again with `--exclude-agent <agent>` for this job, start the replacement
the same way, and tell the user which agent failed to start, why, and how they
can fix it.

For `stalled`, read `tail` first. If it reports an error (model, account,
limits), stop the worker with `orca orchestration worker-stop --dispatch <id>
--json`, route again with `--exclude-agent <agent>` and start the replacement
with `--retry-of <dispatchId>`. If it asks a question, answer it in its
terminal; otherwise keep waiting.

For `unknown` with `unsent: true`, do not reroute: the model was not refused
and the agent has not started the task. Read the terminal and run `verify`
again once the agent is working.

The `next` list in the output spells out these steps for the verdict at hand.

## Example

Illustrative output for a Codex worker that refused its model and is still
running:

```sh
$ orcacompass verify --dispatch d-7f3a --json
{
  "dispatchId": "d-7f3a",
  "taskId": "t-19",
  "agent": "codex",
  "model": "claude-opus-5-5",
  "status": "rejected",
  "message": "The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.",
  "detail": "codex refused claude-opus-5-5",
  "cleanup": [
    ["orca", "orchestration", "worker-stop", "--dispatch", "d-7f3a", "--json"],
    ["orca", "orchestration", "worker-release", "--dispatch", "d-7f3a", "--json"]
  ],
  "skippedForHours": 168,
  "next": [
    "clean up: orca orchestration worker-stop --dispatch d-7f3a --json, then orca orchestration worker-release --dispatch d-7f3a --json",
    "route again with the same flags; codex claude-opus-5-5 is skipped for 168h",
    "start the replacement on the same Task: orca orchestration worker-start --task t-19 --retry-of d-7f3a --worktree <same placement> <new launchArgs> --json"
  ]
}
```

Text output has the same content: the verdict line
(`<status>: <agent> · <model> — <detail>`), `agent said: …` for a rejection,
the last terminal lines prefixed with `|` (for `stalled`, `failed` and
`unknown`), then a numbered `next:` list.
