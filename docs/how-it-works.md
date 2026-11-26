---
description: Follow one job from its needs through model selection, cost, usage and reasoning effort to a route.
---

# How it works

OrcaCompass answers one question for an orchestrator (the agent coordinating
workers): which agent, model and reasoning effort should this worker get? A
**route** is one model through one agent; the same model through Claude Code
and through Cursor draws on different subscriptions. This page gives the
decision order, then follows one job through every step. The last section
lists what every call reads and caches.

## Decision order {#decision-order}

- **Describe the job.** Supply the minimum coding, agentic and reasoning levels
  (or a tier shorthand). Optionally specify effort demand or an exact effort.
- **Find eligible routes.** Apply agent restrictions, availability, model bans
  and recorded launch refusals. Keep the latest release per agent, family and
  cost tier. Defer last-resort agents such as OpenCode unless explicitly selected.
- **Check capability.** A regular candidate must meet every required axis and
  support any exact effort requested. Models from all cost tiers can qualify.
- **Check quota.** Read the usage windows of each route. A route is blocked
  when Orca reports 100% or more in any of its active windows. Recent
  hand-outs lower its score only. A forecast above 90% at reset adds a warning.
- **Score the eligible routes.** Start with the percentage expected to remain
  at reset in the limiting window. Positive headroom counts in full for a reset
  within seven days and is discounted for a later reset. Subtract the price
  adjustment (at most five points) and choose the highest score among the
  unblocked routes with known usage. See
  [Ranking covering routes](tiers-and-routing.md#ranking-covering-routes).
- **Apply a configured favorite.** An eligible, unblocked favorite can take
  precedence, even if it falls short on capability. Above its separate risk
  limit, a qualifying alternative with known usage within that limit is used
  if there is one. The decision reports when a preference or shortfall applies.
- **Handle missing routes.** When downgrades are allowed, try unblocked models
  with the smallest capability shortfall. If ordinary agents yield no route,
  retry with last-resort agents. Cursor `auto` is the final fallback when
  downgrades are allowed. Return a reset time to wait for when one is known,
  or report that no route is available.
- **Return and verify the pick.** Resolve the effort, return launch arguments,
  reasons and up to five alternatives. The route command records a temporary
  hand-out (five points of usage for ten minutes by default). The orchestrator
  launches the worker and verifies it. After a confirmed model refusal it
  routes the same task again with that agent and model left out.

::: info About the example
The scores and prices below are from the bundled evidence snapshot of
November 2026; the usage figures and the set of installed agents are
illustrative. Your models, data and usage will differ; the steps stay the
same. The exact rules are in [Tiers and routing](tiers-and-routing.md).
:::

## The job

> Add a CSV export button to the reports page, with tests.

A few files in one area, tests to run and fix until they pass, and no hard
design decision.

## 1. The orchestrator rates the job

The orchestrator rates the capability the job needs on three axes and the
effort demand (how much the worker should think):

```sh
orcacompass route --need coding=mid,agentic=mid,reasoning=low --demand moderate --json
```

Each level is a minimum score on that axis. `min` has no minimum.

| Axis | `low` | `mid` | `high` | `top` |
| --- | --- | --- | --- | --- |
| coding | 60 | 75 | 82 | 87 |
| agentic | 35 | 70 | 80 | 82 |
| reasoning | 70 | 80 | 86 | 90 |

`low` sits under the good small models, so a simple job can go to one. `mid`
sits under the current daily workers and `high` under the frontier models.
`top` is for the rare job `high` is not enough for; today only Opus 5.5 and
Fable 5.2 reach it on every axis. A model that meets a level also meets every
level below it.

So this job asks for coding 75 or more, agentic 70 or more and reasoning 70 or
more. The cuts travel with the evidence snapshot, so a data refresh can move
them. [Skill workflow](skill-workflow.md) explains how to rate a job;
`--tier` is a shorthand for the same level on every axis. The highest level
here, `mid`, makes Advanced the requested tier, which sets the default effort
and which [preference](tiers-and-routing.md#preferences-pins) applies.

## 2. OrcaCompass finds what you can launch

It looks for each agent's CLI, asks Orca which agents are switched on, and
reads each agent's current model list. In the example, Claude Code, Codex and
Cursor are available; Grok and Antigravity are switched off in Orca, and
OpenCode is not installed. Banned models and models an agent refused at an
earlier launch are left out here. See [Models and agents](models-and-agents.md).

## 3. Evidence decides who can do the job

The evidence snapshot supplies coding, agentic and reasoning scores where
available. A model qualifies only when it meets the minimum on all three axes.
Price plays no part in this step.

| Model | coding ≥ 75 | agentic ≥ 70 | reasoning ≥ 70 | Result |
| --- | --- | --- | --- | --- |
| Haiku 5.5 | 68.4 | 53.5 | 74.6 | out |
| Composer 2.5 | 38.6 (assumed) | 35.7 (assumed) | 52.4 (assumed) | out |
| GPT-6.1 Terra | 76.5 | 69.1 | 82.3 | out |
| Grok 4.7 | 64.8 | 43.7 | 75.1 | out |
| GPT-6.1 Sol | 79.8 | 75.5 | 88.7 | qualifies |
| Sonnet 5.5 | 84.3 | 78.2 | 87.3 | qualifies |
| Opus 5.5 | 87.3 | 82.0 | 90.6 | qualifies |
| GPT-6 Astra | 83.8 | 80.5 | 89.7 | qualifies |
| Fable 5.2 | 87.6 | 85.4 | 94.7 | qualifies |
| Gemini 4 Carbon | 86.6 | 78.8 | 94.2 | qualifies |

Each model that falls short is listed under `skipped` with the reason, for
example `below need on agentic (69.1 < 70)`. A model with no evidence at all is
`unranked` and skipped. A new release with no scores of its own inherits, per
axis, the best score of its family or of the same vendor's models at or below
its hinted tier, labelled `assumed`, until its own data arrives. For Composer
2.5, the snapshot uses Kimi K2.5 as an explicit fallback on all three axes.
See [Model data](model-data.md).

## 4. Price sets the cost tier and the price adjustment {#_4-price-decides-how-much-model-to-spend}

Each model also has a cost tier, set by its API price in the snapshot, blended
3:1 input to output, in USD per million tokens. It is not what your
subscription charges; the router uses it as a measure of how much of a
subscription a model consumes.

| Cost tier | Blended $/M | Qualifying models in the example |
| --- | --- | --- |
| Light | below 1 | none |
| Daily | 1 to below 5 | Sol ($4), Sonnet 5.5 ($4), Gemini 4 Carbon ($4) |
| Advanced | 5 to below 12 | Opus 5.5 ($8) |
| Frontier | 12 or above | Fable 5.2 ($16), Astra ($20) |

Every qualifying model enters the comparison, including Opus, Fable and Astra.
The price takes a few points off a route's score in the next step: 2.5 points
at $4, 3.33 at $8, 4 at $16, and never more than 5. Change the thresholds with
`costBands`, or move a model with `tierOverrides`; see
[Tiers and routing](tiers-and-routing.md).

## 5. Compare subscription headroom and price

OrcaCompass reads your live usage from Orca and projects it: at the current
pace, how much of each usage window will be left when it resets? This
remaining share is **headroom**. Each route's score is its headroom in
percentage points minus its price adjustment, and minus an effort adjustment
when the model cannot think as hard as the job asks; the highest score wins. In
the example, every model of an agent draws on the same weekly window, and
Cursor offers Sonnet 5.5 and Gemini 4 Carbon:

| Route | Usage | Headroom | Price adjustment | Score |
| --- | --- | --- | --- | --- |
| Codex, Sol ($4) | weekly 8% used, 31% of the week gone | 62% | 2.50 | 59.50 |
| Codex, Astra ($20) | same window | 62% | 4.17 | 57.83 |
| Claude Code, Sonnet 5.5 ($4) | weekly reset less than a day ago | 55% | 2.50 | 52.50 |
| Claude Code, Opus 5.5 ($8) | same window | 55% | 3.33 | 51.67 |
| Claude Code, Fable 5.2 ($16) | same window | 55% | 4.00 | 51.00 |
| Cursor, Sonnet 5.5 or Gemini 4 Carbon ($4) | 76% used, 78% of the window gone | 3% | 2.50 | 0.50 |

- On one subscription the cheaper model always scores higher: Sol before
  Astra, Sonnet before Opus and Fable.
- Between subscriptions, room decides: a pricier route wins only when it has
  clearly more headroom. Five points more always outweigh the price.
- A route is **blocked**, and skipped, only when Orca reports one of its
  windows as 100% used. A route at 96% can still win when nothing better is
  left; the pick then carries a warning that the quota is nearly used up
  (from 95% of a long window or 90% of a session by default).
- A pick expected to end its usage window above `usageRiskLimit` (90%) carries
  a warning too. The Cursor routes here are in that state; they are not picked,
  so nothing is warned.
- A route with unknown usage is used only when no unblocked route with known
  usage covers the job.

Each route handed out in the last `handoutMinutes` (10) counts as
`handoutPercent` (5 points) more usage on that model's windows, so workers
routed back to back spread across subscriptions. A favorite set with
`orcacompass prefer` can take the place of this pick; see
[Preferences](tiers-and-routing.md#preferences-pins).

## 6. Effort follows the demand

The demand `moderate` maps to `medium`, an effort Sol supports, passed as
`--effort medium`. Agents that encode effort in the model id get it there
instead. See [Reasoning effort](effort.md).

## 7. Return the decision

The route comes back with launch arguments and the reasons behind it. Without
`--json` it prints like this (illustrative, `skipped` list shortened):

```text
daily → codex · gpt-6.1-sol · medium (high confidence)
  codex gpt-6.1-sol: weekly 8% used, 31% of window elapsed (headroom 62%) → on pace for 26% before reset in 4d
  needs coding=mid agentic=mid reasoning=low; covering routes: 7 across all cost tiers
  cost: daily ($4.00/M blended, maker price)
  coding 79.8 measured, agentic 75.5 measured, reasoning 88.7 measured
  effort: medium from moderate effort demand (balanced policy), passed as --effort
  selection: 62.00 ranked headroom points minus 2.50 price points = 59.50
  next best: codex gpt-6-astra (weekly headroom 62%, resets in 4d, $20.00/M blended)
  skipped: …
orca orchestration worker-start --spec "<task>" --agent codex --model gpt-6.1-sol --effort medium
```

The first line shows the pick's cost tier. "7" counts the covering routes in
the table above. `next best` is the runner-up by score: here the pricier model
on the same subscription.

The orchestrator appends `launchArgs` to `orca orchestration worker-start`,
then runs `orcacompass verify --dispatch <id>` to confirm the agent accepted
the model. If the agent refused it, OrcaCompass remembers the refusal and the
next route picks another model. See
[Verify and rejections](verify-and-rejections.md) and
[Commands](commands.md) for the full JSON.

## What changes the answer

- **Codex is at its limit.** Sol and Astra are blocked; the next score is
  Sonnet 5.5 through Claude Code.
- **The job needs more coding.** At `coding=high` (82 or more), Sol (79.8)
  drops out. Astra (83.8) on the same subscription now has the highest score
  (57.83), ahead of Sonnet 5.5 (52.50).
- **A pricier route has much more headroom.** If Claude Code had 79% headroom
  and Codex 60%, Opus 5.5 (75.67) would beat Sol (57.50); Sonnet 5.5 (76.50),
  on the same subscription as Opus, would still win.
- **No Daily model qualifies.** The pick comes from a pricier tier. When the
  requested tier is cheaper than the pick and has no covering model, the route
  is marked `upgraded`.
- **Every qualifying route is close to its limit.** They still compete on the
  same score, and the pick carries a warning.
- **Every qualifying route is blocked.** OrcaCompass picks the closest model
  that falls short and marks the route `downgraded`, or returns `wait` with
  `--no-downgrade`. See
  [Fallbacks](tiers-and-routing.md#fallbacks-downgrade-upgrade-wait-none).
- **Nothing can be routed.** Cursor `auto` is the last fallback before waiting
  (not with `--no-downgrade` or `--effort`); Cursor then picks the model
  itself.

## What runs on every call

`route`, `status`, the `agents` listing, `setup`, setting a `prefer` entry,
`ban` (including its listing) and `unban` gather the same picture of your
machine (`src/routing/environment.ts`). `tiers` and `ranking` load the
placement table without live usage; both can rebuild it when stale.

The **placement table** holds every model's tiers, built from every source
and kept for `placementsTtlHours` (5 hours by default). A **route** is the
recommended agent, model and effort, chosen using that table and live usage.
The optional `--tier-reason` is the
coordinator's short explanation, returned with the decision. The coordinator
classifies the task using the Skill's rubric. OrcaCompass does not call a
model for classification.

1. **Load config** from the platform path (see [Configuration](configuration.md));
   a missing file means defaults, an invalid one is exit code 2.
2. **Gather in parallel:** load the placement table, read usage, and read
   Orca's agent switches. The following entries describe those branches, not
   a sequential series of waits.

   **Read the placement table** from the cache. When it is missing, older
   than `placementsTtlHours`, from another OrcaCompass version, built with
   other `tierOverrides` or `costBands`, an older placement schema, a changed
   evidence generation recorded in `evidence-check.json`, a future build time,
   or a newly detected agent, it is rebuilt. The manifest checks the repository evidence
   snapshot with cached and bundled fallbacks (24 hours by default).

   **Discover agents** in parallel. For each one: find the executable,
   read its model list, note its effort levels and which usage pools it draws
   on. Live listings (`cursor-agent models`, `agy models`, `opencode models`,
   and `grok models` when `~/.grok/models_cache.json` is empty) run with a
   30 s timeout; a nonempty successful listing is saved and reused if a later command fails
   or produces no parsed models. If no models were parsed and the output
   asks you to sign in, the agent is marked `not signed in` instead.
   `agy models` runs with its background auto-updater off, so listing models
   never updates Antigravity; `agy` still updates itself when you or Orca run it.

   **Profile every model** with raw evidence scores and a separate cost tier
   from user `tierOverrides`, then snapshot prices (3:1 input/output blend, `costBands` default `[1, 5, 12]`),
   falling back to hints and evidence class without a price. `orcacompass ranking`
   is the evidence view; `orcacompass tiers` groups by cost tier and
   `orcacompass tiers --axis coding` shows evidence bands.
3. **Read usage** with `orca account list --json` (20 s timeout). The usage reader covers all supported agents except OpenCode,
   which has no usage entry. Each covered agent gets a status (`ok`, `unavailable`, `unknown`) and its usage pools. A pool with a
   missing number is skipped, never read as 0%. This is the only child command a
   route runs when the table is fresh; local files and executable locations
   are still checked.
4. **Read Orca's agent switches**, read-only, from the active profile's
   `profile-state.db` (or `orca-data.json`). Anything unexpected is `unknown`
   and excludes nobody.
5. **Apply recent [hand-outs](tiers-and-routing.md#usage-headroom-and-pace)**
   to known usage pools, then **load rejections**:
   models an agent refused at launch, saved by `verify`,
   still younger than `rejectionTtlHours`.

Then the pure routing core (`src/routing/router.ts`, no I/O) turns that
environment, your request and your config into a `Decision`: every model that
covers the job competes, from all cost tiers, and the score is the route's
usage headroom minus a price adjustment of at most five points. Setup and
status show a pick from another cost tier with a label such as
`(daily cost tier)` for Advanced needs; a cheaper covering pick is not a
downgrade. See
[Tiers and routing](tiers-and-routing.md).

Each evidence HTTP request has a 10 s timeout (manifest, then snapshot when
needed); live model listings have 30 s each and usage has 20 s. These limits
apply to individual operations, not the total call. See
[The first call is slow](troubleshooting.md#the-first-call-is-slow) for how
the concurrent operations affect waiting time.
