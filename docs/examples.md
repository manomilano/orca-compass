---
title: Examples
description: Follow realistic jobs through needs, routing, worker launch, verification and recovery.
---

# Examples

Use these scenarios to route work, launch a worker, and recover from a refused
model. OrcaCompass recommends an agent, model and effort; the orchestrator
(the agent coordinating workers) launches and supervises the worker.
Complete [installation and setup](getting-started.md) first.
Each scenario stands alone unless a step explicitly continues the previous one.

::: info Reading the responses
Every response below is **illustrative**, assembled from response types and
test fixtures rather than captured from an account. Model availability and
usage will change the answer. JSON blocks are valid JSON **excerpts**, for
reading rather than use as complete API fixtures. The surrounding prose marks
omitted properties and array entries with **…**; the JSON contains no comments,
placeholder properties or invalid tokens. An array shown as `[]` is empty.
:::

Only `status: "ok"` carries a route. Read `warnings`, `reasons`, `confidence`,
`downgraded` and `upgraded` before using `launchArgs`; exit code 0 also covers
`decide` and `none`. Keep the full task specification in the worker launch;
`--tier-reason` is only a short classification explanation.

## 1. Route an everyday job

**Situation:** update an existing form's validation message and its regression
test. The steps and expected result are clear, with a few local choices. Use
`daily` (equal `low` needs on all three axes) and `moderate` effort demand:

```sh
orcacompass route --tier daily --demand moderate --tier-reason "Familiar validation change with a regression test." --json
```

**Illustrative response excerpt** (… other decision fields):

```json
{
  "status": "ok",
  "requestedTier": "daily",
  "needs": { "coding": "low", "agentic": "low", "reasoning": "low" },
  "needsSource": "tier",
  "tier": "light",
  "downgraded": false,
  "upgraded": false,
  "route": { "agent": "claude", "model": "claude-haiku-5-5", "effort": "medium" },
  "launchArgs": ["--agent", "claude", "--model", "claude-haiku-5-5", "--effort", "medium"],
  "confidence": "high",
  "reservation": { "id": "rsv_3f9a1c2b7d10", "state": "pending", "buckets": [{ "bucket": "claude:1f0c9a2b7d3e:weekly", "percentPoints": 1 }], "expiresAt": 1793232600000 },
  "warnings": []
}
```

`tier` is the pick's cost tier. It is `light` here because a Light-cost model
covers the `low` needs; a cheaper covering tier is not a downgrade.
`reservation` is the quota this route set aside for its worker: one
percentage point of Claude's weekly window, counted by every later route until
Orca's usage covers it.

**Next:** append each `launchArgs` element as a separate, properly quoted
argument to Orca's worker launch, with the actual task and placement. Then verify
the returned dispatch, as in [the full loop](#_6-launch-verify-and-retry).
See [`route`](commands.md#route) for the complete response.

## 2. Rate difficulty separately from volume

**Situation A:** rename an internal helper across fifty files. Call sites are
known, and the instructions include a search and test command. Coding is `low`,
agentic need (autonomy) is `low`, reasoning is `min`, and effort demand is `low`:

```sh
orcacompass route --need coding=low,agentic=low,reasoning=min --demand low --tier-reason "Mechanical rename with known call sites and checks." --json
```

**Illustrative response excerpt** (… other decision and effort fields):

```json
{
  "status": "ok",
  "needs": { "coding": "low", "agentic": "low", "reasoning": "min" },
  "needsSource": "need",
  "effort": { "source": "demand", "demand": "low", "target": "low", "resolved": "low", "applied": "flag", "policy": "balanced", "adjusted": false, "supportSource": "provider" }
}
```

**Next:** launch with the returned arguments and require the specified search
and tests in the task. Fifty files alone is no reason to raise effort demand.

**Situation B:** investigate a subtle concurrency bug in one file. The worker
must reproduce it, reason about interleavings and adapt its investigation.
Coding and reasoning are `high`, agentic need (autonomy) is `mid`, and demand is `high`:

```sh
orcacompass route --need coding=high,agentic=mid,reasoning=high --demand high --tier-reason "Unknown race condition requiring an interleaving argument and regression test." --json
```

**Illustrative response excerpt** (… other decision and effort fields):

```json
{
  "status": "ok",
  "needs": { "coding": "high", "agentic": "mid", "reasoning": "high" },
  "needsSource": "need",
  "effort": { "source": "demand", "demand": "high", "target": "high", "resolved": "high", "applied": "flag", "policy": "balanced", "adjusted": false, "supportSource": "provider" }
}
```

**Next:** launch and verify; ask for the reproduction, the invariant behind the
fix and a regression test. Needs select capability; demand maps to a supported
effort. Inspect the actual `resolved` and `applied` values: effort can be encoded
in the model id or left to the provider. Use `--effort` only for an explicit user
request. See [rating work](skill-workflow.md#rate-the-work) and
[effort demand](effort.md#effort-demand).

## 3. Restrict agents for one job

**Situation:** the user permits only Claude Code and Codex for this change:

```sh
orcacompass route --tier daily --demand moderate --agent claude --agent codex --json
```

**Illustrative response excerpt** (… other fields and skipped entries):

```json
{
  "status": "ok",
  "route": { "agent": "claude", "model": "claude-haiku-5-5", "effort": "medium" },
  "skipped": [{ "agent": "cursor", "reason": "excluded by request" }]
}
```

**Next:** launch that route. For a different job that permits other agents but
excludes Cursor, use exclusion instead:

```sh
orcacompass route --tier daily --demand moderate --exclude-agent cursor --json
```

**Illustrative response excerpt** (… other decision fields and skipped entries):

```json
{ "skipped": [{ "agent": "cursor", "reason": "excluded by request" }] }
```

**Next:** inspect the new route and launch only if it is `ok`. These flags do
not change the saved agent choices, and cannot enable an agent switched off in
Orca. Both flags are repeatable; use agent ids such as `cursor`, not executable
names such as `cursor-agent`. See [`route`](commands.md#route).

## 4. When the decision comes back {#_4-when-the-decision-comes-back}

**Situation:** a difficult investigation needs `mid` coding and `high` agentic
and reasoning capability. In this illustrative environment, the only eligible
Claude model has an exhausted usage window:

```sh
orcacompass route --need coding=mid,agentic=high,reasoning=high --demand high --agent claude --json
```

**Illustrative response excerpt** (… other decision fields, and the `quota`
of each option):

```json
{
  "status": "decide",
  "downgraded": false,
  "upgraded": false,
  "options": {
    "wait": { "until": 1793282400000, "reason": "the earliest quota reset is in 14h" },
    "use": [],
    "lower": [
      { "agent": "claude", "model": "claude-sonnet-5-5", "effort": "high", "tier": "daily", "shortfall": "below need on agentic (78.2 < 80)", "reason": "weekly 51.75% prospective, available", "use": "--use claude/claude-sonnet-5-5" }
    ]
  }
}
```

**Next:** nothing was picked, and there are no launch arguments. The
Orchestrator chooses, asking the user when the choice is theirs:

- **WAIT** until the reset. `until` is epoch milliseconds, and present only
  when Orca reports a reset time.
- **USE** has no entry here: the eligible model's quota is exhausted, which
  cannot be overridden. With the quota at 95% instead, the same model would be
  listed under `use` and taken with its flag.
- **LOWER:** Sonnet would take the job with a lower agentic need. Either route
  again with `agentic=mid`, or take that route as it is:

```sh
orcacompass route --need coding=mid,agentic=high,reasoning=high --demand high --agent claude --use claude/claude-sonnet-5-5 --json
```

**Illustrative response excerpt** (… other fields, including coverage details):

```json
{
  "status": "ok",
  "tier": "daily",
  "downgraded": true,
  "route": { "agent": "claude", "model": "claude-sonnet-5-5", "effort": "high" },
  "warnings": ["claude-sonnet-5-5 falls short of the job's needs by 1 band step (agentic); effort is not raised to make up for it: split the job or add stronger checks"]
}
```

**Next:** read the shortfall in `quality` and the warning, narrow the task or add
checks, and mention the downgrade in the worker specification. Effort does not
rise to compensate. Requirements are never lowered on their own: a weaker model
is used only after this explicit choice. A cheaper cost tier that *covers* all
needs is not a downgrade and is routed normally. See
[outcomes](tiers-and-routing.md#outcomes-ok-decide-none).

## 5. Save a favorite and a ban

**Situation:** the user asks to favor Codex for everyday work and never route a
Haiku model. These commands change saved preferences for later jobs:

```sh
orcacompass prefer daily codex
orcacompass ban claude-haiku
orcacompass route --tier daily --demand moderate --json
```

**Illustrative response excerpt from the later route** (… other fields and
entries in `reasons` and `skipped`):

```json
{
  "status": "ok",
  "route": { "agent": "codex", "model": "gpt-6.1-terra", "effort": "medium" },
  "reasons": ["preferred route, available"],
  "skipped": [{ "agent": "claude", "model": "claude-haiku-5-5", "reason": "banned by you" }]
}
```

**Next:** launch and verify. The favorite is subject to availability and usage:
once its usage, with reserved workers and one more, reaches `preferRiskLimit`
(90% by default), routing goes on without it. Relay any `preferred … skipped` warning rather than
silently ignoring the preference. A family ban applies across agents that offer
matching models. See [`prefer`](commands.md#prefer) and
[`ban` / `unban`](commands.md#ban-unban).

## 6. Launch, verify and retry

**Situation:** add a CSV export button with tests. Rate the work, then make one
route call for this worker:

```sh
orcacompass route --need coding=mid,agentic=mid,reasoning=low --demand moderate --json
```

**Illustrative response excerpt** (… other decision fields):

```json
{
  "status": "ok",
  "route": { "agent": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
  "launchArgs": ["--agent", "claude", "--model", "claude-sonnet-5-5", "--effort", "medium"],
  "reservation": { "id": "rsv_3f9a1c2b7d10", "state": "pending" }
}
```

Append that array to the launch, preserving Orca's normal lifecycle options.
Here the placement is the current worktree:

```sh
orca orchestration worker-start --spec "Add CSV export to the reports page; test escaping and empty results, and run the relevant tests." --worktree current --agent claude --model claude-sonnet-5-5 --effort medium --json
```

Use the actual `dispatchId` from Orca's receipt, and the `reservation.id` of
the route. Suppose the dispatch is `ctx_export_1`:

```sh
orcacompass verify --dispatch ctx_export_1 --reservation rsv_3f9a1c2b7d10 --json
```

A refusal releases that reservation at once, since nothing ran; a worker that
started keeps it under the same record.

**Illustrative refusal response excerpt** (… `next`, which lists the recovery
steps):

```json
{
  "status": "rejected",
  "dispatchId": "ctx_export_1",
  "taskId": "task_export",
  "agent": "claude",
  "model": "claude-sonnet-5-5",
  "message": "There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it.",
  "detail": "claude refused claude-sonnet-5-5",
  "cleanup": [
    ["orca", "orchestration", "worker-stop", "--dispatch", "ctx_export_1", "--json"],
    ["orca", "orchestration", "worker-release", "--dispatch", "ctx_export_1", "--json"]
  ],
  "skippedForHours": 168
}
```

The agent listed the model but this account refused it. Verification records the
refusal; later routes skip that agent/model for `rejectionTtlHours` (168 hours by
default). Run each returned `cleanup` argv in order, checking success before the
next step. If the worker already exited, the returned list contains only release.
For the response above:

```sh
orca orchestration worker-stop --dispatch ctx_export_1 --json
orca orchestration worker-release --dispatch ctx_export_1 --json
```

Only after cleanup succeeds, route again with the same flags:

```sh
orcacompass route --need coding=mid,agentic=mid,reasoning=low --demand moderate --json
```

**Illustrative replacement response excerpt** (… other fields and skipped entries):

```json
{
  "status": "ok",
  "route": { "agent": "codex", "model": "gpt-6.1-sol", "effort": "medium" },
  "launchArgs": ["--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "medium"],
  "skipped": [{ "agent": "claude", "model": "claude-sonnet-5-5", "reason": "refused by claude 0m ago: \"There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it.\"" }]
}
```

Start the replacement on the **same Task**, referencing the old dispatch and
keeping the same placement. Use the new `launchArgs`:

```sh
orca orchestration worker-start --task task_export --retry-of ctx_export_1 --worktree current --agent codex --model gpt-6.1-sol --effort medium --json
```

Suppose the replacement receipt gives `ctx_export_2`:

```sh
orcacompass verify --dispatch ctx_export_2 --json
```

**Illustrative success response excerpt** (… task, agent, model and `next`):

```json
{
  "status": "started",
  "dispatchId": "ctx_export_2",
  "detail": "working for 8s with no refusal",
  "cleanup": []
}
```

**Next:** tell the user which model was refused and what replaced it, then wait
for `worker_done` through normal Orca supervision. When it arrives, run
`orcacompass release --dispatch ctx_export_2`: the worker's quota stays
reserved until Orca's next usage refresh covers what it consumed. `started` means startup was
observed without a refusal; it does not verify the code. Review the result and
checks required by the task. Never stop a worker reported as `started` just to
retry a route. See [verify and rejections](verify-and-rejections.md).

Other verification outcomes need different actions:

| Response | What the orchestrator does next |
| --- | --- |
| `reported` | Handle the existing `worker_done` result. |
| `unknown`, `unsent: true` | Read the terminal; do not reroute. Wait for task delivery and verify once it is working. |
| `unknown` without `unsent` | Report the timeout and continue normal supervision; do not repeatedly extend startup verification. |
| `stalled` | Read `tail`: answer a question through Orca's normal workflow, or recover from a model/account/limit error with cleanup and an agent exclusion. |
| `failed` | Read `tail`, release as instructed, route with `--exclude-agent` for the failing agent and retry the same Task. |

## 7. Read an answer that needs attention

**Situation:** rerun the everyday validation job in different availability
conditions. These are independent outcomes of this command:

```sh
orcacompass route --tier daily --demand moderate --json
```

**Illustrative `none` response excerpt** (… other decision fields):

```json
{ "status": "none", "reasons": ["no usable agent"] }
```

**Next:** inspect `orcacompass agents` and resolve the stated availability
problem. If using Orca's default fallback, say no recommendation was available
and omit `--model` and `--effort`; preserve explicit user model choices and agent
constraints. Do not assume `none` satisfies a user's exact effort or model request.

**Illustrative low-confidence response excerpt** (… other fields and reasons):

```json
{
  "status": "ok",
  "confidence": "low",
  "quota": { "status": "unknown", "binding": null, "remaining": null, "prospective": null, "buckets": [] },
  "reasons": ["claude claude-haiku-5-5: usage unknown (Orca not reachable)"],
  "warnings": ["usage of claude is unknown: usage unknown (Orca not reachable); routed without a quota check"]
}
```

**Next:** surface the unknown usage and inspect `status`. A route exists, but
it was taken without a quota check and there is no basis for quoting usage
percentages. Unknown usage is never read as 0% or as exhausted. Very stale
usage and a window that reset since the snapshot are unknown as well; read the
reason.

**Illustrative caution response excerpt** (… other fields):

```json
{
  "status": "ok",
  "tier": "light",
  "downgraded": false,
  "upgraded": false,
  "quota": { "status": "caution", "prospective": 87.5 },
  "warnings": ["weekly quota would be 87.5% used with this worker (caution); resets in 14h"]
}
```

**Next:** relay the warning and keep the job small: counting the workers
already reserved and this one, the pick's quota is between 85% and 90%, and no
eligible route was available below that. From 90% nothing is picked
automatically and the result is `decide`; follow
[the decision example](#_4-when-the-decision-comes-back), where there are no
launch arguments to use. A pick from a pricier cost tier than expected needs no
warning: its quota had more room, and `reasons` shows its `selection` line
and the `next best` route. `upgraded` is `true` only when no route at or
below the requested tier is eligible; its warning reads
`no model in the <tier> cost tier covers the job; using <tier>`. See
[troubleshooting](troubleshooting.md#a-route-says-decide-or-none).

## 8. Inspect the decision's inputs

**Situation:** understand why a job routed differently today. Inspect the
available agents and usage, the cost tiers and the capability evidence:

```sh
orcacompass status --json
orcacompass tiers
orcacompass ranking --axis coding
```

**Illustrative `status` response excerpt** (… other fields and agents):

```json
{
  "agents": [{ "agent": "codex", "installed": true, "enabledInOrca": "yes", "models": 4, "usage": null }]
}
```

**Illustrative `tiers` text excerpt** (… model rows):

```text
cost: light < $1 ≤ daily < $5 ≤ advanced < $12 ≤ frontier (per million tokens, 3:1 blended)
```

**Illustrative `ranking --axis coding` text excerpt** (… other model rows):

```text
gpt-6.1-sol  daily $4.00/M price  evidence frontier  coding 79.8 A measured(5)  agents: codex
```

**Next:** use `status` for availability and usage, `tiers` for cost grouping,
and `ranking` for the evidence behind capability coverage. The price is sorting
metadata, not a statement of subscription charges. `tiers --axis coding` groups
by coding evidence bands instead of cost. These inspection commands may refresh
local metadata caches; they do not launch workers. Consult
[`status`](commands.md#status), [`tiers`](commands.md#tiers) and
[`ranking`](commands.md#ranking) for the full fields.
