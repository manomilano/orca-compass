# Model data

The schema 1 `data/evidence-snapshot.json` is both the model catalog and the
benchmark evidence used for coding, agentic and reasoning profiles. It contains
model identifiers, aliases, results with source URLs and dates, axis scores,
weights, bands and licensed source metadata. No token prices are used.

The owner runs the daily refresh from [LLMBenchmark.ai](https://llmbenchmark.ai)
and reviews the resulting pull request. The raw dataset is not committed. The
trimmed snapshot is licensed CC BY 4.0; see the repository NOTICE.

Clients check `data/evidence-manifest.json` on the repository's public `main`
at most once per `evidenceTtlHours` (24 by default). A changed manifest causes
a snapshot download and integrity check. A valid cached copy, then the bundled
snapshot, supplies offline fallback. `orcacompass refresh` forces a check and
rebuilds placements. `evidenceSource` reports `network`, `cache` or `snapshot`.
No API key is required; clients do not contact LLMBenchmark directly.

See [Tiers and routing](tiers-and-routing.md) for scoring and routing.
