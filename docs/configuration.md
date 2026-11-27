---
description: Where OrcaCompass keeps its config and cache, every config key with its default, and what data it reads.
---

# Configuration

Look up settings and cache locations, config keys and defaults, and the data
OrcaCompass reads from your machine. No config file is required:
`orcacompass setup`, `agents`, `prefer` and `ban` write the common keys for you,
and the rest are edited by hand. Code: `src/config.ts`, `src/paths.ts`.

## Where things live

| Platform | Config | Cache |
| --- | --- | --- |
| Windows | `%APPDATA%\orcacompass\config.json` | `%LOCALAPPDATA%\orcacompass\cache` |
| macOS / Linux | `${XDG_CONFIG_HOME:-~/.config}/orcacompass/config.json` | `${XDG_CACHE_HOME:-~/.cache}/orcacompass` |
| `ORCACOMPASS_HOME` set | `$ORCACOMPASS_HOME/config.json` | `$ORCACOMPASS_HOME/cache` |

Other tools' locations follow their own environment variables:

| Variable | Default | Used for |
| --- | --- | --- |
| `ORCA_USER_DATA_PATH` | Orca's data folder | Orca's agent switches and model catalog |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's model catalog |
| `CODEX_HOME` | `~/.codex` | `models_cache.json` |
| `GROK_HOME` | `~/.grok` | `models_cache.json` and `bin/` |

A variable that is set but empty counts as unset. `~` is `$HOME` on macOS and
Linux and `%USERPROFILE%` on Windows, the folder the agents themselves use.

### The cache

The cache holds discovered data, the reservations of allocated workers and
saved model refusals. You can delete it, but doing so forgets those
reservations and refusals as well as the cached metadata:

| File | Content |
| --- | --- |
| `evidence-snapshot.json`, `evidence-check.json` | Cached evidence and manifest check time |
| `reservations.json` | The reservation ledger: one record per allocated worker with its lifecycle state, and the last valid usage snapshot per provider (quota identities are hashes; no account id is stored). Changed under `reservations.lock` and replaced whole, so concurrent commands cannot corrupt it |
| `placements.json` | The placement table: every model's tiers with the numbers behind them, built from every source; reused for `placementsTtlHours` |
| `cursor-models.json`, `grok-models.json`, `antigravity-models.json`, `opencode-models.json` | Last good model listing per agent, used only when the live command fails |
| `rejected-models.json` | Models agents refused at launch, written by `verify` |

The four model-list caches use `schemaVersion: 1`, `agent`, `fetchedAt` (Unix
milliseconds), and `models`: an array of `{ "id": "..." }` objects with an optional
provider `label` (Cursor keeps its labels, including `NO ZDR`). They store provider
observations only. Computed tiers live in `placements.json`, which records the
OrcaCompass version and the placement keys of the configuration
(`tierOverrides`, `costBands`) in `builtWith` (schema 5), so a change
to any of them rebuilds it. OrcaCompass reads usage on each run and keeps
worker reservations until Orca's usage covers them. User preferences remain in
`config.json`.

The listing commands run when the placement table is built, not on every
route (Grok first checks its own native `models_cache.json`). A successful listing
atomically replaces its JSON cache. If the command fails, a valid JSON cache is
preferred; an old `*-models.txt` cache can still be read and converted to JSON,
preserving its original timestamp and leaving the old file intact. Invalid JSON
or unsupported schema versions are ignored. Sign-in failures never use a cached
listing. Running `cursor-agent models` directly does not update OrcaCompass's
cache; OrcaCompass writes it when it invokes that command during discovery.

## How the file is read and written

- A missing file means defaults. An unreadable or invalid file is exit code 2
  with `config error: <path>: <message>`.
- JSON objects deep-merge over the defaults; arrays replace them.
- Known keys must have the documented types; numbers must be finite and
  non-negative. `costBands` must contain exactly three strictly ascending,
  non-negative numbers; invalid values are a config error naming the key.
- Commands that write the file change only their own keys. Every other key
  keeps its value and position, and the file keeps its indentation and line
  endings. The write replaces the file in one step, so a crash never leaves
  half a config. A file that is not a valid config is left untouched.

::: warning Unknown keys are ignored
OrcaCompass silently ignores unknown keys: a typo such as `denyAgent` has no
effect and produces no warning. Unknown tier keys inside `pins` or
`defaultEffort` are errors.
:::

::: info Retired keys
`scoreWeight`, `classWeight` and `modelsDevTtlHours` are no longer used. If
present they produce a warning and are ignored; use `costBands` and
`evidenceTtlHours` instead.
:::

## Keys and defaults

### Which agents and models

| Key | Default | Purpose | Written by |
| --- | --- | --- | --- |
| `allowAgents` | omitted (all) | Only these agents are eligible | `agents only`; `agents disable` and `agents enable` when the key exists; `agents reset` removes it |
| `denyAgents` | `[]` | These agents are never used, even if allowed | `agents disable`, `agents enable`, `agents only`, `agents reset` |
| `pins` | `{}` | Preferred route per tier with optional `model`, e.g. `{ "daily": { "agent": "codex" } }`. A favorite is used while its prospective usage stays below `preferRiskLimit`, and never when a quota is exhausted | `prefer` |
| `preferRiskLimit` | `90` | A favorite is skipped once its prospective usage (reported + reserved + its own buffer) reaches this percentage on a quota it draws on. Above `riskThresholds.highPercent` it keeps a favorite in use at high risk | `prefer --risk-limit` |
| `banModels` | `[]` | Model ids or families never routed | `ban`, `unban` |
| `lastResortAgents` | `["opencode"]` | Agents used only when no other agent can take the job (instead of waiting, never ahead of a route the Orchestrator could still use). `--agent <id>` or a preference for the tier lifts it; `[]` makes them ordinary | by hand |
| `tierOverrides` | `{}` | Model id or family to a tier: `{ "gemma4:12b": "light", "grok": "daily" }`. Sets the cost tier, leaving a model's own evidence bands and coverage unchanged. A model with no scores of its own and a known maker also inherits assumed scores through the override; with no known maker it stays unranked. An `auto` override is ignored with a warning | by hand |
| `excludeNoZdr` | `false` | Exclude models marked no-ZDR (zero data retention). Relies on Cursor's `NO ZDR` labels only | by hand |
| `cursorAuto` | `true` | List Cursor `auto` as an option when the decision comes back to the Orchestrator. It is never routed on its own | by hand |

### Usage and risk

| Key | Default | Purpose |
| --- | --- | --- |
| `riskThresholds.cautionPercent` | `85` | Prospective usage from here on is `caution`: the route is used only when none is available below it, with a warning |
| `riskThresholds.highPercent` | `90` | Prospective usage from here on is `high`: the route is never picked automatically, and the decision goes back to the Orchestrator. Must not be below `cautionPercent`; both are 0 to 100 |
| `usageStaleMinutes` | `30` | A usage snapshot older than this caps confidence at medium; beyond 4x this the usage is unknown and confidence low |

Prospective usage is `reported + reserved + this worker's buffer` per quota
bucket; see [Risk thresholds](tiers-and-routing.md#risk-thresholds). Actual
exhaustion is always 100% reported usage.

### Reservations {#reservations}

| Key | Default | Purpose |
| --- | --- | --- |
| `reservations.buffers` | the table below | Percentage points a worker reserves on each quota bucket it draws on, by buffer tier (row) and effort (column). Given cells replace the defaults; the rest keep theirs |
| `reservations.overrides` | `[]` | Changes for some workers or buckets, applied in order. Each rule matches by any of `agent`, `plan` (Orca's plan type, such as `max_5x`) and `pool` (a usage window, such as `session` or `bucket:Other Models`), and gives a `scale` to multiply by, `buffers` cells to replace, or both |
| `reservations.modelTiers` | `{}` | Model id or family to a buffer tier, when a model should reserve another row than its cost tier's: `{ "claude-haiku-5-5": "minimal" }` |
| `reservations.pendingMinutes` | `10` | A reservation whose launch nobody confirmed (`verify`) is abandoned after this long, then released by the next fresh usage snapshot |
| `reservations.settleSeconds` | `60` | A finished worker's reservation is released, window by window, by readings Orca took at least this long after the worker ended (a window Claude's live session carries forward unchanged waits at least 20 minutes) |
| `reservations.maxRunningHours` | `24` | A running reservation is closed after this long, in case its worker was never released and Orca no longer lists it. A worker Orca confirms is still live is never closed. A finished record still held is dropped seven days after the worker ended |

Default `buffers`, in percentage points per worker:

| Buffer tier | `low` | `medium` | `high` | `xhigh` |
| --- | ---: | ---: | ---: | ---: |
| `minimal` | 0.5 | 0.5 | 0.75 | 1.0 |
| `light` | 0.5 | 1.0 | 1.25 | 1.5 |
| `daily` | 1.0 | 1.5 | 1.75 | 2.0 |
| `advanced` | 1.5 | 2.0 | 2.5 | 3.0 |
| `frontier` | 2.0 | 2.5 | 3.0 | 3.5 |

A model reserves the row of its cost tier. No model uses `minimal` unless
`modelTiers` maps it there; a model without a cost tier uses `frontier`.
Efforts `none` and `minimal` use the `low` column and `max` uses `xhigh`.
The values are starting heuristics, not measured token costs: compare them
with how much your usage really moves per worker and adjust. A 5-hour session
is a far smaller window than a week, so the same work takes a larger share of
it; an override can say so:

```json
{
  "reservations": {
    "buffers": { "frontier": { "xhigh": 4 } },
    "overrides": [
      { "agent": "claude", "pool": "session", "scale": 3 },
      { "agent": "claude", "plan": "max_20x", "scale": 0.5 }
    ],
    "modelTiers": { "claude-haiku-5-5": "minimal" }
  }
}
```

::: info Removed keys
`thresholds`, `usageRiskLimit`, `handoutMinutes` and `handoutPercent`
belonged to the usage projection and the flat hand-out buffer. They are ignored
with a warning; `riskThresholds` and `reservations` take their place.
:::

### Effort

| Key | Default | Purpose |
| --- | --- | --- |
| `defaultEffort` | `{ "light": "low", "daily": "medium", "advanced": "medium", "frontier": "high" }` | Effort per requested tier when a route has neither `--demand` nor `--effort` |
| `effortPolicy` | `"balanced"` | How `--demand` maps to effort, as below |

`effortPolicy` maps each [effort demand](effort.md#effort-demand) to an effort:

| Policy | low | moderate | high | exceptional |
| --- | --- | --- | --- | --- |
| `efficient` | low | low | medium | high |
| `balanced` | low | medium | high | xhigh |
| `quality` | low | medium | xhigh | xhigh |

No demand maps to `max`; it takes an explicit `--effort max`. Efforts are
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the config requires
the spelling `xhigh` (the `--effort` flag also accepts `extra-high`).

### Metadata and memory

| Key | Default | Purpose |
| --- | --- | --- |
| `costBands` | `[1, 5, 12]` | USD per million blended tokens: Light below 1, Daily below 5, Advanced below 12, Frontier at or above 12; blend `(3 × input + output) / 4` |
| `evidenceTtlHours` | `24` | Manifest check interval |
| `placementsTtlHours` | `5` | Placement cache lifetime; `0` rebuilds on every command. Changed snapshot or placement settings rebuild it, and `refresh` forces a rebuild |
| `rejectionTtlHours` | `168` | How long a model an agent refused at launch (found by `verify`) is skipped |

## Example

A hand-written config (illustrative):

```json
{
  "denyAgents": ["grok"],
  "pins": { "daily": { "agent": "codex" } },
  "preferRiskLimit": 95,
  "banModels": ["claude-haiku"],
  "tierOverrides": { "gemma4:12b": "light" },
  "effortPolicy": "quality"
}
```

This config:

- excludes Grok Build and all Haiku models;
- prefers Codex for everyday jobs while its usage, with reserved workers and
  one more, stays below 95% on every quota it draws on;
- treats a local Gemma model as Light;
- gives high as well as exceptional demand `xhigh`.

::: details The shipped config.example.json
[`config.example.json`](https://github.com/manomilano/orca-compass/blob/main/config.example.json)
shows a typical setup rather than the defaults. It limits routing to Claude,
Codex and Cursor (`allowAgents`), pins Claude Sonnet for Daily and adds one tier
override (treating `grok-4.7` as Advanced cost without changing its evidence).
Remove the agent restriction, pin and override to keep automatic selection. The
other keys it lists are at their defaults, and keys it omits (`effortPolicy`,
`placementsTtlHours`, `rejectionTtlHours`, `lastResortAgents`) keep theirs.
:::

## Data sources

Commands that gather a routing environment read usage and Orca's agent switches
each time: `route`, `status`, `agents` (the list) and `setup`. Setting a
preference with `prefer <tier> <agent> [model]`, listing or adding bans with
`ban`, and removing bans with `unban` also gather it, to check or display
entries against discovered models. `tiers`, `ranking` and `refresh` do not read
usage. Agent selection edits, the bare `prefer` listing, `prefer clear`,
`prefer --risk-limit`, `rejected` and the installer commands do not gather it.

Metadata and model listings are read when the placement table is built (see
`placementsTtlHours`).

| Source | Used for | How |
| --- | --- | --- |
| `orca account list --json` | Usage and limits per agent | Run whenever the routing environment is gathered, 20 s timeout |
| Orca's model catalog, then the Claude Code (`CLAUDE_CONFIG_DIR`) or Codex (`CODEX_HOME`) local catalog, then the evidence snapshot | Claude and Codex models and effort options | Read at table build; fallback effort levels are assumed |
| Evidence snapshot and manifest | Catalog and benchmark profiles | Cache, repository manifest and snapshot, then bundled fallback; never older than the bundled snapshot |
| `cursor-agent models` | Cursor model variants and `NO ZDR` labels | At table build, 30 s, saved copy on failure |
| `$GROK_HOME/models_cache.json` (default `~/.grok`), then `grok models` | Grok Build models, efforts, default | At table build: file, then live (30 s, saved copy on failure) |
| `agy models` | Antigravity models (`id<TAB>label`) | At table build, 30 s, saved copy on failure |
| `opencode models` | OpenCode models (`provider/model`) | At table build, 30 s, saved copy on failure |
| OrcaCompass's built-in Muse list | Muse models (neither Muse nor Orca lists them) | At table build, when `muse` is on PATH |
| Orca's profile state (`profile-state.db` or `orca-data.json`), read-only | Which agents you enabled in Orca (`settings.disabledTuiAgents`) | Experimental; anything unexpected is `unknown` |
| `orca orchestration worker-show` / `worker-read` | `verify` only | Read-only |

## Privacy

OrcaCompass fetches the public evidence manifest and snapshot from this
repository on GitHub without an API key. The optional `--tier-reason` is
returned in command output and is not sent in these requests. Discovery reads
machine metadata. Usage and configuration stay local. OrcaCompass collects no
telemetry and calls no AI model. Background discovery commands run with stdin
closed and bounded timeouts. Install, update and uninstall attach their
interactive steps to your terminal. On Windows, OrcaCompass disables telemetry
in the `skills` child processes to avoid their shutdown crash. The agent CLIs,
npm, the Skill installer and Orca have their own network and privacy behavior.

::: warning Sanitize diagnostics before sharing
`status --json` and `agents --json` include local paths and usage details.
:::
