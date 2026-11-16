# LLMBenchmark dataset

`dataset.json` is the full dataset published by [LLMBenchmark.ai](https://llmbenchmark.ai)
at https://llmbenchmark.ai/data/dataset.json, committed here unchanged. It is the
input of the evidence refresh; `data/evidence-snapshot.json` is built from it.

License: Creative Commons Attribution 4.0 International (CC BY 4.0), credit
LLMBenchmark.ai. Source boards keep their own terms; every row keeps its source
URL and date. See the repository NOTICE.

## Updating

The `update-evidence.yml` workflow runs these steps every morning and opens a
pull request when the scores changed; nothing happens when they did not. By
hand:

1. Replace `dataset.json` with the current download.
   `node scripts/refresh-evidence.mjs --fetch` downloads it here.
2. Run `npm run build && npm run refresh-evidence`. The script reads this file,
   rebuilds the snapshot and manifest, prints the profile diff, and exits 1
   without writing when a calibration check fails.
3. Commit `data/llmbenchmark/dataset.json`, `data/evidence-snapshot.json` and
   `data/evidence-manifest.json` together, so the snapshot always matches the
   dataset it was built from.

The GitHub workflow `refresh-evidence.yml` runs step 2 on pull requests that
change this file and on `main`, and fails with the profile diff when the
committed snapshot does not match this dataset.

The raw dataset and this README are not part of the npm package. The package
ships `data/evidence-snapshot.json`, `data/evidence-manifest.json` and
`data/evidence-curated.json`.
