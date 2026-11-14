# Tiers and routing

## Cost tiers and capability

Each model has separate capability and cost profiles. Coding, agentic and
reasoning scores are raw LLMBenchmark evidence; hints and prices never change
scores, bands or need cuts. The evidence class is the highest axis band.

The cost tier is Light, Daily, Advanced or Frontier. With default `costBands`
`[1, 5, 12]`, the blended price in USD per million tokens determines the tier:

| Cost tier | Blended $/M |
| --- | --- |
| Light | below 1 |
| Daily | 1 to below 5 |
| Advanced | 5 to below 12 |
| Frontier | 12 or above |

Blended price is `(3 × inputPerM + outputPerM) / 4`, rounded to two decimals.
It is a 3:1 sorting key, not a subscription bill. Cost tier comes from the first
available source: `tierOverrides` (model id, then family), snapshot price,
family/model-line hint, provider lineup, then evidence class. With none it is
null. An override changes cost only; it cannot make a model cover harder needs.
Day-0 models without prices use hints and inherited evidence until data arrives.

`orcacompass tiers` is the cost-tier view, with price thresholds and each
model's evidence beside its cost. `orcacompass ranking` is the evidence view:
model id, cost tier, blended price or `no price`, cost source, evidence class,
axis scores/bands/labels and launchable agents. Its default order is cost tier
(Frontier first), then evidence class and score; `ranking --axis coding` sorts
by that axis's score. Hints are printed only when they decided the cost tier.
`orcacompass tiers --axis coding` still groups by evidence band and shows cuts.

## When placement runs

The schema 4 placement table is cached for five hours by default. A changed
snapshot, `tierOverrides`, `costBands` or newly detected agent rebuilds it;
`refresh` forces a rebuild. Older schemas are discarded and rebuilt. A model
without evidence or an inheritance hint is unranked.

## Needs and ranking

Pass all three axes, for example `--need coding=high,agentic=mid,reasoning=low`.
Each level is `min`, `low`, `mid` or `high`; min has no cut, and the other
levels correspond to the Daily, Advanced and Frontier evidence-band cuts.
`--tier` is a shorthand mapping light/daily/advanced/frontier to the same need
level on every axis; it cannot be combined with `--need`. The requested tier
expresses capability needs, so a covering pick may have a cheaper cost tier.

A model covers a job when every axis meets its cut. Routing chooses the
cheapest cost tier whose evidence covers the job, then the most headroom.
Within that fit group, unblocked routes come first, then pace-scaled headroom,
hot-session status, usage confidence, evidence strength, need-weighted score,
non-fast variants, newest release, agent id and model id. Preferences, bans
and agent constraints still apply.

When the fit group is blocked, routing tries non-covering groups in increasing
shortfall, or waits with `--no-downgrade`. Higher covering cost tiers are used
only when the cheaper group has no route at all, never to bypass blocked usage.
`quality` reports evidence class, cost (`tier`, `blended`, `source`), coverage,
shortfall, overshoot and per-axis scores, needs and evidence. Estimated and
assumed evidence is provisional. `Decision.tier` is the pick's cost tier;
`quality.class` remains its evidence class. See [Commands](commands.md) for JSON.

Within one agent, only the newest release of a family competes per cost tier.
Sonnet 4.6 (Advanced cost) can remain beside Sonnet 5.5 (Daily cost), but cannot
beat it for a job the cheaper model covers. Grok 4.5 and 4.7 are both Daily cost,
so only 4.7 competes.

## Cursor auto fallback

Cursor `auto` is not ranked as a model. It is a fallback when no named candidate
can be routed, after named last-resort candidates and before waiting; Cursor chooses the model.
`--no-downgrade` and `cursorAuto: false` exclude it; an auto override is ignored.
The result has no quality profile or cost tier and confidence is at most medium.

## Confidence and stale usage

Confidence describes usage, not placement certainty. Known fresh usage is high;
moderately stale usage is medium and unknown or very stale usage is low. Stale
usage still blocks. Evidence certainty appears in `quality.evidence`.

## Fallbacks: downgrade, upgrade, wait, none

A downgrade falls short of the job's needs; narrow the task or add checks. An
upgrade reflects structural availability, not an attempt to evade a quota.
A cheaper cost tier that covers the needs is not a downgrade. Setup and status
accept it as a pick and label it, for example `(daily cost tier)` for Advanced
needs. `(upgraded to X)` and `(downgraded to X)` mark actual fallbacks.
`waitUntil` may indicate the next reset. Recent successful hand-outs add a
configurable temporary usage adjustment before routing, reducing repeated picks.
