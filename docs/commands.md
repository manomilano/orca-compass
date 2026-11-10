# Commands

Every command of the `orcacompass` CLI, its flags, what it writes, and what its
JSON looks like. Code: `src/cli.ts`.

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
```

| Command | What it does | Writes |
| --- | --- | --- |
| `route` | One recommendation for a job of the given tier | rebuilds the placement table when it is stale (`placements.json`, with the metadata and model-list caches) |
| `verify` | Whether a just-started worker's agent accepted its model; records a refusal | cache (`rejected-models.json`) |
| `rejected` | Models agents refused at launch, still skipped; `--clear` forgets them | cache |
| `status` | Agents, usage pools, the pick and alternatives per tier, metadata and placement table age | same as `route` |
| `ranking` | Profiles of discovered models, optionally sorted by axis | placement cache |
| `tiers` | Every model's tiers from the placement table, with the words and numbers behind each one | same as `route` |
| `agents` | Which agents are used, and why not; `disable`, `enable`, `only`, `reset` change it | listing: same as `route`; mutations write `allowAgents`, `denyAgents` |
| `prefer` | Favorite route per tier; `clear` removes it; `--risk-limit` sets when a known within-limit alternative replaces it | `pins`, `preferRiskLimit`; same caches as `route` when setting a preference |
| `ban` / `unban` | Models or families never routed | `banModels` when adding/removing entries; same caches as `route`, including when listing bans |
| `refresh` | Downloads fresh model metadata and rebuilds the placement table | evidence and placement caches |
| `setup` | Interactive first-time setup in a terminal | the keys above |
| `setup --json` | What the setup questions need, for an orchestrator asking them in chat | same as `route` |
| `setup --complete` | Marks chat setup complete, including unchanged defaults | an empty config if absent; same as `route` |
| `setup --skip` | Declines setup: keeps existing settings or defaults and stops the chat offer | an empty config if absent; same caches as `route` |
| `install` | Installs or updates the CLI, then its matching packaged Skill | agents' skills folders; a global npm package |
| `update` | Fetches the latest release and runs its installer with your options | same as `install` |
| `uninstall` | Removes the selected Skill; full `--global` also removes the CLI | selected Skill files; optionally the global npm package |

Agent ids everywhere: `claude`, `codex`, `cursor`, `grok`, `antigravity`,
`opencode`, `muse`, in any letter case. Tier and demand names are
case-insensitive too. Commands that change the config (`agents`, `prefer`)
reject unknown ids (exit 1). `route` goes on and adds a warning that suggests
the id probably meant, such as `unknown agent "cursor-agent" in
--exclude-agent: nothing excluded for it (did you mean cursor?)`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Answered. For `route` this covers `ok`, `wait` **and** `none`: check `status` in the output |
| 1 | Usage error (bad flag, unknown agent, missing argument) or runtime error |
| 2 | Config error: `config error: <path>: <message>` |

## `route`

```sh
orcacompass route --need coding=high,agentic=mid,reasoning=low --demand high --agent claude --agent codex --json
```

| Flag | Meaning |
| --- | --- |
| `--need <axes>` | All three axes: `coding`, `agentic`, `reasoning`, each `min`, `low`, `mid` or `high`; no spaces |
| `--tier <t>` | Shorthand for equal needs: `light`, `daily`, `advanced`, `frontier`; mutually exclusive with `--need` |
| `--tier-reason <text>` | Optional nonempty explanation from the coordinator, returned in JSON and text. The Skill keeps routine classification in the tool exchange and explains it in chat on request |
| `--demand <d>` | `low`, `moderate`, `high`, `exceptional`; mapped to an effort through `effortPolicy` |
| `--effort <e>` | Exact effort; never snapped. Routes that cannot apply it are left out |
| `--agent <id>` | Repeatable. Only these agents. Lifts a last-resort agent's status |
| `--exclude-agent <id>` | Repeatable. Not these agents |
| `--no-downgrade` | No fallback to a lower tier; blocked candidates give `wait` |
| `--json` | Machine-readable output |

There is no `--model` flag: an exact model the user named is launched directly.

Text output:

```text
daily → claude · claude-sonnet-5-5 · medium (high confidence)
  claude claude-sonnet-5-5: weekly 20% used, 56% of window elapsed (headroom 60%) → on pace for 36% before reset in 3d
  effort: medium from tier default, passed as --effort
  next best: codex gpt-6.1-terra (weekly headroom 41%, resets in 4d)
  skipped: grok (not enabled in Orca), opencode (last resort: used only when no other agent can take the job)
orca orchestration worker-start --spec "<task>" --agent claude --model claude-sonnet-5-5 --effort medium
```

JSON is the `Decision` type (`src/types.ts`) plus `launch`, the two
source fields and `placementsBuiltAt`:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `wait`, or `none` |
| `requestedTier`, `tier` | What was asked, what was chosen (absent without a route) |
| `tierReason` | The coordinator's explanation of the requested tier, when supplied. Also included in `reasons`, even when there is no route |
| `downgraded`, `upgraded` | Whether fallback changed the tier |
| `route` | `{ agent, model, effort }`; `effort` is `null` when it is in the model id or not set |
| `effort` | How the effort was chosen and applied; see [Effort](effort.md#the-effort-object-in-route-json) |
| `launchArgs` | Array to append to `orca orchestration worker-start --spec "<task>"`, one argument per element |
| `launch` | Readable template with a `<task>` placeholder; not shell-escaped, not for automation |
| `confidence` | `high`, `medium`, `low` |
| `risk` | `{ pool, usedPercent, elapsedPercent, projectedPercent, tooEarly, resetsAt }` for the route; `null` when usage is unknown |
| `reasons` | One line per fact behind the choice |
| `warnings` | Downgrade, upgrade, skipped preference, last-resort use |
| `alternatives` | Up to five other candidates from the chosen tier (requested tier without a pick): `agent`, `model`, `effort`, `tier`, `headroom` (fraction, or `null`), `confidence`, `blocked`, `risk`, `reason` |
| `skipped` | `{ agent, model?, reason }` for excluded agents and banned/refused models in the requested tier. Superseded releases and no-ZDR exclusions are omitted. Preference exclusions appear in `warnings` |
| `waitUntil` | Epoch ms when a blocked requested-tier candidate resets; with `wait`, sometimes with `none` |
| `needs`, `needsSource` | The three requested levels and whether they came from `need` or `tier` |
| `quality` | Class, coverage, shortfall or overshoot, evidence and per-axis scores, bands, needs and cuts; also on alternatives |
| `evidenceSource` | `network`, `cache`, or `snapshot`; `catalogSource` and `scoreSource` are compatibility aliases |
| `placementsBuiltAt` | Epoch ms when the placement table this route read was built (see [`tiers`](#tiers)); the evidence source says what that build used |

The chosen route's own headroom appears in its reason line, not as a separate
field.

## `verify`

```sh
orcacompass verify --dispatch <dispatchId> [--wait 60] [--json]
```

Watches the worker Orca just started (`worker-show`, then `worker-read
--source terminal` with 1.5 s between polls). The total budget includes the
initial lookup, reads, and polling delays. The default and maximum are 60 s.
`--wait` accepts 0–60 seconds, with 0 returning `unknown` immediately. A verdict
returns early. Each Orca command is limited to the remaining budget and at most
20 s. Verification returns cleanup instructions for the coordinator. Output:

| Field | Meaning |
| --- | --- |
| `status` | `started`, `reported`, `rejected`, `stalled`, `failed`, `unknown` |
| `dispatchId`, `taskId`, `agent`, `model` | From Orca's `worker-show` |
| `message` | With `rejected`: the agent's refusal, in its own words |
| `detail` | One line: what was seen |
| `tail` | With `stalled`, `failed`, `unknown`: the last lines of the terminal |
| `cleanup` | Orca argv lists to run in order before a replacement (`worker-stop`, then `worker-release`; only `worker-release` when the worker already exited) |
| `skippedForHours` | With `rejected`: how long routes skip this agent and model (`rejectionTtlHours`) |
| `next` | What the orchestrator does next, in order, including the `worker-start --task <taskId> --retry-of <dispatchId>` command for a replacement |

A `rejected` verdict is saved to the cache and skipped by every route for
`rejectionTtlHours`. See [Verify and rejections](verify-and-rejections.md).

## `rejected`

```sh
orcacompass rejected           # agent, model, age, the agent's words
orcacompass rejected --clear   # forget them all
```

`--json` returns `{ rejectionTtlHours, cleared, rejections }`; `cleared` is the
number forgotten by `--clear` (0 otherwise).

## `status`

Shows: installed agents with their notes, usage pools with headroom, the pick
and up to three alternatives per tier (each tier on its own, without
fallbacks), models placed by the provider's lineup or the
capability score with the words and numbers behind them, unclassified models,
the age and source of the metadata, and when the placement table was built
(`placements: built 2h ago (orcacompass <version>)`, or `built now: no table
yet` when this call rebuilt it, plus `placements: could not be saved: …`
when the cache folder is not writable). `--json` has `now`, `catalog`,
`scores` (or `null`), `placements` (`builtAt`,
`age` in ms, `version`, `rebuilt` (why this call rebuilt it, or `null`),
`saveError`, `scoreScale`), `orcaAgents`, `agents`,
`banned` (`{ agent, model }` pairs), `rejected`, `tiers`, `scored`,
`unclassified`; metadata summaries carry `source`, `fetchedAt`, `models`. Each `agents` row has
`agent`, `installed`, `enabledInOrca`, `models` (count), `usage` (`null` or
`status`, `updatedAt`, `error`, and `pools` with `headroom`, `expired`,
`blocked`), plus `note` and `skipped` when they apply.

## `tiers`

Prints the placement table: when it was built and by which version, what
each metadata source contributed, then every model under each tier it may
serve with the words and numbers behind that placement, and the unclassified
models. A model that spans two tiers appears under both. The table is
rebuilt first when it is stale (see [Tiers and
routing](tiers-and-routing.md#when-placement-runs)). `--json` prints the
table file itself (`schemaVersion`, `version`, `builtAt`, `builtWith`,
`sources`, `agents` with each model's `placements` and `tiers`) plus `age`
in milliseconds.

## `agents`

```sh
orcacompass agents
```

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

```sh
orcacompass agents disable grok muse     # adds to denyAgents
orcacompass agents enable grok           # removes from denyAgents (and adds to allowAgents if that exists)
orcacompass agents only claude codex     # sets allowAgents
orcacompass agents reset                 # removes both keys
```

Each prints `chosen` and `not chosen` after the change; `--json` returns
`configPath`, `allowAgents`, `denyAgents`, `chosen`, `notChosen`.

`agents --json` (the list) returns `orcaAgents`, `configPath`, `allowAgents`,
`denyAgents` and `agents`: one row per agent with `agent`, `installed`,
`enabledInOrca`, `orcaUsage`, `orcaUsageError` (when usage is not `ok`),
`chosen`, `used` and `verdict`.

## `prefer`

```sh
orcacompass prefer                             # list preferences per tier
orcacompass prefer daily codex                 # Codex's best Daily model
orcacompass prefer advanced claude claude-opus-5-5
orcacompass prefer clear daily
orcacompass prefer clear --all
orcacompass prefer --risk-limit 120            # above 120%, switch if a known within-limit alternative exists
orcacompass prefer --risk-limit 100            # back to the default (removes the key)
```

A model must be one the agent lists; when the agent is not installed right now
the preference is saved with a warning. `--risk-limit` accepts `120` or `120%`.
`--json` returns `{ configPath, preferRiskLimit, pins }`. Rules for when a
preference wins:
[Tiers and routing](tiers-and-routing.md#preferences-pins).

## `ban` / `unban`

```sh
orcacompass ban                       # list bans with the models each matches now
orcacompass ban claude-haiku grok     # a family and a family
orcacompass ban claude-opus-5-5       # a base model id (covers Cursor's claude-opus-5-5-high too)
orcacompass unban grok
```

An entry matches a model's base id or its catalog family. An entry that
matches nothing discovered right now is saved with a warning. An agent id that
is not also a model family is refused: use `agents disable` for a whole agent.
`--json` returns `{ configPath, banModels, matches }`, where `matches` maps each
entry to the `{ agent, model }` pairs it covers now.

## `refresh`

Checks the repository manifest and downloads changed evidence without an API
key, then rebuilds placements. It does not read Orca usage. JSON returns
`{ evidence, placements }`; a valid cached or bundled snapshot is used if the
network fails.

## `setup`

See [Getting started](getting-started.md#first-time-setup) for the three
questions. `setup --json` prints one document for a chat setup:

| Field | Content |
| --- | --- |
| `configPath`, `configExists` | Where the config lives and whether it exists |
| `orcaAgents` | Orca's agent switches as read, or why they are unknown |
| `config` | Current `allowAgents`, `denyAgents`, `pins`, `preferRiskLimit`, `banModels` |
| `defaultPreferRiskLimit` | 100 |
| `agents` | `agent`, `installed`, `enabledInOrca`, `orcaUsage`, `models` (count), `chosen`, `preselected` (in the default answer to question 1), `verdict` |
| `tiers` | Per tier: `pick`, `preferred`, `options` (agent, `model` to prefer, `blocked`, `onPacePercent`, `reason`), `warnings` |
| `families` | Each discovered family with its models and whether it is banned |

`setup --skip` writes an empty `{}` config file when none exists, so the Skill
stops offering setup; defaults then apply (agents follow Orca's switches).
`setup --skip --json` returns `{ configPath, agentsUsed, orcaAgents }`.

`setup --complete` finishes chat setup. It creates an empty config when absent
and preserves an existing file. This makes `configExists` true even when all
answers kept their defaults. With `--json` it returns the same document as
`setup --json`. `--complete` and `--skip` cannot be combined.

## `install`

Run `npx orcacompass install` from your project. The default is a project Skill;
`--local` selects the same default flow, and `--global` selects a user-wide Skill.
Without `--global`, the interactive Skill installer may ask Project or Global;
keep its Project default for a local installation. `--yes` accepts that default.
The installer reads the globally installed version with `npm ls --global`.
Unless `--skill-only` is given, it installs a missing or older CLI with
`npm install -g orcacompass@<this version>` and keeps an already current CLI.
An older installer refuses to downgrade a newer CLI or replace its Skill.
Copies in npx's cache or project-local installations do not count as global
installations.

After the CLI step succeeds, it installs the Skill with
`npx -y skills@1 add <package folder>`, the
[`skills`](https://github.com/vercel-labs/skills) installer pointed at the
Skill inside this package, so the Skill matches this CLI version. `--global`,
`--yes` and each `--agent <name>` pass through to it. `--skill-only` skips
the CLI check and installation entirely.
Both steps run attached to the terminal, so their questions and output reach
you. Without a terminal it exits 1 unless `--yes` is given. Exits 1 when either
step fails, with the step that failed and how to finish by hand.

On Windows, OrcaCompass disables telemetry only in its `skills` subprocesses
to avoid an upstream shutdown crash. It does not change your environment or
npm's settings.


## `update`

Run `npx orcacompass update` to check npm for the latest release, then run
that exact release's installer. It preserves the scope, agent selections,
`--yes` and `--skill-only` flags. It refuses to downgrade a newer CLI.
Add `--global` for the user-wide Skill. If your installed release does not
recognize `update`, run `npx orcacompass@latest update` once.

## `uninstall`

Run `npx orcacompass uninstall` from a project to remove its Skill through
`skills@1`. The shared CLI remains installed. `--global` removes the
user-wide Skill first and then runs `npm uninstall -g orcacompass`.
`--skill-only` or an explicit `--agent` keeps the shared CLI even with
`--global`. Before full global CLI removal, the installer also checks that
the global Skill is no longer listed; cancellation, inventory errors or a
remaining copy retain the CLI. A failed Skill removal stops before CLI removal. Preferences
and caches are preserved. `--yes` is required without an interactive terminal.
