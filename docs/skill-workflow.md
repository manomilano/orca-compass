---
description: Follow the packaged Skill from setup and job ratings through routing, launch verification, and result handling.
---

# Skill workflow

This page explains how an orchestrator (the agent coordinating workers) uses
the packaged Skill (`skills/orcacompass/SKILL.md`) to set up OrcaCompass,
rate work, request a route, and launch and verify Orca workers. Explicit user
instructions about agent or model take precedence over a recommendation.

::: info Two skills work together
Use OrcaCompass alongside Orca's orchestration skill. OrcaCompass recommends
agent, model and effort; Orca's skill supplies placement and lifecycle rules.
:::

## First-time setup

When the user asks for setup, or before the first route in a conversation,
read `orcacompass setup --json`. If `configExists` is false, offer setup once.
If declined, run `orcacompass setup --skip`, report the agents it says are
used, and route with the defaults.

For chat setup, keep that JSON document and ask each question in a separate
message, showing the current `config` as defaults. A skipped answer keeps its
setting:

1. **Agents:** show every agent's installation, `enabledInOrca`, `orcaUsage`
   and model count. Start with `preselected: true`. Disable only preselected
   agents the user dropped and enable only agents they added, using
   `orcacompass agents disable|enable <id>...`. An added agent whose Orca
   setting is `no` also needs enabling in Orca's settings.
2. **Favorites:** for each tier show `pick`, `preferred`, and `options`
   (agent, model, `onPacePercent`, `blocked`). Apply the option's `model` with
   `orcacompass prefer <tier> <agent> <model>`, clear with
   `orcacompass prefer clear <tier>`, and change the limit with
   `orcacompass prefer --risk-limit <percent>`. Above `config.preferRiskLimit`
   (default `defaultPreferRiskLimit`, 100%), a known within-limit, unblocked
   covering alternative replaces a favorite; otherwise it is retained with
   a warning.
3. **Bans:** show `families` and `config.banModels`. Apply model or family
   bans with `orcacompass ban <entry>...` and remove them with
   `orcacompass unban <entry>...`. Use agent selection for whole agents.
4. **Finish:** run `orcacompass setup --complete --json` even if all defaults
   were kept. Summarize agents, favorites and their limit, bans, one example
   route per tier (including warnings), and `configPath`.

Use these commands to write config; do not edit it by hand. The user can
also run `orcacompass setup` in a terminal. See
[First-time setup](getting-started.md#first-time-setup).

## The five steps for each job {#rate-the-work}

For each job the orchestrator rates it, requests a route, launches the worker,
verifies the launch and handles the result.

### 1. Rate the job

Rate capability needs and effort demand separately using the packaged Skill's
rubric below. [Favorites](tiers-and-routing.md#preferences-pins) still apply
per requested tier.

Rate all three needs from the work itself, regardless of spare capacity:

| Need | What it measures |
| --- | --- |
| coding | Implementation difficulty |
| agentic | Autonomy and adaptive execution |
| reasoning | Cognitive problem-solving difficulty |

Use the packaged Skill's definitions for `min`, `low`, `mid`, `high`, and
`top`. Use `top` only when `high` is not enough: a high route already failed,
or a mistake would be expensive. Most hard work is `high`.

Use `--tier` only for a job with equal needs on all axes: `light`, `daily`,
`advanced`, and `frontier` map to `min`, `low`, `mid`, and `high`. There is no
tier for `top`; use `--need`.

Rate effort demand independently, by how likely a direct first attempt is to
be wrong and how hard that would be to notice: `low` for known steps whose
mistakes are obvious, `moderate` for a clear path with a few local choices,
`high` when the worker must work out what to do and a wrong answer can look
right, and `exceptional` for several of those with a costly or hard-to-detect
mistake, or after a `high` attempt failed. When unsure, `moderate`. A rename
across fifty files can be `low`; a subtle race in one file can be `high`.
Costly failure also calls for tests and review in the task spec.

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
| `--no-downgrade` | Prevent capability shortfalls and Cursor Auto fallback; covering routes from any cost tier remain allowed |

::: warning Preference exception in this checkout
The router checks a favorite before the normal `--no-downgrade` branch. An
unblocked favorite that falls short can therefore still be returned as a
downgrade with that flag. Inspect `quality.covers` and `downgraded` before
launching when capability coverage is required.
:::

There is no `--model` flag. If the user names an exact model, launch it
directly and skip OrcaCompass. For a lasting constraint ("never use Grok"),
write config with `orcacompass agents disable grok` instead of per-route flags.

Supported agent IDs are `claude`, `codex`, `cursor`, `grok`, `antigravity`,
`opencode`, and `muse`. Correct an unknown-ID warning and route again.
OpenCode is a last resort by default; use `--agent opencode` only when the
user asks for it. Its routes require an existing Orca worktree.

Valid explicit effort levels are `none`, `minimal`, `low`, `medium`, `high`,
`xhigh` (also `extra-high`) and `max`. Unsupported spellings such as `ultra`
exit 1. If no route supports the exact requested level, ask the user or route
without `--effort`.

Routing compares every covering route across cost tiers: the most usage
headroom wins, after a price adjustment of at most five points. A route is
blocked only when Orca reports a usage window as 100% used. A pick that is
close to its limit, or expected to end above `usageRiskLimit` (default 90%),
carries a warning; relay it. Prices never change evidence scores or need cuts.

Parse the JSON and read `status`, `reasons`, `warnings`, `confidence`,
`downgraded` and `upgraded`. Exit code 0 alone does not mean a route exists.

### 3. Launch

For `status: "ok"`, append `launchArgs` to Orca's command, each element as its
own properly quoted argument, together with Orca's worktree and lifecycle flags:

Illustrative launch after appending a returned argument array:

```sh
orca orchestration worker-start --spec "<actual task specification>" --agent claude --model claude-sonnet-5-5 --effort medium
```

Notes:

- `launch` in the JSON is a readable template with a `<task>` placeholder, not
  for automation (it does not shell-escape).
- Cursor and Antigravity Gemini models encode effort in the model id
  (`claude-opus-5-5-high`, `gemini-3.8-flash-high`): `route.effort` is `null` and
  `launchArgs` has no `--effort`.
- Cursor `auto` is a fallback when no named model can be routed. It has no
  evidence profile or cost tier and never competes with ranked models.
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
| `rejected` | The agent refused the model (`message` has its words). Saved; every route skips it for `rejectionTtlHours` | Run each `cleanup` argv in order (stop then release, or release only if already exited), route again with the same flags, start the replacement on the same Task with `--task <taskId> --retry-of <dispatchId>`. Preserve the same placement and tell the user what was refused and what replaced it |
| `unknown` with `unsent: true` | The agent is idle and the task never reached its terminal | Do not reroute. Read the terminal, keep waiting, and run `verify` again once it is working |
| `stalled` | The agent ended its turn without `worker_done` and no known refusal | Read `tail`. Model/account/limit error: stop it and route again with `--exclude-agent`. A question: answer it in its terminal |
| `failed` | The worker ended on its own | Read `tail`, release it, replace it as for `rejected`, excluding that agent for this job. Tell the user the cause and how to fix it; no rejection is remembered |
| `unknown` | No verdict within `--wait` | Report the timeout and continue normal Orca supervision without repeating startup verification |

Follow the returned `next` list. The Skill's instruction takes precedence:
do not extend a timed-out startup verification by repeating calls. Start a
replacement only after cleanup succeeds. Never stop a worker that `verify`
reported as `started`. Details: [Verify and rejections](verify-and-rejections.md).

### 5. Handle the result

| Field | Action |
| --- | --- |
| `downgraded: true` | Mention the downgrade and reason in the worker's task spec. Effort is not raised to make up for a weaker model; narrow the task or add checks |
| `upgraded: true` | Surface the warning. No route at or below the requested tier covers the job, so a pricier cost tier was used. See [Fallbacks](tiers-and-routing.md#fallbacks-downgrade-upgrade-wait-none) |
| warning `<window> quota is N% used; resets in …` | Orca reports the pick's usage window at or above its warning threshold (`thresholds`, 95% long, 90% session). Relay it and keep the job small |
| warning `selected route is expected to end above …` | The pick is expected to end its usage window above `usageRiskLimit`. Relay it and keep the job small |
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

When Orca reports an agent as disabled, OrcaCompass skips it (`not enabled in
Orca`). Tell the user to enable it in Orca's settings. If the setting reads
`unknown`, say that Orca's settings could not be read: every installed agent
counts as enabled and may be routed. Repeat config
changes and resulting agent choices to the user; use per-route flags for a
one-job constraint. Relay warnings when a favorite was skipped.

## Several workers at once

OrcaCompass applies [recent hand-outs](tiers-and-routing.md#usage-headroom-and-pace)
to known usage pools, so manual spreading across `alternatives` is unnecessary.
These are estimates, not capacity reservations. Alternatives have no `launchArgs`; if choosing one
explicitly, route again with `--agent` and use that decision's arguments.

Inspect `quality` for evidence class, cost (`tier`, `blended`, `source`),
coverage, shortfall, overshoot, axis scores and evidence. Labels include
`measured`, `partial`, `estimated`, `assumed` and `unranked`; estimated and
assumed placements are provisional. A cheaper covering pick is not a
downgrade. Price uses a 3:1 input/output blend with default `costBands`
`[1, 5, 12]`; user overrides precede price, then family/model-line hints,
provider lineup and evidence class provide fallbacks.

Use `orcacompass status --json` for discovery, usage pools and skips,
`orcacompass rejected` for saved refusals, and `orcacompass rejected --clear`
to forget them. `orcacompass refresh` refetches metadata and rebuilds the table;
`orcacompass ranking` inspects evidence and `orcacompass tiers --axis coding`
shows evidence bands. Keep only the short classification explanation in
`--tier-reason`; put the full task and repository contents in the worker launch.
