---
description: Look up how needs, evidence, cost tiers, quota, reservations and preferences determine a route.
---

# Tiers and routing

Look up how `orcacompass route` turns needs into evidence cuts, groups models
by cost tier, and applies coverage, quota, reservations and preferences. For a
step-by-step example, read [How it works](how-it-works.md) first. Code:
`src/routing/router.ts`, `src/routing/adequacy.ts`, `src/routing/quota.ts`,
`src/routing/reservations.ts`, `src/placements/profiles.ts`.

## Cost tiers and capability

Each model has two independent profiles:

- **Evidence (capability).** A coding, agentic and reasoning score from the
  LLMBenchmark evidence snapshot. Each score falls in a band (Light, Daily,
  Advanced or Frontier) set by the snapshot's per-axis cuts. The model's
  **evidence class** is its highest axis band.
- **Cost tier.** Light, Daily, Advanced or Frontier, mostly from the maker's
  price.

Prices and cost tiers never change scores, bands or need cuts. Each axis score
also carries an evidence label:

| Label | Meaning |
| --- | --- |
| `measured` | The model's own score, from three or more benchmarks |
| `partial` | The model's own score, from fewer than three benchmarks |
| `estimated` | The model's own score, marked as estimated in the snapshot |
| `assumed` | Another model's score standing in: inherited from a related model, or a curated stand-in |
| `unranked` | No score on this axis |

### The four cost tiers {#the-four-tiers}

With the default `costBands` `[1, 5, 12]`, the blended price in USD per million
tokens decides the tier:

| Cost tier | Blended $/M |
| --- | --- |
| Light | below 1 |
| Daily | 1 to below 5 |
| Advanced | 5 to below 12 |
| Frontier | 12 or above |

The blended price is `(3 × inputPerM + outputPerM) / 4`, rounded to two
decimals. It sets the cost tier and the
[price adjustment](#ranking-covering-routes) in ranking; it is not a
subscription bill.

The cost tier comes from the first source that has one; `cost.source` in the
JSON names it:

| Order | `cost.source` | Where the tier comes from |
| --- | --- | --- |
| 1 | `override` | `tierOverrides`, by model id, then by family |
| 2 | `price` | The snapshot's maker price, banded by `costBands` |
| 3 | `family` | A built-in model line (Gemini Argon, Grok 4.7 and later), then a built-in family (Claude Haiku/Sonnet/Opus/Fable, GPT Luna/Terra/Sol/Astra, Gemini Flash Lite) |
| 4 | `lineup` | Words in the provider's own description of the model |
| 5 | `evidence` | The evidence class |

With none of these the cost tier is null and the model is listed as
unclassified. Newly released models without a price use these hints and
inherited evidence until data arrives.

::: info Overrides and evidence
For a model with its own scores, an override changes the cost tier only; it
cannot make the model cover harder needs. A model without its own scores
inherits, per axis, the best score among models of the same vendor that are in
its family or whose hint is at or below its own hint. That hint includes an
override, so for such a model an override also limits which scores it can
inherit.
:::

### Views

- `orcacompass tiers` is the cost-tier view: the price thresholds, then each
  cost tier's models with their cost and evidence. `tiers --axis coding`
  groups by evidence band on that axis instead and shows its cuts, including
  the `top` cut.
- `orcacompass ranking` is the evidence view: model id, cost tier, blended
  price or `no price`, cost source, evidence class, each axis's score, band,
  label and benchmark count, and the agents that can launch it. The default
  order is cost tier (Frontier first), then evidence class, then the sum of
  the axis scores; `ranking --axis coding` sorts by that axis's score. A hint
  is printed only when it decided the cost tier.

## When placement runs

OrcaCompass computes every model's profiles into the placement table
(`placements.json`, schema 5, in the cache folder) and reuses it for
`placementsTtlHours` (5 by default; `0` rebuilds on every command). It is
rebuilt when:

- the file is missing or unreadable, including a table of another schema;
- it was written by another OrcaCompass version;
- it is older than `placementsTtlHours`, or its build time is in the future;
- `tierOverrides` or `costBands` changed;
- the evidence snapshot changed;
- an agent the table recorded as not installed is now found on the PATH.

`orcacompass refresh` forces a rebuild. A model with no evidence and no hint to
inherit evidence through is unranked.

## Needs and ranking

Pass all three axes exactly once, for example
`--need coding=high,agentic=mid,reasoning=low`. Each level is a minimum on
that axis:

| Need | Meaning | coding | agentic | reasoning |
| --- | --- | --- | --- | --- |
| `min` | No minimum | — | — | — |
| `low` | Daily evidence band | 60 | 35 | 70 |
| `mid` | Advanced evidence band | 75 | 70 | 80 |
| `high` | Frontier evidence band | 82 | 80 | 86 |
| `top` | Frontier band and at or above `topBands` | 87 | 82 | 90 |

These are the cuts of the current snapshot (`bands` and `topBands`); a data
refresh can move them. The `low` cut sits under the good small models, so a
simple job can go to one; `top` leaves only the strongest models. A model that
meets a level also meets every level below it.

`--tier` is a shorthand for the same level on every axis: `light`, `daily`,
`advanced` and `frontier` mean `min`, `low`, `mid` and `high` (`top` has no
tier). It cannot be combined with `--need`.

::: info The requested tier
Every route has a **requested tier** (`requestedTier` in the JSON). With
`--tier` it is that tier. With `--need` it follows the highest need: `min`
Light, `low` Daily, `mid` Advanced, `high` or `top` Frontier. It picks the
tier-default effort and the preference that applies, and it is what
`upgraded` compares against. It does not limit the cost tier: a covering pick
may have a cheaper or a pricier cost tier.
:::

A model **covers** the job when its band on every axis reaches the need (for
`top`, a Frontier band with a score at or above the `top` cut). Otherwise it
falls short; its **shortfall** is the number of band steps missing, summed over
the axes, and each short axis is listed under `skipped` as
`below need on <axis> (<score> < <cut>)`. An axis without a score is not a
shortfall: its coverage is **unknown**, and the model is listed as
`unranked: no evidence or estimate (<axes>)`. Unknown coverage never makes a
route eligible.

Within one agent, only the newest release of a family competes per cost tier.
Sonnet 4.6 (Advanced cost) can remain beside Sonnet 5.5 (Daily cost). If both
qualify and draw on the same pools, the lower price favors Sonnet 5.5. Grok
4.5 and 4.7 are both Daily cost, so only 4.7 competes. Gemini's family is its
line, the word after the version: Gemini 4 Carbon, Argon and Hydrogen are three
families, so a newer Hydrogen does not hide Carbon, while Gemini 3.8 Flash
replaces 3.5 Flash. A release that is not in the evidence yet borrows its
predecessor's scores, so Gemini 5 Neon replaces Gemini 4 Neon on the day it
appears.

### Order of decisions {#order-of-decisions}

1. **Agents.** An agent is left out, and listed under `skipped`, when the
   config excludes it (`denyAgents`, `allowAgents`), the request excludes it
   (`--agent`, `--exclude-agent`), it is switched off in Orca, Orca reports
   its usage as unavailable, it is not installed, it is signed out, or it has
   no models. Agents in `lastResortAgents` (OpenCode by default) are held back
   unless named with `--agent` or set as the preference for the requested tier
   (see [Last-resort agents](#last-resort-agents)).
2. **Models.** Left out: models marked NO ZDR when `excludeNoZdr` is on,
   models you banned, models the agent refused at launch within
   `rejectionTtlHours` (see [Verify and rejections](verify-and-rejections.md)),
   and unranked models unless the requested tier's preference or `--use` names
   that exact model. Cursor `auto` is set aside as an
   [option](#cursor-auto-fallback). Per agent, family and cost tier only the
   newest release competes; an older release that the preference or `--use`
   names exactly is kept for that choice only, never for automatic routing.
   Banned, refused and unranked models are listed under `skipped`; NO ZDR
   models and superseded releases are dropped without an entry. A model
   without capability scores is never given any.
3. **Eligibility.** A route is eligible only when its model covers the job on
   all three axes and can apply an effort that satisfies the request (see
   [Effort](effort.md#explicit-effort-is-a-constraint)). A route that fails
   either test is left out, with the reason under `skipped`. Nothing is scored
   down for falling short, and neither the needs nor the effort are lowered to
   make a route fit.
4. **Quota.** Each eligible route gets the reported, reserved, effective and
   prospective usage of every [quota bucket](#quota-reservations-and-risk) it
   draws on.
5. **Explicit choice.** With `--use <agent>/<model>` that route is taken as it
   is, unless a quota it draws on is exhausted.
6. **Preference.** A preference for the requested tier is tried first (see
   [Preferences](#preferences-pins)).
7. **Pick.** The first route in [rank order](#ranking-covering-routes) that may
   be routed automatically.
8. **Decide or none.** When no eligible route is below the risk threshold, the
   decision goes back to the Orchestrator: `decide`, with what it can do under
   `options` (see [Outcomes](#outcomes-ok-decide-none)). `none` when nothing
   can take the job even with lower requirements.

### Ranking eligible routes {#ranking-covering-routes}

Routing is quota first. Eligible routes from all cost tiers and agents are
ordered by:

1. **Standing.** Routes whose prospective usage is *available* on every bucket,
   then *caution*, then routes whose usage is unknown, then routes without a
   usage window (pay per use, local). Routes at high risk, fully reserved or
   exhausted come last and are never picked automatically.
2. **Remaining capacity.** The quota bucket with the most effective capacity
   left comes first. A route that draws on several windows is ranked by its
   most restrictive one, its **binding bucket**.
3. **Economy, inside one bucket.** The route that reserves the fewest
   percentage points comes first (a Daily model before a Frontier one at the
   same effort), then the lower blended price. A model is not preferred for
   being stronger than the job needs.
4. Ties: higher usage confidence, stronger evidence, the higher need-weighted
   score, a standard model before a fast variant, the newer release, then
   agent and model id, so equal inputs always give the same route.

A route whose own buffer would take a bucket over the threshold is passed over
for the next route in the same bucket before the next bucket is tried: a
Frontier worker reserving 2.5 points may cross 85% where a Daily worker
reserving 1.5 does not.

A route that returns this pick adds a line such as `selection: quota bucket
codex weekly has 80% effective capacity left (bucket 2 of 3 with an eligible
route); most economical eligible route in it below the 85% caution threshold`
to its reasons, and `next best` names the runner-up.

## Quota buckets, reservations and risk {#quota-reservations-and-risk}

OrcaCompass does not forecast how much quota you will use. It routes on what
Orca reports now and on what is reserved now.

### Buckets

A **quota bucket** is one limit that is enforced on its own: a provider, the
account it runs on (with its runtime and plan), and a usage window. Claude's
session, weekly and Fable weekly windows are three buckets; Cursor's monthly
total and each named bucket are separate; each Antigravity quota group has its
own 5-hour and weekly bucket. Models that share a window share its bucket;
names that differ only in case or spacing are one bucket. A change of account,
runtime or plan is a different set of buckets.

Three numbers are kept apart for every bucket:

| Number | Meaning |
| --- | --- |
| `reported` | The usage in Orca's latest valid snapshot. A valid 0% is fully available. A missing number is unknown, never 0 |
| `reserved` | The sum of the buffers of the workers currently reserving the bucket, in percentage points |
| `effective` | `reported + reserved`, held between 0 and 100 |

For a route being considered, `prospective` adds the buffer its own worker
would reserve: `reported + reserved + buffer`, held between 0 and 100. Windows
are never added together; each is checked on its own and the most restrictive
one decides.

A window without a reset time (Orca reports `0` or `null` before a window has
started) keeps its usage and simply has no reset time. A window whose reset
passed since the snapshot, a snapshot more than four times `usageStaleMinutes`
old, and a window Orca gave no number for are **unknown**.

### Reservations {#reservations}

Every `route` that returns a route reserves, on each bucket the route draws
on, a buffer for the worker it is about to start. The buffer covers usage that
does not show in Orca's numbers yet; it is not a forecast.

| Buffer tier | `low` | `medium` | `high` | `xhigh` |
| --- | ---: | ---: | ---: | ---: |
| `minimal` | 0.5 | 0.5 | 0.75 | 1.0 |
| `light` | 0.5 | 1.0 | 1.25 | 1.5 |
| `daily` | 1.0 | 1.5 | 1.75 | 2.0 |
| `advanced` | 1.5 | 2.0 | 2.5 | 3.0 |
| `frontier` | 2.0 | 2.5 | 3.0 | 3.5 |

The row is the model's cost tier; `minimal` is used only by models you map to
it in `reservations.modelTiers`, and a model without a cost tier (Cursor
`auto`, a preferred unranked model) uses `frontier`. The column is the effort
the launch applies: `none` and `minimal` use `low`, `max` uses `xhigh`, and an
effort the agent sets itself uses its reported default, else `high`. These are
starting values, in percentage points per worker and bucket; change them, or
scale them per provider, plan or window, under
[`reservations`](configuration.md#reservations).

Each worker has one record with a lifecycle:

| State | Counts | Meaning |
| --- | --- | --- |
| `pending` | yes | Reserved by `route`; the launch is not confirmed yet |
| `running` | yes | `verify` saw the worker start, or Orca lists it as live |
| `completed` | yes | The worker finished; held until a fresh snapshot covers it |
| `cancelled_after_consumption` | yes | Stopped after it had worked, or a `pending` reservation nobody confirmed within `pendingMinutes`; held the same way |
| `failed_before_launch` | no | Nothing ran (the agent refused the model): released at once |
| `released` | no | Reconciled by a fresh snapshot |

The reserved total of a bucket is **rebuilt from these records every time**:
the buffer of each worker that still counts, once per bucket, on top of the
latest reported usage. No earlier total is carried over, so a buffer cannot
accumulate from one refresh to the next. With four workers reserving 2.5
points each:

| Snapshot | Reported | Workers | Reserved | Effective |
| --- | ---: | ---: | ---: | ---: |
| 12:00 | 40% | 4 | 10 pp | 50% |
| 12:05 | 48% | 3 | 7.5 pp | 55.5% |
| 12:10 | 55% | 1 | 2.5 pp | 57.5% |
| 12:15 | 58% | 0 | 0 pp | 58% |

A finished worker's reservation is released only by a snapshot that Orca took
at least `settleSeconds` after the worker ended, for the same provider and
account. The snapshot's own timestamp decides: reading the same cached snapshot
again releases nothing, however much time passed, and a fresh snapshot
releases even when it reports the same percentage. A provider whose refresh
failed keeps its reservations while the others are reconciled.

The records live in `reservations.json` in the cache folder. Every change is
made under a lock file and written through a temporary file, so OrcaCompass
processes running at the same moment cannot lose or duplicate a reservation,
and the route is decided again on the locked ledger before its capacity is
reserved: ten simultaneous calls take exactly as many routes as fit.

### Risk thresholds {#risk-thresholds}

| Prospective usage | Status | Routing |
| --- | --- | --- |
| Below `cautionPercent` (85) | `available` | Normal routing |
| From it to below `highPercent` (90) | `caution` | Used only when no route is available, with a warning |
| From `highPercent` to below 100 | `high` | Not routed automatically |
| 100, reported usage below 100 | `reserved` | Fully reserved: unavailable until reservations are released, usable with `--use` |
| Reported usage 100 | `exhausted` | Cannot be used |
| No valid number | `unknown` | Ranked after known usage; routed with low confidence and a warning |

The thresholds apply to the prospective usage, so a bucket at 84% is still
available as it stands and already caution for a worker reserving 1.5 points.

## Preferences (pins) {#preferences-pins}

A preference names your favorite route for one tier: an agent, optionally a
model. It applies when the route's **requested tier** is that tier.

1. A preferred **model** is used even when it falls short of the job or is
   unranked. A measured shortfall marks the route `downgraded`, the reasons
   say `preferred route does not cover the job` and a warning gives the
   shortfall. A preferred **agent** without a model takes that agent's most
   economical eligible route.
   - An **unranked** preferred model, or one with no score on an axis the job
     needs, is not downgraded: missing benchmark data is unknown coverage,
     not a shortfall. It gets no artificial score, band or shortfall, is not
     listed under `skipped`, and the route carries the informational reason
     `Manually preferred model; benchmark data unavailable. Task coverage could
     not be verified.` (also as `coverageNote`, and as the tier's `note` in
     `status` and `setup`). An axis that does have a score is still checked,
     and a measured shortfall on it is reported as above.
   - Once benchmark data for the model arrives, it is evaluated like any
     other model: the note goes away and any actual shortfall is reported.
   - Unranked models stay out of automatic routing; only the preference (or
     `--use`) routes one.
2. The preference must be able to apply the effort: `--effort` exactly, a
   `--demand` at or above its target.
3. It is used while its prospective usage stays below `preferRiskLimit` (90 by
   default) on every bucket it draws on, and never when a quota is exhausted.
   Unknown usage does not count as over the limit.
4. Otherwise it is skipped with a warning and routing goes on without it:

```text
preferred codex gpt-6.1-terra skipped: weekly would be 90.5% used with this worker (limit 90%); resets in 2d
```

When the skipped preference is a model that automatic routing never offers
(unranked, or an older release kept only for the preference) and no route can
be taken automatically, the decision comes back as `decide`: the preference
is the first `options.use` entry (`preferred: true`, with `coverageNote`
when its coverage is unknown), and `options.wait` names the reset of the
buckets at or above the limit. It is never offered under `options.lower`. An
exhausted preference, or one that cannot apply the effort, is not offered.

`preferRiskLimit` is set with `orcacompass prefer --risk-limit <percent>`.
Raising it above `riskThresholds.highPercent` keeps a favorite in use at high
risk; the route then carries the warning for that bucket.

## Last-resort agents {#last-resort-agents}

Agents in `lastResortAgents` (OpenCode by default: API keys cost per token,
local models take this machine) are left out of the first pass. They take the
job, with a warning that says how it is paid for, only when no other agent can:
nothing else is eligible, or every eligible route is exhausted. When another
route could still be used at elevated risk, the decision goes back to the
Orchestrator with the last-resort route listed as one more `use` option.
`--agent`, `--use` or a preference for the requested tier makes such an agent
an ordinary one for that route.

## Cursor auto {#cursor-auto-fallback}

With Cursor `auto`, Cursor chooses the model, so OrcaCompass claims no
capability for it and never routes it on its own. With `cursorAuto` on, it is
listed under `options.lower` when a decision comes back, and the Orchestrator
can take it with `--use cursor/auto`. `--effort`, `cursorAuto: false`, a ban
and an exhausted bucket remove it.

## Confidence and stale usage

Confidence describes the usage data only; `quality` carries the certainty of
the model's profile.

| Confidence | Meaning |
| --- | --- |
| `high` | Usage is known and fresh |
| `medium` | The snapshot is older than `usageStaleMinutes` (30 by default), or it is the last valid one OrcaCompass kept because Orca could not be read, or the route is Cursor `auto` |
| `low` | Usage is unknown: Orca gave none, the snapshot is more than four times `usageStaleMinutes` old, a window reset since it was taken, or the route has no usage window |

Orca refreshes usage on its own schedule, and only while its window is in
use: `orca account list` returns the snapshot Orca holds and never triggers a
refresh. A stale snapshot is still used (usage inside a window only grows), and
reservations stay in place until a fresh one arrives. When Orca cannot be read
at all, the last valid snapshot stands in; usage is never replaced by 0%.

## Outcomes: ok, decide, none {#outcomes-ok-decide-none}

| Result | Meaning |
| --- | --- |
| `status: "ok"` | A route was picked and its quota reserved (`reservation`) |
| `upgraded: true` | The pick's cost tier is above the requested tier because no eligible route exists at or below it |
| `downgraded: true` | The pick falls short of the job's needs. This happens only for a route chosen explicitly: `--use`, or a preferred model. Effort is not raised to make up for it |
| `status: "decide"` | No eligible route is below the risk threshold, or only routes with lower requirements exist. Nothing was picked; `options` lists what the Orchestrator can do |
| `status: "none"` | Nothing can take the job |

With `decide`, `options` holds:

- **`wait`**: waiting can help. `until` is the earliest reset that frees an
  eligible route, present only when every bucket holding that route back
  reports a reset time; no time is made up otherwise. `reason` also says when
  capacity is only held by reservations, which a fresh snapshot releases.
- **`use`**: eligible routes above the threshold whose quota is not exhausted.
  Each carries the flag that takes it, for example
  `--use claude/claude-opus-5-5`.
- **`lower`**: routes that would take the job with lower requirements, nearest
  first, each with its `shortfall` (`below need on agentic (78.2 < 80)`,
  `highest effort high is below xhigh`). Route again with a lower `--need` or
  `--demand`, or take one as it is with its `use` flag.

A cheaper route that covers the needs is not a downgrade, and a pricier route
picked because its bucket has more room is not an upgrade.

`orcacompass status` routes each tier without reserving anything. It shows a
pick only when a route can be taken automatically; the example routes in
`setup` mark `(upgraded to X)` and `(downgraded to X)`.

`route` exits 0 for every outcome; read `status`.
