# Skill workflow

The Skill (`skills/orcacompass/SKILL.md`) tells an orchestrator how to use
OrcaCompass when it delegates work to Orca workers. This page explains that
workflow and the reasoning behind each step. Explicit user instructions about
agent or model always take precedence over a recommendation.

## Rate the work

Rate coding, agentic and reasoning separately as `min`, `low`, `mid` or
`high`, using the examples in the packaged Skill.
Rate effort demand separately as low, moderate, high or exceptional.
`--tier` remains a shorthand for equal needs on every axis. Favorites still
apply per tier.

## 1. Rate the job

Two independent ratings, both from the work itself:

- **Tier**: how capable a model the job needs (`light`, `daily`, `advanced`,
  `frontier`). Rate the hardest part, not the average. Never rate by spare
  capacity: a Light job does not go to Frontier because Frontier is idle.
- **Demand**: how much the job needs to think (`low`, `moderate`, `high`,
  `exceptional`). The amount of work is not the demand: a rename across fifty
  files is `low`; a subtle race in one file is `high`.

Rules of thumb from the Skill:

- Between two tiers, take the lower one when the result is cheap to check and
  retry, the higher one when a wrong result is costly or hard to notice.
- Split mixed jobs: a bulk mechanical edit plus one hard decision is a Light
  worker and an Advanced (or Daily) worker, not one Advanced worker.
- Move up a tier only when a worker failed for lack of capability, not for
  missing context; give it the context first.
- Costly failure calls for tests and review in the task spec, not only more
  thinking.

Full tier and demand tables: [Tiers and routing](tiers-and-routing.md#the-four-tiers)
and [Effort](effort.md#reasoning-demand).

### 2. Route

One call per worker:

```sh
orcacompass route --need coding=mid,agentic=low,reasoning=low --demand moderate --tier-reason "Multi-file change with tests and routine judgement." --json
```

Options the orchestrator may add:

| Flag | When |
| --- | --- |
| `--demand <d>` | Always, when the demand was rated; without it the tier's default effort applies |
| `--tier-reason <text>` | The coordinator's short explanation of the tier, kept in the tool exchange and explained in chat only on request. Returned as `tierReason` and in `reasons`. Existing callers can omit it |
| `--agent <id>` (repeatable) | The user restricted the job to some agents. Also lifts OpenCode's last-resort status for this route |
| `--exclude-agent <id>` (repeatable) | The user excluded an agent for this job |
| `--effort <e>` | Only when the user asked for a specific effort. Never snapped: routes that cannot apply it exactly are left out |
| `--no-downgrade` | Never fall back to a lower tier; blocked candidates return `wait` instead |

There is no `--model` flag. If the user names an exact model, launch it
directly and skip OrcaCompass. For a lasting constraint ("never use Grok"),
write config with `orcacompass agents disable grok` instead of per-route flags.

Parse the JSON and read `status`, `reasons`, `warnings`, `confidence`,
`downgraded`, `upgraded`. Exit code 0 alone does not mean a route exists.

### 3. Launch

For `status: "ok"`, append `launchArgs` to Orca's command, each element as its
own properly quoted argument, together with Orca's worktree and lifecycle flags:

```sh
orca orchestration worker-start --spec "<actual task specification>" --agent claude --model claude-sonnet-5-5 --effort medium
```

Notes:

- `launch` in the JSON is a readable template with a `<task>` placeholder, not
  for automation (it does not shell-escape).
- Cursor and Antigravity Gemini models encode effort in the model id
  (`claude-opus-5-5-high`, `gemini-3.8-flash-high`): `route.effort` is `null` and
  `launchArgs` has no `--effort`.
- Cursor's route for Light and Daily is usually `auto` (Cursor picks the model;
  at most medium confidence). An Advanced request that falls back to Daily can
  receive it.
- An OpenCode route needs `--worktree current` or an existing worktree: Orca
  refuses `--model` for OpenCode in a new one. The route's `reasons` say so.

### 4. Verify

Right after `worker-start` returns a `dispatchId`:

```sh
orcacompass verify --dispatch <dispatchId> --json
```

Orca does not check that an agent can use the model it was given. Codex and
Claude Code print a refusal and idle (Orca shows a live worker needing
nothing); Cursor, Grok and Antigravity exit. `verify` reads the worker's
terminal with a total budget of 60 s, including `worker-show`, and returns
as soon as it has a verdict. `--wait` can shorten the budget to 0–60 s.
It answers:

| `status` | Meaning | What to do |
| --- | --- | --- |
| `started` | Working for 8 s or more with no refusal | Wait for `worker_done` as usual |
| `reported` | Already sent `worker_done` | Nothing |
| `rejected` | The agent refused the model (`message` has its words). Saved; every route skips it for `rejectionTtlHours` | Run each `cleanup` argv in order (stop, release), route again with the same flags, start the replacement on the same Task with `--task <taskId> --retry-of <dispatchId>`. Tell the user |
| `stalled` | The agent ended its turn without `worker_done` and no known refusal | Read `tail`. Model/account/limit error: stop it and route again with `--exclude-agent`. A question: answer it in its terminal |
| `failed` | The worker ended on its own | Read `tail`, release it, replace it as for `rejected`, excluding that agent for this job |
| `unknown` | No verdict within `--wait` | Report the timeout and continue normal Orca supervision without repeating startup verification |

Never start the replacement before the cleanup succeeded, and never stop a
worker `verify` called `started`. Details: [Verify and rejections](verify-and-rejections.md).

### 5. Handle the result

| Field | Action |
| --- | --- |
| `downgraded: true` | Mention the downgrade and reason in the worker's task spec. Effort is not raised to make up for a weaker model; narrow the task or add checks |
| `upgraded: true` | Surface the warning. Happens only when the requested and all lower tiers have no candidates, never to dodge usage limits |
| `effort.applied` | `flag`, `model-id`, or `provider-default` (the agent decides). Never claim an effort was set when it is `provider-default` |
| warning `… is a last-resort agent …` | The route costs money per token or runs on this machine; tell the user before launching several workers on it |
| `status: "wait"` | Read `waitUntil` (epoch ms). Wait, or retry without `--no-downgrade` if the user allows a downgrade |
| `status: "none"` | Launch with Orca's default (no `--model`, no `--effort`) and say no recommendation was available. Keep any explicit user model choice |
| command missing | Same default fallback; say OrcaCompass was absent |
| exit 1 | Usage or runtime error: fix the command or report it |
| exit 2 | `config error: <path>: <message>`: report and resolve before retrying |
| low confidence | Usage unknown or more than 4x `usageStaleMinutes` old. Do not invent percentages |
| medium confidence | Usage moderately stale (the reason says "usage 45m old"), or a recent hand-out |
| catalog source `snapshot` | Metadata may be old; run `orcacompass refresh` when online |
| warning `preferred … skipped: …` | The user's favorite would exceed its risk limit or is blocked; tell them the line |

## Managing providers through the Skill

| The user says | The orchestrator runs |
| --- | --- |
| "Which agents are available?" | `orcacompass agents`, then reports the table |
| "Stop using Grok" / "use Codex again" | `orcacompass agents disable grok` / `orcacompass agents enable codex` |
| "Only use Claude and Codex" | `orcacompass agents only claude codex` |
| "Use everything again" | `orcacompass agents reset` |
| "Use Codex for everyday jobs" | maps "everyday" to `daily`: `orcacompass prefer daily codex` |
| "Never use Haiku" | `orcacompass ban claude-haiku` |
| "Never use Grok Build at all" | an agent, not a family: `orcacompass agents disable grok` |

An agent the user has not enabled in Orca is never routed (`not enabled in
Orca`); the orchestrator tells the user to enable it in Orca's settings rather
than working around it. If the setting reads `unknown`, it says so.

## Several workers at once

Routing is stateless: back-to-back calls may return the same route, and nothing
reserves capacity for workers that were just launched. When launching several
workers at once, consider the route and its unblocked `alternatives`.
Alternatives have no `launchArgs`: route again with `--agent <agent>` for the
one you pick, then use that decision's launch arguments.

Inspect `quality` for coverage and evidence: estimated and assumed placements are provisional. Cursor `auto` is a fallback where Cursor chooses the model. Recent hand-outs are remembered, so manual spreading across alternatives is unnecessary.
