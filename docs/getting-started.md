---
description: Install OrcaCompass, complete setup, and check your first route.
---

# Getting started

Three steps: install OrcaCompass, choose your setup preferences, and check
your first route. Other install options come after.

## Quick start

```sh
npx orcacompass install   # 1. shared CLI and project Skill, from your project
orcacompass setup         # 2. optional: your agents, favorite models and bans
orcacompass status        # 3. optional: usage and the pick per tier
```

After the install, you can do the rest from your agent instead of the
terminal: ask it to "set up OrcaCompass", then to run `orcacompass status`.

`orcacompass setup` and `orcacompass status` are optional: without setup,
OrcaCompass uses every agent that is installed and not switched off in Orca.

Each step has its own section below: [Install](#install),
[First-time setup](#first-time-setup) and
[Check that it works](#check-that-it-works).

## Requirements

- **Node.js 24 is recommended** for both using OrcaCompass and building it
  from source. The published CLI supports Node.js 20+, but reading Orca's
  agent switches and model catalog needs Node.js 22.13+ without extra flags
  (`node:sqlite`).
  When SQLite is unavailable, those switches are reported as `unknown`.
  Development tools have newer Node requirements than the published CLI;
  see [Development setup](https://github.com/manomilano/orca-compass/blob/main/CONTRIBUTING.md#development-setup).
- [Orca IDE](https://github.com/stablyai/orca) running, for live usage data
  (`orca account list --json`). Without Orca, routing still works with usage
  unknown and low confidence.
- The agent CLIs you want to route to, installed and signed in: `claude`,
  `codex`, `cursor-agent`, `grok`, `agy` (Antigravity), `opencode`, and `muse`. An agent
  that is not installed is simply skipped.

## 1. Install {#install}

From your project directory, run:

```sh
npx orcacompass install
```

The installer checks npm's global installation and installs or updates the
shared CLI to its own version first. It then installs that version's Skill
for the current project through [`skills`](https://github.com/vercel-labs/skills).
It needs network access and asks which agents should receive the Skill.
The CLI goes to npm's global folder; that prefix must be writable.

Keep Orca's own orchestration skill installed alongside it: OrcaCompass only
recommends a route; Orca's skill explains how to launch and supervise workers.

To update, uninstall, install a user-wide Skill or build from source, see
[More install options](#other-options).

## 2. First-time setup {#first-time-setup}

This step is optional: no config file is required. Setup saves your agent choices, favorite routes
and model bans for later jobs. Choose one of the three setup methods below.

### In a terminal

```sh
orcacompass setup
```

The wizard asks about agents, favorites and bans, then shows a summary.
It asks to save when settings changed or the config does not exist; if an
existing config is unchanged, it exits without another confirmation.
Press Enter to keep the answer shown in brackets; running it
again starts from your current settings. Ctrl+C saves nothing.

1. **Agents.** Every known agent is listed with: installed, enabled in Orca
   (`yes`, `no`, `unknown`), Orca usage status and model count. The default is
   the agents that are installed, have models, are not switched off in Orca
   (`yes` or `unknown`) and are not switched off in your config. Your answer is written as `allowAgents` /
   `denyAgents`, through the same edits as `orcacompass agents`.
2. **Favorites (optional).** For each tier the current pick and its
   alternatives are shown with their usage, counting reserved workers and one
   more. Choose one as the favorite, or 0 for none. A favorite is used while
   that usage stays below the limit (default 90%) on every quota it draws on;
   at or above it, routing goes on without the favorite, with a warning. The
   wizard asks for that limit when you set at least one favorite. Written as `pins` and `preferRiskLimit`.
3. **Bans (optional).** The model families found (and their models) are listed;
   name families or model ids never to use. Written as `banModels`. An agent id that is not also a discovered model family
   is refused here: to stop using a whole agent, leave it out in question 1.
4. **Summary.** The settings in plain words, one example route per tier (with
   any warning), the config file path, and a yes/no to save when needed. Only what an
   answer changed is written; every other key keeps its value and position.

Without a terminal (stdin or stdout is not a TTY) `setup` exits 1 and points to
the chat setup and the individual commands.

### In chat, through the orchestrator

With the Skill installed, ask your orchestrator (the agent coordinating your
workers) to "set up OrcaCompass".
It runs `orcacompass setup --json`, which prints everything the questions need
(`configPath`, `configExists`, `orcaAgents`, the current `config`, `agents` with
`preselected`, `tiers` with `pick`/`preferred`/`options`, `families`), asks the
same three questions in plain words, and applies the answers with
`orcacompass agents`, `orcacompass prefer` and `orcacompass ban`. It never edits
the file by hand.

It finishes with `orcacompass setup --complete --json`,
including when every answer kept its default. The command creates an empty
config if needed. The presence of that file marks setup complete, so later
conversations do not offer setup again. Existing settings are preserved.

The Skill also offers setup once, before the first route in a conversation,
when `setup --json` reports `configExists: false`. If you decline, the
orchestrator runs `orcacompass setup --skip`. This creates an empty config file
if none exists, so the Skill does not repeat the offer. The orchestrator reports
which agents it will use; routing still checks installation, model availability,
and Orca's agent switches.

### Command by command

Everything setup does is also a command:

```sh
orcacompass agents                        # who is used, and why not
orcacompass agents disable grok           # never route to Grok Build
orcacompass prefer daily codex            # Codex first for everyday jobs
orcacompass ban claude-haiku              # never route a Claude Haiku model
```

See [Commands](commands.md).

## 3. Check that it works {#check-that-it-works}

```sh
orcacompass agents          # each agent: installed, enabled in Orca, usage, chosen, verdict
orcacompass status          # usage pools, the pick per tier, metadata age
orcacompass route --tier daily
```

Illustrative output, shortened (models, percentages and prices depend on
your environment):

```text
light → claude · claude-haiku-5-5 · medium (high confidence)
  claude claude-haiku-5-5: weekly 20% reported + 0.5 pp for this worker = 20.5% prospective (available), resets in 3d
  cost: light ($0.20/M blended, maker price)
  effort: medium from tier default, passed as --effort
  reserved rsv_3f9a1c2b7d10: weekly +0.5 pp; after worker-start run: orcacompass verify --dispatch <id> --reservation rsv_3f9a1c2b7d10
orca orchestration worker-start --spec "<task>" --agent claude --model claude-haiku-5-5 --effort medium
```

The first word is the pick's cost tier. It is `light` here because a
Light-cost model covers an everyday job and its quota had the most room; a
cheaper covering tier is not a downgrade. The `reserved` line is the quota
this route set aside for its worker; `--dry-run` routes without reserving.

If `status` says `evidence: snapshot`, run `orcacompass refresh`
when online. If an agent you expect is `not used`, the verdict says why
(`not installed`, `not enabled in Orca`, `excluded by config`, `not signed in`,
`no models`). [Troubleshooting](troubleshooting.md) covers what to do for each.

## More install options {#other-options}

```sh
npx orcacompass install --global  # user-wide Skill, across projects
npx orcacompass install --local   # project Skill, explicitly (the default)
npx orcacompass update           # latest CLI and this project's Skill
npx orcacompass uninstall        # remove this project's Skill
```

### Scope and flags

The CLI goes to npm's global folder in either scope.
Without `--global`, the interactive Skill installer can ask Project or Global;
Project is preselected. Keep Project for a local installation. `--local` is an
alias for this default flow; it does not suppress that question. With `--yes`,
the project default is accepted automatically.

| Option | Effect |
| --- | --- |
| `-g`, `--global` | Manage the Skill for your user, across projects |
| `-l`, `--local` | Manage this project's Skill; this is the default |
| `-y`, `--yes` | Accept defaults; required without a terminal |
| `-a`, `--agent <name>` | Select an agent such as `claude-code` or `codex`; repeatable |
| `--skill-only` | Manage only the Skill; keep the shared CLI |

`--global` and `--local` cannot be combined. The options apply to `install`,
`update` and `uninstall`.

For example, install for both agents across projects:

```sh
npx orcacompass install --global --agent claude-code --agent codex
```

### Update

`update` checks npm for the latest release and runs that release's installer.
It works even when an older installed CLI handles the command. Add `--global`
to update the user-wide Skill. An already current CLI is kept and the Skill
is refreshed. An older installer refuses to downgrade a newer CLI.

If the CLI update fails, the Skill is left unchanged. If the Skill step
fails, the updated CLI remains installed and you can retry the command.
For a release that predates the `update` command, use
`npx orcacompass@latest update` to download a current updater first.

### Uninstall

Local uninstall keeps the shared CLI because other projects may use it.
`uninstall --global` removes the user-wide Skill and then the shared CLI.
With `--skill-only` or a specific `--agent`, global uninstall keeps the CLI.
Uninstall and updates preserve OrcaCompass preferences, caches and accounts.

### Install the CLI, then the Skill

From the project where you want the Skill, run:

```sh
npm install -g orcacompass@latest
orcacompass install --skill-only
```

This installs the same published version in two steps: the CLI first, then
its matching Skill for the current project. Keep Project if the installer
asks for scope. The CLI's `-g` makes the CLI available across projects; it
does not make the Skill global. Add `--global` to the second command for a
user-wide Skill, or `--local` to spell out the project default. The other
Skill options above also work with the second command.

### From source

To run the current `main` instead of the published package, build it with
Node.js 24 and npm, then install the Skill from that checkout:

```sh
git clone https://github.com/manomilano/orca-compass.git
cd orca-compass
npm ci
npm install -g .
orcacompass install --skill-only --global
```

`npm ci` installs the build tools and compiles the CLI. `--skill-only` installs
the Skill from the checkout and leaves the CLI you just installed alone.
