# Troubleshooting

Start with these three commands. They inspect availability and routing and
may update local metadata and model-list caches:

```sh
orcacompass agents          # which agents are used, and why not
orcacompass status          # usage per agent, the pick per tier, metadata age
orcacompass route --tier daily
```

When you share their output in an issue, use `--json` and remove paths and
account details first.

## Install

**`orcacompass install asks questions in a terminal, and this is not one.`**
`install` exits 1 when stdin or stdout is not a terminal, for example when an
agent runs it for you. Run it in a terminal, or add `--yes` to accept the
installer's defaults, with `--global` and `--agent <name>` to choose where:

```sh
orcacompass install --skill-only --yes --global --agent claude-code --agent codex
```

**`The Skill was not installed (npx skills@1 exited with …)`**: the
[`skills`](https://github.com/vercel-labs/skills) installer failed; its own
output above says why. `npx` downloads it on first use, so it needs network
access. The CLI may already have been installed or updated. Fix the cause
and retry `npx orcacompass update` with the same scope and agent choices.

**`CLI installation failed (npm exited with …)`**: the
global npm install failed, often because npm cannot write to its global
folder. The Skill was left unchanged. Fix the cause, then retry
`npx orcacompass update` with the same scope; see [Install](getting-started.md#install).

**`The installed CLI … is newer than this installer …`**: an older installer
would downgrade your CLI. Use `npx orcacompass@latest update` with the same scope.

**`Cannot resolve the latest installer …`**: npm could not read its latest
version tag. Check network access and registry settings, then retry `update`.

**`Cannot confirm Skill removal …`**: the Skill installer may have been
cancelled or could not remove every copy. The shared CLI was retained. Fix
the reported problem and retry `uninstall --global`.

**`Cannot check the installed CLI …`**: npm could not read its global package
metadata. Run `npm ls --global --depth=0 --json orcacompass` to inspect the
error. Nothing was changed.

**`orcacompass` is not found after installing.** npm's global `bin` folder is
not on your PATH (`npm prefix -g` shows where npm installs). Add that folder
on Windows, or its `bin` subfolder on macOS/Linux, to PATH and open a new terminal.

**`orcacompass setup asks its questions in a terminal, and this is not one.`**
Ask your orchestrator to "set up OrcaCompass" in chat instead (it reads
`orcacompass setup --json`), or set things one at a time with `agents`,
`prefer` and `ban`. See [First-time setup](getting-started.md#first-time-setup).

## An agent is not used

`orcacompass agents` gives the reason in the `verdict` column.

| Verdict | What to do |
| --- | --- |
| `not installed` | The executable was not found. `status` names it, such as `claude not found on PATH`. See below |
| `not signed in` | The agent's model listing asked you to sign in. Sign in with that agent's CLI, then try again |
| `not signed in or unavailable` | Orca reports the agent's usage as `unavailable` (signed out, or its CLI is missing in Orca). Sign in to it in Orca |
| `not enabled in Orca` | The agent is switched off in Orca's settings. Turn it on there, or leave it off |
| `excluded by config` | `denyAgents` or `allowAgents` leaves it out. `orcacompass agents enable <id>`, or `agents reset` |
| `no models` | The agent was found but listed no models; `status` shows the listing's error |
| `used as last resort` | OpenCode is used only when no other agent can take the job. Change `lastResortAgents` to make it ordinary; see [Configuration](configuration.md#which-agents-and-models) |

OrcaCompass looks for agent executables on the PATH of the shell that runs it.
On macOS and Linux it then tries the folders Orca adds to its own PATH, so a
launcher or non-login shell that leaves them out does not hide an agent:
Homebrew, `/usr/local/bin`, `~/bin`, `~/.local/bin`, Nix, Snap, MacPorts and a
few agents' own folders. A file only counts if you can execute it.
It also checks where some installers put them: `%LOCALAPPDATA%\cursor-agent`
for Cursor, `~/.grok/bin` (or `$GROK_HOME/bin`) for Grok Build, and
`%LOCALAPPDATA%\agy\bin` or `~/.local/bin` for Antigravity. A terminal opened
before you installed an agent keeps the old PATH: open a new one, and restart
Orca if the orchestrator runs in an Orca terminal that started earlier.

Orca's agent switches are read from its profile database using `node:sqlite`.
Use Node.js 24, or Node.js 22.13+ where SQLite works without extra flags.
When SQLite is unavailable, or when the file cannot be read,
the switches are `unknown` and exclude nobody. The first line of
`orcacompass agents` says which one applies.

## Usage is unknown and confidence is low

`status` shows `usage unknown: Orca not reachable: …` for every agent when
`orca account list --json` fails or takes longer than 20 seconds. Start Orca,
make sure `orca` is on your PATH (on macOS and Linux, `/usr/local/bin`
and `~/.local/bin` are also tried), and run `orca account list --json` yourself
to see the error. Routing still works without usage, but every route has low
confidence and the ranking cannot spread load by headroom.

Other causes of low confidence: Orca reports no usage for that agent, the
usage is older than four times `usageStaleMinutes` (2 hours by default), or a
pool's reset time has already passed. See
[Confidence and stale usage](tiers-and-routing.md#confidence-and-stale-usage).

## A route says `wait` or `none`

`route` exits 0 for `ok`, `wait` and `none`; check `status` in the output.

- `none` with `no usable agent`: no agent passed the checks above. Run
  `orcacompass agents`.
- `none` with `all <tier> candidates blocked`: every model of that tier is at
  or above its usage limit, and no lower tier can take the job.
- `wait`: you passed `--no-downgrade` and the requested tier is blocked.
  `waitUntil` says when the first candidate resets.
- `none` with `--effort`: no candidate can apply that exact effort; the
  reasons list what each one offers. Use `--demand` instead to let OrcaCompass
  pick a supported effort.

`skipped` lists excluded agents and banned/refused models in the requested
tier. Superseded releases and no-ZDR exclusions are omitted. Preference
exclusions appear in `warnings`.
See [Fallbacks](tiers-and-routing.md#fallbacks-downgrade-upgrade-wait-none).

## The worker refused its model

A model an agent lists can still be one your account cannot use. The worker
then idles at its prompt (Codex, Claude Code), exits (Cursor, Grok Build,
Antigravity) or prints `Model unavailable` (OpenCode), while Orca reports the
start as fine. Check every new worker:

```sh
orcacompass verify --dispatch <dispatchId>
```

A `rejected` verdict is saved, and every route skips that agent and model for
`rejectionTtlHours` (a week by default). After upgrading a plan or signing in
to another account, forget the saved refusals:

```sh
orcacompass rejected           # what is skipped, with the agent's words
orcacompass rejected --clear
```

`stalled` or `failed` with a refusal in the terminal tail usually means the
agent changed its wording. Please open an issue with that tail. See
[Verify and rejections](verify-and-rejections.md).

## Models are missing or out of date

Every model's tiers come from the placement table, normally reused for
`placementsTtlHours` (5 hours). A refresh, changed placement settings, a CLI
update or a newly detected agent can rebuild it earlier. A model you just gained, or an
agent you just signed in to, shows up at the next build. `orcacompass tiers`
prints the table with its age. This rebuilds it now and refetches the
metadata too:

```sh
orcacompass refresh
```

If `status` says `evidence: snapshot`, the bundled evidence is in use.
Run `orcacompass refresh` when online to check the repository. Unranked models
lack evidence or a usable inheritance hint; inspect `orcacompass ranking` and
use `tierOverrides` if appropriate.

## Config errors (exit code 2)

```text
config error: <path>: invalid JSON: …
```

Fix the file at that path, or delete it to go back to the defaults. Every
command that reads the config exits 2 until it is valid. When a value has the
wrong type the message names the key, such as `usageStaleMinutes must be a
non-negative number`.

Unknown keys are ignored without a warning, so a setting that has no effect is
often a typo, such as `denyAgent` for `denyAgents`. Check the spelling against
[Configuration](configuration.md#keys-and-defaults).

## A window flashes on Windows

OrcaCompass runs its background commands with a hidden console. It also starts
`agy models` with Antigravity's auto-updater off, because that detached updater
opens a brief terminal window on Windows, at most once every 15 minutes.

A window that still flashes comes from another program, for example a console
tool started by a process with no console of its own. An agent launched through
Orca also opens its own terminal tab, which is expected.

## The first call is slow

A call that builds the placement table checks the evidence manifest and then runs
every agent's model listing, so it can take longer than any single timeout:
10 s for metadata, 30 s for each live listing, 20 s for Orca usage. That
happens on the first call, during `orcacompass refresh`, and when the table
becomes stale. A routing request with a fresh table only runs `orca account list`
for live usage. `status` and `tiers` say when the table was built. The cache
holds observed state only and is safe to delete; see
[Where things live](configuration.md#where-things-live).
