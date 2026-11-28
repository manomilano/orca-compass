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
- **Find the routes you can launch.** Apply agent restrictions, availability,
  model bans and recorded launch refusals. Keep the latest release per agent,
  family and cost tier. Defer last-resort agents such as OpenCode unless
  explicitly selected.
- **Keep the eligible ones.** A route is eligible only when its model meets
  every required axis and can apply an effort that satisfies the request.
  Models from all cost tiers can qualify. A route that falls short is left
  out; neither the needs nor the effort are lowered to make it fit.
- **Read the quota.** For every quota bucket a route draws on (provider,
  account and usage window), take the usage Orca reports, add what is reserved
  for workers already allocated, and add the buffer this worker would reserve.
  That prospective usage is checked on each bucket separately. Nothing is
  forecast.
- **Route quota first.** Rank the buckets by the capacity they have left. In
  the best one, take the most economical eligible route whose prospective
  usage is below the risk threshold; a route over it is passed over for the
  next route in the same bucket, then for the next bucket. See
  [Ranking eligible routes](tiers-and-routing.md#ranking-covering-routes).
- **Apply a configured favorite.** A favorite for the requested tier comes
  first while its prospective usage stays below its own limit (capped at 100%:
  never onto a fully reserved or exhausted quota), even if it falls short on
  capability. The decision reports when a preference or shortfall applies.
- **Hand back what cannot be decided.** When no eligible route is below the
  threshold, nothing is picked: the Orchestrator gets the decision, with what
  it can do: WAIT for a reset or a fresh snapshot, USE a route at elevated
  risk, or LOWER the requirements. Last-resort agents take the job only when
  no other agent can, or return a decision when they cannot take it
  automatically either.
- **Reserve, return and verify.** Under a lock, the route is decided again on
  the current reservations and its buffer is reserved on every bucket it
  draws on. The orchestrator launches the worker and verifies it, which
  confirms the reservation or, after a model refusal, releases it and routes
  the same task again without that model. A finished worker's reservation is
  released by Orca's next usage refresh.

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
its hinted tier, labelled `assumed`, until its own data arrives. A Gemini
line has no hinted tier: a new release (Gemini 5 Neon) takes the scores and
cost tier of the latest earlier release of its line (Gemini 4 Neon). For Composer
2.5, the snapshot uses Kimi K2.5 as an explicit fallback on all three axes.
See [Model data](model-data.md).

## 4. Price sets the cost tier {#_4-price-decides-how-much-model-to-spend}

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

Every qualifying model stays eligible, including Opus, Fable and Astra. The
cost tier sets how much quota a worker on that model reserves in the next
step, and on one quota the cheaper model goes first. Change the price cuts
with `costBands`, or move a model with `tierOverrides`; see
[Tiers and routing](tiers-and-routing.md).

## 5. Route to the quota with the most room

OrcaCompass reads your usage from Orca as it is now. It does not project it:
where a window stands in time changes nothing. For each **quota bucket** (a
provider's usage window on one account) it keeps three numbers apart: what
Orca **reported**, what is **reserved** for workers already routed, and their
sum, the **effective** usage. For a route it adds the buffer this worker
would reserve, in percentage points by cost tier and effort: the
**prospective** usage. In the example a worker is already running on Codex,
and Cursor offers Sonnet 5.5 and Gemini 4 Carbon:

| Route | Binding bucket | Reported | Reserved | This worker | Prospective | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Codex, Sol (Daily) | Codex weekly | 8% | 2 pp | 1.5 pp | 11.5% | available |
| Codex, Astra (Frontier) | same | 8% | 2 pp | 2.5 pp | 12.5% | available |
| Claude Code, Sonnet 5.5 (Daily) | Claude weekly | 30% | 0 | 1.5 pp | 31.5% | available |
| Claude Code, Opus 5.5 (Advanced) | same | 30% | 0 | 2 pp | 32% | available |
| Claude Code, Fable 5.2 (Frontier) | Fable weekly | 62% | 0 | 2.5 pp | 64.5% | available |
| Cursor, Sonnet 5.5 or Gemini 4 Carbon (Daily) | Cursor Other Models | 84% | 0 | 1.5 pp | 85.5% | caution |

- **The bucket with the most capacity left comes first.** Codex's weekly has
  90% left (8% reported plus 2 points reserved), Claude's 70%, Fable's own
  weekly 38%, Cursor's 16%. A route on several windows is ranked by its most
  restrictive one.
- **Inside a bucket the most economical route wins.** Sol reserves 1.5
  points, Astra 2.5: Sol goes first. A stronger model is not preferred when a
  cheaper one meets the needs.
- **The thresholds apply to the prospective usage.** Below 85% is available.
  From 85% to below 90% is caution: used only when nothing is available, with
  a warning. Cursor's bucket is still at 84%, but one more worker takes it to
  85.5%. From 90% a route is never picked automatically.
- A bucket is **exhausted**, and its routes cannot be used, only when Orca
  reports it as 100% used. A bucket that reaches 100% only through
  reservations is *fully reserved*: nothing is used up, and it frees itself.
- A route with unknown usage is used only when no route with known usage can
  be routed, at low confidence and with a warning.

The reserved total is rebuilt from the worker records at every refresh, on top
of the newly reported usage, so it cannot pile up; see
[Reservations](tiers-and-routing.md#reservations). A favorite set with
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
  codex gpt-6.1-sol: weekly 8% reported + 2 pp reserved (1 worker) + 1.5 pp for this worker = 11.5% prospective (available), resets in 4d
  needs coding=mid agentic=mid reasoning=low; eligible routes: 7 across all cost tiers
  cost: daily ($4.00/M blended, maker price)
  coding 79.8 measured, agentic 75.5 measured, reasoning 88.7 measured
  effort: medium from moderate effort demand (balanced policy), passed as --effort
  selection: quota bucket codex weekly has 90% effective capacity left (bucket 1 of 4 with an eligible route); most economical eligible route in it below the 85% caution threshold
  next best: codex gpt-6-astra (weekly 12.5% prospective, available, $20.00/M blended)
  skipped: …
  reserved rsv_3f9a1c2b7d10: weekly +1.5 pp; after worker-start run: orcacompass verify --dispatch <id> --reservation rsv_3f9a1c2b7d10
orca orchestration worker-start --spec "<task>" --agent codex --model gpt-6.1-sol --effort medium
```

The first line shows the pick's cost tier. "7" counts the eligible routes in
the table above. `next best` is the runner-up: here the pricier model on the
same quota. The `reserved` line names the reservation this route took.

The orchestrator appends `launchArgs` to `orca orchestration worker-start`,
then runs `orcacompass verify --dispatch <id> --reservation <id>` to confirm
the agent accepted the model. If the agent refused it, OrcaCompass remembers
the refusal, releases the reservation, and the next route picks another model.
When the worker is done, `orcacompass release --dispatch <id>` ends its
reservation. See
[Verify and rejections](verify-and-rejections.md) and
[Commands](commands.md) for the full JSON.

## What changes the answer

- **Codex is at its limit.** Sol and Astra cannot be used; the next bucket is
  Claude's weekly, and its most economical route is Sonnet 5.5.
- **The job needs more coding.** At `coding=high` (82 or more), Sol (79.8)
  is no longer eligible. Astra (83.8), on the same bucket, takes the job.
- **Another quota has more room.** If Claude's weekly had 95% left and Codex's
  90%, Claude's bucket would come first and Sonnet 5.5, its most economical
  route, would win; Opus on the same bucket would not.
- **Several workers are routed at once.** Each reserves its buffer, so the
  bucket's effective usage rises with every route and later workers move to
  the next bucket once the threshold is near. Reservations are released as
  Orca's refreshes cover the finished workers.
- **No Daily model qualifies.** The pick comes from a pricier tier. When the
  requested tier is cheaper than the pick and has no eligible model, the route
  is marked `upgraded`.
- **Every eligible route is in the caution range.** The bucket with the most
  room is used, and the pick carries a warning.
- **Every eligible route is at 90% or more, or exhausted.** Nothing is picked.
  The result is `decide`: wait for the reset, use a route at elevated risk
  with `--use`, or lower the needs. Models that fall short are listed there
  with what they lack; they are not chosen for you. See
  [Outcomes](tiers-and-routing.md#outcomes-ok-decide-none).
- **Only Cursor `auto` is left.** Cursor would pick the model itself, so it
  is offered as an option, never routed on its own.

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
   which has no usage entry. Each covered agent gets a status (`ok`, `unavailable`, `unknown`), its usage pools, the time Orca took the snapshot and a
   quota identity (a hash of account, runtime and plan). A pool with a
   missing number is kept as unknown, never read as 0%, and a reset time of `0` or `null` as no reset time.
   `orca account list --json` asks Orca to refresh its cached snapshot when stale (`refreshStaleUsage: true`) and returns cached readings otherwise; OrcaCompass itself never polls providers directly.
   When Orca cannot be read, or a single provider's refresh fails (even with no windows left), the stored snapshot for the same account stands in as `retained` (medium confidence; a known 100% still blocks and nothing settles), whereas `unavailable` (signed out) or a newer reading for another account clears it. Once Antigravity reports quota groups, obsolete ungrouped `session`/`weekly` snapshots are dropped.
   When a reservation is bound to a worker (pending, running, or ended only by a timeout) or the ledger is unreadable, `orca orchestration worker-list` is read as well.
   These are the only child commands a route runs when the table is fresh; local files and executable locations
   are still checked.
4. **Read Orca's agent switches**, read-only, from the active profile's
   `profile-state.db` (or `orca-data.json`). Anything unexpected is `unknown`
   and excludes nobody.
5. **Reconcile [reservations](tiers-and-routing.md#reservations)** with the
   snapshots and with the workers Orca reports, then **load rejections**:
   models an agent refused at launch, saved by `verify`,
   still younger than `rejectionTtlHours`.

Then the pure routing core (`src/routing/router.ts`, no I/O) turns that
environment, your request and your config into a `Decision`: every eligible
model competes, from all cost tiers, and the quota bucket with the most
capacity left decides. `route` then repeats that decision under the ledger's
lock and reserves the pick's quota (`src/routing/allocate.ts`). Setup and
status show a pick from another cost tier with a label such as
`(daily cost tier)` for Advanced needs; a cheaper covering pick is not a
downgrade. See
[Tiers and routing](tiers-and-routing.md).

Each evidence HTTP request has a 10 s timeout (manifest, then snapshot when
needed); live model listings have 30 s each and usage has 20 s. These limits
apply to individual operations, not the total call. See
[The first call is slow](troubleshooting.md#the-first-call-is-slow) for how
the concurrent operations affect waiting time.
