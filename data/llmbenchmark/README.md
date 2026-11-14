# LLMBenchmark dataset

`dataset.json` is the full dataset published by [LLMBenchmark.ai](https://llmbenchmark.ai)
at https://llmbenchmark.ai/data/dataset.json, committed here unchanged. It is the
input of the evidence refresh; `data/evidence-snapshot.json` is built from it.

License: Creative Commons Attribution 4.0 International (CC BY 4.0), credit
LLMBenchmark.ai. Source boards keep their own terms; every row keeps its source
URL and date. See the repository NOTICE.

## Updating

1. Replace `dataset.json` with the current download (an automation may do this
   daily). `node scripts/refresh-evidence.mjs --fetch` downloads it here.
2. Run `npm run build && npm run refresh-evidence`. The script reads this file,
   rebuilds the snapshot and manifest, prints the profile diff, and exits 1
   without writing when a calibration check fails.
3. Commit `data/llmbenchmark/dataset.json`, `data/evidence-snapshot.json` and
   `data/evidence-manifest.json` together, so the snapshot always matches the
   dataset it was built from.

The GitHub workflow `refresh-evidence.yml` runs step 2 whenever this file
changes on `main` (or on manual dispatch) and opens a pull request with the diff.

This file is not part of the npm package; only the snapshot ships.
