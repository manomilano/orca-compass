# Effort

The tier decides how capable the model must be. **Effort** is a separate
decision: how much the chosen model should think on this job. This page covers
how OrcaCompass chooses an effort, checks it against what the model and agent
support, and reports what it applied. Code: `src/routing/effort.ts` and the
`resolve` / `effortPlan` functions in `src/routing/router.ts`.

## The effort ladder

```text
none < minimal < low < medium < high < xhigh < max
```

These are the levels OrcaCompass knows. `extra-high` and `extra_high` on the
command line are aliases of `xhigh`; the config file requires `xhigh`. Codex's
`ultra` is not an effort (it means automatic delegation) and is never used.

## Where the target effort comes from

The **target** is the effort the route asks for, decided in this order:

| Source | When | Target |
| --- | --- | --- |
| `explicit` | `--effort <e>` was passed | exactly `<e>` |
| `demand` | `--demand <d>` was passed | `<d>` mapped through `effortPolicy` |
| `tier-default` | neither | `defaultEffort[requested tier]`: Light `low`, Daily `medium`, Advanced `medium`, Frontier `high` |

The target is chosen from the **requested** tier, before any fallback. A
downgrade or upgrade keeps it: effort follows the work, not the model. A
weaker model doing the job is not given more effort to compensate; the warning
asks you to split the job or add checks instead.

## Effort demand

The orchestrator rates how much the job needs to think, from the work itself:

| Demand | Signals |
| --- | --- |
| `low` | The steps are known; checking the result is easy |
| `moderate` | Some local choices or a little diagnosis |
| `high` | Ambiguity, an unknown cause, trade-offs, constraints across components, or a plan to make |
| `exceptional` | Several of those at once, with costly failure |

Demand is independent of tier and of model: a Light model can get `high`
(a tricky one-file fix) and a Frontier model `low` (a bulk edit that only a
very strong model is trusted with). The amount of work is not the demand.

### Effort policies

`effortPolicy` in the config maps demand to effort. `balanced` is the default.

| Demand | `efficient` | `balanced` (default) | `quality` |
| --- | --- | --- | --- |
| `low` | `low` | `low` | `low` |
| `moderate` | `low` | `medium` | `medium` |
| `high` | `medium` | `high` | `high` |
| `exceptional` | `high` | `high` | `xhigh` |

No policy maps to `max`; that takes an explicit `--effort max`. The mapping is a
starting heuristic, not a measured optimum: `balanced` keeps exceptional work
at `high`, `quality` allows `xhigh` for it only, `efficient` saves effort on
moderate and high work. Measuring it is on the [roadmap](roadmap.md).

## Checking the target against the model

Each discovered model carries the efforts it supports and where that list came
from (`supportSource`), most trusted first:

| `supportSource` | Meaning | Agents |
| --- | --- | --- |
| `provider` | The agent CLI's own model list or cache | Claude Code (its cached account catalog), Codex (`models_cache.json`), Cursor (effort variants in `cursor-agent models`), Grok (`models_cache.json`), Antigravity Gemini variants (effort in the id) |
| `orca` | Orca's effort menu or catalog for that agent | Claude Code and Codex (when Orca's catalog is the source), Grok (from `grok models`, with Orca's ceilings), Antigravity non-Gemini models (`low`/`medium`/`high`), OpenCode (none) |
| `assumed` | A built-in guess | Claude Code and Codex on the evidence catalog fallback when no efforts are listed: `low`, `medium`, `high`, `xhigh`, `max` |

### Snapping (automatic targets)

A `demand` or `tier-default` target the model does not offer is **snapped**:
the nearest **lower** supported effort, else the **lowest higher** one.

| Target | Model supports | Resolved | Reported |
| --- | --- | --- | --- |
| `high` | `low`, `medium` | `medium` | `adjusted: true`, "(high not offered, nearest supported)" |
| `xhigh` | `low`, `medium`, `high` | `high` | adjusted |
| `low` | `medium`, `high` | `medium` | adjusted (lowest higher) |
| `medium` | `low`, `medium`, `high` | `medium` | not adjusted |
| any | none settable | `null` | `applied: provider-default` |

### Explicit `--effort` is a constraint

An explicit effort is never snapped. It behaves like `--agent`: candidates that
cannot apply exactly that effort are left out of the tier. Cursor Auto never
can, so `--effort` always excludes it. When the requested tier has candidates
but none can apply the effort, the route is `none` and the reasons list what
each one offers:

```text
no daily route supports effort xhigh: claude claude-sonnet-5-5 (low/medium/high/max), cursor auto (provider-controlled), …
choose one of these efforts, or route without --effort
```

Use `--effort` only when the user asked for a specific level.

## How effort reaches the agent

`effort.applied` in the route says how the launch carries the effort:

| `applied` | Launch | Agents |
| --- | --- | --- |
| `flag` | `--model <id> --effort <e>` | Claude Code, Codex, Grok Build, Antigravity non-Gemini models |
| `model-id` | `--model <variant id>`, no `--effort`; `route.effort` is `null` | Cursor (`claude-opus-5-5-high`; the plain id stands for `medium`), Antigravity Gemini (`gemini-3.8-flash-high`) |
| `provider-default` | `--model <id>` only; the agent uses its own default | OpenCode (Orca passes no effort), Cursor Auto, any model with no settable effort |

When `applied` is `provider-default`, the reason reads `effort: not set, codex
uses its own default (medium); high wanted from high effort demand (balanced
policy)`, and `providerDefault` carries the agent's default when the provider
reports one. The orchestrator must not claim an effort was set in that case.

### Per-agent details

- **Claude Code**: efforts from its cached account catalog, then Orca's
  catalog, then assumed
  `low`…`max`. Passed as `--effort`.
- **Codex**: `supported_reasoning_levels` and `default_reasoning_level` from
  `~/.codex/models_cache.json`; then Orca's catalog, then assumed `low` to `max` when neither local catalog supplies models.
  Passed as `--effort`. Orca checks effort against its own catalog for models it
  knows (for example `gpt-5.5` up to `xhigh`); whether the two lists always agree
  has not been checked.
- **Cursor**: variants `…-low`, `…-medium`, `…-high`, `…-xhigh`, `…-max` grouped
  under one base id; `-thinking` and `-fast` are stripped. Non-fast variants
  are preferred, then thinking variants; fast-only levels are dropped when a
  non-fast level exists, so a request snaps to a non-fast id instead of silently
  picking a fast one. The unsuffixed id fills a missing `medium`.
- **Grok Build**: `reasoning_efforts` and the default `reasoning_effort` from
  `~/.grok/models_cache.json`. Multi-agent models get no effort (on them effort
  sets how many agents run). From `grok models`: `low` to `xhigh`, capped as in
  Orca's seed (`grok-4.5` up to `high`).
- **Antigravity**: Gemini ids carry effort (`gemini-3.8-flash-low|medium|high`),
  grouped like Cursor's; other ids (Claude, GPT-OSS) take Orca's `--effort`
  `low`/`medium`/`high`.
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
| `adjusted` | `true` when `resolved` differs from `target` (snapped) |
| `supportSource` | `provider`, `orca`, `catalog`, `assumed`, or `unknown` |
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

# no demand rated: the tier default applies
orcacompass route --tier advanced
#   effort: medium from tier default, passed as --effort
```
