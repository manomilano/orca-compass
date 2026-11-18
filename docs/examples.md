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
`wait` and `none`. Keep the full task specification in the worker launch;
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
  "warnings": []
}
```

`tier` is the pick's cost tier. It is `light` here because a Light-cost model
covers the `low` needs; a cheaper covering tier is not a downgrade.

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

## 4. Refuse a capability shortfall

**Situation:** a difficult investigation needs `mid` coding and `high` agentic
and reasoning capability. In this illustrative environment, its only covering
Claude model has a blocked usage pool:

```sh
orcacompass route --need coding=mid,agentic=high,reasoning=high --demand high --agent claude --no-downgrade --json
```

**Illustrative response excerpt** (… other decision fields):

```json
{
  "status": "wait",
  "downgraded": false,
  "upgraded": false,
  "waitUntil": 1793282400000
}
```

**Next:** do not launch a replacement model. `waitUntil` is epoch milliseconds;
wait for reset. If the user's constraints permit a capability shortfall, the
orchestrator can repeat the same request without `--no-downgrade`:

```sh
orcacompass route --need coding=mid,agentic=high,reasoning=high --demand high --agent claude --json
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
rise to compensate. A cheaper cost tier that *covers* all needs is not a
downgrade; `--no-downgrade` allows that route. It prevents capability shortfalls
and Cursor `auto` fallback, not every change of cost tier. See
[fallbacks](tiers-and-routing.md#fallbacks-downgrade-upgrade-wait-none).

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
  "reasons": ["preferred route, on pace for 82%"],
  "skipped": [{ "agent": "claude", "model": "claude-haiku-5-5", "reason": "banned by you" }]
}
```

**Next:** launch and verify. The favorite is subject to availability and usage:
when it exceeds `preferRiskLimit` (100% by default), a known within-limit
alternative can replace it. Relay any `preferred … skipped` warning rather than
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
  "launchArgs": ["--agent", "claude", "--model", "claude-sonnet-5-5", "--effort", "medium"]
}
```

Append that array to the launch, preserving Orca's normal lifecycle options.
Here the placement is the current worktree:

```sh
orca orchestration worker-start --spec "Add CSV export to the reports page; test escaping and empty results, and run the relevant tests." --worktree current --agent claude --model claude-sonnet-5-5 --effort medium --json
```

Use the actual `dispatchId` from Orca's receipt. Suppose it is `ctx_export_1`:

```sh
orcacompass verify --dispatch ctx_export_1 --json
```

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
for `worker_done` through normal Orca supervision. `started` means startup was
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
  "risk": null,
  "reasons": ["claude claude-haiku-5-5: usage unknown (Orca not reachable)"]
}
```

**Next:** surface the unknown usage and inspect `status`. A route exists, but
there is no basis for quoting usage percentages. Very stale usage can also lower
confidence; read the reason rather than inferring headroom.

**Illustrative near-limit response excerpt** (… other fields):

```json
{
  "status": "ok",
  "tier": "light",
  "downgraded": false,
  "upgraded": false,
  "warnings": [
    "weekly quota is 96% used; resets in 14h",
    "selected route is expected to end above 90% of its usage window"
  ]
}
```

**Next:** relay the warnings and keep the job small: the pick is close to its
usage limit, and no route with more room covered the job. A route is left out
for usage only when Orca reports a window as 100% used. A pick from a pricier
cost tier than expected needs no warning: it had more room, and `reasons`
shows its `selection` score and the `next best` route. `upgraded` is `true`
only when no route at or below the requested tier covers the job; its warning
reads `no model in the <tier> cost tier covers the job; using <tier>`.
For `wait`, follow
[the reset example](#_4-refuse-a-capability-shortfall); there are no launch arguments
to use. See [troubleshooting](troubleshooting.md#a-route-says-wait-or-none).

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
