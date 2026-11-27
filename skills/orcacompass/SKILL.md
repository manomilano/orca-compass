---
name: orcacompass
description: Use when delegating work to Orca workers (orca orchestration worker-start / agent launch) to choose agent, model and effort by task difficulty and current usage limits.
---

# OrcaCompass

Use alongside Orca's orchestration skill. OrcaCompass recommends a route;
the coordinator launches and supervises the worker with Orca's normal commands.
Explicit user instructions about agent, model or effort take precedence over recommendations.

## First-time setup

Run this when the user asks to set up OrcaCompass, or before your first route
in a conversation when `orcacompass setup --json` reports `configExists: false`
(offer it once; if the user declines, run `orcacompass setup --skip`, which
saves the defaults so setup is not offered again, tell the user which agents it
reports as used, and route with the defaults). The user can also run `orcacompass setup` in a
terminal; it asks the same questions.

1. Run `orcacompass setup --json` and keep the document. Ask the questions
   below in plain words, one message each. Every question can be skipped:
   skipping keeps the current setting. Show current settings (`config`) as
   the defaults.
2. **Agents.** List every entry of `agents`: installed, `enabledInOrca`
   (yes / no / unknown), `orcaUsage`, and `models`. Ask which to use; the
   default is the agents with `preselected: true`. Apply only the change:
   `orcacompass agents disable <id>...` for preselected agents the user
   dropped, `orcacompass agents enable <id>...` for agents they added. An
   added agent with `enabledInOrca: "no"` must also be switched on in Orca's
   settings; say so.
3. **Favorites (optional).** For each tier in `tiers`, show `pick`,
   `preferred`, and `options` (agent, model, `usagePercent`, `blocked`), and
   ask whether to set a favorite. `usagePercent` is the route's usage with the
   workers already reserved and one more. A favorite is used while that stays
   below `config.preferRiskLimit` percent (default `defaultPreferRiskLimit`,
   90) on every quota it draws on, and never when a quota is exhausted;
   otherwise routing goes on without it and the route output says why. Apply with
   `orcacompass prefer <tier> <agent> <model>` (the option's `model`),
   `orcacompass prefer clear <tier>`, and, if the user wants another limit,
   `orcacompass prefer --risk-limit <percent>`.
4. **Bans (optional).** Show `families` (name and a few of their models) and
   the current `config.banModels`. Ask whether any models or families should
   never be used. Apply with `orcacompass ban <model-or-family>...` and
   `orcacompass unban <entry>...`. A whole agent is not a ban; use step 2.
5. **Finish and summarize.** Run `orcacompass setup --complete --json`, even
   when every answer kept the defaults. This creates the config if absent,
   marking setup complete so it is not offered again. Tell the user, in
   plain words, which agents are used, the favorites and limit, and the bans,
   then one example route per tier (`orcacompass route --tier <tier>`; mention
   any warning), and the config file path (`configPath`).

Use the commands above to write the config; never edit the file yourself.

## Which providers to use

- When the user asks which agents or providers are available, run
  `orcacompass agents` and report its table: installed, enabled in Orca,
  Orca usage status, chosen by the user, and the verdict.
- When the user says to use or avoid providers from now on, record it with:
  - `orcacompass agents disable <id>...` to stop using agents,
  - `orcacompass agents enable <id>...` to use them again,
  - `orcacompass agents only <id>...` to use only those agents,
  - `orcacompass agents reset` to go back to all agents.

  These write the user's OrcaCompass config and print the resulting choice;
  repeat it to the user. For a constraint on one job only, use `--agent` or
  `--exclude-agent` on that route call instead of changing the config.
- When the user names a go-to model or agent for a kind of work ("use Codex
  for everyday jobs"), map the work to a tier and run
  `orcacompass prefer <tier> <agent> [model]`; `orcacompass prefer` lists the
  preferences and `orcacompass prefer clear <tier>` removes one.
- When the user says never to use a model or model family, run
  `orcacompass ban <model-or-family>...` (`orcacompass unban` lifts it). For a
  whole agent use `orcacompass agents disable <id>` instead.
- A route's `warnings` may say a preference was skipped, for example
  `preferred codex gpt-6.1-terra skipped: weekly would be 90.5% used with this
  worker (limit 90%); resets in 2d`. Tell the user that line: their preference
  is at its limit on that quota, so another route was chosen.
- An agent the user has not enabled in Orca is never routed (`not enabled in
  Orca`). Do not work around it; tell the user to enable it in Orca's settings
  if they want it. If `agents` reports the Orca setting as `unknown`, say so:
  Orca's settings could not be read, so every installed agent counts as
  enabled and may be routed.

## Rate the three needs

Rate each job by the work, not spare capacity. Pass all three axes with `--need`:

### Coding: implementation difficulty

| Level | Definition |
| --- | --- |
| `min` | No coding capability required. |
| `low` | Straightforward code changes using familiar patterns, clear instructions, and limited technical decisions. |
| `mid` | Non-trivial implementation requiring understanding of existing code, interactions between components, or moderate technical judgment. |
| `high` | Complex implementation requiring deep code understanding, challenging debugging, intricate logic, or significant architectural decisions. |
| `top` | Exceptional engineering challenges involving unusually difficult algorithms, subtle system-wide invariants, or highly complex interactions where advanced coding expertise is essential. |

### Agentic: autonomy and adaptive execution

| Level | Definition |
| --- | --- |
| `min` | No autonomous execution or tool use required. |
| `low` | Simple, predictable actions with clear steps and completion criteria. |
| `mid` | Multi-step work requiring independent tool use, iteration, and adaptation to routine results or failures. |
| `high` | Complex autonomous workflows requiring investigation, independent planning, coordination, and recovery from unexpected obstacles. |
| `top` | Exceptional autonomous execution involving deeply interdependent tasks, substantial uncertainty, dynamic replanning, and sophisticated coordination across tools or workers. |

### Reasoning: cognitive problem-solving difficulty

| Level | Definition |
| --- | --- |
| `min` | Mechanical or deterministic tasks requiring virtually no judgment. |
| `low` | Familiar problems with obvious solutions and straightforward decisions. |
| `mid` | Problems requiring meaningful analysis, comparison of alternatives, or reasoning through multiple constraints. |
| `high` | Difficult, ambiguous problems requiring deep analysis, non-obvious deductions, or sophisticated multi-step reasoning. |
| `top` | Exceptional reasoning challenges involving novel problems, highly complex interacting constraints, or solutions that demand unusually deep insight beyond established approaches. |

Use `top` only on an axis where the job requires capability beyond `high`.
A failed attempt or an expensive mistake does not by itself justify `top`.
Most hard jobs are `high`; `top` leaves only the strongest models, for example
`--need coding=top,agentic=high,reasoning=top`. For retries, use the failure
reassessment rule in the effort demand section.

Use `--tier` for the rare job that is the same on all axes: light, daily,
advanced and frontier map to min, low, mid and high respectively. There is no
tier for `top`; pass it with `--need`. Supply a
short explanation with `--tier-reason`; explain it in chat when asked.

## Rate the effort demand separately

The needs pick how capable the model must be; the effort demand picks how much
it should think before acting. More effort buys exploring alternatives and
checking its own reasoning, at a cost in time and usage. Rate it from the work,
never from the tier or the model, with one question: **how much reasoning is
required to reach a correct solution, and how difficult is it to detect an
incorrect one with the checks available for this job?**

| Demand | The job | Typical work |
| --- | --- | --- |
| `low` | The approach is known, decisions are mechanical, and little independent reasoning or verification is needed. | Rename, formatting, routine dependency bump, boilerplate, a straightforward step of a written plan. |
| `moderate` | The approach is mostly clear but requires local decisions, analysis, or routine investigation. | A feature following an existing pattern, a bug whose cause is localized by the error, tests for known behaviour. |
| `high` | Finding or validating the right approach requires substantial investigation, non-obvious deductions, or resolving competing constraints. | An unexplained bug with no repro, a subtle race, a migration plan with real trade-offs, a refactor with an invariant that is hard to preserve or verify. |
| `exceptional` | The job requires unusually deep reasoning, extensive exploration of competing explanations or solutions, or resolving complex interacting uncertainties beyond a normal `high` attempt. | Tracing intermittent corruption across services with conflicting evidence, designing a novel security boundary with subtle failure modes. |

Between two levels:

- When unsure between adjacent levels, prefer the lower unless deeper
  reasoning would materially improve the solution or its validation. Default
  to `moderate` only when the task description is too sparse for a more precise
  rating. Most jobs are `low` or `moderate`; `exceptional` is rare.
- Good tests reduce verification uncertainty, not necessarily the reasoning
  needed to find a solution. Lower demand only if the work itself justifies it;
  hard-to-detect errors may warrant deeper reasoning and stronger checks.
- Only part of the job is hard: split it when practical and rate the parts
  separately.
- After a failed attempt, reassess before escalating. Raise demand one level if
  more thorough thinking is needed; raise the relevant need if greater model
  capability is needed. Raise both only when independently justified. Fix an
  unclear task spec or missing context, tools or access instead of escalating
  for those reasons. If the cause is unclear, diagnose it first.

Do not raise demand for size, topic, keywords, urgency or importance alone,
or to make up for a weaker model. A rename across fifty files can be `low`;
a subtle race in one file can be `high`. Security, migration, concurrency and
production work follow the same rubric. Human review before execution can
reduce execution risk, not the reasoning needed to design a sound plan.
Costly failure calls for tests and review in the task spec, not only more
thinking. Do not lower demand because the model is strong: a Light model can
get `high` and a Frontier model `low`.

Pass `--demand <d>`; OrcaCompass maps it to an effort and routes only to
models that can apply that effort or the next higher one they offer. A model
that tops out below it is not eligible: effort is never lowered silently.

Pass `--effort <e>` only when the user asked for a specific effort. Valid
levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` (also spelled
`extra-high`) and `max`; anything else, such as `ultra`, exits 1. It is never
snapped: routes that cannot apply it are left out, and if no route can,
`status` is `decide` with the levels each route offers under `options.lower`.
Ask the user before relaxing or removing their explicit effort requirement.

## Route, then launch

1. Rate the needs and the effort demand, and note any user constraints.
2. Make one route call per worker:

   ```sh
   orcacompass route --need coding=mid,agentic=low,reasoning=low --demand moderate --tier-reason "Multi-file change with tests and routine judgement." --json
   ```

   `--demand` takes `low`, `moderate`, `high` or `exceptional`. Restrict agents
   with repeated `--agent <id>` or `--exclude-agent <id>`. Use `--effort <e>` only
   for an effort the user asked for. Capability needs and effort are never
   lowered automatically; a cheaper cost tier that covers the needs is always
   allowed. `--dry-run` decides without reserving quota. Agent ids are `claude`, `codex`, `cursor`,
   `grok`, `antigravity`, `opencode`, and `muse` (routed from a built-in model list, since
   neither Muse nor Orca lists Muse models). An unknown id adds a warning with a likely match
   (`did you mean cursor?`); fix the id and route again.
   OpenCode is a last resort by default (API keys cost per token; local models
   take this machine): it is routed only when no other agent can take the job.
   Pass `--agent opencode` only when the user asks for OpenCode. An OpenCode
   route needs `--worktree current` or an existing worktree; Orca refuses
   `--model` for OpenCode in a new worktree.
   If the user specifies an exact model, honor that choice directly; the CLI
   has no model selection flag.

3. OrcaCompass routes by quota first, on what is known now, never on a
   forecast. A route is eligible only when its model meets all three needs and
   can apply the effort. For every quota bucket a route draws on (provider,
   account and usage window) it adds up `reported` usage, what is `reserved`
   for workers already allocated, and the `buffer` this worker would reserve:
   the `prospective` usage. The bucket with the most capacity left comes
   first; in it the most economical eligible route below the risk threshold is
   taken. Below 85% is available, 85% to below 90% is caution (used only when
   nothing is available, with a warning), 90% and above is never routed
   automatically. A quota is exhausted only at 100% reported usage.
   Parse JSON and inspect `status`, `reasons`, `warnings`, `confidence`,
   `quota`, `downgraded`, `upgraded`, and `effort`. Exit code 0 alone does
   not mean a route exists.
4. For `status: "ok"`, append the returned `launchArgs` array to:

   ```sh
   orca orchestration worker-start --spec "<actual task specification>"
   ```

   Preserve Orca's required worktree and lifecycle flags from its own skill.
   Pass each argument as an argument, using proper shell quoting. The `launch`
   string is a readable template with a `<task>` placeholder, not task content.
   `route` contains agent/model/effort; Cursor effort is encoded in its model id,
   so `route.effort` is null and its `launchArgs` omit `--effort`. The same
   holds for Antigravity Gemini ids such as `gemini-3.8-flash-high`. Cursor `auto` is never routed on its own: Cursor picks the model,
   so it only appears as an option under `options.lower`.

   An `ok` route has already reserved its quota: `reservation.id` names it,
   and other route calls, in any process, count it from now on. Start the
   worker promptly; a reservation nobody confirms is abandoned after
   `reservations.pendingMinutes` (default 10). If you decide not to launch,
   give it back at once:

   ```sh
   orcacompass release --reservation <reservation.id> --outcome failed-before-launch
   ```
5. Right after `worker-start` returns a `dispatchId`, check that the agent
   accepted the model:

   ```sh
   orcacompass verify --dispatch <dispatchId> --reservation <reservation.id> --json
   ```

   This also settles the reservation: a worker that started is marked
   running, a refused model releases its quota at once. Without
   `--reservation` the worker is matched to the pending reservation for the
   same agent and model.

   Orca does not check this: `worker-start` reports the requested model as
   effective even when the agent cannot use it. Codex and Claude then print a
   refusal and idle without `worker_done` (Orca shows them as live, needing
   nothing); Cursor, Grok and Antigravity exit. `verify` reads the worker's
   terminal (60 s total by default and at most, including the initial lookup;
   `--wait <seconds>` can shorten it) and returns as soon as it has a verdict:

   - `started` or `reported`: the model works; wait for `worker_done` as usual.
   - `rejected`: the agent refused the model (`message` has its words). The
     model is now skipped by every route for `rejectionTtlHours` (default a
     week). Run each `cleanup` argv in order (stop then release, or only release when
     the worker already exited), route again
     with the same flags, and start the replacement on the same Task with
     `worker-start --task <taskId> --retry-of <dispatchId>`, the same
     placement and the new `launchArgs`. Tell the user which model was refused
     and what replaced it.
   - `unknown` with `unsent: true`: the agent is idle and the task never
     reached its terminal. Do not reroute; read the terminal, keep waiting,
     and run `verify` again once it is working.
   - `stalled`: the agent ended its turn without `worker_done` and no known
     refusal; read `tail`. If it is an error about its model, account or
     limits, stop it and route again with `--exclude-agent <agent>`; if it
     asks a question, answer it in its terminal.
   - `failed`: the worker ended on its own; read `tail`, release it, and
     replace it as for `rejected`, excluding that agent for this job. Tell
     the user which agent failed to start, why, and how they can fix it,
     for example by finishing its first-time setup. Nothing is remembered,
     so a later route may pick that agent again.
   - `unknown`: no verdict within `--wait` seconds (default and maximum 60).
     Report that verification timed out and continue normal Orca supervision.
     Do not repeatedly call `verify` to extend the startup verification budget.

   Follow the `next` list it returns. Never start the replacement before the
   cleanup succeeded, and never stop a worker `verify` called `started`.
6. When a worker reports `worker_done`, or you stop it, end its reservation:

   ```sh
   orcacompass release --dispatch <dispatchId>
   ```

   Add `--outcome cancelled` for a worker you stopped after it had worked. The
   quota stays reserved until Orca's next real usage refresh covers what the
   worker consumed, then it is released by itself; nothing accumulates. A
   worker you forget to release is closed when Orca reports it finished.

## Handle the result

- `downgraded: true`: only for a route you or the user chose that falls short
  of the needs (`--use`, or a preferred model). Mention it and the reason in the
  worker task spec. Effort is not raised to make up for the weaker model;
  narrow the task or add checks, as the warning says.
- `coverageNote`: the preferred or `--use` model has no benchmark data on an
  axis the job needs, so whether it covers the job is unknown. It is not a
  downgrade; mention it in the worker task spec and add checks.
- `effort`: `applied` says how effort reaches the worker (`flag`, `model-id`,
  or `provider-default` when the agent decides). Never claim an effort was set
  when `applied` is `provider-default`.
- `effort.adjusted: true`: the selected route does not offer the exact target
  and applies the next higher effort it has (a lower one only when neither
  `--demand` nor `--effort` was given). Report the target and resolved effort
  when relevant. Do not reroute because of it.
- A warning `… is a last-resort agent (lastResortAgents) …`: the route costs
  money per token or runs on this machine; tell the user before launching
  several workers on it.
- `upgraded: true`: surface the warning. The covering pick's cost tier is
  higher than the requested tier because no cheaper route covers the job.
- A warning `<window> quota would be N% used with this worker (caution)`: the
  route is in the caution range because nothing was available below it. Relay
  the warning and keep the job small.
- `status: "decide"`: no suitable route is below the risk threshold, and
  nothing was picked for you. Read `options` and choose, asking the user when
  the choice is theirs:
  - **WAIT** (`options.wait`): for the quota to reset or for a fresh usage
    snapshot to free reserved capacity. `until` (epoch milliseconds) is there
    only when Orca reports a reset time; never invent a waiting time.
  - **USE** (`options.use`): a suitable route at high usage. Take it with its
    `use` flag on the same route call, for example
    `--use claude/claude-opus-5-5`. It is refused when the quota is exhausted.
    An entry with `preferred: true` is the user's preference for the tier,
    held back by their own `preferRiskLimit`.
  - **LOWER** (`options.lower`): routes that take the job with lower
    requirements; `shortfall` says what each lacks. Route again with a lower
    `--need` or `--demand`, or take one as it is with its `use` flag.
  Do not launch on `decide`: there are no `launchArgs`.
- `status: "none"`: state that no recommendation was available. Use Orca's
  normal defaults only where they respect explicit user constraints; preserve
  any explicit agent or model choice. If no route can honor an explicit effort,
  report the available levels and ask before launching with a different effort
  or without one. Do not silently bypass other explicit constraints.
- Command missing: say OrcaCompass was absent. Use the same default fallback
  only if it can honor explicit user constraints; otherwise ask before launching.
- Exit 1 means a command usage or runtime error; fix the command or report it. Exit 2 means invalid config;
  report `config error: <path>: <message>` and resolve it before retrying.
- Low confidence: usage is unknown (Orca gave none, the snapshot is more than
  4x `usageStaleMinutes` old, or a window reset since it was taken). The route
  was then taken without a quota check, and a warning says so. Medium
  confidence means the snapshot is moderately stale ("usage 45m old") or is the
  last one OrcaCompass kept because Orca could not be read. Unknown usage is
  never read as 0% or as exhausted. Do not invent percentages. `catalogSource`
  is `network`, `cache`, or `snapshot`.
- `evidenceSource: "snapshot"` means the bundled evidence was used; run
  `orcacompass refresh` when online. Profiles use raw LLMBenchmark evidence;
  evidence class is the highest axis band. Cost tier comes from a user override,
  then snapshot price, family/model-line hint, provider lineup or evidence class.
  Prices use a 3:1 input/output blend, with `costBands` default `[1, 5, 12]`.
  Inspect evidence with `orcacompass ranking` and cost tiers with `orcacompass tiers`.
- `quality` reports evidence class, cost (`tier`, `blended`, `source`), coverage,
  shortfall, overshoot, axis scores and evidence. Labels include `measured`, `partial`, `estimated`, `assumed` and
  `unranked`; estimated and assumed placements are provisional and worth
  mentioning when asked why a model was chosen. `tier` is the pick's cost tier;
  a cheaper covering pick is not a downgrade. Setup and status label it with
  `(daily cost tier)`, for example. Cursor auto has no quality or cost tier;
  `ranking` and `tiers` list it as `unranked` with no price, and it never
  competes with ranked models in any cost tier.
- `quota` holds, for each bucket the route draws on, `reported`, `reserved`,
  `effective`, `buffer` and `prospective` usage and its status; `buckets`
  lists every quota bucket considered, most capacity left first.

Use `orcacompass status --json` to inspect discovery, pools, live reservations, and skipped agents
(each skipped agent carries its reason, such as `excluded by config` or
`not enabled in Orca`, and banned models show as `banned by you`, models an
agent refused at launch as `refused by <agent> …`; `orcacompass rejected`
lists those and `orcacompass rejected --clear` forgets them);
use `orcacompass refresh` to refetch metadata and rebuild the placement
table, and `orcacompass tiers --axis coding` to inspect evidence bands.
Send only the short classification explanation via `--tier-reason`. Keep the full task specification and repository
contents in the worker launch.

Every route reserves its worker's share of each quota until a fresh usage
snapshot covers it, so spreading workers by hand over `alternatives` is
unnecessary. Alternatives carry no `launchArgs`; route again with `--agent`
if choosing one explicitly.
