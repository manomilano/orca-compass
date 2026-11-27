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
| `route` | Recommends an agent, model and effort for a job and reserves its quota | [`route`](#route) |
| `verify` | Checks whether a just-started worker's agent accepted its model | [`verify`](#verify) |
| `release` | Ends the quota reservation of a finished worker | [`release`](#release) |
| `rejected` | Lists or clears models agents refused at launch | [`rejected`](#rejected) |
| `status` | Shows agents, usage and reservations per quota, the pick per tier and data ages | [`status`](#status) |
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
orcacompass route --need coding=<l>,agentic=<l>,reasoning=<l> | --tier <light|daily|advanced|frontier> [--agent <id>]... [--exclude-agent <id>]... [--demand <d>] [--effort <e>] [--use <agent>/<model>] [--dry-run] [--tier-reason <text>] [--json]
orcacompass verify --dispatch <id> [--reservation <id>] [--wait <seconds>] [--json]
orcacompass release --reservation <id> | --dispatch <id> | --all [--outcome completed|cancelled|failed-before-launch] [--json]
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
| `route` | Table caches when stale; `reservations.json`: a reservation when the result is `ok` (not with `--dry-run`) |
| `verify` | `rejected-models.json` when the verdict is `rejected`; `reservations.json`: the worker's reservation |
| `release` | `reservations.json` |
| every command that reads usage | `reservations.json`, when Orca's usage snapshot changed or a reservation was reconciled |
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
| 0 | Answered. For `route` this covers `ok`, `decide` **and** `none`: check `status` in the output |
| 1 | Usage error (bad flag, unknown agent, missing argument) or runtime error; also `setup` canceled with Ctrl+C (answering no to "Save" exits 0), and a `route` whose quota could not be reserved (nothing on stdout, nothing routed) |
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
| `defaultPreferRiskLimit` | 90 |
| `agents` | `agent`, `installed`, `enabledInOrca`, `orcaUsage`, `models` (count), `chosen`, `preselected` (in the default answer to question 1), `verdict` |
| `tiers` | Per tier: `pick`, `preferred`, `options` (agent, `model` to prefer, `blocked`, `usagePercent`: the route's highest prospective usage, or `null` when unknown, `reason`, and on the pick `note` when its task coverage could not be verified), `warnings` |
| `families` | Each discovered family with its models and whether it is banned |

`setup --complete` creates an empty config when absent and preserves an
existing file, so `configExists` becomes true even when all answers kept their
defaults. Text output is `Setup complete. Config: <path>`; with `--json` it
returns the same document as `setup --json`.

`setup --skip` writes an empty `{}` config file when none exists, so the Skill
stops offering setup; defaults then apply (agents follow Orca's switches).
`setup --skip --json` returns `{ configPath, agentsUsed, orcaAgents }`.

## `route`

Recommends one agent, model and effort for a job and reserves the quota its
worker will draw on. Needs a tier or an explicit need per axis.

```sh
orcacompass route --need coding=high,agentic=mid,reasoning=low --demand high --agent claude --agent codex --json
```

| Flag | Meaning |
| --- | --- |
| `--need <axes>` | All three axes: `coding`, `agentic`, `reasoning`, each `min`, `low`, `mid`, `high` or `top`; no spaces |
| `--tier <t>` | Shorthand for equal needs: `light`, `daily`, `advanced`, `frontier`; mutually exclusive with `--need` |
| `--tier-reason <text>` | Optional nonempty explanation from the coordinator, returned in JSON and text. The Skill keeps routine classification in the tool exchange and explains it in chat on request |
| `--demand <d>` | `low`, `moderate`, `high`, `exceptional`; mapped to an effort through `effortPolicy`. Only models that can apply that effort, or the next higher one they offer, are eligible |
| `--effort <e>` | Exact effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`extra-high` is accepted for `xhigh`). Never snapped; routes that cannot apply it are left out |
| `--agent <id>` | Repeatable. Only these agents. Lifts a last-resort agent's status |
| `--exclude-agent <id>` | Repeatable. Not these agents |
| `--use <agent>/<model>` | The Orchestrator's explicit choice after a `decide`: that route is taken despite the risk thresholds and a capability or effort shortfall. Refused when a quota it draws on is exhausted |
| `--dry-run` | Decide without reserving quota |
| `--no-downgrade` | Accepted and ignored, with a warning: requirements are never lowered automatically |
| `--json` | Machine-readable output |

One of `--need` or `--tier` is required.

::: info No `--model` flag
There is no `--model` flag: an exact model the user named is launched directly.
:::

Text output (illustrative; values vary):

```text
daily → codex · gpt-6.1-terra · medium (high confidence)
  codex gpt-6.1-terra: weekly 20% reported + 1.5 pp reserved (1 worker) + 1.5 pp for this worker = 23% prospective (available), resets in 5d
  needs coding=low agentic=low reasoning=low from tier daily; eligible routes: 9 across all cost tiers
  cost: daily ($2.00/M blended, maker price)
  coding 77.5 measured, agentic 70 measured, reasoning 78 measured
  effort: medium from tier default, passed as --effort
  selection: quota bucket codex weekly has 78.5% effective capacity left (bucket 1 of 2 with an eligible route); most economical eligible route in it below the 85% caution threshold
  next best: codex gpt-6.1-sol (weekly 23% prospective, available, $4.00/M blended)
  skipped: grok (not enabled in Orca), opencode (last resort: used only when no other agent can take the job)
  reserved rsv_3f9a1c2b7d10: weekly +1.5 pp; after worker-start run: orcacompass verify --dispatch <id> --reservation rsv_3f9a1c2b7d10
orca orchestration worker-start --spec "<task>" --agent codex --model gpt-6.1-terra --effort medium
```

When no eligible route is below the risk threshold, nothing is picked and the
decision comes back:

```text
daily → your decision: WAIT (14h), USE or LOWER
  no eligible route is below the 90% risk threshold: claude claude-sonnet-5-5 (weekly 94.5% prospective, high risk)
  needs coding=low agentic=low reasoning=low from tier daily; eligible routes: 1 across all cost tiers
  WAIT: until 2026-10-29T14:00:00.000Z (14h); the earliest quota reset is in 14h
  USE: claude claude-sonnet-5-5 with --use claude/claude-sonnet-5-5 (weekly 94.5% prospective, high risk)
  LOWER: claude claude-haiku-5-5 takes the job with lower requirements: below need on agentic (53.5 < 60) (weekly 93.5% prospective, high risk)
  to LOWER, route again with lower --need or --demand; to take one route as it is, add its --use flag
```

### Route JSON

The JSON is the `Decision` type (`src/types.ts`) plus `launch`, the source
fields (`evidenceSource`, `catalogSource`, `scoreSource`) and `placementsBuiltAt`.

| Field | Meaning |
| --- | --- |
| `status` | `ok` (routed and reserved), `decide` (the Orchestrator chooses; see `options`), or `none` |
| `requestedTier`, `tier` | Requested needs shorthand and the pick's cost tier (absent without a route and for Cursor `auto`); an eligible pick from a cheaper tier is not a downgrade, and one from a pricier tier is an upgrade only when no cheaper route is eligible |
| `source` | Where the pick's cost tier came from: `override`, `lineup`, `family` or `evidence`; `auto` for Cursor `auto` |
| `tierReason` | The coordinator's explanation of the requested tier, when supplied. Also included in `reasons`, even when there is no route |
| `downgraded`, `upgraded` | A downgrade falls short of the requested needs; it only happens for a route chosen explicitly (`--use`, or a preferred model). An upgrade is an eligible pick from a pricier cost tier than the requested tier, when no route at or below the requested tier is eligible |
| `coverageNote` | Informational, not a downgrade: the explicitly chosen model has no benchmark data on an axis the job needs, so task coverage could not be verified. `Manually preferred model; benchmark data unavailable. Task coverage could not be verified.` for the tier's preferred model (also with `--use`), `Explicitly chosen model (--use); benchmark data unavailable. Task coverage could not be verified.` for another `--use` model. Absent when coverage was checked |
| `route` | `{ agent, model, effort }`; `effort` is `null` when it is in the model id or not set |
| `effort` | How the effort was chosen and applied; see [Effort](effort.md#the-effort-object-in-route-json) |
| `launchArgs` | Array to append to `orca orchestration worker-start --spec "<task>"`, one argument per element |
| `launch` | Readable template with a `<task>` placeholder; not shell-escaped, not for automation; `null` without a route |
| `confidence` | `high`, `medium`, `low` |
| `quota` | The route's quota: `status` (the most restrictive prospective status), `binding` (the bucket with the least capacity left), `remaining`, `prospective`, and `buckets`: for every bucket the route draws on `id`, `pool`, `reported`, `reserved`, `workers`, `effective`, `remaining`, `buffer`, `prospective`, `prospectiveStatus`, `resetsAt` (or `null`), `snapshotAt`, `stale`. `null` for a route without a usage window |
| `reservation` | With `ok`: `{ id, state: "pending", buckets: [{ bucket, percentPoints }], expiresAt }`. Absent with `--dry-run` and for a route without a usage window |
| `buckets` | Every quota bucket of the agents considered, most capacity left first, with the same reported, reserved and effective fields |
| `options` | With `decide`: `wait` (`{ until?, reason }` or `null`; `until` only when a reset time is reported), `use` and `lower` (routes with `agent`, `model`, `effort`, `tier`, `quota`, `reason`, the `use` flag that takes them, and for `lower` the `shortfall`). A preference held back only by `preferRiskLimit` that automatic routing never offers comes first under `use` with `preferred: true`, plus `coverageNote` when its coverage is unknown |
| `reasons` | One line per fact behind the choice; the first names the route and, for each bucket it draws on, reported usage, what is reserved, this worker's buffer and the prospective result; the needs line includes `eligible routes: 3 across all cost tiers`, a route adds `cost: daily ($4.00/M blended, maker price)`, and an automatic pick adds a `selection:` line with its bucket's rank and the threshold it passed; a `decide` adds `WAIT:`, `USE:` and `LOWER:` lines |
| `warnings` | Downgrade, upgrade, skipped preference, last-resort use, and on the picked route: a bucket in the caution range or above (`weekly quota would be 87.5% used with this worker (caution); resets in 14h`) or unknown usage (`usage of codex is unknown: …; routed without a quota check`) |
| `alternatives` | Up to five other eligible routes in rank order, from all cost tiers: `agent`, `model`, `effort`, `tier`, `quota`, `confidence`, `blocked` (a quota is exhausted), `reason` |
| `skipped` | `{ agent, model?, reason }` for excluded agents (including an unknown `--agent`), banned and refused models, unranked models, models below the requested needs and models that cannot apply the effort, in every tier. Superseded releases and no-ZDR exclusions are omitted. Preference exclusions appear in `warnings` |
| `needs`, `needsSource` | The three requested levels and whether they came from `need` or `tier` |
| `quality` | Evidence class, cost, coverage, shortfall or overshoot, evidence and per-axis scores, bands, needs and cuts; also on alternatives |
| `quality.class` | Highest evidence band across the axes; independent of cost |
| `quality.cost` | `{ tier, blended, source }` or `null`; `blended` is USD per million tokens, `(3 × inputPerM + outputPerM) / 4`, rounded to two decimals, or `null` without a price; `source` is `override`, `price`, `family`, `lineup`, or `evidence` |
| `evidenceSource` | `network`, `cache`, or `snapshot`; `catalogSource` and `scoreSource` are compatibility aliases |
| `placementsBuiltAt` | Epoch ms when the placement table this route read was built (see [`tiers`](#tiers)); the evidence source says what that build used |

Reported usage is never adjusted: what is reserved for workers is a separate
number next to it, and the effective and prospective usage are derived from
both. See [Quota buckets, reservations and risk](tiers-and-routing.md#quota-reservations-and-risk).

A route is never printed without its reservation. When the reservation ledger
(`reservations.json` in the cache folder) cannot be locked, read or written,
`route` prints nothing on stdout, exits 1, and says on stderr:

```text
error: quota could not be reserved (<cause>): nothing was routed. Fix <cache dir>, or route with --dry-run for an unreserved decision
```

`--dry-run` is the explicit unreserved path: it decides without writing the
ledger and, when the ledger could not be written, adds the warning
`the reservation ledger could not be written: <cause>`. A ledger file that is
not a valid ledger is not an error: it is kept as `reservations.json.corrupt`,
a fresh ledger is written, the workers Orca reports live are reconstructed in
it, and a warning says so.

## `verify`

Checks whether a newly started worker's agent accepted its model, records any
recognized refusal and settles the worker's quota reservation.

```sh
orcacompass verify --dispatch <dispatchId> [--reservation <id>] [--wait 60] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--dispatch <id>` | Required. The `dispatchId` that `worker-start` printed |
| `--reservation <id>` | The `reservation.id` the route returned. Without it, the worker is matched to the oldest pending reservation for the same agent and model |
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

The JSON also carries `reservation` (`{ id, state }`, or `null` when none
matched). The verdict moves the reservation on: a worker that `started` is
marked `running` (the same record, nothing is reserved twice), and so is a
`stalled` one; `unknown` (for example with `--wait 0`) binds the reservation
to the Dispatch but leaves it `pending`, so Orca's worker list moves it on at
the next `route` or `status`, or `pendingMinutes` abandons it; `reported`
marks it `completed`; a `rejected` model consumed nothing, so its
reservation is released at once; a `failed` worker keeps its reservation
until a fresh usage snapshot covers it. A reservation already bound to
another Dispatch is never moved: `reservationError` says
`reservation <id> is bound to dispatch <x>, not <y>; nothing changed`.

OrcaCompass saves a `rejected` verdict to the cache when Orca reports the
worker's agent and model (`skippedForHours` is then present). Every route then skips
that agent and model for `rejectionTtlHours`. See
[Verify and rejections](verify-and-rejections.md).

## `release`

Ends the quota reservation of a worker.

```sh
orcacompass release --dispatch <dispatchId>                 # the worker finished
orcacompass release --dispatch <dispatchId> --outcome cancelled
orcacompass release --reservation <id> --outcome failed-before-launch
orcacompass release --all                                   # forget every reservation
```

| Outcome | Effect |
| --- | --- |
| `completed` (default) | The worker finished. Its reservation keeps counting until Orca's next usage refresh covers what it consumed, then it is released |
| `cancelled` | The worker was stopped after it had worked: held the same way |
| `failed-before-launch` | Nothing ran. The reservation stops counting at once |

A worker that is never released is closed when Orca reports it as finished
(checked on later calls), and a reservation nobody confirmed is abandoned
after `reservations.pendingMinutes`. `--reservation` with a `--dispatch` other
than the one the reservation is bound to changes nothing and exits 1:
`reservation <id> is bound to dispatch <x>, not <y>; nothing changed`. `--json` returns `{ reservation }` (or
`{ cleared }` with `--all`). See
[Reservations](tiers-and-routing.md#reservations).

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

Shows the whole routing picture in one call: which agents are available, the
reported, reserved and effective usage of every quota, the workers holding
reservations, and what each tier would pick now. It reserves nothing.

Text output contains:

- The evidence source, model count and age, then the placement table's age and
  version (`placements: built 2h ago (orcacompass <version>)`, or `built now:
  no table yet` when this call rebuilt it, plus `placements: could not be
  saved: …` when the cache folder is not writable).
- A warning under the evidence line when the evidence in use is older than
  the snapshot bundled with the installed release.
- Orca's agent switches.
- Each agent with its note, model count, usage state (`usage ok, updated 3m
  ago`; `usage retained (<error>), updated 12m ago` when the windows shown are
  kept from an earlier reading because Orca's refresh failed or Orca could not
  be read) and, per quota, a line
  such as `weekly 50% reported + 3 pp reserved (2 workers) = 53% effective,
  available; resets in 14h`.
- The reservations that count against quota: id, route, state and the points
  held on each bucket not yet settled.
- A warning when the reservation ledger could not be written, or was
  unreadable and rebuilt.
- The pick and up to three alternatives per requested tier, from any cost
  tier that is eligible, or the decision that would come back. A pick with no
  benchmark data on a needed axis gets a `note:` line with the informational
  reason.
- Banned and refused models.
- Unclassified models, under `unclassified (not routed automatically)`: the
  first 15 per agent (the JSON has all of them), preferred ones first and
  marked `(preferred for <tier>)`, since a preference routes one for its tier.

`--json` fields:

| Field | Meaning |
| --- | --- |
| `now` | Epoch ms of the call |
| `riskThresholds` | The configured `cautionPercent` and `highPercent` |
| `reservations` | Every reservation record: `id`, `state`, `live` (whether it counts), `agent`, `model`, `tier`, `effort`, `pools` (every window the model is declared to draw on), `settled` (windows a fresh reading already covers), `plan`, `dispatchId`, timestamps, and `buckets` with the `percentPoints` held on each: `0` when the record is not live or the window is settled (`settled: true`), else the buffer for the plan the record was reserved on |
| `ledgerError` | Present when the reservation ledger could not be written |
| `ledgerRecovered` | Present when the ledger file was unreadable: it was kept as `reservations.json.corrupt` and rebuilt, and this says what was reconstructed |
| `evidence` | The evidence summary: `source`, `fetchedAt`, `models`, `generatedAt` |
| `evidenceWarning` | `null`, or a warning when the evidence in use is older than the snapshot bundled with the installed release. The same text is added to `route` warnings; `orcacompass refresh` clears it |
| `placements` | `builtAt`, `age` in ms, `version`, `rebuilt` (why this call rebuilt it, or `null`), `saveError` (or `null`) |
| `orcaAgents` | Orca's agent switches as read, or `null` |
| `agents` | One row per agent: `agent`, `installed`, `enabledInOrca`, `models` (count), `usage` (`null` or `status`, `updatedAt`, `plan`, `error`, `retained` when the windows are kept from an earlier reading (Orca's refresh failed, or Orca could not be read and the last valid snapshot stands in), and `pools`: per quota bucket `name`, `reported` (also as `usedPercent`), `reserved`, `workers`, `effective`, `remaining`, `status`, `resetsAt`, `snapshotAt`, `stale`), plus `note` and `skipped` when they apply |
| `banned` | `{ agent, model }` pairs |
| `rejected` | Active refusals |
| `tiers` | Per tier: `status`, `pick` (with `note` when the pick's task coverage could not be verified, see `coverageNote` under `route`), `alternatives`, `warnings`, and `options` when the status is `decide` |
| `unclassified` | `{ agent, model }` pairs that are never routed automatically; `preferredFor` lists the tiers whose model preference names one, which routes it for that tier |

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

`--json` prints the table file plus `age` in milliseconds: `schemaVersion: 5`,
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

Sets a favorite route per tier, and the usage limit below which it is used.

```sh
orcacompass prefer                             # list preferences per tier
orcacompass prefer daily codex                 # Codex's best Daily model
orcacompass prefer advanced claude claude-opus-5-5
orcacompass prefer clear daily
orcacompass prefer clear --all
orcacompass prefer --risk-limit 95             # keep a favorite in use up to 95% prospective usage
orcacompass prefer --risk-limit 90             # back to the default (removes the key)
```

A model must be one the agent lists. When the agent is not installed or lists
no models right now, the preference is saved with a warning. `--risk-limit`
accepts `95` or `95%`, must be a non-negative number, and cannot be combined
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
