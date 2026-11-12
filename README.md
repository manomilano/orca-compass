<div align="center">

# OrcaCompass

**Help your orchestrator pick the right model for every job.**

<p>
<img src="docs/assets/orca-comic-strip.jpg" width="100%" alt="Three-panel orca comic. 1: the pod trusts its leader to match each job to its best model. 2: the leader is unsure which model fits each job and how to share the load, thinking of Anthropic, OpenAI, and + more. 3: holding a glowing compass, the leader sends each worker along a route to Anthropic, OpenAI, or + more." />
</p>

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-64748b)](#install)

[Install](#install) · [Quick start](#quick-start) · [User guide](docs/README.md) · [Commands](docs/commands.md) · [Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md)

</div>

An [Orca](https://github.com/stablyai/orca) orchestrator that hands a job to a
worker has to pick an agent, a model and a reasoning effort. On its own it
cannot tell which of your installed models suits the job, or how much of each
plan's usage is left before the limits reset. OrcaCompass makes that choice:
the orchestrator rates how hard the job is, and OrcaCompass compares the
installed Claude Code, Codex, Cursor, Grok Build, Antigravity and OpenCode
routes using model metadata and current usage limits, explains its choice, and
returns launch arguments. The orchestrator still launches the worker. It ships
as an Agent Skill backed by a small TypeScript CLI.

## How it works

1. **Rate the job** on coding, agentic and reasoning needs.
2. **OrcaCompass builds profiles** with raw LLMBenchmark capability evidence
   and separate cost tiers from price (3:1 input/output blend, `costBands`
   default `[1, 5, 12]`; hints are the fallback when price is missing).
3. **It chooses a route** from the cheapest cost tier whose evidence covers
   the job, then the most headroom, accounting for recent hand-outs.
   Cursor `auto` is a fallback.

```sh
orcacompass route --need coding=mid,agentic=low,reasoning=low --demand moderate --json
orcacompass ranking --axis coding  # evidence view
orcacompass tiers                  # cost-tier view
```

`--tier` remains a shorthand for equal needs on all axes. See
[Tiers and routing](docs/tiers-and-routing.md) for details.

## Install

Use **Node.js 24** for the simplest setup. The published CLI also runs on
Node.js 20+, but reading Orca's agent switches requires Node.js 22.13+ without
extra flags; otherwise those switches are reported as `unknown`.
You also need the agent CLIs you want to route to installed and signed in,
and Orca running for live usage data.

### Recommended install

Run this inside the project where you want to use the Skill:

```sh
npx orcacompass install
```

This installs the shared CLI and the matching Skill for the current project.
It asks which agents should receive the Skill. Keep Orca's own orchestration
skill installed alongside it.

### Other options

| Command | What it does |
| --- | --- |
| `npx orcacompass install --global` | Install the Skill for your user, across projects |
| `npx orcacompass install --local` | Use the project default; keep Project if the installer asks for scope |
| `npx orcacompass update` | Fetch the latest release, update the CLI and this project's Skill |
| `npx orcacompass uninstall` | Remove this project's Skill; keep the shared CLI |

Use `update --global` for your user-wide Skill. Use `uninstall --global`
to remove the user-wide Skill and shared CLI. Your preferences and cache
are preserved. Add `--agent <name>` to select agents, or `--yes` to accept
the installer's defaults without a terminal.

### Alternative: install the CLI, then the Skill

From your project directory, run:

```sh
npm install -g orcacompass@latest
orcacompass install --skill-only
```

The CLI is shared across projects; the Skill is installed for this project.
Keep Project if the installer asks for scope. Add `--global` to the second
command for a user-wide Skill, or `--local` to spell out the project default.

See [Getting started](docs/getting-started.md#install) for all options and
building from source.
To work on OrcaCompass itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```sh
orcacompass setup
```

`setup` asks three short questions in the terminal (which agents to use,
optional favorite routes per tier, models never to use), then shows the
result with an example route per tier and saves it once you confirm. Press
Enter to keep any answer; running it again starts from your current settings.
With the Skill installed you can also just ask your orchestrator to "set up
OrcaCompass": it asks the same questions in chat (and offers to before your
first route).

Everything `setup` does is also a command of its own:

```sh
orcacompass status                        # agents, usage, and the pick for each tier
orcacompass tiers                         # cost tiers, prices and capability evidence
orcacompass agents                        # which agents are used, and why not
orcacompass agents disable grok           # never route to Grok Build
orcacompass prefer daily codex            # Codex first for everyday jobs, unless it runs too hot
orcacompass ban claude-haiku              # never route a Claude Haiku model
orcacompass route --tier daily --json     # a route for an everyday job
orcacompass route --tier advanced --agent claude --agent codex --demand high
orcacompass route --tier frontier --no-downgrade --json   # never accept a capability shortfall
```

With the Skill installed, the orchestrator does this for you: it rates each
job, calls `orcacompass route`, and launches the worker with the returned
arguments:

```sh
orca orchestration worker-start --spec "<actual task>" --agent claude --model claude-opus-5-5 --effort medium
```

Only `status: "ok"` carries a route. Pass `launchArgs` as separate, properly
quoted arguments together with your usual Orca worktree and lifecycle options.
OrcaCompass never launches workers itself.

For example, a routing decision can look like this (illustrative numbers):

```text
$ orcacompass route --tier advanced
advanced → claude · claude-sonnet-5-5 · medium (high confidence)
  cost: daily ($4.00/M blended, maker price)
  claude claude-sonnet-5-5: weekly 40% used, 62% of window elapsed (headroom 34%) → on pace for 65% before reset in 2d
```

## User guide

Start with [Getting started](docs/getting-started.md), or browse the
[complete user guide](docs/README.md).

| Learn about | Read |
| --- | --- |
| Every command, flag, exit code and JSON response | [Commands](docs/commands.md) |
| Preferences, bans, paths and defaults | [Configuration](docs/configuration.md) |
| How routes are ranked and how fallbacks work | [Tiers and routing](docs/tiers-and-routing.md) |
| Effort demand and supported effort levels | [Effort](docs/effort.md) |
| How the orchestrator routes, launches and verifies | [Skill workflow](docs/skill-workflow.md) |
| Checking that a worker's agent accepted its model | [Verify and rejections](docs/verify-and-rejections.md) |
| Supported agents and where their models come from | [Models and agents](docs/models-and-agents.md) |
| Data sources, cache timing and maintaining model scores | [Model data](docs/model-data.md) |
| What to do when an agent is not used or a route fails | [Troubleshooting](docs/troubleshooting.md) |
| Planned work and known limitations | [Roadmap](docs/roadmap.md) |
