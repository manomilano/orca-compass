# OrcaCompass user guide

This guide describes the code in this checkout. Installed releases may differ;
use `orcacompass --help` to see the commands your version supports.

OrcaCompass helps an Orca orchestrator choose the **agent**, **model** and
**reasoning effort** for each job it hands to a worker. It ships as an Agent
Skill (`skills/orcacompass/SKILL.md`) backed by a small TypeScript CLI
(`orcacompass`). It recommends; Orca launches.

## Pages

| Page | Read it for |
| --- | --- |
| [Getting started](getting-started.md) | Install, first-time setup (terminal or chat), what runs on every call |
| [Skill workflow](skill-workflow.md) | How the orchestrator uses the Skill: rate, route, launch, verify, handle the result |
| [How it works, end to end](how-it-works.md) | One job followed through every step: needs, evidence, cost tier, usage, launch |
| [Tiers and routing](tiers-and-routing.md) | The four tiers, how a model gets its tier, the capability score, headroom ranking, preferences, bans, fallbacks |
| [Effort](effort.md) | Effort demand, effort policies, snapping, how effort reaches each agent |
| [Commands](commands.md) | Every CLI command, flag, exit code and JSON field |
| [Configuration](configuration.md) | Config and cache paths, every key with its default, data sources, privacy |
| [Verify and rejections](verify-and-rejections.md) | Checking that a worker's agent accepted its model, and routing around refusals |
| [Troubleshooting](troubleshooting.md) | Install failures, agents not used, unknown usage, `wait`/`none`, refused models, stale metadata, config errors |
| [Models and agents](models-and-agents.md) | The agents OrcaCompass routes to, their model sources, and how to inspect available models |
| [Model data](model-data.md) | Data sources, cache timing, snapshot dates, and maintaining shared scores |
| [Orca agents](orca-agents.md) | Every agent id Orca can launch and what OrcaCompass does with each one |
| [Roadmap](roadmap.md) | What is done, what is next, known limitations, decisions taken |

To build, test or change OrcaCompass itself, see
[CONTRIBUTING.md](https://github.com/manomilano/orca-compass/blob/main/CONTRIBUTING.md).

## Quick tour

```sh
npx orcacompass install            # shared CLI and project Skill
orcacompass setup                   # three questions, then a summary
orcacompass route --tier daily --demand moderate --json
```

See [Getting started](getting-started.md) for requirements and install options.

The orchestrator does the last step for you once the Skill is installed: it
rates the job, calls `orcacompass route`, launches the worker with the returned
`launchArgs`, then runs `orcacompass verify` to make sure the agent accepted the
model.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Agent** | A coding CLI Orca can launch as a worker: `claude`, `codex`, `cursor`, `grok`, `antigravity`, `opencode`, `muse` |
| **Tier** | How capable a model the job needs: `light`, `daily`, `advanced`, `frontier` |
| **Demand** | How much the job needs to think: `low`, `moderate`, `high`, `exceptional`. Separate from the tier |
| **Effort** | The reasoning level passed to the agent: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| **Route** | One recommendation: agent, model, effort, plus `launchArgs` for `orca orchestration worker-start` |
| **Usage pool** | A rate-limit window Orca reports for an agent: `session`, `weekly`, `monthly`, `fableWeekly`, or a named bucket |
| **Headroom** | The share of a usage window expected to be left unused at reset; routes rank by it |
| **Risk** | Where a route's usage is heading: `used% / elapsed fraction` of the window, the pool projected to end most used |
| **Preference (pin)** | Your favorite route for a tier; used when eligible, unblocked and under `preferRiskLimit` |
| **Ban** | A model id or catalog family that is never routed |
| **Rejection** | A model an agent refused at launch (found by `verify`); skipped for `rejectionTtlHours` |
| **Last-resort agent** | An agent used only when nothing else can take the job (OpenCode by default) |
