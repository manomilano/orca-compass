# Changelog

## Unreleased

- Each Gemini line is its own family (Gemini 4 Neon, Carbon, Argon and
  Hydrogen). Before, all Gemini models shared one family, so the newest one in
  a cost tier hid the others: Gemini 4 Hydrogen hid the stronger Carbon and
  Argon. This takes effect from the evidence snapshot, without an update.
- A new Gemini release that has no evidence yet takes the scores and cost tier
  of the previous release of its line, labelled `assumed`, as new Claude and
  GPT releases already did: Gemini 5 Neon replaces Gemini 4 Neon on the day it
  appears.
- `--demand` gives each effort demand its own effort under the default
  `balanced` policy: `exceptional` now maps to `xhigh` (was `high`). `quality`
  maps `high` and `exceptional` to `xhigh`; `efficient` is unchanged. A model
  without `xhigh` still snaps to its nearest lower effort. Route reasons say
  `effort demand` (was `reasoning demand`), so it is not confused with the
  reasoning need.
- Antigravity's `-xhigh` model ids (Gemini 4 Neon and Hydrogen) are grouped
  with their model as its `xhigh` effort instead of being listed as unknown
  models that were never routed. Claude and GPT models in Antigravity take
  their efforts from Orca's model catalog when it lists them. Placement table
  schema 5 is rebuilt on first run, so a table cached before this change does
  not keep the old grouping until it expires.
- **Routing is quota first, and no longer forecasts usage.** The headroom
  projection (pace, expected use at reset, the seven-day urgency discount) is
  removed. A route is ranked by the capacity left in its most restrictive
  quota bucket; inside a bucket the most economical eligible route wins.
  `headroom` and `risk` are gone from the JSON; `quota` and `buckets` report
  reported, reserved, effective and prospective usage per bucket.
- **A valid 0% is fully available.** Unused windows are no longer penalized,
  and a window with no reset time yet (`resetsAt` `0` or `null`) is no longer
  skipped as expired. A missing percentage is unknown, never 0.
- **Per-quota worker reservations replace the flat hand-out buffer.** Each
  routed worker reserves percentage points on every quota bucket it draws on,
  by cost tier and effort (`reservations.buffers`, with per-provider, plan and
  window overrides). The reserved total is rebuilt from the worker records on
  every usage snapshot and never accumulates. Finished workers are reconciled
  only by a fresh Orca snapshot, told apart by its timestamp. Records live in
  `reservations.json`, updated under a lock, so parallel route calls cannot
  overbook a quota. New: `orcacompass release`, `verify --reservation`,
  `route --dry-run`.
- **Risk thresholds.** Prospective usage below 85% is available, 85% to below
  90% is caution (used only when nothing is available), 90% and above is never
  routed automatically (`riskThresholds`). `preferRiskLimit` now applies to
  prospective usage and defaults to 90.
- **The decision comes back instead of a silent fallback.** When no eligible
  route is below the threshold the result is `decide`, with `options.wait`,
  `options.use` and `options.lower`; `route --use <agent>/<model>` takes one.
  `status: "wait"`, `waitUntil` and automatic downgrades are gone;
  `--no-downgrade` is accepted and ignored. Cursor `auto` is offered as an
  option and no longer routed on its own.
- **Effort is an eligibility test, not a penalty.** A model must offer the
  demanded effort or the next higher one; a model that tops out below it is
  left out instead of losing 2.5 points per step. A tier default still takes
  the nearest offered effort.
- Removed config keys, ignored with a warning: `thresholds`,
  `usageRiskLimit`, `handoutMinutes`, `handoutPercent`.
- When Orca cannot be read, the last valid usage snapshot stands in at medium
  confidence instead of all usage becoming unknown.
- **A preferred unranked model is not downgraded.** Missing benchmark data is
  unknown coverage, not a shortfall: the route is not marked `downgraded`, the
  model is not listed under `skipped`, and the reasons say `Manually preferred
  model; benchmark data unavailable. Task coverage could not be verified.`
  The same reason is in the new `coverageNote` field, under the tier in
  `status` and `setup`, and on a `--use` of that model (a `--use` of another
  unranked model gets a matching `Explicitly chosen model (--use)` reason).
  Unranked models stay out of automatic routing. `status` lists them as
  `unclassified (not routed automatically)` and marks a preferred one.
- A preference held back only by `preferRiskLimit` that automatic routing
  never offers (an unranked model, or an older release) comes back as
  `decide`, with WAIT and the preference as the first USE option
  (`preferred: true`), instead of `none`.
- A preference or `--use` naming an older release in the same family and cost
  tier as a newer one routes it, instead of reporting it as not available.
  Automatic routing still sees only the newest release.
- **`route` fails closed when quota cannot be reserved.** If the reservation
  ledger cannot be locked, read or written, `route` prints nothing on stdout,
  exits 1 and says `quota could not be reserved (…): nothing was routed`.
  Before, it printed the route with `status: "ok"` and only a warning, so a
  worker could be launched unreserved. `--dry-run` is the explicit unreserved
  path and warns when the ledger could not be written. A ledger file that is
  not valid is kept as `reservations.json.corrupt` and rebuilt, with the
  workers Orca reports live reconstructed; `route` and `status` say so.
- The ledger lock records its owner. A lock left by a process that has exited
  is taken over at once; a live owner is respected for 30 seconds; a holder
  whose lock was taken over writes nothing and removes nothing.
- An older usage reading no longer overwrites a newer one in the ledger, and a
  window missing from one refresh keeps its last reading until it ages out.
  The ledger is now version 2; version 1 files are read and rewritten.
- **Reservations are released window by window.** A finished worker stops
  counting on a window only once that window was re-read after the worker
  ended and after the snapshot it was allocated on (`settled` lists them);
  `settleSeconds: 0` no longer releases on the allocation snapshot itself.
  Claude windows that Orca's live session carries forward (`fableWeekly`,
  `monthly`) count as re-read when their value changed, or once a healthy
  snapshot is 20 minutes past the end.
- A reservation records every window its model is declared to draw on, plus
  the account and plan, so a window missing at allocation (a Claude
  `session` between windows) counts the worker once it is reported again.
- Usage identity follows the account Orca read, including WSL accounts.
  Switching or signing out of an account drops the previous account's stored
  snapshot, so its numbers never stand in for another account.
- Claude's `monthly` spend window is read and declared: a monthly-only account
  at 100% gets `decide` instead of an unknown route. Antigravity windows of
  other lengths stay apart from the 5-hour and weekly ones, and bucket names
  are normalized. Orca's `rateLimits.opencodeGo` is ignored for now.
- `verify` with an `unknown` verdict (for example `--wait 0`) binds the
  Dispatch but leaves the reservation `pending` instead of marking it running.
  A reservation bound to one Dispatch is never moved to another: `verify`
  reports it as `reservationError` and `release` exits 1, changing nothing.
- A worker Orca confirms is still live is no longer closed after
  `maxRunningHours`. Finished records are kept seven days from `endedAt`
  instead of `createdAt`, and one Dispatch counts once.
- One agent's malformed usage no longer makes every agent unreachable. Windows
  Orca kept after a failed refresh are `retained` (medium confidence at most),
  and `status` shows `usage retained (<error>), updated 12m ago`. A snapshot
  without a time is treated as stale.
- `status` holds no points for a record that no longer counts or for a
  settled window, and uses the plan each record was reserved on.
- `--use` with an effort variant (`cursor/claude-sonnet-5-5-high`) launches
  that variant and reserves its effort. A model whose effort cannot be set and
  whose reported default is `none` or `minimal` no longer counts as meeting a
  higher demand. The selection reason names windows that could not be read.
- `reservations.overrides[].scale` must be between 0 and 100, and a warning
  says when `preferRiskLimit` is above `riskThresholds.highPercent`.
- `npm run build` cleans `dist` first, so deleted modules no longer ship.

## 0.2.5

- Added the OrcaCompass website with a landing page, user guide, examples,
  contributing, changelog and community pages, a custom theme, and site
  verification in CI. Publication remains a manual maintainer action.
- Routing compares every route that covers the job across all cost tiers.
  Among unblocked routes with known usage, the score is the reset-adjusted
  headroom in percentage points minus a price adjustment of
  `5 × p / (p + 4)` points for a blended price of `p` USD per million tokens
  (at most five points), and the highest score wins. Before, the cheapest
  covering cost tier was used first and a pricier tier only when the cheaper
  one was blocked or strained.
- A usage window blocks its routes only when Orca reports it as 100% used.
  `thresholds.longPercent` and `thresholds.sessionPercent` (95 and 90) are now
  warning levels: a pick at or above them carries the warning
  `<window> quota is N% used; resets in …`. Recent hand-outs lower headroom
  but no longer block a window.
- `usageRiskLimit` only adds the warning `selected route is expected to end
  above N% of its usage window` to the pick; it no longer changes which route
  is picked. The warnings `cheaper <tier> cost tier passed over …` and `every
  unblocked route that covers the job is expected to end above …` are gone.
- `upgraded` is `true` only when no route at or below the requested tier
  covers the job. A pricier route picked for its headroom is an ordinary pick.
- With `--effort`, a covering route from any cost tier that can apply the
  effort is used; the result is `none` only when no covering route can.
- Route reasons show `covering routes: N across all cost tiers` in place of
  `fit group: …`, a `selection: …` line with the pick's score, and the price
  of the `next best` route. `alternatives` can span cost tiers.
- `status --json` adds `reportedUsedPercent` to a usage pool whose
  `usedPercent` includes recent hand-outs.
- The message shown when this Node.js cannot read Orca's databases now names
  Node 22.13, the first release where `node:sqlite` works without a flag (it
  said 22.5).

## 0.2.4

- Upgrading no longer keeps older evidence (and its need cuts) for up to
  `evidenceTtlHours`. The evidence loader never uses a snapshot older than the
  one bundled with the installed release: a fresh cache older than it is
  checked against the repository at once, and the bundled snapshot wins when
  the repository is unreachable or lags the release. The bundled snapshot is
  dated from its small manifest, so a fresh cache costs no extra parse.
  `status` and `route` warn if the evidence in use is still older than the
  bundled snapshot.

## 0.2.3

- Lowered the `low` need cuts to coding 60, agentic 35 and reasoning 70 (from
  70, 60 and 76), so simple jobs can go to the good small models, and the
  `mid` cuts to coding 75, agentic 70 and reasoning 80 (from 78, 72 and 84).
  The `high` reasoning cut is 86 (from 89); the other `high` cuts are
  unchanged. The cuts travel with the evidence snapshot, so 0.2.2
  picks them up on its next refresh.
- A route expected to end its usage window above the new `usageRiskLimit`
  (default 90%) is strained. When every covering route in the cheapest cost
  tier is blocked or strained, routing moves to the cheapest pricier tier that
  has a route with known usage below the limit, and warns. When every covering
  route is strained, the one with the most room in the cheapest tier that is
  not fully blocked is used, with a warning, so the job keeps its level. Before,
  the cheapest tier was kept until it was fully blocked, and then the job was
  downgraded even if a pricier covering route still had room.
- Evidence refreshed from LLMBenchmark's 2026-11-15 dataset: Gemini 4 Hydrogen
  and four other models added, Muse Wonder now has agentic and reasoning
  scores, and about 900 more benchmark results.
- New need level `top`, above `high`: coding 87, agentic 82, reasoning 90.
  Pass it with `--need` (there is no tier for it), for the rare job where
  `high` is not enough; the Skill says when. Its cuts are a separate
  `topBands` field in the evidence snapshot, so 0.2.2 keeps reading the
  snapshot.
- The Skill defines every level of each skill (coding: implementation
  difficulty; agentic: autonomy and adaptive execution; reasoning: cognitive
  problem-solving difficulty), so the orchestrator rates jobs more
  consistently.
- Of two routes with the same headroom that both cover the job, the cheaper
  model now wins before the higher score. Routes on one agent share its usage
  pools, so a covering GPT-6.1 Terra is chosen before GPT-6.1 Sol. A model that
  falls short never wins on price.
- Curated models can name a `fallback` model whose score stands in on axes
  they have no evidence for, labelled `assumed`. Composer 2.5 takes its
  agentic score from Kimi K2.5.
- `verify` no longer reports `stalled` for an agent that is idle because the
  task never reached its terminal. It keeps waiting for the prompt, and if it
  never arrives returns `unknown` with `unsent: true` and tells the
  coordinator not to reroute.
- Added `orcacompass --version` (also `-v` and `version`).
- Claude Code's and Codex's model lists now come first from Orca's model
  catalog: the models Orca's model picker offers, with the efforts and default
  effort Orca allows for each. Their own caches come second. Orca saves no
  other agent's list there, so the others keep their own sources. Orca moved
  that catalog from `agent-model-catalog.json` to `agent-model-catalog.db`,
  which 0.2.2 did not read; the JSON file is still read for older Orca
  versions. Reading the database needs `node:sqlite` (Node.js 22.13+ without
  flags); without it the agent's note says the catalog was skipped.
- Muse is routed from a built-in list (Muse Wonder, Muse Spark 1.1, Muse
  Ember, Muse Spark 1.3) with Orca's Muse efforts, `minimal` to `max`. Neither
  Muse nor Orca lists Muse models, so 0.2.2 only detected Muse.

## 0.2.2

- Replaced Model Index and Models.dev sources with a daily
  owner-refreshed evidence snapshot from [LLMBenchmark.ai](https://llmbenchmark.ai)
  (CC BY 4.0).
- Removed `scoreWeight` and `modelsDevTtlHours`; existing keys warn and are ignored.
  `scoreSource` remains for one release as an alias of `evidenceSource`.
- Added `--need`, `needs`, `needsSource`, `quality`, `evidenceSource`, `ranking`
  and `tiers --axis`; `--tier` remains supported.
- Recent hand-outs adjust pool usage. Cursor `auto` is now a fallback.
- Models get a cost tier from their maker price (LLMBenchmark pricing, blended
  3:1, `costBands`); routing takes the cheapest cost tier whose evidence covers
  the job, then the most headroom. `tiers` groups by cost; `ranking` shows
  capability evidence alongside cost. Scores are raw evidence; `classWeight`
  is removed and warns.
- Older generations are hidden only behind a newer release of the same cost
  tier; older models in another cost tier remain routable.
- Placement table schema 4 is rebuilt on first run; snapshot schema stays 1
  with optional pricing.
- The raw LLMBenchmark dataset is committed at `data/llmbenchmark/dataset.json`;
  the refresh script reads it from there (`--fetch` downloads a fresh copy) and the
  workflow rebuilds the snapshot when it changes.
