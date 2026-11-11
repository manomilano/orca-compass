# Model data

The schema 1 `data/evidence-snapshot.json` is both the model catalog and the
benchmark evidence used for coding, agentic and reasoning profiles. It contains
model identifiers, aliases, results with source URLs and dates, axis scores,
weights, bands and licensed source metadata. No token prices are used.

The raw [LLMBenchmark.ai](https://llmbenchmark.ai) dataset is committed unchanged
at `data/llmbenchmark/dataset.json` (about 22 MB, updated by the owner's
automation). `npm run refresh-evidence` reads it, rebuilds the snapshot and
manifest, and refuses to write when a calibration check fails; the workflow
runs it when the dataset changes and opens a pull request with the profile
diff. Only the trimmed snapshot ships in the npm package. Both files are
licensed CC BY 4.0; see the repository NOTICE and `data/llmbenchmark/README.md`.

Clients check `data/evidence-manifest.json` on the repository's public `main`
at most once per `evidenceTtlHours` (24 by default). A changed manifest causes
a snapshot download and integrity check. A valid cached copy, then the bundled
snapshot, supplies offline fallback. `orcacompass refresh` forces a check and
rebuilds placements. `evidenceSource` reports `network`, `cache` or `snapshot`.
No API key is required; clients do not contact LLMBenchmark directly.

See [Tiers and routing](tiers-and-routing.md) for scoring and routing.
