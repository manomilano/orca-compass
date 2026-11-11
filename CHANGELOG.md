# Changelog

## 0.3.0

- Replaced Model Index and Models.dev sources and the price term with a daily
  owner-refreshed evidence snapshot from [LLMBenchmark.ai](https://llmbenchmark.ai)
  (CC BY 4.0).
- Removed `scoreWeight` and `modelsDevTtlHours`; existing keys warn and are ignored.
  `scoreSource` remains for one release as an alias of `evidenceSource`.
- Added `--need`, `needs`, `needsSource`, `quality`, `evidenceSource`, `ranking`
  and `tiers --axis`; `--tier` remains supported.
- Recent hand-outs adjust pool usage. Cursor `auto` is now a fallback.
- Placement table schema 3 is rebuilt on first run.
- The raw LLMBenchmark dataset is committed at `data/llmbenchmark/dataset.json`;
  the refresh script reads it from there (`--fetch` downloads a fresh copy) and the
  workflow rebuilds the snapshot when it changes.
