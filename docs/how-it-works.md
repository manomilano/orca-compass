# How it works

OrcaCompass answers one question for an orchestrator: which agent, model and
reasoning effort should this worker get? It narrows the field in four moves:
what the job needs, which models can do it, which of those costs least, and
which subscription has room. This page follows one job through every step.

The scores, prices and usage below come from a real run in November 2026.
Your models, data and usage will differ; the steps stay the same.

## The job

> Add a CSV export button to the reports page, with tests.

A few files in one area, tests to run and fix until they pass, and no hard
design decision.

## 1. The orchestrator rates the job

The orchestrator (the agent handing out work) rates what the job needs on
three axes, and how much the worker should think:

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
`--tier` is a shorthand for the same level on every axis.

## 2. OrcaCompass finds what you can launch

It looks for each agent's CLI, asks Orca which agents are switched on, and
reads each agent's current model list. In the example, Claude Code, Codex and
Cursor are available; Grok and Antigravity are switched off in Orca, and
OpenCode is not installed. Banned models and models an agent refused at an
earlier launch are left out here. See [Models and agents](models-and-agents.md).

## 3. Evidence decides who can do the job

Every model has a coding, agentic and reasoning score from the LLMBenchmark
evidence snapshot. A model qualifies only when it meets the minimum on all
three axes. Price plays no part in this step.

| Model | coding ≥ 75 | agentic ≥ 70 | reasoning ≥ 70 | Result |
| --- | --- | --- | --- | --- |
| Haiku 5.5 | 68.4 | 53.5 | 74.6 | out |
| Composer 2.5 | 67.1 | 35.7 (assumed) | 75.0 | out |
| GPT-6.1 Terra | 76.4 | 69.1 | 82.3 | out |
| Grok 4.7 | 64.8 | 43.7 | 75.1 | out |
| GPT-6.1 Sol | 79.8 | 75.5 | 88.7 | qualifies |
| Sonnet 5.5 | 84.3 | 78.2 | 87.3 | qualifies |
| Opus 5.5 | 87.3 | 82.0 | 90.6 | qualifies |
| GPT-6 Astra | 83.8 | 80.5 | 89.7 | qualifies |
| Fable 5.2 | 87.8 | 85.4 | 94.7 | qualifies |

Each model that falls short is listed under `skipped` with the reason, for
example `below need on agentic (69.1 < 70)`. A model with no evidence at all is
`unranked` and skipped. A new release of a known family inherits the evidence
of the release before it until its own data arrives. Composer 2.5 has no
agentic benchmark, so Kimi K2.5's score stands in for it and is labelled
`assumed`. See
[Model data](model-data.md).

## 4. Price decides how much model to spend

Each model also has a cost tier, set by its API price in the snapshot, blended
3:1 input to output, in USD per million tokens. The price only sorts models
from cheap to expensive; it is not what your subscription charges.

| Cost tier | Blended $/M | Qualifying models in the example |
| --- | --- | --- |
| Light | below 1 | none |
| Daily | 1 to below 5 | Sol ($4), Sonnet 5.5 ($4), Gemini 4 Carbon ($4) |
| Advanced | 5 to below 12 | Opus 5.5 ($8) |
| Frontier | 12 or above | Fable 5.2 ($16), Astra ($20) |

All qualifying models enter the comparison, including Opus, Fable and Astra.
Change the cost thresholds with `costBands` or move a model with
`tierOverrides`; see [Tiers and routing](tiers-and-routing.md).

## 5. Compare subscription headroom and price

OrcaCompass estimates what will remain at reset. Among healthy measured
routes, subtract up to five price points from reset-adjusted headroom. The highest score wins.
For example, consider these routes when the other qualifying routes have
less headroom or share the same pools at higher prices.

| Route | Usage | Headroom |
| --- | --- | --- |
| Codex, Sol | weekly 8% used, 31% of the week gone | 62% |
| Claude Code, Sonnet 5.5 | weekly reset less than a day ago | 55% |
| Cursor, Sonnet 5.5 or Gemini 4 Carbon | 76% used, 78% of the window gone | 3% |

A route at or over a limit is blocked and skipped. A route expected to end
its usage window above `usageRiskLimit` (90%) is strained: it ranks after the
healthy measured routes. If every measured open route is strained, the same
weighted score applies and the decision carries a warning. In this
example Sol and Sonnet qualify for the price comparison; they have the same
price, so Sol wins on headroom. Routes handed out in the
last `handoutMinutes` (10) count as `handoutPercent` (5%) more usage, so
workers launched back to back spread across subscriptions. A favorite set
with `orcacompass prefer` can take the place of this pick; see
[Configuration](configuration.md).

## 6. Effort follows the demand

The demand `moderate` maps to `medium`, an effort Sol supports, passed as
`--effort medium`. Agents that encode effort in the model id get it there
instead. See [Reasoning effort](effort.md).

## 7. The answer

The route comes back with launch arguments and the reasons behind it:

```text
route: codex gpt-6.1-sol, effort medium, confidence high
reasons:
  codex gpt-6.1-sol: weekly 8% used, 31% of window elapsed (headroom 62%) → on pace for 26% before reset in 4d
  needs coding=mid agentic=mid reasoning=low; covering routes: 7 across all cost tiers
  cost: daily ($4.00/M blended, maker price)
  coding 79.8 measured, agentic 75.5 measured, reasoning 88.7 measured
  effort: medium from moderate reasoning demand (balanced policy), passed as --effort
  selection: 62.00 ranked headroom points minus 2.50 price points = 59.50
  next best: claude claude-sonnet-5-5 (weekly headroom 55%, resets in 6d, $4.00/M blended)
```

The orchestrator appends `launchArgs` to `orca orchestration worker-start`,
then runs `orcacompass verify --dispatch <id>` to confirm the agent accepted
the model. If the agent refused it, OrcaCompass remembers the refusal and the
next route picks another model. See
[Verify and rejections](verify-and-rejections.md) and
[Commands](commands.md) for the full JSON.

## What changes the answer

- **Codex is at its limit.** With the example usage, the replacement is Sonnet 5.5
  through Claude Code.
- **The job needs more coding.** At `coding=high` (82 or more), Sol (79.8)
  drops out and Sonnet 5.5 (84.3) still qualifies in the Daily tier.
- **A pricier route has much more headroom.** If Opus has 79% and the best
  Daily route has 60%, its 19-point advantage outweighs the maximum five-point price adjustment.
- **Every qualifying route is close to its limit.** The router compares the
  open strained routes across tiers and warns about projected usage.
- **Every qualifying route is blocked.** OrcaCompass picks the closest model
  that falls short and marks the route `downgraded`, or returns `wait` with
  `--no-downgrade`. See
  [Fallbacks](tiers-and-routing.md#fallbacks-downgrade-upgrade-wait-none).
- **Nothing can be routed.** Cursor `auto` is the last fallback before waiting;
  Cursor then picks the model itself.
