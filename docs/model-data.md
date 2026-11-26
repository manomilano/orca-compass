---
description: Understand the evidence snapshot, pricing, refresh workflow, and offline fallback.
---

# Model data

Use this page to understand where model evidence and prices come from, how
they are rebuilt, and which copy a client uses offline.

## What the snapshot contains

The schema 1 `data/evidence-snapshot.json` is both the model catalog and the
benchmark evidence used for coding, agentic and reasoning profiles. It contains
model identifiers, aliases, results with source URLs and dates, axis scores,
weights, bands and licensed source metadata. Optional model `pricing` is
`{ inputPerM, outputPerM, basis? }`, in USD per million tokens. The refresh
copies LLMBenchmark pricing: the maker API price when the maker serves the
model on OpenRouter, otherwise the median across providers; `basis` records
which.

Curated rows can also carry pricing and a `fallback` model id. On axes where
the curated model has no score, the fallback model's score stands in, labelled
`assumed`. The current LLMBenchmark dataset has no entry for Composer 2.5,
so it takes all three capability scores from Kimi K2.5. Its price comes from
Cursor. A future LLMBenchmark score for Composer takes priority on that axis. The snapshot
omits missing or unusable dataset prices; schema 1 still accepts rows without pricing.

The blended price feeds both the routing score and the cost tier, using a 3:1 input/output blend and configurable
`costBands` (default `[1, 5, 12]`). It never changes evidence scores, bands or
need cuts. Models without a price fall back to family/lineup hints and then
evidence class; user cost-tier overrides take precedence over price.

## Rebuild and validate the data

The raw [LLMBenchmark.ai](https://llmbenchmark.ai) dataset is committed unchanged
at `data/llmbenchmark/dataset.json` (about 28 MB in this checkout). Every morning a workflow
downloads it and, when the scores changed, opens a pull request for the
maintainer. `npm run refresh-evidence` reads it and rebuilds the snapshot and
manifest. It refuses to write either file when a calibration check fails;
calibration runs on every refresh, changed or not.

Sources sometimes stop publishing a score, for example when they drop older
models from a leaderboard. `data/evidence-archive.json` keeps the last known
value of every axis score row the dataset has carried, and the refresh updates
it from each dataset. When a model no longer has any live row of a benchmark,
the refresh adds the archived rows back, dated to the last committed dataset
that had them. A setting a source stopped reporting while it still reports
others (a low-effort run beside the high-effort one), or a source of a
benchmark another source still reports, is not added back. Restored rows keep
counting however old they are. The refresh summary in the update pull request
lists them per metric, says when a metric is no longer published at all, and
calls out rows older than 180 days, so the maintainer sees what rests on old
data. The refresh never deletes archive rows. To withdraw a wrong value, delete
its line from `data/evidence-archive.json`, run `npm run refresh-evidence`, and
commit both files.

When the rebuilt evidence matches the committed snapshot, the refresh keeps
that snapshot. A new build time or dataset date alone is not a change. It
rewrites the manifest only if it no longer matches the snapshot's hash, size
or date. A dataset update ships with
its rebuilt snapshot in the same pull request; the refresh workflow runs on
such pull requests and on `main`, and fails with the profile diff when the
committed snapshot does not match the dataset.

The npm package includes the trimmed snapshot, manifest and curated rows,
but omits the raw dataset and the evidence archive. The dataset and transformed snapshot are licensed
CC BY 4.0; see the repository
NOTICE and `data/llmbenchmark/README.md`.

## Client refresh and offline fallback

When placements need rebuilding, clients load evidence from a fresh cache
or check `data/evidence-manifest.json` on the repository's public `main`.
`evidenceTtlHours` (24 by default) controls cache freshness; forced refresh
bypasses it. A missing local snapshot or a different manifest `generatedAt`
causes a snapshot download with byte-length and SHA-256 checks.

::: info Cache identity
A manifest with the same `generatedAt` reuses the parsed cache without comparing its
hash or size again.
:::

A snapshot older than the one bundled with the installed release is never
used. After an upgrade, an older cache is checked against the repository at
once, and the bundled snapshot is kept when the repository has nothing newer
or cannot be reached.

A valid cached copy, then the bundled snapshot, supplies offline fallback.
`orcacompass refresh` forces a check and rebuilds placements. `evidenceSource`
reports `network` (the repository was checked on this call, whether or not
anything was downloaded), `cache` or `snapshot` (the repository could not be
reached).
No API key is required; clients do not contact LLMBenchmark directly.

See [Tiers and routing](tiers-and-routing.md) for scoring and routing.
