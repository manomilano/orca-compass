---
description: Look up how needs, evidence, cost tiers, usage, preferences and fallbacks determine a route.
---

# Tiers and routing

Look up how `orcacompass route` turns needs into evidence cuts, groups models
by cost tier, and applies coverage, usage, preferences and fallbacks. For a
step-by-step example, read [How it works](how-it-works.md) first. Code:
`src/routing/router.ts`, `src/routing/adequacy.ts`, `src/routing/pace.ts`,
`src/placements/profiles.ts`.

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
(`placements.json`, schema 4, in the cache folder) and reuses it for
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
the axes (an axis without a score counts as one step below Light), and each
short axis is listed under `skipped` as `below need on <axis> (<score> < <cut>)`.

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
   and unranked models unless the requested tier's preference names that exact
   model. Cursor `auto` is set aside as a [fallback](#cursor-auto-fallback).
   Per agent, family and cost tier only the newest release stays. Banned,
   refused and unranked models are listed under `skipped`; NO ZDR models and
   superseded releases are dropped without an entry.
3. **Effort.** With `--effort`, routes that cannot apply exactly that effort
   are dropped (see [Effort](effort.md#explicit-effort-is-a-constraint)).
4. **Covering routes.** Every remaining route whose model covers the job, from
   every cost tier, in [rank order](#ranking-covering-routes).
5. **Preference.** A preference for the requested tier is tried first (see
   [Preferences](#preferences-pins)).
6. **Effort check.** With `--effort`, when models cover the job but none of
   their routes can apply the effort, the result is `none` with the efforts
   each route offers. No downgrade is tried.
7. **Pick.** The first unblocked covering route in rank order.
8. **Downgrade.** Without `--no-downgrade`: routes that fall short, in groups
   of increasing shortfall; the first unblocked route in
   [usage order](#usage-order) wins.
9. **Cursor auto.** Without `--no-downgrade`, when it is not blocked.
10. **Wait or none.** `wait` when some blocked covering route (or, without
    `--no-downgrade`, a blocked route that falls short) will unblock;
    `waitUntil` is the earliest time one has all its blocking windows reset.
    `none` otherwise.

### Ranking covering routes {#ranking-covering-routes}

Covering routes from all cost tiers compete together. A pricier model can win
when its subscription has clearly more room. They are compared in this order:

1. unblocked before [blocked](#usage-headroom-and-pace);
2. known usage before unknown usage;
3. the higher **score**: [pace-scaled headroom](#usage-headroom-and-pace) in
   percentage points, minus the price adjustment and the effort adjustment
   below;
4. on equal scores, the [usage order](#usage-order).

The price adjustment for a blended price of `p` USD per million tokens is
`5 × p / (p + 4)` points:

| Blended $/M | Price adjustment |
| --- | --- |
| 0.20 | 0.24 points |
| 1 | 1.00 point |
| 4 | 2.50 points |
| 8 | 3.33 points |
| 16 | 4.00 points |
| any price | below 5 points |

So five points more headroom outweigh any price difference, and two routes on
the same usage windows are decided by price: the cheaper model wins.

- The price is kept inside the model's cost tier, so a `tierOverrides` entry
  also moves the adjustment: a model priced at $8 and overridden to Daily
  counts as $5.
- A model without a price counts as the middle of its cost tier ($0.50, $3 or
  $8.50), or $12 in the Frontier tier.
- A model billed per use (OpenCode's `pay per use through <provider>`) takes
  the full five points.
- A route with unknown usage has no headroom to score, so among such routes
  the adjustment alone decides: the cheapest first.

For example, a $1/M model with 80% headroom scores 79. A $4/M model with 82%
scores 79.5 and wins. At 81% it scores 78.5 and the cheaper model wins.

The effort adjustment is 2.5 points for each effort step a route falls short of
the target from `--demand` or the tier default, because the model offers only
lower efforts and the target would be [snapped](effort.md#snapping-automatic-targets)
down. An `exceptional` job (target `xhigh`) on Gemini 4 Carbon, which stops at
`high`, loses 2.5 points, so Gemini 4 Neon with `xhigh` wins on the same usage
windows although it costs more. A route with clearly more headroom still wins
at the lower effort. An explicit `--effort` leaves out routes that cannot apply
it instead.

A route that returns this pick adds the line `selection: 62.00 ranked headroom
points minus 2.50 price points = 59.50` to its reasons, and `next best` names
the runner-up with its price.

### Usage order {#usage-order}

Routes inside a downgrade group or a preference's own models, and covering
routes with equal scores, are compared in this order:

1. unblocked before blocked;
2. known usage before unknown usage;
3. more [pace-scaled headroom](#usage-headroom-and-pace);
4. no [hot session](#usage-headroom-and-pace) before a hot session;
5. higher usage confidence;
6. stronger evidence label for the job (`measured` first);
7. the lower blended price, when both routes cover the job;
8. the higher need-weighted score (each axis score times its need step);
9. non-fast before fast variants;
10. the newer release date;
11. agent id, then model id.

`quality` in the route JSON reports the evidence class, the cost (`tier`,
`blended`, `source`), `covers`, `shortfall`, `overshoot`, the evidence label
for the job, and per axis the score, band, label, benchmark count, need and
cut. Estimated and assumed evidence is provisional. `Decision.tier` is the
pick's cost tier; `quality.class` remains its evidence class. See
[Commands](commands.md) for the JSON.

## Usage, headroom and pace {#usage-headroom-and-pace}

OrcaCompass reads each agent's usage windows (pools) from Orca. Per route:

| Term | Rule | Default |
| --- | --- | --- |
| Blocked | Orca reports a window as 100% used or more. Recent hand-outs are not counted here. Checked even on stale usage. A blocked route cannot be picked | 100% |
| Near its limit | Orca reports a window at or above `thresholds.longPercent` (long windows) or `thresholds.sessionPercent` (session windows), below 100%. The route can still win; when it does, it carries the warning `<window> quota is N% used; resets in …` | 95% / 90% |
| Expired window | Its reset time has passed: ignored, and confidence drops to low | — |
| Headroom | The share of the window expected to be left unused at reset (negative when on pace to run out) | — |
| Ranked window | The long window with the least room; a session window instead when it is near its limit, or its current pace would reach `sessionPercent` before reset, and it has less room; the session window when there is no long one | — |
| Pace-scaled headroom | Headroom scaled down when the window resets more than 7 days away: counted in proportion, half at 14 days | 7 days |
| Hot session | A session window at or above `sessionPercent` − 20 points: a tiebreak after headroom | 70% |
| Strained | Not blocked, but the ranked window is expected to end above `usageRiskLimit`. It changes no ranking; a strained pick carries the warning `selected route is expected to end above N% of its usage window` | 90% |
| Unknown usage | No usage window (OpenCode), usage not reported by Orca, no matching window, or usage older than four times `usageStaleMinutes` | 2 hours |

The expected use at reset is what is used so far plus the rest of the window at
an estimated pace. That pace blends the observed pace with an even pace,
weighted as if 10% of a window of even use had already been seen, so a burst
right after a reset is not extrapolated.

The `risk` field is simpler: used percent divided by the elapsed fraction of
the window, for the window on pace to end most used. Under 10% elapsed it is
not extrapolated (`tooEarly`). Reasons show it as `on pace for N%`, and
[preferences](#preferences-pins) compare it with `preferRiskLimit`.

Every `route` that returns a route records a hand-out. For `handoutMinutes`
(10) after it, each hand-out counts as `handoutPercent` (5) points more usage
on each of that model's windows, so workers routed back to back spread across
subscriptions. Hand-outs lower headroom only: a window is blocked by the usage
Orca reports, never by hand-outs.

## Preferences (pins) {#preferences-pins}

`orcacompass prefer <tier> <agent> [model]` stores a favorite route for a tier.
It applies when that tier is the [requested tier](#needs-and-ranking). Without
a model, the agent's best-ranked model with a cost tier is used, from any cost
tier; with a model, that model, even when it is unranked.

1. A favorite that is not available, or cannot apply an explicit `--effort`,
   or is blocked, is skipped with a warning and routing continues normally.
2. When its `risk` is within `preferRiskLimit` (100% by default), or its usage
   is unknown, the favorite is used.
3. Above the limit, it is replaced by the best unblocked covering route with
   known usage whose `risk` is within the limit, from any cost tier, in
   [rank order](#ranking-covering-routes).
4. With no such route, the favorite is kept, with a warning.

A favorite is used even when it does not cover the job; the route is then
marked `downgraded` and the reasons say `preferred route does not cover the
job`. `preferRiskLimit` is set with `orcacompass prefer --risk-limit <percent>`.

```text
preferred codex gpt-6.1-terra skipped: weekly on pace for 150% (limit 100%), resets in 2d
preferred codex retained: no unblocked alternative with known usage within the 100% risk limit
preferred codex skipped: blocked (weekly 100% used, resets in 1d)
preferred grok skipped: not available (not enabled in Orca)
```

::: info Two different limits
`usageRiskLimit` only adds a warning, when the picked route's *expected* use
at reset is above it. `preferRiskLimit` decides whether a favorite is
replaced, using the simpler `risk` projection.
:::

## Last-resort agents {#last-resort-agents}

Agents in `lastResortAgents` (OpenCode by default) are used only when nothing
else can take the job. Routing first runs without them and without Cursor
`auto`. If that gives no route, it runs again with them; when that picks a
last-resort agent, the route carries a warning that it was used instead of
waiting, or because nothing else can take it. Otherwise a final run without
them allows Cursor `auto`. Naming the agent with `--agent`, or preferring it for
the requested tier, makes it an ordinary agent for that route.

## Cursor auto fallback

Cursor `auto` is not ranked as a model. It is a fallback when no named candidate
can be routed, after named last-resort candidates and before waiting; Cursor
chooses the model. `--no-downgrade`, `--effort` and `cursorAuto: false` exclude
it; a `tierOverrides.auto` entry is ignored with a warning. The result has no
quality profile or cost tier, and its confidence is at most medium.

## Confidence and stale usage

Confidence describes usage, not placement certainty:

| Confidence | When |
| --- | --- |
| `high` | Usage is known and fresh |
| `medium` | Usage is older than `usageStaleMinutes` (30 by default), or the ranked window includes recent hand-outs, or the route is Cursor `auto` |
| `low` | Usage is unknown, older than four times `usageStaleMinutes`, or a window's reset time has already passed |

Stale usage still blocks. Evidence certainty appears in `quality.evidence`.

## Fallbacks: downgrade, upgrade, wait, none

| Outcome | Meaning |
| --- | --- |
| `downgraded: true` | The pick falls short of the job's needs. Effort is not raised to make up for it; the warning says to split the job or add stronger checks |
| `upgraded: true` | The pick covers the job, its cost tier is pricier than the requested tier, and no route at or below the requested tier covers the job (with `--effort`: and can apply that effort). The warning reads `no model in the <tier> cost tier covers the job; using <tier>` |
| `status: "wait"` | Nothing can be routed now; `waitUntil` is the earliest reset that unblocks a route |
| `status: "none"` | Nothing can be routed and no reset helps, or no covering route can apply an explicit `--effort` |

A pick from another cost tier is an ordinary pick whenever a route at or below
the requested tier also covers the job: a cheaper cost tier that covers the
needs is not a downgrade, and a pricier route picked for its headroom is not
an upgrade.

`orcacompass status` routes each tier with `--no-downgrade`. It shows a pick
from another cost tier with that tier, for example `(daily cost tier)` on the
Advanced line, and shows no route for a tier whose pick is upgraded. The
example routes in `setup` mark `(upgraded to X)` and `(downgraded to X)`.

`route` exits 0 for every outcome; read `status`.
