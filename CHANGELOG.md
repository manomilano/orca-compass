# Changelog

## 0.2.3

- Lowered the `low` need cuts to coding 60, agentic 35 and reasoning 70 (from
  70, 60 and 76), so simple jobs can go to the good small models. `mid` and
  `high` are unchanged. The cuts travel with the evidence snapshot, so 0.2.2
  picks them up on its next refresh.
- A route expected to end its usage window above the new `usageRiskLimit`
  (default 90%) is strained. When every covering route in the cheapest cost
  tier is blocked or strained, routing moves to the cheapest pricier tier that
  has a route with known usage below the limit, and warns. Before, the cheapest
  tier was kept until it was fully blocked, and then the job was downgraded.
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
