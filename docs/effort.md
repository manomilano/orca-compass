---
description: Learn how OrcaCompass chooses reasoning effort, checks model support and reports what the launch applies.
---

# Effort

The [needs](tiers-and-routing.md#needs-and-ranking) decide how capable the
model must be. **Effort** is a separate
decision: how much the chosen model should think on this job. This page covers
how OrcaCompass chooses an effort, checks it against what the model and agent
support, and reports what it applied. Code: `src/routing/effort.ts` and the
`effortPlan` / `resolve` functions in `src/routing/router.ts`.

## The effort ladder

```text
none < minimal < low < medium < high < xhigh < max
```

These are the levels OrcaCompass knows. On the command line, `--effort` is
case-insensitive and accepts `extra-high` and `extra_high` as aliases of
`xhigh`; the config file requires the exact names. Codex's `ultra` is not an
effort (it means automatic delegation) and is never used.

## Where the target effort comes from

The **target** is the effort the route asks for, decided in this order:

| `source` | When | Target |
| --- | --- | --- |
| `explicit` | `--effort <e>` was passed | exactly `<e>` |
| `demand` | `--demand <d>` was passed, without `--effort` | `<d>` mapped through `effortPolicy` |
| `tier-default` | neither | `defaultEffort` of the requested tier: Light `low`, Daily `medium`, Advanced `medium`, Frontier `high` |

The requested tier is the `--tier` value, or with `--need` the tier of the
highest need level (`min` Light, `low` Daily, `mid` Advanced, `high` or `top`
Frontier); see [the requested tier](tiers-and-routing.md#needs-and-ranking).

The target is fixed before any fallback. A cheaper pick, a downgrade or an
upgrade keeps it: effort follows the work, not the model. A weaker model doing
the job is not given more effort to compensate; the downgrade warning asks you
to split the job or add checks instead.

## Effort demand

The orchestrator (the agent coordinating workers) rates how much thinking the
job requires, based on the work itself. The needs pick how capable the model
must be; the demand picks how much it should think before acting. More effort
buys exploring alternatives and checking its own reasoning, at a cost in time
and usage.

### Rating the demand {#reasoning-demand}

The rating answers one question: how much reasoning is required to reach a
correct solution, and how difficult is it to detect an incorrect one with the
checks available for this job?

| Demand | The job | Typical work |
| --- | --- | --- |
| `low` | The approach is known, decisions are mechanical, and little independent reasoning or verification is needed | Rename, formatting, routine dependency bump, boilerplate, a straightforward step of a written plan |
| `moderate` | The approach is mostly clear but requires local decisions, analysis, or routine investigation | A feature following an existing pattern, a bug whose cause is localized by the error, tests for known behaviour |
| `high` | Finding or validating the right approach requires substantial investigation, non-obvious deductions, or resolving competing constraints | An unexplained bug with no repro, a subtle race, a migration plan with real trade-offs, a refactor with an invariant that is hard to preserve or verify |
| `exceptional` | The job requires unusually deep reasoning, extensive exploration of competing explanations or solutions, or resolving complex interacting uncertainties beyond a normal `high` attempt | Tracing intermittent corruption across services with conflicting evidence, designing a novel security boundary with subtle failure modes |

Between two adjacent levels, the orchestrator prefers the lower unless deeper
reasoning would materially improve the solution or its validation, and falls
back to `moderate` only when the task description is too sparse to rate. Most
jobs are `low` or `moderate`; `exceptional` is rare. Good tests reduce
verification uncertainty, not necessarily the reasoning needed to find a
solution. A job that is only partly hard is split when practical and its parts
rated separately. After a failed attempt the orchestrator reassesses first: it
raises the demand one level when more thorough thinking is needed, the
relevant need when more capability is needed, and both only when each is
justified on its own. An unclear task spec or missing context, tools or access
is fixed instead of escalating.

Demand is independent of the needs and of the model: a Light model can get
`high` (a tricky one-file fix) and a Frontier model `low` (a bulk edit that
only a very strong model is trusted with). Size, topic, keywords, urgency or
importance alone do not raise it: a rename across fifty files can be `low`,
and security, migration, concurrency and production work follow the same
rubric. Costly failure calls for tests and review in the task spec, not only
more thinking.

### Effort policies

`effortPolicy` in the config maps demand to effort. `balanced` is the default.

| Demand | `efficient` | `balanced` (default) | `quality` |
| --- | --- | --- | --- |
| `low` | `low` | `low` | `low` |
| `moderate` | `low` | `medium` | `medium` |
| `high` | `medium` | `high` | `xhigh` |
| `exceptional` | `high` | `xhigh` | `xhigh` |

::: tip
No policy maps to `max`; that takes an explicit `--effort max`. The mapping is
a starting heuristic, not a measured optimum: `balanced` gives each demand its
own effort, `low` to `xhigh`; `quality` also gives high work `xhigh`;
`efficient` saves effort on moderate and high work and keeps exceptional work
at `high`. Measuring it is on the [roadmap](roadmap.md).
:::

## Checking the target against the model

Each discovered model carries the efforts it supports and where that list came
from (`supportSource`), most trusted first:

| `supportSource` | Meaning | Agents |
| --- | --- | --- |
| `provider` | The agent CLI's own model list or cache | Claude Code (its cached account catalog), Codex (`models_cache.json`), Cursor (effort variants in `cursor-agent models`), Grok (`models_cache.json`), Antigravity ids with an effort suffix (Gemini) |
| `orca` | Orca's effort menu or catalog for that agent | Claude Code and Codex (Orca's model catalog, their first source), Grok (from `grok models`, with Orca's ceilings), Antigravity ids without an effort suffix (Orca's catalog, else `low`/`medium`/`high`), Muse (`minimal` to `max`; Orca's `ultra` has no rung here), OpenCode (none) |
| `assumed` | A built-in guess | Claude Code and Codex when neither Orca's catalog nor the agent's own cache lists any model, so models come from the evidence catalog: `low`, `medium`, `high`, `xhigh`, `max` |

`supportSource` is `unknown` when a model carries no source.

### Snapping (automatic targets)

A `demand` or `tier-default` target the model does not offer is **snapped**:
the nearest **lower** supported effort, else the **lowest higher** one.
Ranking counts each step snapped down against the route (2.5 points per step,
see [ranking](tiers-and-routing.md#ranking-covering-routes)), so a route that
can apply the target wins a near tie.

| Target | Model supports | Resolved | Reported |
| --- | --- | --- | --- |
| `high` | `low`, `medium` | `medium` | `adjusted: true`, "(high not offered, nearest supported)" |
| `xhigh` | `low`, `medium`, `high` | `high` | adjusted |
| `low` | `medium`, `high` | `medium` | adjusted (lowest higher) |
| `medium` | `low`, `medium`, `high` | `medium` | not adjusted |
| any | none settable | `null` | `applied: provider-default` |

### Explicit `--effort` is a constraint

An explicit effort is never snapped. It behaves like `--agent`: routes that
cannot apply exactly that effort are left out, including a preferred route and
routes that fall short. Cursor Auto never can, so `--effort` always excludes
it.

A covering route from any cost tier that can apply the effort is used (see
[Tiers and routing](tiers-and-routing.md#order-of-decisions)). When models
cover the job but none of their routes can apply the effort, the route is
`none` and the reasons list what each one offers. No downgrade is tried. The
first reason names the requested tier:

```text
no daily route supports effort xhigh: claude claude-sonnet-5-5 (low/medium/high/max), …
choose one of these efforts, or route without --effort
```

A route with no settable effort is listed as `provider-controlled`. Use
`--effort` only when the user asked for a specific level.

## How effort reaches the agent

`effort.applied` in the route says how the launch carries the effort:

| `applied` | Launch | Agents |
| --- | --- | --- |
| `flag` | `--model <id> --effort <e>` | Claude Code, Codex, Grok Build, Antigravity ids without an effort suffix, Muse |
| `model-id` | `--model <variant id>`, no `--effort`; `route.effort` is `null` | Cursor (`claude-opus-5-5-high`; the plain id stands for `medium`), Antigravity Gemini (`gemini-3.8-flash-high`) |
| `provider-default` | `--model <id>` only; the agent uses its own default | OpenCode (Orca passes no effort), Cursor Auto, any model with no settable effort |

When `applied` is `provider-default`, the reason reads, for example, `effort:
not set, codex uses its own default (medium); high wanted from high reasoning
demand (balanced policy)`, and `providerDefault` carries the agent's default
when the provider reports one. The orchestrator must not claim an effort was
set in that case.

When the supported levels are `assumed`, the effort reason ends with
`supported levels assumed, not reported by the provider`.

### Per-agent details

- **Claude Code**: efforts from Orca's catalog, then its cached account
  catalog, then assumed `low` to `max`. Passed as `--effort`.
- **Codex**: efforts and the default from Orca's catalog; then
  `supported_reasoning_levels` and `default_reasoning_level` from
  `~/.codex/models_cache.json` (which also fills a default Orca's catalog
  lacks); then assumed `low` to `max` when neither lists any model. Passed as
  `--effort`. Orca checks effort against its own catalog for models it knows
  (for example `gpt-5.5` up to `xhigh`); whether the two lists always agree
  has not been checked.
- **Cursor**: variants `…-low`, `…-medium`, `…-high`, `…-xhigh`, `…-max` grouped
  under one base id; `-thinking` and `-fast` are stripped. Non-fast variants
  are preferred, then thinking variants; fast-only levels are dropped when a
  non-fast level exists, so a request snaps to a non-fast id instead of silently
  picking a fast one. When a model has effort variants, the unsuffixed id fills
  a missing `medium`.
- **Grok Build**: `reasoning_efforts` and the default `reasoning_effort` from
  `~/.grok/models_cache.json`. Multi-agent models get no effort (on them effort
  sets how many agents run). From `grok models`: `low` to `xhigh`, capped as in
  Orca's seed (`grok-4.5` up to `high`).
- **Antigravity**: ids ending in `-low`, `-medium`, `-high` or `-xhigh` (the
  Gemini models, `gemini-4-neon-low|medium|high|xhigh`) are grouped like
  Cursor's, with the unsuffixed id filling a missing `medium`; other ids
  (Claude, GPT-OSS) take Orca's `--effort`, with the efforts Orca's catalog
  lists for them, else `low`/`medium`/`high`.
- **Muse**: Orca's menu, `minimal` to `max`, passed as `--effort`; the
  default is `high`.
- **OpenCode**: no effort; Orca does not support it for OpenCode.

## The `effort` object in route JSON

```json
"effort": {
  "source": "demand",
  "demand": "high",
  "policy": "balanced",
  "target": "high",
  "resolved": "medium",
  "applied": "flag",
  "adjusted": true,
  "supportSource": "provider",
  "providerDefault": "medium"
}
```

| Field | Meaning |
| --- | --- |
| `source` | `explicit`, `demand`, or `tier-default` |
| `demand`, `policy` | Present when `source` is `demand` |
| `target` | The effort asked for |
| `resolved` | The effort the launch asks the agent for; `null` when the agent decides |
| `applied` | `flag`, `model-id`, or `provider-default` |
| `adjusted` | `true` when `resolved` is set and differs from `target` (snapped) |
| `supportSource` | `provider`, `orca`, `assumed`, or `unknown` |
| `providerDefault` | The agent's own default effort, when the provider reports one |

## Examples

```sh
# everyday feature, a few local choices
orcacompass route --tier daily --demand moderate
#   effort: medium from moderate effort demand (balanced policy), passed as --effort

# bulk rename across many files: cheap model, little thinking
orcacompass route --tier light --demand low

# one subtle race in one file: ordinary model, deep thinking
orcacompass route --tier daily --demand high
#   effort: high from high effort demand (balanced policy), passed as --effort

# the user asked for max on a Frontier job
orcacompass route --tier frontier --effort max
#   routes that cannot apply max exactly are left out
#   effort: max from request, passed as --effort

# no demand rated: the tier default applies
orcacompass route --tier advanced
#   effort: medium from tier default, passed as --effort
```

The commented lines are the effort reason as `route` prints it when the model
supports the target and takes `--effort`.
