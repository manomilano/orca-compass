---
description: Reference for every orcacompass command, flag, JSON field and exit code.
---

# Commands

Look up each `orcacompass` command's flags, writes, JSON fields and exit codes.
For installation instructions, start with [Getting started](getting-started.md).
Code: `src/cli.ts`.

## Command index

| Command | What it does | Section |
| --- | --- | --- |
| `install` | Installs or updates the CLI, then its matching Skill | [`install`](#install) |
| `setup` | First-time setup, in a terminal or from chat | [`setup`](#setup) |
| `route` | Recommends an agent, model and effort for a job | [`route`](#route) |
| `verify` | Checks whether a just-started worker's agent accepted its model | [`verify`](#verify) |
| `rejected` | Lists or clears models agents refused at launch | [`rejected`](#rejected) |
| `status` | Shows agents, usage, the pick per tier and data ages | [`status`](#status) |
| `tiers` | Shows every model's tiers and the numbers behind them | [`tiers`](#tiers) |
| `ranking` | Lists profiles of discovered models | [`ranking`](#ranking) |
| `agents` | Shows which agents are used or skipped; changes the selection | [`agents`](#agents) |
| `prefer` | Lists or sets a favorite route per tier and its risk limit | [`prefer`](#prefer) |
| `ban` / `unban` | Lists, adds or removes model and family bans | [`ban` / `unban`](#ban-unban) |
| `refresh` | Downloads fresh model metadata, rebuilds the placement table | [`refresh`](#refresh) |
| `update` | Fetches the latest release and runs its installer | [`update`](#update) |
| `uninstall` | Removes the Skill; a full `--global` run also removes the CLI | [`uninstall`](#uninstall) |

Also: `--help` (aliases `help`, `-h`) prints the usage text, and `--version`
(aliases `version`, `-v`) prints the installed version.

## Synopsis

```text
orcacompass route --need coding=<l>,agentic=<l>,reasoning=<l> | --tier <light|daily|advanced|frontier> [--no-downgrade] [--agent <id>]... [--exclude-agent <id>]... [--demand <d>] [--effort <e>] [--tier-reason <text>] [--json]
orcacompass verify --dispatch <id> [--wait <seconds>] [--json]
orcacompass rejected [--clear] [--json]
orcacompass status [--json]
orcacompass ranking [--axis <coding|agentic|reasoning>] [--json]
orcacompass tiers [--axis <coding|agentic|reasoning>] [--json]
orcacompass agents [--json]
orcacompass agents disable|enable|only <id>... [--json]
orcacompass agents reset [--json]
orcacompass prefer [--json]
orcacompass prefer <tier> <agent> [model] [--json]
orcacompass prefer clear <tier>|--all [--json]
orcacompass prefer --risk-limit <percent> [--json]
orcacompass ban [<model-or-family>...] [--json]
orcacompass unban <model-or-family>... [--json]
orcacompass refresh [--json]
orcacompass setup
orcacompass setup --json
orcacompass setup --complete [--json]
orcacompass setup --skip [--json]
orcacompass install [-g|--global | -l|--local] [-y|--yes] [-a|--agent <name>]... [--skill-only]
orcacompass update [same options as install]
orcacompass uninstall [same options as install]
orcacompass --help
orcacompass --version
```

## What each command writes

"Table caches" means the placement table (`placements.json`) plus the evidence
and model-list caches that a rebuild refreshes. The table is rebuilt only when
stale; see [Tiers and routing](tiers-and-routing.md#when-placement-runs).

| Command | Writes |
| --- | --- |
| `route` | Table caches when stale; `handouts.json` when the result is `ok` |
| `verify` | `rejected-models.json` when the verdict is `rejected` |
| `rejected` | Nothing; `--clear` empties `rejected-models.json` |
| `status`, `ranking`, `tiers` | Table caches when stale |
| `agents` (list) | Table caches when stale |
| `agents disable`, `enable`, `only`, `reset` | `allowAgents`, `denyAgents` in the config |
| `prefer` (list), `prefer clear`, `prefer --risk-limit` | `pins`, `preferRiskLimit` in the config (list writes nothing) |
| `prefer <tier> <agent> [model]` | `pins`; table caches when stale |
| `ban`, `unban` | `banModels` in the config when adding or removing entries; table caches when stale, including when only listing bans |
| `refresh` | Evidence and placement caches, always rebuilt |
| `setup` | The agent, favorite, ban and risk-limit keys above |
| `setup --json` | Table caches when stale |
| `setup --complete` | An empty config if absent; table caches when stale |
| `setup --skip` | An empty config if absent; table caches when stale |
| `install`, `update` | Agents' skills folders; a global npm package |
| `uninstall` | The selected Skill files; optionally the global npm package |

A command that edits the config creates the file when none exists, even when
it has nothing to remove (`agents reset`, `prefer clear`, `unban`). The Skill
offers setup only while there is no config file, so it stops offering it then;
run `orcacompass setup` yourself if you still want it.

## Conventions

Agent IDs throughout the CLI are `claude`, `codex`, `cursor`, `grok`, `antigravity`,
`opencode`, `muse`, in any letter case. Tier and demand names are
case-insensitive too. The axes and levels of `--need` and the values of
`--axis` are case-sensitive: write `coding=high`, not `coding=HIGH`.

Unknown agent ids are handled differently by command:

- `agents`, `prefer`: refused, exit 1.
- `route`: routing continues with a warning suggesting the ID you probably
  intended, such as `unknown agent "cursor-agent" in --exclude-agent: nothing
  excluded for it (did you mean cursor?)`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Answered. For `route` this covers `ok`, `wait` **and** `none`: check `status` in the output |
| 1 | Usage error (bad flag, unknown agent, missing argument) or runtime error; also `setup` canceled with Ctrl+C (answering no to "Save" exits 0) |
| 2 | Config error: `config error: <path>: <message>` |

## `install`

Installs or updates the CLI, then the Skill that matches its version.

Run `npx orcacompass install` from your project.

| Flag | Meaning |
| --- | --- |
| `-g`, `--global` | Install the Skill user-wide |
| `-l`, `--local` | Accepted as the project default; it cannot be combined with `--global` and is not passed to the Skill installer |
| `-y`, `--yes` | Passed to the Skill installer, which then accepts its defaults |
| `-a`, `--agent <name>` | Repeatable. Passed to the Skill installer |
| `--skill-only` | Skip the CLI check and installation entirely |

The default is a project Skill. Without `--global`, the interactive Skill
installer may ask Project or Global; keep its Project default for a local
installation.

Steps:

1. Unless `--skill-only` is given, read the globally installed version with
   `npm ls --global`. Install a missing or older CLI with
   `npm install -g orcacompass@<this version>`; keep an already current CLI.
   An older installer refuses to downgrade a newer CLI or replace its Skill.
   Copies in npx's cache or project-local installations do not count as global
   installations.
2. After the CLI step succeeds, install the Skill with
   `npx -y skills@1 add <package folder>`, the
   [`skills`](https://github.com/vercel-labs/skills) installer pointed at the
   Skill inside this package, so the Skill matches this CLI version.

Both steps run attached to the terminal, so their questions and output reach
you. Without a terminal it exits 1 unless `--yes` is given. It exits 1 when
either step fails, naming the step that failed and how to finish by hand.

::: info Windows
OrcaCompass disables telemetry only in its `skills` subprocesses to avoid an
upstream shutdown crash. It does not change your environment or npm's settings.
:::

## `setup`

First-time setup of agents, favorites and bans. See
[Getting started](getting-started.md#first-time-setup) for the questions.

| Form | What it does |
| --- | --- |
| `setup` | Interactive questions and a summary in a terminal; nothing is saved until you confirm. Without a terminal it exits 1 |
| `setup --json` | Prints what the questions need, for an orchestrator asking them in chat |
| `setup --complete` | Marks chat setup complete, including unchanged defaults |
| `setup --skip` | Declines setup: keeps existing settings or defaults and stops the chat offer |

`--complete` and `--skip` cannot be combined.

`setup --json` prints one document:

| Field | Content |
| --- | --- |
| `configPath`, `configExists` | Where the config lives and whether it exists |
| `orcaAgents` | Orca's agent switches as read, or why they are unknown |
| `config` | Current `allowAgents`, `denyAgents`, `pins`, `preferRiskLimit`, `banModels` |
| `defaultPreferRiskLimit` | 100 |
| `agents` | `agent`, `installed`, `enabledInOrca`, `orcaUsage`, `models` (count), `chosen`, `preselected` (in the default answer to question 1), `verdict` |
| `tiers` | Per tier: `pick`, `preferred`, `options` (agent, `model` to prefer, `blocked`, `onPacePercent`, `reason`), `warnings` |
| `families` | Each discovered family with its models and whether it is banned |

`setup --complete` creates an empty config when absent and preserves an
existing file, so `configExists` becomes true even when all answers kept their
defaults. Text output is `Setup complete. Config: <path>`; with `--json` it
returns the same document as `setup --json`.

`setup --skip` writes an empty `{}` config file when none exists, so the Skill
stops offering setup; defaults then apply (agents follow Orca's switches).
`setup --skip --json` returns `{ configPath, agentsUsed, orcaAgents }`.

## `route`

Recommends one agent, model and effort for a job. Needs a tier or an explicit
need per axis.

```sh
orcacompass route --need coding=high,agentic=mid,reasoning=low --demand high --agent claude --agent codex --json
```

| Flag | Meaning |
| --- | --- |
| `--need <axes>` | All three axes: `coding`, `agentic`, `reasoning`, each `min`, `low`, `mid`, `high` or `top`; no spaces |
| `--tier <t>` | Shorthand for equal needs: `light`, `daily`, `advanced`, `frontier`; mutually exclusive with `--need` |
| `--tier-reason <text>` | Optional nonempty explanation from the coordinator, returned in JSON and text. The Skill keeps routine classification in the tool exchange and explains it in chat on request |
| `--demand <d>` | `low`, `moderate`, `high`, `exceptional`; mapped to an effort through `effortPolicy` |
| `--effort <e>` | Exact effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`extra-high` is accepted for `xhigh`). Never snapped; routes that cannot apply it are left out |
| `--agent <id>` | Repeatable. Only these agents. Lifts a last-resort agent's status |
| `--exclude-agent <id>` | Repeatable. Not these agents |
| `--no-downgrade` | Prevent capability-shortfall and Cursor Auto fallbacks; cheaper covering cost tiers remain allowed. A [favorite](tiers-and-routing.md#preferences-pins) can still fall short with this flag |
| `--json` | Machine-readable output |

One of `--need` or `--tier` is required.

::: info No `--model` flag
There is no `--model` flag: an exact model the user named is launched directly.
:::

Text output (illustrative; values vary):

```text
light → claude · claude-haiku-5-5 · medium (high confidence)
  claude claude-haiku-5-5: weekly 20% used, 56% of window elapsed (headroom 60%) → on pace for 36% before reset in 3d
  needs coding=low agentic=low reasoning=low from tier daily; covering routes: 14 across all cost tiers
  cost: light ($0.20/M blended, maker price)
  coding 68.4 measured, agentic 53.5 measured, reasoning 74.6 measured
  effort: medium from tier default, passed as --effort
  selection: 60.00 ranked headroom points minus 0.24 price points = 59.76
  next best: claude claude-sonnet-5-5 (weekly headroom 60%, resets in 3d, $4.00/M blended)
  skipped: grok (not enabled in Orca), opencode (last resort: used only when no other agent can take the job)
orca orchestration worker-start --spec "<task>" --agent claude --model claude-haiku-5-5 --effort medium
```

### Route JSON

The JSON is the `Decision` type (`src/types.ts`) plus `launch`, the source
fields (`evidenceSource`, `catalogSource`, `scoreSource`) and `placementsBuiltAt`.

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `wait`, or `none` |
| `requestedTier`, `tier` | Requested needs shorthand and the pick's cost tier (absent without a route and for the Cursor `auto` fallback); a covering pick from a cheaper tier is not a downgrade, and one from a pricier tier is an upgrade only when no cheaper route covers the job |
| `source` | Where the pick's cost tier came from: `override`, `lineup`, `family` or `evidence`; `auto` for the Cursor `auto` fallback |
| `tierReason` | The coordinator's explanation of the requested tier, when supplied. Also included in `reasons`, even when there is no route |
| `downgraded`, `upgraded` | A downgrade falls short of the requested needs. An upgrade is a covering pick from a pricier cost tier than the requested tier, when no route at or below the requested tier covers the job (and can apply an explicit `--effort`) |
| `route` | `{ agent, model, effort }`; `effort` is `null` when it is in the model id or not set |
| `effort` | How the effort was chosen and applied; see [Effort](effort.md#the-effort-object-in-route-json) |
| `launchArgs` | Array to append to `orca orchestration worker-start --spec "<task>"`, one argument per element |
| `launch` | Readable template with a `<task>` placeholder; not shell-escaped, not for automation; `null` without a route |
| `confidence` | `high`, `medium`, `low` |
| `risk` | `{ pool, usedPercent, elapsedPercent, projectedPercent, tooEarly, resetsAt }` for the route; `null` when usage is unknown |
| `reasons` | One line per fact behind the choice; the needs line includes `covering routes: 3 across all cost tiers`, a route adds `cost: daily ($4.00/M blended, maker price)`, and a pick made by score adds `selection: 62.00 ranked headroom points minus 2.50 price points = 59.50` (tier, count, price and source vary) |
| `warnings` | Downgrade, upgrade, skipped preference, last-resort use, and on the picked route: reported usage at or above `thresholds` (`weekly quota is 96% used; resets in 14h`) or a forecast above `usageRiskLimit` (`selected route is expected to end above 90% of its usage window`) |
| `alternatives` | Up to five other candidates in decision order: the other covering routes, from all cost tiers, or for a downgrade the models with the same shortfall; without a pick, the covering routes: `agent`, `model`, `effort`, `tier`, `headroom` (fraction, or `null`), `confidence`, `blocked`, `risk`, `reason` |
| `skipped` | `{ agent, model?, reason }` for excluded agents (including an unknown `--agent`), banned and refused models, unranked models and models below the requested needs, in every tier. Superseded releases and no-ZDR exclusions are omitted. Preference exclusions appear in `warnings` |
| `waitUntil` | Epoch ms of the earliest time a blocked candidate has all its blocking windows reset; present with `wait` only |
| `needs`, `needsSource` | The three requested levels and whether they came from `need` or `tier` |
| `quality` | Evidence class, cost, coverage, shortfall or overshoot, evidence and per-axis scores, bands, needs and cuts; also on alternatives |
| `quality.class` | Highest evidence band across the axes; independent of cost |
| `quality.cost` | `{ tier, blended, source }` or `null`; `blended` is USD per million tokens, `(3 × inputPerM + outputPerM) / 4`, rounded to two decimals, or `null` without a price; `source` is `override`, `price`, `family`, `lineup`, or `evidence` |
| `evidenceSource` | `network`, `cache`, or `snapshot`; `catalogSource` and `scoreSource` are compatibility aliases |
| `placementsBuiltAt` | Epoch ms when the placement table this route read was built (see [`tiers`](#tiers)); the evidence source says what that build used |

The chosen route's own headroom appears in its reason line, not as a separate
field.

## `verify`

Checks whether a newly started worker's agent accepted its model and records
any recognized refusal.

```sh
orcacompass verify --dispatch <dispatchId> [--wait 60] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--dispatch <id>` | Required. The `dispatchId` that `worker-start` printed |
| `--wait <seconds>` | 0–60, default 60. `0` returns `unknown` immediately |
| `--json` | Machine-readable output |

It runs `worker-show`, then `worker-read --source terminal` with 1.5 s between
polls. The total budget includes the initial lookup, reads and polling delays;
a verdict returns early. Each Orca command is limited to the remaining budget
and at most 20 s. A worker that has been working for 8 s without a refusal is
`started`; one that stopped without `worker_done` is `stalled` after 3 s once
its task prompt has been seen. `verify` exits 0 whatever the verdict.

Output fields:

| Field | Meaning |
| --- | --- |
| `status` | `started`, `reported`, `rejected`, `stalled`, `failed`, `unknown` |
| `dispatchId`, `taskId`, `agent`, `model` | From Orca's `worker-show` |
| `message` | With `rejected`: the agent's refusal, in its own words |
| `detail` | One line: what was seen |
| `tail` | With `stalled`, `failed`, `unknown`: the last lines of the terminal |
| `unsent` | `true` with `unknown` when the agent stayed idle and the task never appeared in its terminal: the prompt was probably not sent yet. Do not reroute |
| `cleanup` | Orca argv lists to run in order before a replacement (`worker-stop`, then `worker-release`; only `worker-release` when the worker already exited) |
| `skippedForHours` | With `rejected`: how long routes skip this agent and model (`rejectionTtlHours`) |
| `next` | What the orchestrator does next, in order. For `rejected` and `failed` this includes the `worker-start --task <taskId> --retry-of <dispatchId>` command for a replacement |

OrcaCompass saves a `rejected` verdict to the cache when Orca reports the
worker's agent and model (`skippedForHours` is then present). Every route then skips
that agent and model for `rejectionTtlHours`. See
[Verify and rejections](verify-and-rejections.md).

## `rejected`

Lists models that agents refused at launch and that routes still skip, or
forgets them.

```sh
orcacompass rejected           # agent, model, age, the agent's words
orcacompass rejected --clear   # forget them all
```

`--json` returns `{ rejectionTtlHours, cleared, rejections }`; `cleared` is the
number forgotten by `--clear` (0 otherwise).

## `status`

Shows the whole routing picture in one call: which agents are available, how
much usage is left, and what each tier would pick now.

Text output contains:

- The evidence source, model count and age, then the placement table's age and
  version (`placements: built 2h ago (orcacompass <version>)`, or `built now:
  no table yet` when this call rebuilt it, plus `placements: could not be
  saved: …` when the cache folder is not writable).
- A warning under the evidence line when the evidence in use is older than
  the snapshot bundled with the installed release.
- Orca's agent switches.
- Each agent with its note, model count, usage state and pools with headroom.
- Recent hand-outs.
- The pick and up to three alternatives per requested tier, from any cost
  tier that covers it, without downgrade or upgrade fallbacks.
- Banned and refused models.
- Unclassified models (the first 15 per agent; the JSON has all of them).

`--json` fields:

| Field | Meaning |
| --- | --- |
| `now` | Epoch ms of the call |
| `handouts`, `handoutMinutes`, `handoutPercent` | Live hand-outs and the settings that count them |
| `evidence` | The evidence summary: `source`, `fetchedAt`, `models`, `generatedAt` |
| `evidenceWarning` | `null`, or a warning when the evidence in use is older than the snapshot bundled with the installed release. The same text is added to `route` warnings; `orcacompass refresh` clears it |
| `placements` | `builtAt`, `age` in ms, `version`, `rebuilt` (why this call rebuilt it, or `null`), `saveError` (or `null`) |
| `orcaAgents` | Orca's agent switches as read, or `null` |
| `agents` | One row per agent: `agent`, `installed`, `enabledInOrca`, `models` (count), `usage` (`null` or `status`, `updatedAt`, `error`, and `pools` with `headroom`, `expired`, `blocked`, and `reportedUsedPercent` when recent hand-outs raised `usedPercent`), plus `note` and `skipped` when they apply |
| `banned` | `{ agent, model }` pairs |
| `rejected` | Active refusals |
| `tiers` | Per tier: `status`, `pick`, `alternatives`, `warnings`, `waitUntil` |
| `unclassified` | `{ agent, model }` pairs that are never routed |

## `tiers`

Shows every model's place in the placement table, with the words and numbers
behind it.

Text output prints the table's age and version, then models grouped by cost
tier with their evidence profiles. The header shows the configured `costBands`,
by default:

```text
cost: light < $1 ≤ daily < $5 ≤ advanced < $12 ≤ frontier (per million tokens, 3:1 blended)
```

`--axis <coding|agentic|reasoning>` instead groups by that axis's evidence bands
and prints its capability cuts. The table is rebuilt first when stale (see
[Tiers and routing](tiers-and-routing.md#when-placement-runs)).

`--json` prints the table file plus `age` in milliseconds: `schemaVersion: 4`,
`version`, `builtAt`, `builtWith` (containing `tierOverrides` and `costBands`),
`sources`, `bands`, `topBands`, and `agents` with each model's `profile`.

## `ranking`

Lists each discovered model once, with its agents. Rows show the cost tier,
blended price (or `no price`) and source, then `evidence <class>` and the three
axes' scores, bands and evidence labels. A hint appears only when it decided the
cost tier. The default order is descending cost tier, descending evidence class,
descending total axis score (equal weights), then model id; `--axis` instead
sorts by that axis's score and prints only that axis.

`--json` returns `generatedAt`, `sources`, `bands`, `topBands` and `models`:

| Model field | Meaning |
| --- | --- |
| `id`, `agents` | Base model id and agents that offer it |
| `class` | Highest evidence band, or `null` when unranked |
| `cost` | `{ tier, blended, source }` or `null`, with the same meaning as `quality.cost` in route JSON |
| `axes` | Per-axis raw score, band, evidence label, benchmark count and provenance |
| `hint` | Classification hint or `null`; retained in JSON even when price decides the cost tier |

## `agents`

Shows which agents are used or skipped, explains why, and lets you change
the selection.

```sh
orcacompass agents
```

Example (illustrative):

```text
orca agent switches: read from …\profile-state.db (experimental); disabled: grok
config: C:\Users\you\AppData\Roaming\orcacompass\config.json

agent        installed  enabled in Orca  Orca usage   chosen  verdict
claude       yes        yes              ok           yes     used
codex        yes        yes              ok           yes     used
cursor       yes        yes              ok           yes     used
grok         yes        no               unavailable  yes     not used: not enabled in Orca
antigravity  yes        yes              ok           yes     used
opencode     yes        yes              unknown      yes     used as last resort
muse         no         yes              unknown      yes     not used: not installed
```

The verdict's reason is the strongest one that applies: `excluded by config`,
`excluded by request`, `not enabled in Orca`, `not signed in or unavailable`,
`not installed`, `not signed in`, `no models`.

`agents --json` (the list) returns `orcaAgents`, `configPath`, `allowAgents`,
`denyAgents` and `agents`: one row per agent with `agent`, `installed`,
`enabledInOrca`, `orcaUsage`, `orcaUsageError` (when usage is not `ok`),
`chosen`, `used` and `verdict`.

### Change the agent selection {#changing-the-choice}

```sh
orcacompass agents disable grok muse     # adds to denyAgents (and removes from allowAgents if that exists)
orcacompass agents enable grok           # removes from denyAgents (and adds to allowAgents if that exists)
orcacompass agents only claude codex     # sets allowAgents (and removes those ids from denyAgents)
orcacompass agents reset                 # removes both keys
```

`disable`, `enable` and `only` need at least one id; `reset` takes none. Each
prints `wrote <config path>`, `chosen` and `not chosen`; `--json` returns
`configPath`, `allowAgents`, `denyAgents`, `chosen`, `notChosen`.

## `prefer`

Sets a favorite route per tier, and the projected usage above which a
within-limit alternative replaces it.

```sh
orcacompass prefer                             # list preferences per tier
orcacompass prefer daily codex                 # Codex's best Daily model
orcacompass prefer advanced claude claude-opus-5-5
orcacompass prefer clear daily
orcacompass prefer clear --all
orcacompass prefer --risk-limit 120            # above 120%, switch if a known within-limit alternative exists
orcacompass prefer --risk-limit 100            # back to the default (removes the key)
```

A model must be one the agent lists. When the agent is not installed or lists
no models right now, the preference is saved with a warning. `--risk-limit`
accepts `120` or `120%`, must be a non-negative number, and cannot be combined
with other arguments. `--json` returns `{ configPath, preferRiskLimit, pins }`.
Rules for when a preference wins:
[Tiers and routing](tiers-and-routing.md#preferences-pins).

## `ban` / `unban`

Bans models or families so they are never routed.

```sh
orcacompass ban                       # list bans with the models each matches now
orcacompass ban claude-haiku grok     # a family and a family
orcacompass ban claude-opus-5-5       # a base model id (covers Cursor's claude-opus-5-5-high too)
orcacompass unban grok
```

Entries are lowercased. An entry matches a model's base id or its catalog
family. An entry that matches nothing discovered right now is saved with a
warning. `unban` warns about an entry that was not banned.

An agent id is refused when it matches no discovered model, because it is not
a model family: use `agents disable` for a whole agent. `grok` is also a
catalog model family, so when Grok models are discovered `ban grok` bans the
family and prints a note about `agents disable`. The same holds for any agent
id that is also a catalog family: `claude` is the family of the older Claude
2 and 3 models, so `ban claude` is accepted when one of those is discovered
and bans only that family, not the Claude Code agent.

`--json` returns `{ configPath, banModels, matches }`, where `matches` maps each
entry to the `{ agent, model }` pairs it covers now.

## `refresh`

Forces fresh model metadata and a rebuilt placement table.

It checks the repository manifest and downloads changed evidence without an API
key, then rebuilds placements. It does not read Orca usage. If the network
fails, a valid cached or bundled snapshot is used and a message on stderr says
which. JSON returns `{ evidence, placements }`; `placements` holds `builtAt`,
`models` and `agents` (counts).

## `update`

Checks npm for the latest release and runs that release's installer.

Run `npx orcacompass update`. It runs that exact release's installer with the
scope, agent selections, `--yes` and `--skill-only` flags you gave. It refuses
to downgrade a newer CLI. Add `--global` for the user-wide Skill. If your
installed release does not recognize `update`, run `npx orcacompass@latest
update` once.

## `uninstall`

Removes the Skill, and with a full `--global` run the CLI too.

Run `npx orcacompass uninstall` from a project to remove its Skill through
`skills@1`. The shared CLI remains installed. `--global` removes the
user-wide Skill first and then runs `npm uninstall -g orcacompass`.
`--skill-only` or an explicit `--agent` keeps the shared CLI even with
`--global`. Before full global CLI removal, the installer also checks that
the global Skill is no longer listed; cancellation, inventory errors or a
remaining copy retain the CLI. A failed Skill removal stops before CLI removal.
Preferences and caches are preserved. `--yes` is required without an
interactive terminal.
