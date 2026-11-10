# Tiers and routing

## The four tiers

Each model has a profile on coding, agentic and reasoning. LLMBenchmark evidence
is nudged by an override, family or provider lineup hint; the highest axis band
is its class: Light, Daily, Advanced or Frontier. `orcacompass ranking` shows
scores, bands, evidence and hints; `orcacompass tiers --axis coding` shows bands.

## When placement runs

The schema 3 placement table is cached for five hours by default. A changed
snapshot, placement settings or newly detected agent rebuilds it; `refresh`
forces a rebuild. A model without evidence or an inheritance hint is unranked.

## Needs and ranking

Pass all three axes, for example `--need coding=high,agentic=mid,reasoning=low`.
Each level is `min`, `low`, `mid` or `high`; min has no cut, and the other
levels correspond to the Daily, Advanced and Frontier band cuts. `--tier` is a
shorthand mapping light/daily/advanced/frontier to the same level on every axis;
it cannot be combined with `--need`.

A model covers a job when every axis meets its cut. The fit group is the lowest
class among covering models. Within it, usage headroom and confidence precede
quality evidence and need-weighted score. When the fit group is blocked, routing
tries non-covering groups in increasing shortfall, or waits with `--no-downgrade`.
Higher covering classes are used only when the fit group has no route at all,
not to bypass blocked usage. Preferences, bans and agent constraints still apply.
`quality` reports class, coverage, shortfall, overshoot and per-axis scores,
needs and evidence. Estimated and assumed evidence is provisional.

## Cursor auto fallback

Cursor `auto` is not ranked as a model. It is a fallback when no named candidate
can be routed, after named last-resort candidates and before waiting; Cursor chooses the model.
`--no-downgrade` and `cursorAuto: false` exclude it; an auto override is ignored.
The result has no quality profile and confidence is at most medium.

## Confidence and stale usage

Confidence describes usage, not placement certainty. Known fresh usage is high;
moderately stale usage is medium and unknown or very stale usage is low. Stale
usage still blocks. Evidence certainty appears in `quality.evidence`.

## Fallbacks: downgrade, upgrade, wait, none

A downgrade falls short of the job's needs; narrow the task or add checks. An
upgrade reflects structural availability, not an attempt to evade a quota.
`waitUntil` may indicate the next reset. Recent successful hand-outs add a
configurable temporary usage adjustment before routing, reducing repeated picks.
