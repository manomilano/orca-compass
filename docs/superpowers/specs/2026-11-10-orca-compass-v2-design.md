# OrcaCompass V2: evidence-based model profiles and need-based, quota-aware routing

Status: design, agreed in conversation on 2026-11-09 and 2026-11-10. Revised on 2026-11-10:
a job now states a need on each of three axes instead of one kind of work and one tier.
Not yet planned or built.
Supersedes the stage-by-stage roadmap draft ("Orca Compass V2 - End-to-End Implementation Plan").

## 1. Intent

OrcaCompass recommends which agent, model and effort should run a job. Today a model's
tier comes from a fixed family table, a provider's one-line description, or a single
capability score blended with its output price. Nothing in that says how good a model is
at a *kind* of work, and price stands in for intelligence for every model outside the
family table.

V2 separates two questions that V1 mixes:

1. **How good is each model at coding, at agentic work, and at reasoning?** Answered
   from published benchmark evidence, never from price or quota. The result is a
   **profile** per model: three scores, one per axis, each with the evidence behind it
   and a band (Light, Daily, Advanced or Frontier) on that axis.
2. **Which model should take this job right now?** Every job needs all three
   abilities, in different amounts. The coordinator rates the job's **need on each
   axis**; the router takes the models whose profile covers all three needs, prefers
   the lowest class among them (no token waste), and inside that class orders by the
   user's subscription usage and pace, favorites and bans.

The owner's words for the rules: the family table and the provider's description
"provide a hint to the calculation and not a full veto"; "it's normal that Fable 5.1 is
not on top, since Opus 5.5 is a later version, which is superior in coding"; "the job
will always be code, agentic and reasoning ... rank from low mid high the need of each".

## 2. Goals

- Score every discoverable model on three axes (coding, agentic, reasoning) from
  benchmark evidence, with the family table and provider descriptions as a small nudge.
- Place a brand-new model on day one from its family and the vendor's own numbers, and
  improve the placement automatically as independent results arrive, with no npm release.
- Route to the lowest class of model that covers the job's three needs, then by quota,
  pace, favorites and bans, as today. Never spend a Frontier model on work a Daily model
  covers.
- Stop handing the same nearly-drained pool to several workers launched in the same
  minutes.
- Keep every existing command, config key and `route --json` field working, with new
  fields added beside them. `--tier` keeps working as a shorthand.
- Keep the whole thing key-free and offline-capable: users fetch one small data file
  from the repository, with a bundled fallback. That file is also the model catalog;
  the Models.dev download goes away.

## 3. Non-goals

- Rewriting Orca's orchestrator, workers, worktrees or launch commands.
- Changing the four band names (Light, Daily, Advanced, Frontier) or the meaning of
  `--effort` and `--demand`.
- Running V1 and V2 side by side (shadow mode, feature flag). V2 replaces V1 in release
  0.3.0.
- Importance weights over the axes ("70% coding, 20% agentic, 10% reasoning"). A job
  states what it *needs* on each axis, not how much each axis matters. A weighted sum
  appears only as a tie-break (7.6).
- Cost per solved task, Epoch AI as a separate source, BenchLM as a source (its data is
  CC BY-NC 4.0 and its terms forbid building a product on it without a license).
- Inventing precise scores for models with no evidence.

## 4. Anti-goals (a failure even if it works)

- Price per token influencing where a model ranks.
- A model being sent work above its profile only because its quota is unused.
- A Frontier-class model taking a job a lower class covers, only because its quota is
  unused (token waste).
- Sonnet 5.5 ranking above Fable 5.1 on any axis. (Opus 5.5 above Fable 5.1 on coding
  is correct and expected.)
- Redistributing data whose license does not allow it, or losing the attribution the
  license requires.
- A new flagship model needing a new npm release before it can be routed.

## 5. Constraints

- The project is Apache 2.0 and public. Bundled data must allow commercial
  redistribution with attribution. LLMBenchmark.ai's data is CC BY 4.0 (credit
  "LLMBenchmark.ai" with a link to https://llmbenchmark.ai); its own wording adds that
  "source boards keep their own terms". The owner's decision (2026-11-10): treat
  LLMBenchmark's CC BY 4.0 as sufficient for everything in its dataset; no per-board
  check, and every row LLMBenchmark publishes may be used. Each row keeps its source URL
  and date, as LLMBenchmark asks. Models.dev is no longer used (7.2).
- No API keys for users. LLMBenchmark's full dataset is a free download
  (https://llmbenchmark.ai/data/dataset.json, about 21 MB, rebuilt daily); its REST API
  is limited to 500 requests per IP per day and returns only top-10 lists for the
  computed indexes, so it is not used at runtime. Clients never contact LLMBenchmark
  at all. The owner's decision (2026-11-11): the raw dataset is committed unchanged at
  `data/llmbenchmark/dataset.json`, updated by the owner's automation; the refresh
  script reads it from there (`--fetch` downloads a fresh copy into place) and the
  trimmed result is committed next to it (7.3). The raw file never ships in the npm
  package.
- The computed Coding / Agentic / Reasoning indexes are **not** in the download. They
  are recomputed from the raw rows with the weights and ranges LLMBenchmark publishes
  on https://llmbenchmark.ai/methodology (copied in section 7.3).
- Node.js and TypeScript as today; tests with Vitest; CI on Ubuntu, Windows and macOS.
- Routing stays a pure function of (environment, request, config): no I/O inside it,
  deterministic for identical inputs.

## 6. Decisions made by the owner

| Decision | Choice |
| --- | --- |
| Evidence source | LLMBenchmark.ai full dataset, for its CC BY 4.0 license and daily refresh. Its license is treated as covering every row it publishes; no per-board license check |
| Model catalog | Models.dev is dropped. Names, providers, families and release dates come from the evidence snapshot's model list; effort lists come from the agents' own catalogs with the existing assumed fallback |
| Refresh | Daily, run by the owner's own automation: it runs the repository's refresh script and opens the PR. The trimmed snapshot lands in the repository, never the raw dataset. Switching provider later is one adapter in the script |
| Who decides a band | Benchmarks. The family table and provider descriptions only nudge |
| Price in capability | Never |
| Axes | Three: coding, agentic, reasoning. Every job has all three; the coordinator rates the need of each (`min`, `low`, `mid`, `high`) on every call |
| Job tier | Replaced by the three needs. `--tier` stays as a shorthand for the same need on all three axes |
| Adequate, not best | The job goes to the lowest class of model that covers all three needs; a higher class is used only when that class is blocked or absent |
| Newer beats bigger | A newer release of a smaller model may outrank an older flagship (Opus 5.5 over Fable 5.1 on coding) |
| Lower class stays lower | Sonnet 5.5 must not rank above Fable 5.1 |
| New models | Route immediately once an estimate exists; no hold for verification |
| Parallel workers | Keep a short-lived local record of routes just handed out |
| Naming | "Reasoning" is an axis only. The thinking a job needs is "effort demand" |
| Cursor pools | The whole Grok family, Composer and Auto draw on "Cursor Models"; everything else on "Other Models" |
| Cursor `auto` | Not a model (owner's note, 2026-11-10). It gets no profile, is never ranked and never covers a need. It stays only as a fallback for when no named Cursor model can be given (7.6) |
| Release | One release (0.3.0) replaces V1; no side-by-side mode |
| Order of work | Step 1 local models, Step 2 profiles, Step 3 decision, Step 4 maintenance |

## 7. Design

### 7.1 The four steps

```
Step 1  Discovery            agents' model lists  ->  routes (agent + model + efforts + pools)
Step 2  Evidence + profiles  snapshot + hints      ->  profile per model (score, band, evidence per axis; class)
Step 3  Decision             profiles + needs + usage + config  ->  route, alternatives, reasons
Step 4  Maintenance          CI refresh -> snapshot on main -> clients fetch when it changed
```

### 7.2 Step 1: discovery and identity

Discovery for the seven agents stays as it is (`src/placements/agents/*`). V2 adds a
clear split between a **model** and a **route**:

- `modelId`: the canonical model, today's normalized Models.dev id
  (`claude-opus-5-5`). One per model, shared across agents.
- A route: one agent's way of launching that model, with its own efforts, launch form
  (`--model` flag or effort variants) and usage pools. Today's `LaunchModel` is the
  route.

Profiles are keyed by `modelId`. Matching a snapshot entry to a `modelId` uses the
existing normalization (`normalizeModelId`, `stripVersion`, dashless compare) plus an
`aliases` list in the snapshot for the few ids that still differ. LLMBenchmark's `slug`
(`claude-opus-5-5`) is already the normalized id, so most entries match directly.

**The snapshot is also the catalog.** V1 fetched Models.dev for a model's name,
`family`, `releaseDate` and effort list; its price field was written but never read
(the price in V1's scoring came from The Model Index). V2 fills `ModelMeta` (id,
provider, name, family, releaseDate) from the snapshot's `models` entries instead. The
refresh script derives `family` from the slug; `knownModelVersion` stays as the in-code
fallback for models missing from the snapshot. Effort lists for Claude Code and Codex
come from the agents' own catalog files, as today, and otherwise from the existing
`DEFAULT_EFFORTS` fallback marked `assumed`. Removed: `src/placements/sources/modelsdev.ts`,
`data/models-snapshot.json`, the `models` part of `scripts/make-snapshot.mjs`, the
`modelsDevTtlHours` key and the Models.dev entry in `NOTICE`.

Cursor pools (`src/placements/agents/cursor.ts`): a model is in `bucket:Cursor Models`
when its base id starts with `grok` or `composer`, is `auto`, or its variant id starts
with `cursor-`; otherwise `bucket:Other Models`. Today `grok-4.7-*` (no `cursor-`
prefix) lands in Other Models; that is the bug this fixes.

### 7.3 Step 2: evidence snapshot

**One file, built in CI, fetched by clients:** `data/evidence-snapshot.json`. It replaces
`data/modelindex-snapshot.json` and the Model Index source (`src/placements/sources/modelindex.ts`),
which are removed along with `scoreWeight` and the price term.

Contents (schema version 1):

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-10T04:00:00Z",
  "sources": [ { "id": "llmbenchmark", "label": "LLMBenchmark.ai", "url": "https://llmbenchmark.ai",
                 "license": "CC BY 4.0", "fetchedAt": "2026-11-10", "dataDate": "2026-11-09" } ],
  "benchmarks": { "tbench_4_0": { "name": "Terminal-Bench 4", "range": [0, 75], "source": "vals.ai" } },
  "axes": {
    "coding":    { "weights": { "tbench_4_0": 25, "vibe_code_bench": 20, "livebench_coding": 15, "swe_bench_vals": 15, "frontiercode": 15, "webdev_arena": 10 } },
    "agentic":   { "weights": { "tbench_4_0": 30, "livebench_long_agentic": 30, "livebench_browser": 20, "aa_agentic_index": 20 } },
    "reasoning": { "weights": { "gpqa_diamond": 30, "hle": 30, "livebench_reasoning": 20, "arc_agi_2": 20 } }
  },
  "bands": { "coding": [68, 76, 84], "agentic": [68, 76, 84], "reasoning": [68, 76, 84] },
  "models": [
    {
      "id": "claude-opus-5-5", "aliases": ["anthropic/claude-opus-5.5"], "provider": "anthropic",
      "name": "Claude Opus 5.5", "family": "claude-opus", "releasedAt": "2026-09-22",
      "results": [ { "benchmark": "tbench_4_0", "value": 64.85, "setting": "max", "kind": "measured", "source": "terminal-bench", "observedAt": "2026-11-09", "url": "https://..." } ],
      "scores": { "coding": { "score": 89.0, "benchmarks": 5, "kind": "measured" }, "agentic": { "...": "..." }, "reasoning": { "...": "..." } }
    }
  ]
}
```

- `results` holds only the rows that feed an axis (measured) plus vendor-reported rows
  that can bridge to an axis (see 7.5). Everything else in the 21 MB download is left
  out, so the snapshot stays in the hundreds of kilobytes.
- `kind` is `measured` (an independent board), `vendor` (the model's maker, from
  LLMBenchmark's `vendorReports`) or `reported` (a third party quoting a number for a
  model it does not make, such as Cursor's comparison figures for Opus 4.7). `vendor`
  and `reported` rows are treated alike in estimates and never feed a measured score.
- The maintainer may add a curated file `data/evidence-curated.json` in the same
  `results` shape for vendor claims LLMBenchmark does not carry; the build merges it.
  First entry: Composer 2.5, from Cursor's published comparison
  (Terminal-Bench 2.0 69.3 vs Opus 4.7 69.4 and GPT-5.5 82.7; SWE-bench Multilingual 79.8
  vs 80.5 and 77.8; CursorBench). Each curated row carries its source URL and date.

**Axis weights and ranges** are copied from LLMBenchmark's methodology page as read on
2026-11-09, so a score can be recomputed by hand:

| Axis | Benchmark | Weight | Rescaled from |
| --- | --- | --- | --- |
| coding | Terminal-Bench 4 (Vals AI) | 25% | 0–75% |
| coding | Vibe Code Bench (Vals AI) | 20% | 0–100% |
| coding | LiveBench coding | 15% | 0–100% |
| coding | SWE-bench Verified (Vals AI) | 15% | 0–100% |
| coding | FrontierCode | 15% | 0–65% |
| coding | LMArena WebDev | 10% | 1200–1900 Elo |
| agentic | Terminal-Bench 4 | 30% | 0–75% |
| agentic | LiveBench Long Agentic | 30% | 0–100% |
| agentic | LiveBench Browser | 20% | 0–100% |
| agentic | AA Agentic Index | 20% | 0–65 |
| reasoning | GPQA Diamond (Epoch) | 30% | 0–100% |
| reasoning | Humanity's Last Exam (AA) | 30% | 0–70% |
| reasoning | LiveBench Reasoning | 20% | 0–100% |
| reasoning | ARC-AGI-2 (Epoch) | 20% | 0–100% |

Rules, also LLMBenchmark's: rescale each result to 0–100 from its fixed range, clamp
outside the range; keep a model's best published run when a source lists several
settings; a missing benchmark is skipped, the weights of the benchmarks a model has are
scaled to add up to 100%; a model needs at least **two** benchmarks on an axis to get a
measured score. The builder copies these constants into code once and the refresh
script re-reads the methodology page only to warn when they change.

**The refresh:** `scripts/refresh-evidence.mjs` downloads the dataset, validates it
(schema, value bounds, duplicates, license field present for the source), computes the
scores, builds estimates (7.5), merges the curated file, writes the snapshot and prints a
profile diff against the previous snapshot. **The owner's own automation runs it
daily**; when the snapshot changed it pushes a branch and opens a pull request with
the diff in the body (branch protection requires the PR and the test matrix; enabling
auto-merge lets a green PR land without a manual step). A `workflow_dispatch` GitHub
Actions workflow wraps the same script for manual runs. The raw 21 MB dataset is never
committed (it would add about 7 GB of history a year); only the trimmed snapshot and the
manifest are. Switching or adding a provider later is one adapter in the script: the
snapshot shape and the clients do not change. `NOTICE` credits LLMBenchmark.ai under
CC BY 4.0 and drops The Model Index and Models.dev.

### 7.4 Step 2: model profiles

Built locally on each machine from the snapshot, the local discoveries, the hints and
the user's config, and cached in the placement table as today (`placements.json`,
schema version 3, rebuilt on the same triggers plus a changed snapshot).

For each axis *a* and each discovered model:

1. **Evidence score** `E_a`: the model's `scores[a].score` from the snapshot, or an
   estimate (7.5), or none.
2. **Class points** `C`: Light 25, Daily 50, Advanced 75, Frontier 100, from the first
   hint that applies, in this order: the user's `tierOverrides` (by id, then by family),
   the built-in `FAMILY_TIERS` and `MODEL_LINE_TIERS`, and only then the provider's
   lineup words (`lineupTier`). The family table precedes the lineup words because
   Claude Code describes Sonnet as "for complex work and everyday tasks" (which
   `lineupTier` reads as Advanced) and Haiku as "most efficient for simpler tasks"
   (Daily); taking those as class points would put Sonnet 5.5 above Fable 5.1. Hints are
   resolved per `modelId`: a lineup seen on any route of the model counts, and the
   description is still shown as a reason. No hint: no class points. The same `C`
   applies on all three axes.
3. **Final score** `S_a = (1 - w) * E_a + w * C` when both exist; `S_a = E_a` without a
   hint. `w` is `classWeight` in config, default **0.10**.
4. **Band** on the axis: `S_a` cut by the axis's `bands` from the snapshot (three cut
   points, Light below the first, Frontier at or above the last).
5. **Evidence label** (carried with the score everywhere): `measured` (3+ benchmarks),
   `partial` (2), `estimated` (vendor bridge, 7.5), `assumed` (family inheritance,
   7.5), `unranked` (no `E_a`).

The model's **class** is its highest band across the three axes: the most expensive
thing it is. The class is what the decision (7.6) uses to avoid token waste.

Worked example on the coding axis with the 2026-11-09 data and `w = 0.10`:

| Model | `E_coding` | Hint | `S_coding` | Band (bands 68/76/84) |
| --- | --- | --- | --- | --- |
| Claude Opus 5.5 | 89.0 | Advanced (75) | 87.6 | Frontier |
| GPT-6 Astra | 85.0 | Frontier (100) | 86.5 | Frontier |
| Claude Fable 5.1 | 84.2 | Frontier (100) | 85.8 | Frontier |
| Claude Sonnet 5.5 | 87.4 | Daily (50) | 83.7 | Advanced |
| GPT-6.1 Sol | 82.2 | Advanced (75) | 81.5 | Advanced |
| GPT-6.1 Terra | 77.5 | Daily (50) | 74.8 | Daily |
| Claude Haiku 5.5 | 70.9 | Light (25) | 66.3 | Light |

A user override still wins outright (as today): it sets the model's band on all three
axes, is reported as `override`, and also supplies the class points.

**Calibration checks** the refresh PR prints, so a reviewer sees them: Fable 5.1, GPT-6
Astra and Opus 5.5 are Frontier on coding; Fable 5.1 ranks above Sonnet 5.5 on every
axis; Haiku 5.5 is Light on coding; no model's band differs by more than one step
between axes without at least `partial` evidence on both. The checks use family
hints only (CI has no local agent catalogs). The cross-axis check **fails** the build
only for models that have a family hint (`FAMILY_TIERS` or `MODEL_LINE_TIERS`), the
models whose class the decision relies on; for every other model it is printed as a
warning (added 2026-11-10: on the first full build a dozen sparse third-party models
with an estimated reasoning score tripped it, and moving the bands to silence them
would have distorted the bands for the models that matter). `bands` are fixed values in the snapshot,
not re-derived by the script: when ordinary data drift trips a check, the refresh PR
fails and the maintainer adjusts `bands` (or, rarely, a curated row) in that same PR.
That is a data change on `main`, so it still needs no npm release; `classWeight` is a
code default and changes only in a release.

**Unranked** models (no evidence, no estimate on an axis) are listed by `ranking` but
never cover a need on that axis unless the user pins or overrides them. Cursor `auto`
is not a model and gets no profile at all: it is absent from `ranking`, covers no need,
and V1's "Auto serves Light and Daily, ahead of named Cursor models" rule
(`CURSOR_AUTO_TIERS`, `autoFirst`) is removed. Its only role is the fallback in 7.6.

### 7.5 Estimates for new and sparse models

Evidence improves in stages, and the profiles always use the best they have:

1. **Assumed (day 0).** The model's family and version are recognized
   (`knownModelVersion`, or the catalog family) and the model has a class hint. On each
   axis it takes the score of **the same vendor's best measured model whose class is at
   or below its own** (its own family's models count regardless of class), label
   `assumed`; the newest release wins ties within a family, as today. So Fable 5.2
   (Frontier) inherits from Opus 5.5 (Advanced, Anthropic's best measured coding model);
   Sonnet 5.6 (Daily) inherits from Sonnet 5.5, never from Opus; Haiku 5.6 (Light) from
   Haiku 5.5. A model with no class hint, or a vendor with no measured model at or below
   that class, is `unranked`.
2. **Estimated (days 1+).** The snapshot has vendor-reported rows for the model (or
   curated rows, 7.3). For each such row, find every other model that has a result on the
   same benchmark **and** a measured score on the target axis: measured rows are
   preferred; otherwise vendor-reported rows are compared only with vendor-reported (or
   `reported`) rows. Each pair gives a gap in rescaled points: for axis benchmarks the
   axis's range; for other shared benchmarks the benchmark must be a percentage and is
   rescaled 0–100 (Elo and other scales are skipped unless they have a range in
   `benchmarks`). Each pair yields a candidate value "reference's axis score + gap"; the
   estimate is the **median over all pairs**, and it needs at least two shared
   benchmarks, otherwise the stage-1 value stays. Label `estimated`, with the number of
   shared benchmarks. **Same publication first** (added 2026-11-10 after the first
   full-data build): a pair is formed only between rows with the same `source` (the
   same board or the same vendor comparison table, so both numbers come from one
   harness) whenever at least two shared benchmarks have such pairs; only when they do
   not is the pool widened to every reference row on the benchmark. Without this,
   Composer 2.5's two Cursor-table rows were compared with dozens of unrelated vendor
   numbers and landed 13 points under Opus 4.7, the model the table puts it level with. Vendor benchmark names are mapped to snapshot benchmark ids by a
   small bridge table in the refresh script (for example `frontierswe-v2` ->
   `epoch_frontierswe`), extended as new names appear. Composer 2.5 is the curated
   example: its rows compare with Opus 4.7 and GPT-5.5 on Terminal-Bench 2.0 and
   SWE-bench Multilingual (both percentages), and both reference models have measured
   coding scores, so it gets an `estimated` placement near Opus 4.7.
3. **Measured.** Independent results replace the estimate once two benchmarks exist on
   an axis.

**Worked example: Fable 5.2 (released 2026-11-07).** This is a real case, taken from
LLMBenchmark's dataset on the 9th and 10th; numbers are a recompute of the published
formulas and may differ from the site's by about a point.

| When | Rows in LLMBenchmark | Stage | Coding / Agentic / Reasoning | Bands |
| --- | --- | --- | --- | --- |
| First hours | none | assumed | inherits Fable 5.1: ~83 / ~81 / ~88 | Frontier on all three |
| Same day | 11 vendor rows (Anthropic's announcement) | estimated | ahead of Opus 5.5 on 8 of 10 shared benchmarks, so a few points above Opus 5.5's measured scores, label `estimated (10 benchmarks)` | Frontier on all three |
| 2026-11-10 (day 3) | 108 independent rows: LiveBench (all categories), Vals (Terminal-Bench 4, Vibe Code), Epoch (GPQA Diamond, ARC-AGI-2), CursorBench | measured | 87.3 (3 of 6, `partial`) / 85.4 (3 of 4) / 92.4 (3 of 4) | Frontier on all three |

For comparison on the same day: Opus 5.5 87.4 / 82.0 / 90.6, Fable 5.1 82.8 / 81.1 /
88.1, Sonnet 5.5 84.3 / 78.2 / 87.3. On coding the raw evidence is a tie with Opus 5.5
and the class hint settles it (Fable 5.2 ≈ 88.6, Opus 5.5 ≈ 86.2 with `classWeight`
0.10); on agentic and reasoning Fable 5.2 leads without the hint. Still missing on
coding are FrontierCode, LMArena WebDev and SWE-bench Verified, so the coding score
keeps the `partial` coverage label until they arrive.

What the orchestrator sees: Fable 5.2 is Frontier on every axis in every stage, so a
job with a `high` need can go to it from the first profile rebuild after it appears in
the agent's catalog. What changes over the days is the `evidence` label in the JSON and
whether Fable 5.2 wins the score tie-break against Opus 5.5 inside the Frontier class.
Lesson for the TTLs: the big boards (LiveBench, Vals, Epoch) published within three
days of release, so with the daily refresh (7.3) the estimated stage lasts a few days
at most for major models. `orcacompass refresh` must still be able to pull the snapshot
from the repository on demand.

### 7.6 Step 3: the decision

**The request.** `route` takes the job's need on each axis:

```text
orcacompass route --need coding=high,agentic=mid,reasoning=low ...
```

All three axes are required in `--need` (a missing axis is an error, not a default).
The four levels map onto the axis bands, so no new calibration is added:

| Need | Meaning | Cut on the axis |
| --- | --- | --- |
| `min` | the job barely touches this ability | none (any band, including Light) |
| `low` | ordinary use of it | at or above the Daily cut (`bands[0]`) |
| `mid` | real work on it | at or above the Advanced cut (`bands[1]`) |
| `high` | the hard part of the job is here | at or above the Frontier cut (`bands[2]`) |

`--tier <t>` stays as a shorthand for the same need on all three axes: `light` = `min`,
`daily` = `low`, `advanced` = `mid`, `frontier` = `high`. Old callers keep working and
`reasons` says the needs were derived from the tier. `--need` and `--tier` together is
an error. `--demand` (effort demand: how much thinking the worker spends) stays a
separate input and keeps its name.

**Adequacy.** A model **covers** the job when its `S_a` is at or above the cut on every
axis (an `unranked` axis never covers a need above `min`). The **shortfall** of a model
that does not cover is the sum, over axes, of band steps below the need; the
**overshoot** of one that does is the sum of band steps above the need.

**Candidate groups**, in order (this generalizes V1's "requested tier, then downgrade,
upgrade only when structurally empty"):

1. **Fit group**: the models that cover the job and belong to the **lowest class**
   (7.4) among all covering models. This is the token-waste guard: a Frontier-class
   model enters the fit group for a `low/low/low` job only when no Daily-class or
   Advanced-class model covers it.
2. **Downgrade groups**, used only when every route in the fit group is blocked by
   usage: the models that do not cover, by increasing shortfall (shortfall 1, then 2,
   ...), each group tried as V1 tries the next lower tier. `--no-downgrade` and `wait`
   behave as today.
3. **Higher classes** (covering models of a class above the fit group) are used only
   when the fit group has no route at all for the requested agents — the same
   structural rule as V1's upgrade. A blocked fit group never promotes to a higher
   class; it downgrades or waits.

**Order inside a group**: unblocked before blocked, then most headroom (pace-scaled, as
today), then hot session, confidence, **then stronger evidence**, **then higher
need-weighted score**, then non-fast, newest release, agent id, model id. The evidence
label of a model for the job is the weakest label among the axes rated `low` or above
(`min` axes do not count). The need-weighted score is `Σ k_a · S_a` with
`k = min 0, low 1, mid 2, high 3`: a weighted sum appears here only to break ties,
never to decide adequacy. These two replace today's "ladder vendor first" tie-break.

- `confidence` becomes a statement about usage only (`high` known and fresh, `medium`
  moderately stale, `low` unknown or very stale), as the Skill already explains it. The
  certainty of the placement is carried by `quality.evidence`, not by `confidence`.
- Price per token is not consulted anywhere. (V1 never read Models.dev's price either;
  its only price term was The Model Index's, now removed.) `lastResortAgents` ordering
  stays as today.
- Pins, bans, `preferRiskLimit`, rejections and Orca's agent switches are unchanged. A
  pinned model is used as today even when it does not cover the needs; `reasons` says so.

**Cursor `auto` as a fallback only.** `auto` is Cursor's own model picker, not a model,
so it never competes with named models. It is offered only when the route would
otherwise end in `wait` or `lastResortAgents` and Cursor is launchable and not blocked
on "Cursor Models": every named candidate in the fit group and the downgrade groups is
blocked, rejected or failed `verify`, or Cursor's model list could not be read at all so
Cursor has no named model. It is tried before `lastResortAgents` and before `wait`;
`--no-downgrade` excludes it like any other downgrade. When used, `reasons` says
"cursor auto: fallback, no named model could be routed (Cursor picks the model)",
`quality` is `null`, the evidence label is `none` and `confidence` is at most `medium`.
`cursorAuto: false` removes the fallback; a `tierOverrides.auto` entry is ignored with
a warning, since `auto` has no bands to override. The pool rule is unchanged: a launch of
`auto` is billed to "Cursor Models" and recorded in the hand-out ledger like any other.

Worked example with the 2026-11-10 profiles, bands 68/76/84 on every axis, and
`--need coding=high,agentic=mid,reasoning=low` (cuts 84 / 76 / 68):

| Model | coding / agentic / reasoning `S` | Covers? | Class | Group |
| --- | --- | --- | --- | --- |
| Fable 5.2 | 88.6 / 86.9 / 93.2 | yes (overshoot 3) | Frontier | fit |
| Opus 5.5 | 86.2 / 81.3 / 89.0 | yes (overshoot 2) | Frontier | fit |
| Fable 5.1 | 84.5 / 83.0 / 89.3 | yes (overshoot 2) | Frontier | fit |
| Sonnet 5.5 | 80.9 / 75.4 / 83.6 | no (coding 80.9 < 84, agentic 75.4 < 76; shortfall 2) | Advanced | downgrade 2 |
| Haiku 5.5 | 64.2 / 50.7 / 69.7 | no (shortfall 5) | Light | downgrade 5 |

The fit group is the three Frontier-class models; the one with the most headroom wins,
and if headroom ties, Fable 5.2 wins on evidence and score. The same models with
`--need coding=low,agentic=low,reasoning=min` (cuts 68 / 68 / none): the Frontier
models and Sonnet 5.5 all cover, Haiku 5.5 does not (coding 64.2 < 68). The fit group
is Sonnet 5.5 alone (Advanced, the lowest covering class). If Sonnet's pool is blocked
the route downgrades to Haiku 5.5 (shortfall 1) or, with `--no-downgrade`, waits; the
Frontier models are reached only when no lower-class model covers the job at all.

**Hand-out record.** Every `route` that returns `ok` appends
`{ at, agent, model, pools, needs }` to a cache file `handouts.json`. Entries older than
`handoutMinutes` (default 10) are dropped when the file is read. Before routing, the CLI
adds `handoutPercent` (default 5 points of the window) to the `usedPercent` of every
pool for each live entry on it, and records the adjustment on the pool so `reasons` can
say "weekly: 2 workers routed in the last 10m, counted as +10%". Because the adjustment
is made to the pool itself, everything downstream sees it alike: headroom and ranking,
pace projection and `risk`, blocking, and the `preferRiskLimit` swap for a favorite.
The router stays pure: the adjusted usage reaches it through the `Environment`, like
usage does today. `status` shows the live entries and the adjusted pools.

### 7.7 Step 4: maintenance

- Clients learn about a new snapshot without downloading it: `data/evidence-manifest.json`
  (`generatedAt`, `schemaVersion`, `sha256`, `bytes`) is fetched first; the snapshot
  only when `generatedAt` differs from the cached one. Both come from the repository's
  `main` branch over raw.githubusercontent.com, as the Model Index file does today. The
  manifest check runs at most every `evidenceTtlHours` (default 24); `refresh` forces it.
- The bundled `data/evidence-snapshot.json` is the offline fallback and ships with each
  npm release; between releases, `main` is newer.
- The placement table TTL (5 hours) stays. There is no second download any more: the
  snapshot is the only data fetch.
- A new model needs no release: no data means stage 1 of 7.5; data means the next
  daily refresh PR.
- Adding a source later means one adapter in the refresh script that emits `results`
  rows in the snapshot shape, plus a `sources` entry with its license.

### 7.8 CLI and JSON contract

New and changed commands:

```text
orcacompass route --need coding=<l>,agentic=<l>,reasoning=<l> ...   (l = min|low|mid|high; all V1 flags kept)
orcacompass route --tier <t> ...                                    (shorthand: the same need on all axes)
orcacompass ranking [--axis <coding|agentic|reasoning>] [--json]
orcacompass tiers [--axis <a>] [--json]
```

- `ranking`: every discovered model with its profile: per axis the score, band,
  evidence label and benchmark count; the class; the agents that can launch it; and the
  hint that nudged it. `--axis` shows one axis sorted by score. Unranked axes are shown
  with the reason. `--json` returns the profiles with the same fields and the snapshot's
  `generatedAt` and `sources`.
- `tiers`: unchanged purpose, now the bands per axis (one table per axis, or one with
  `--axis`).
- `route --json` adds: `needs` (the three levels, and `needsSource`: `need` or `tier`);
  on the route and on each alternative a `quality` object
  `{ class, covers, shortfall, overshoot, evidence, axes: { coding: { score, band, evidence, benchmarks, need, cut }, ... } }`;
  `skipped` entries for models that do not cover carry the reason, for example
  `below need on agentic (75.4 < 76)`; `reasons` gains the need line ("needs
  coding=high agentic=mid reasoning=low; fit group: Frontier class (3 models)") and the
  quality line ("coding 88.6 partial, agentic 86.9 measured, reasoning 93.2 measured").
  `scoreSource` is replaced by `evidenceSource` (`network`, `cache`, `snapshot`);
  `scoreSource` is kept for one release with the same value. The existing `tier` field
  on the decision reports the chosen model's class. A Cursor `auto` fallback route has
  `quality: null`, `tier: null` and `source: "auto"` (the existing value), so callers can
  tell it from a routed model.
- Text output of `route` adds the need line and the quality line.
- `status` adds the snapshot's date and live hand-outs.

Config keys: `classWeight` (0..1, default 0.10) replaces `scoreWeight`; `handoutMinutes`
(default 10); `handoutPercent` (default 5); `evidenceTtlHours` (default 24).
`tierOverrides` sets a model's band on all three axes. `modelsDevTtlHours` is removed.
`config.ts` ignores unknown keys silently today; V2 adds a warning for the removed
`scoreWeight` and `modelsDevTtlHours` keys (new work), and the general unknown-key
warning stays on the roadmap.

### 7.9 Skill changes (`skills/orcacompass/SKILL.md`)

- Replace the single-tier rubric with "Rate the three needs": for every job, rate
  `coding` (how much code is written or changed, and how hard: `min` none, `low` small
  contained edits, `mid` multi-file changes with tests, `high` design-level or tricky
  code), `agentic` (tool use, running and checking commands, browsing, long multi-step
  autonomy: `min` a single edit, `low` run the tests, `mid` iterate with tools until
  green, `high` long unsupervised runs or orchestration), `reasoning` (analysis,
  planning, design decisions, debugging by thought: `min` mechanical, `low` routine
  judgement, `mid` real analysis, `high` open-ended design or hard debugging). Pass all
  three with `--need`. `--tier` remains for the rare job that is the same on all axes.
- Rename "reasoning demand" to "effort demand" throughout; the flag stays `--demand`.
- Explain the `quality` object, the class and the evidence labels: `estimated` and
  `assumed` mean the placement is provisional and should be mentioned when the user
  asks why a model was chosen.
- Replace the paragraph on how tiers are derived (family ladder, Model Index, price) with
  the profile rule, the fit-group rule and `orcacompass ranking`.
- Note that routing now remembers recent hand-outs, so spreading workers over
  `alternatives` by hand is no longer needed.
- Say that Cursor `auto` is a fallback, not a recommendation: when a route lands on it,
  the orchestrator should know Cursor is picking the model and no named model was
  available.

### 7.10 Testing and release

- Unit tests per module: evidence scoring (weights, ranges, clamping, missing
  benchmarks, the two-benchmark minimum), estimates (bridge pairs, median gap, the
  two-shared-benchmark minimum, assumed inheritance, newest-wins), profiles (class
  points, bands, class = highest band, overrides, unranked), the decision (need parsing
  and validation, `--tier` shorthand mapping, cover/shortfall/overshoot, fit group by
  lowest class, downgrade by shortfall, structural promotion only, evidence and
  need-weighted tie-breaks, hand-out penalty), Cursor `auto` fallback (never ranked,
  reached only before `wait`/`lastResortAgents`, excluded by `--no-downgrade` and
  `cursorAuto: false`), Cursor pools, manifest-based fetch, snapshot validation.
- Regression: record V1 `route` decisions for the existing test environments and keep
  the ones whose behavior is meant to be unchanged (pins, bans, downgrade, wait,
  effort resolution; `--tier` calls) as fixtures V2 must reproduce.
- Calibration test: the checks in 7.4 run against the bundled snapshot in CI, so a
  refresh that moves Fable 5.1 below Sonnet 5.5 fails before merge.
- CI: the refresh workflow's PR runs the normal test matrix. Snapshot validation fails
  when the `sources` entry has no license field or it is not in the allowed list (one
  check per source, not per board).
- Docs: `docs/model-data.md`, `docs/tiers-and-routing.md`, `docs/commands.md`,
  `docs/skill-workflow.md`, `docs/roadmap.md` (remove what V2 delivers), `README.md`,
  `NOTICE`.
- `scripts/test-package.mjs` checks for `evidence-snapshot.json` and
  `evidence-manifest.json` in the package instead of the two old snapshots.
- Release 0.3.0. Changelog lists the removed Model Index and Models.dev sources,
  `scoreWeight`, `modelsDevTtlHours` and `scoreSource`, the new `--need` flag and
  fields, and the new commands. No migration: leftover `scoreWeight` or
  `modelsDevTtlHours` keys only warn; `--tier` still works.

## 8. Left to the builder

- Internal module layout (the roadmap suggested `src/evidence/`, `src/placements/`,
  `src/routing/`, `src/usage/`; follow the repository's current structure where it fits).
- The exact bridge table between vendor benchmark names and axis benchmarks, grown
  from the data.
- How the refresh PR body presents the profile diff.
- The starting `bands` per axis. The values above (68 / 76 / 84) satisfy the
  calibration checks on the 2026-11-09 data for coding; the agentic and reasoning bands
  are to be set the same way and may differ. (On 2026-11-10 data Sonnet 5.5's agentic
  `S` is 75.4, just under an Advanced cut of 76; the agentic bands may need to sit a
  little lower.)
- The exact wording of the need and quality lines in `reasons`.
- Whether `ranking` text output is one wide table or one block per model.

## 9. Calls made while writing this (check these)

- `classWeight` default 0.10 and class points 25 / 50 / 75 / 100, the same on all axes.
- Sonnet 5.5 lands in **Advanced** on the coding axis with those values (score 83.7 on
  2026-11-09 data), one band below the three Frontier models.
- Need levels are four (`min`, `low`, `mid`, `high`) so they line up with the four
  bands; `min` means no cut at all. All three axes are required in `--need`.
- `--tier` maps `light/daily/advanced/frontier` to `min/low/mid/high` on all three axes.
- A model's class is its highest band across the axes; the fit group is the lowest
  class that covers the job. A blocked fit group downgrades or waits, never promotes.
- Per agent, only the newest release of a family competes in each class (decided
  2026-11-12): a day-0 release still replaces its older sibling of the same class, but
  an older generation that evidence places in a lower class stays routable there. The
  V1 rule hid every older generation, which left Grok 4.5 (Light) unreachable behind
  Grok 4.7 (Daily) on Cursor.
- Inside a group, quota still orders candidates first; evidence and the need-weighted
  score (`min 0, low 1, mid 2, high 3`) are tie-breaks only.
- The job's evidence label is the weakest among the axes rated `low` or above.
- The hand-out record counts each recent route as 5 points of the pool's window, for 10
  minutes, added to the pool's usage before routing so favorites and blocking see it too.
- Day-0 inheritance takes the vendor's best measured model at or below the new model's
  class, so a new Sonnet or Haiku never starts from Opus's scores.
- The family table outranks the provider's description for class points, because Claude
  Code's own wording would otherwise read Sonnet as Advanced and Haiku as Daily.
- `confidence` is about usage only; placement certainty lives in `quality.evidence`.
- Bands are fixed in the snapshot; a tripped calibration check is fixed by hand in the
  refresh PR.
- Models.dev is dropped (owner's decision, 2026-11-10); the snapshot's model list is
  the catalog. Prices and context length are not used.
- Starting bands in the bundled snapshot (set 2026-11-10 from the first full build):
  coding 68 / 76 / 84, agentic 60 / 70 / 80, reasoning **72 / 80 / 88**. The reasoning
  cuts sit higher than the others because reasoning scores run high across the board
  (with 70 / 78 / 86, GPT-6.1 Terra's 79.1 made it Advanced class and GPT-6.1 Sol's
  87.2 made it Frontier class on reasoning alone); with 72 / 80 / 88 Haiku 5.5 and
  GPT-6 Luna are Light, Terra Daily, Sonnet 5.5 and Sol Advanced, Opus 5.5, Astra and
  the Fables Frontier on every axis. The test fixture keeps its own bands.
- The refresh is daily and run by the owner's automation (owner's decision,
  2026-11-10). What gets committed is the trimmed snapshot and manifest, never the raw
  dataset (my call, for the size of the git history).
- The `--demand` flag keeps its name; only the wording changes to "effort demand".
- Cursor `auto` is not a model (owner's note, 2026-11-10). Where exactly it sits is my
  call: after every named candidate of every group, before `lastResortAgents` and
  `wait`, excluded by `--no-downgrade`; V1's Auto-first rule for Light and Daily goes.
