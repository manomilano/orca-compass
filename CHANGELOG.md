# Changelog

## 0.2.6

- **Routing is quota first, and no longer forecasts usage.** The headroom
  projection (pace, expected use at reset, the seven-day urgency discount) is
  removed. A route is ranked by the effective capacity left in its most
  restrictive quota bucket; inside a bucket the most economical eligible route
  wins. `headroom` and `risk` are gone from the JSON; `quota` and `buckets`
  report reported, reserved, effective and prospective usage per bucket.
- **Per-quota worker reservations replace the flat hand-out buffer.** Each
  routed worker reserves percentage points on every window its model is
  declared to draw on (recording account and plan), by cost tier and effort
  (`reservations.buffers`, `reservations.modelTiers`, and per-provider, plan
  and window `reservations.overrides` with `scale` bounded to `0`–`100`). The
  reserved total is rebuilt from the worker records on every usage snapshot and
  never accumulates. Records live in `reservations.json` (version 2; version 1
  files are read and rewritten) under an owner-tracked lock that takes over
  immediately from an exited holder and respects a live owner for 30 seconds.
  New: `orcacompass release`, `verify --reservation`, `route --dry-run`.
- **`route` fails closed when quota cannot be reserved.** If the reservation
  ledger cannot be locked, read or written, `route` prints nothing on stdout,
  exits 1 and says `quota could not be reserved (…): nothing was routed`.
  `--dry-run` is the explicit unreserved path and warns when the ledger could
  not be written. An unreadable ledger file is kept as
  `reservations.json.corrupt` and rebuilt with the workers Orca reports live;
  `route` and `status` warn.
- **Reservations are released window by window.** A finished worker stops
  counting on a window once a reading with a valid percentage was taken at
  least `settleSeconds` after the worker ended and after the snapshot it was
  allocated on (`settled` lists them); a window without a valid percentage
  never settles a worker, and `settleSeconds: 0` no longer releases on the
  allocation snapshot itself. Claude windows carried forward by Orca's live
  session (`fableWeekly`, `monthly`) settle when their value changes or once a
  healthy snapshot is 20 minutes past the end. On Antigravity, a concrete
  window settled under its own name is no longer charged through its group key
  while other windows of that group wait to settle.
- **Timeout-inferred reservation ends and live-worker protection.** A worker
  Orca confirms live is never closed after `maxRunningHours`. Reservations
  abandoned after `pendingMinutes` or closed after `maxRunningHours` carry
  `inferred: true`, and later positive proof overrides them cleanly: Orca's
  live worker list or a late `verify` revives the record back to `running`,
  and an explicit `release` (including `--outcome failed-before-launch`)
  replaces the inferred end. Live records reserved before Orca reported a plan
  follow their account to the plan it discloses later without crossing
  accounts. Finished records are kept seven days from `endedAt` instead of
  `createdAt`, and one Dispatch counts once.
- **Risk thresholds and `preferRiskLimit` 100% ceiling.** Prospective usage
  below 85% is available, 85% to below 90% is caution (used only when nothing
  is available), and 90% and above is never routed automatically
  (`riskThresholds`). `preferRiskLimit` applies to prospective usage (default
  90), warns on config load when above `riskThresholds.highPercent`, and caps
  automatic preference allocation at 100% (`min(preferRiskLimit, 100)`):
  values above 100 remain accepted in `config.json` for compatibility, but a
  preference is never automatically allocated onto a fully `reserved` quota
  and hands back `WAIT`/`USE` instead.
- **The decision comes back instead of a silent fallback.** When no eligible
  route is below the threshold, `route` returns `status: "decide"` with
  `options.wait`, `options.use` and `options.lower`; `route --use <agent>/<model>`
  takes one. `status: "wait"`, `waitUntil` and automatic downgrades are gone;
  `--no-downgrade` is accepted and ignored with a warning. Cursor `auto` is
  offered under `options.lower` and never routed on its own.
- **Last-resort `decide` handoff.** When only last-resort agents are usable
  and cannot take the job automatically (high risk or lower requirements),
  `route` returns `status: "decide"` with `lastResort: true` options and a
  warning instead of `none`. When a safe last-resort option is appended to
  `options.use` alongside elevated-risk routes, its `USE:` line is also
  included in text `reasons`.
- **Effort as an eligibility test, plus preferred and `--use` effort variants.**
  A model must offer the demanded effort or the next higher one instead of
  losing points per step (a tier default still takes the nearest offered
  effort). `--demand` gives each demand its own effort under `balanced`
  (`exceptional` now maps to `xhigh`; `quality` maps `high` and `exceptional`
  to `xhigh`; route reasons say `effort demand`). Both `--use` and `prefer`
  naming an effort-variant id (e.g. `cursor/claude-sonnet-5-5-high`,
  `prefer daily cursor claude-sonnet-5-5-high`) launch and reserve that
  variant's encoded effort (conflicting preferences warn and fall back to the
  model at the planned effort). A model whose effort cannot be set and whose
  reported default is `none` or `minimal` no longer satisfies a higher demand.
- **Preferred unranked models and older releases.** Missing benchmark data on
  a manually preferred or `--use` model is reported as unknown coverage
  (`coverageNote`) rather than a downgrade or skip, while unranked models stay
  out of automatic routing. A preference or `--use` naming an older release in
  the same family and cost tier routes it while automatic routing still sees
  only the newest release. A preference held back only by `preferRiskLimit`
  that automatic routing never offers (unranked, older release, or effort
  variant) comes back as `decide` with `WAIT` and the preference first under
  `options.use` (`preferred: true`).
- **Usage accuracy, account identity and failed-fetch stand-ins.** A valid 0%
  is fully available; a missing reset time (`resetsAt` `0` or `null`) is kept
  as no reset time rather than skipped; a missing percentage stays unknown,
  never 0. Usage identity follows the account Orca read (including WSL), and
  an older reading never overwrites or deletes a newer snapshot. When Orca
  cannot be read or a single provider's refresh fails (even with no windows
  left) for the same account, the stored snapshot stands in as `retained`
  (medium confidence; known 100% still blocks, settles nothing, shown in
  `status` as `usage retained (<error>), updated …`), whereas `unavailable`
  (signed out) or a newer reading for another account clears it. One agent's
  malformed usage no longer makes every agent unreachable, snapshots without a
  time count as stale, and missing windows keep their last reading until they
  age out. Once Antigravity reports quota groups, obsolete ungrouped
  `session`/`weekly` snapshots are dropped; Antigravity windows of other
  lengths stay separate from 5h/weekly and bucket names are normalized.
  Claude's `monthly` spend window is read and declared; `rateLimits.opencodeGo`
  is ignored for now; selection reasons name windows that could not be read.
- **`status`, `setup`, `verify` and `release` updates.** `status --json`
  `reservations[].buckets` lists the actual reported windows each reservation
  draws on (including dynamic Antigravity group windows such as 1-day, with no
  unreported fallback windows), holding 0 points for inactive or settled
  windows. Explicitly preferred routes stay visible in `status` and `setup`
  even when `upgraded: true` (automatic structural upgrades stay hidden on the
  cheaper tier). The `status` decision line distinguishes routes held only by
  `preferRiskLimit` or last-resort agents from routes above the risk
  threshold. `verify` with an `unknown` verdict (such as `--wait 0`) binds the
  Dispatch while leaving the reservation `pending`; a reservation already
  bound to one Dispatch is never moved to another (`reservationError` in
  `verify`, exit 1 in `release`).
- **Gemini lines, Antigravity `-xhigh` and placements schema 5.** Each Gemini
  line is its own family (`Gemini 4 Neon`, `Carbon`, `Argon`, `Hydrogen`), and
  a new Gemini release with no evidence yet inherits scores and cost tier from
  its line's previous release (`assumed`). Antigravity `-xhigh` model ids are
  grouped with their base model as `xhigh`, and Claude/GPT models in
  Antigravity take their efforts from Orca's model catalog when listed.
  Placement table schema 5 rebuilds automatically on first run.
- Removed config keys, ignored with a warning: `thresholds`,
  `usageRiskLimit`, `handoutMinutes`, `handoutPercent`.
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
