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
   (agent, model, `usagePercent`, `blocked`). Apply the option's `model` with
   `orcacompass prefer <tier> <agent> <model>`, clear with
   `orcacompass prefer clear <tier>`, and change the limit with
   `orcacompass prefer --risk-limit <percent>`. A favorite is used while its
   prospective usage stays below `config.preferRiskLimit` (default
   `defaultPreferRiskLimit`, 90%) on every quota it draws on; at or above it,
   routing goes on without the favorite, with a warning.
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
`top`. Use `top` only on an axis where the job requires capability beyond
`high`; a failed attempt or an expensive mistake does not by itself justify it.
Most hard work is `high`.

Use `--tier` only for a job with equal needs on all axes: `light`, `daily`,
`advanced`, and `frontier` map to `min`, `low`, `mid`, and `high`. There is no
tier for `top`; use `--need`.

Rate effort demand independently, by how much reasoning a correct solution
needs and how hard an incorrect one is to detect with the job's checks: `low`
for a known approach with mechanical decisions, `moderate` for a mostly clear
approach with local decisions or routine investigation, `high` when finding or
validating the approach takes substantial investigation or competing
constraints, and `exceptional` for unusually deep reasoning beyond a normal
`high` attempt. Between adjacent levels, prefer the lower unless deeper
reasoning would materially help. After a failure, reassess before raising the
demand or the need. A rename across fifty files can be `low`; a subtle race in
one file can be `high`. Costly failure also calls for tests and review in the
task spec.

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
| `--use <agent>/<model>` | The answer to a `decide`: take that route as it is, despite risk or a shortfall |
| `--dry-run` | Decide without reserving quota |

::: info Requirements are never lowered automatically
A route is returned only when its model meets all three needs and can apply
the effort. The one exception is the user's own choice: a preferred model, or
a route taken with `--use`, is returned even when it falls short, marked
`downgraded`. Inspect `quality.covers` and `downgraded` before launching
when capability coverage is required.
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

Routing is quota first: the quota bucket with the most capacity left decides,
and in it the most economical eligible route below the risk threshold is
taken. Usage is what Orca reports plus what is reserved for workers already
routed, plus this worker's own buffer; nothing is forecast. A quota is
exhausted only when Orca reports it as 100% used. A pick in the caution range
(85% to below 90%) carries a warning; relay it. From 90% nothing is picked
automatically. Prices never change evidence scores or need cuts.

Parse the JSON and read `status`, `reasons`, `warnings`, `confidence`,
`quota`, `downgraded` and `upgraded`. Exit code 0 alone does not mean a
route exists. An `ok` route has reserved its quota (`reservation.id`); if the
worker is not going to be launched after all, give it back with
`orcacompass release --reservation <id> --outcome failed-before-launch`.

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
- Cursor `auto` is never routed on its own: Cursor picks the model, so it has
  no evidence profile or cost tier. It only appears under `options.lower`
  when a decision comes back.
- An OpenCode route needs `--worktree current` or an existing worktree: Orca
  refuses `--model` for OpenCode in a new one. The route's `reasons` say so.

### 4. Verify

Right after `worker-start` returns a `dispatchId`:

```sh
orcacompass verify --dispatch <dispatchId> --reservation <reservation.id> --json
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

`verify` also settles the reservation: `started` marks it running,
`rejected` releases it at once, `failed` keeps it until Orca's usage covers
it. When the worker reports `worker_done` or is stopped, end the reservation
with `orcacompass release --dispatch <dispatchId>` (add `--outcome cancelled`
for a worker stopped after it had worked). A worker that is never released is
closed when Orca reports it finished.

### 5. Handle the result

| Field | Action |
| --- | --- |
| `downgraded: true` | Only for a route chosen explicitly (a preferred model, or `--use`). Mention the downgrade and reason in the worker's task spec. Effort is not raised to make up for a weaker model; narrow the task or add checks |
| `upgraded: true` | Surface the warning. No route at or below the requested tier is eligible, so a pricier cost tier was used. See [Outcomes](tiers-and-routing.md#outcomes-ok-decide-none) |
| warning `<window> quota would be N% used with this worker (caution); …` | The pick is in the caution range because no route was available below it (`riskThresholds`). Relay it and keep the job small |
| warning `usage of <agent> is unknown: …` | The route was taken without a quota check. Say so |
| `effort.applied` | `flag`, `model-id`, or `provider-default` (the agent decides). Never claim an effort was set when it is `provider-default` |
| `effort.adjusted: true` | The route cannot apply the exact target. It applies the next higher effort it offers (a lower one only when neither `--demand` nor `--effort` was given). Report the target and the resolved effort when relevant. Do not reroute only for this |
| warning `… is a last-resort agent …` | The route costs money per token or runs on this machine; tell the user before launching several workers on it |
| `status: "decide"` | Nothing was picked and there are no `launchArgs`. Read `options` and choose, asking the user when the choice is theirs: **WAIT** (`options.wait`; `until` in epoch ms only when a reset time is reported, never invent one), **USE** a route at high usage by adding its `use` flag to the same call, or **LOWER** the requirements: route again with a lower `--need` or `--demand`, or take a listed route as it is with its `use` flag |
| `status: "none"` | Say no recommendation was available. Use Orca's defaults only where they respect the user's explicit constraints, and keep any explicit agent or model choice. If no route can apply an explicit effort, report the available levels and ask before launching with another effort or none |
| command missing | Say OrcaCompass was absent. Use the same default fallback only if it respects the user's explicit constraints; otherwise ask first |
| exit 1 | Usage or runtime error: fix the command or report it |
| exit 2 | `config error: <path>: <message>`: report and resolve before retrying |
| low confidence | Usage unknown: not reported, more than 4x `usageStaleMinutes` old, or a window reset since the snapshot. Do not invent percentages |
| medium confidence | Usage moderately stale (the reason says "usage 45m old"), or the last valid snapshot standing in because Orca could not be read |
| catalog source `snapshot` | Metadata may be old; run `orcacompass refresh` when online |
| warning `preferred … skipped: …` | The user's favorite would reach its usage limit or its quota is exhausted; tell them the line |

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

Every route [reserves](tiers-and-routing.md#reservations) its worker's share
of each quota bucket it draws on, and the next route counts it, so manual
spreading across `alternatives` is unnecessary. The reservation is taken
under a lock: route calls made at the same moment, from different
coordinators, cannot both take the last capacity. Alternatives have no
`launchArgs`; if choosing one explicitly, route again with `--agent` and use
that decision's arguments.

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
