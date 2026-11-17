# Changelog

## Unreleased

- Added the OrcaCompass website with a landing page, user guide, examples,
  contributing, changelog and community pages, a custom theme, and site
  verification in CI. Publication remains a manual maintainer action.
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
