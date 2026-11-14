# OrcaCompass V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1's tier placement (family table + Model Index score + price) with per-model profiles on three axes built from a repository-hosted LLMBenchmark snapshot, and route by the job's need on each axis, the lowest covering class, and quota.

**Architecture:** A new `src/evidence/` package owns the snapshot (types, validation, axis scoring, estimates, the refresh builder and the network/cache/bundled loader). `src/placements/profiles.ts` turns snapshot scores plus hints into a profile per discovered model and the placement table (schema 3) caches it. `src/routing/needs.ts` and `src/routing/adequacy.ts` are pure helpers the rewritten `router.ts` uses to form the fit group, downgrade groups and the Cursor `auto` fallback; `src/routing/handouts.ts` is the short-lived hand-out ledger applied to usage before routing. Models.dev and The Model Index are removed; the snapshot is also the catalog.

**Tech Stack:** Node ≥ 20, TypeScript (`tsc`), Vitest, `node:util` `parseArgs`; GitHub Actions for the manual refresh workflow; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-orca-compass-v2-design.md`

## Global Constraints

- Node.js ≥ 20, TypeScript as today, tests with Vitest, CI on Ubuntu, Windows and macOS (`npm test`, `npx tsc --noEmit`, `npm run build`, `npm run test:package` must all pass at every commit).
- Routing stays a pure function of (environment, request, config): no I/O inside `src/routing/router.ts`, deterministic for identical inputs.
- No API keys for users; clients never contact LLMBenchmark at runtime. The only runtime data fetch is the manifest/snapshot from `https://raw.githubusercontent.com/manomilano/orca-compass/main/data/`.
- The raw LLMBenchmark dataset (about 21 MB) is never committed; only `data/evidence-snapshot.json` (hundreds of KB at most), `data/evidence-manifest.json` and `data/evidence-curated.json` are.
- Bundled data license: LLMBenchmark.ai CC BY 4.0, credited as "LLMBenchmark.ai" with a link to https://llmbenchmark.ai; every snapshot row keeps its source URL and date.
- Price per token is never read anywhere in placement or routing.
- Sonnet 5.5 must never rank above Fable 5.1 on any axis (calibration check in the refresh builder; regression test in Task 7).
- Every existing command, config key and `route --json` field keeps working; removed keys (`scoreWeight`, `modelsDevTtlHours`) only warn. `--tier` keeps working as a shorthand.
- Release 0.3.0; placement table schema version 3; evidence snapshot schema version 1.
- Repository rules: Conventional Commits with a short imperative subject; stage by explicit path, never `git add -A`; commit only on `manomilano/compass-v2`; **never push** (the owner reviews locally first).
- Code, identifiers, comments, commit messages and docs in English.

## Review Focus

1. `--need` text that is malformed — a missing axis, a duplicate axis, an unknown level, uppercase (`CODING=High`) or spaces — must be a usage error that prints the expected form, never a silent default. Test in Task 11.
2. A snapshot fetched from the repository that is truncated, not JSON, or carries another `schemaVersion` must fall back to the cached copy, then the bundled one, and `evidenceSource` must say which; the command must not crash. Test in Task 5.
3. A discovered id spelled differently from the snapshot slug (`gpt-6.1-terra`, Cursor's `claude-4.6-sonnet`, an `anthropic/` prefixed id, a `-20261010` date suffix) must still find its profile. Test in Task 7.
4. A corrupt or stale `handouts.json` (not JSON, entries older than `handoutMinutes`, entries for pools the agent no longer reports) must be ignored silently and must never block routing. Test in Task 10.
5. A pinned agent whose discovered models are all unranked (no snapshot match, no hint) must still produce a decision: the pin is reported as not usable with a reason, routing continues to the other agents, and `route --json` never throws. Test in Task 9.

---

## File structure

New:

- `src/placements/ids.ts` — `normalizeModelId`, `compact`, `stripVersion` (moved out of `score.ts`).
- `src/evidence/snapshot.ts` — snapshot types, `AXES`, `parseSnapshot`, `SNAPSHOT_SCHEMA`, `ALLOWED_LICENSES`.
- `src/evidence/catalog.ts` — `toModelIndex(snapshot)`: the `ModelIndex` the agent adapters consume.
- `src/evidence/scoring.ts` — axis weights, benchmark ranges, `rescale`, `axisScore`.
- `src/evidence/refresh.ts` — `buildSnapshot` (dataset → snapshot, measured scores, estimates, curated merge), `diffSnapshots`, `calibrationChecks`.
- `src/evidence/source.ts` — `loadEvidence`: cache → manifest → snapshot download → stale cache → bundled file.
- `src/placements/profiles.ts` — `hintFor`, `buildProfile`, `profileModels`, class points, bands, assumed inheritance.
- `src/routing/needs.ts` — `Need`, `Needs`, `parseNeeds`, `needsFromTier`, `tierOfNeeds`.
- `src/routing/adequacy.ts` — `cutFor`, `coverage`, `jobEvidence`, `needWeightedScore`.
- `src/routing/handouts.ts` — hand-out ledger read/record/apply.
- `scripts/refresh-evidence.mjs` — the owner's daily refresh (download or `--from` file, build, checks, diff, write).
- `.github/workflows/refresh-evidence.yml` — `workflow_dispatch` wrapper that opens a PR.
- `data/evidence-snapshot.json`, `data/evidence-manifest.json`, `data/evidence-curated.json`.
- `tests/fixtures/evidence-mini.json` (hand-written snapshot for routing/profile tests), `tests/fixtures/llmb-dataset-mini.json` (trimmed real dataset for refresh tests).
- `CHANGELOG.md`.

Removed: `src/placements/score.ts`, `src/placements/sources/modelsdev.ts`, `src/placements/sources/modelindex.ts`, `scripts/make-snapshot.mjs`, `data/models-snapshot.json`, `data/modelindex-snapshot.json`, `tests/placements/score.test.ts`, `tests/placements/sources/*`, `tests/fixtures/modelsdev-mini.json`, `tests/fixtures/modelindex-mini.json`.

Modified: `src/types.ts`, `src/config.ts`, `src/placements/tiers.ts`, `src/placements/table.ts`, `src/placements/build.ts`, `src/placements/agents/{claude,codex}.ts` (effort fallback only), `src/routing/router.ts`, `src/routing/environment.ts`, `src/cli.ts`, `src/setup.ts` (no behaviour change; types), `scripts/test-package.mjs`, `NOTICE`, `README.md`, `config.example.json`, `skills/orcacompass/SKILL.md`, `docs/*.md`, `package.json` (0.3.0), tests under `tests/`.

## Shared vocabulary (used by every task)

```ts
// src/evidence/snapshot.ts
export type Axis = 'coding' | 'agentic' | 'reasoning';
export const AXES: readonly Axis[] = ['coding', 'agentic', 'reasoning'];
export type EvidenceKind = 'measured' | 'vendor' | 'reported';
export interface SnapshotResult { benchmark: string; value: number; unit: 'percent' | 'points' | 'elo'; setting?: string; kind: EvidenceKind; source: string; observedAt: string; url: string }
export interface SnapshotScore { score: number; benchmarks: number; kind: 'measured' | 'estimated' }
export interface SnapshotModel { id: string; aliases: string[]; provider: string; name: string; family?: string; releasedAt?: string; results: SnapshotResult[]; scores: Partial<Record<Axis, SnapshotScore>> }
export interface SnapshotSource { id: string; label: string; url: string; license: string; fetchedAt: string; dataDate?: string }
export interface EvidenceSnapshot { schemaVersion: 1; generatedAt: string; sources: SnapshotSource[]; benchmarks: Record<string, { name: string; range: [number, number]; unit: 'percent' | 'points' | 'elo'; source: string }>; axes: Record<Axis, { weights: Record<string, number> }>; bands: Record<Axis, [number, number, number]>; models: SnapshotModel[] }
```

```ts
// src/placements/profiles.ts
export type EvidenceLabel = 'measured' | 'partial' | 'estimated' | 'assumed' | 'unranked';
export interface AxisProfile { score: number | null; evidence: number | null; benchmarks: number; label: EvidenceLabel; band: Tier | null; inheritedFrom?: string }
export interface Profile { class: Tier | null; hint: Classification | null; axes: Record<Axis, AxisProfile> }
```

`Classification.source` becomes `'override' | 'family' | 'lineup'` (`'score'` and `'auto'` are removed). `PlacedModel` becomes `LaunchModel & { profile: Profile }` (the `placements` and `tiers` fields go).

Test fixture `tests/fixtures/evidence-mini.json` (schema 1; bands coding `[68, 76, 84]`, agentic `[60, 70, 80]`, reasoning `[70, 78, 86]`; `results: []` everywhere; `scores` as evidence `E` coding / agentic / reasoning with benchmark counts; starred values are synthetic, the rest are the 2026-11-10 recomputes from the spec):

| id | aliases | provider | family | releasedAt | coding | agentic | reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-5-5 | anthropic/claude-haiku-5.5 | anthropic | claude-haiku | 2026-10-07 | 68.5 (3) | 53.5 (3) | 74.7 (3) |
| claude-sonnet-5-5 | anthropic/claude-sonnet-5.5 | anthropic | claude-sonnet | 2026-09-28 | 84.3 (5) | 78.2 (4) | 87.3 (4) |
| claude-opus-5-5 | anthropic/claude-opus-5.5 | anthropic | claude-opus | 2026-09-22 | 87.4 (5) | 82.0 (4) | 90.6 (4) |
| claude-opus-5 | anthropic/claude-opus-5 | anthropic | claude-opus | 2026-07-24 | 80.0* (3) | 75.0* (3) | 85.0* (3) |
| claude-fable-5-1 | anthropic/claude-fable-5.1 | anthropic | claude-fable | 2026-09-01 | 82.8 (6) | 81.1 (4) | 88.1 (4) |
| claude-fable-5-2 | anthropic/claude-fable-5.2 | anthropic | claude-fable | 2026-11-07 | 87.3 (3) | 85.4 (3) | 92.4 (3) |
| gpt-6-luna | openai/gpt-6-luna | openai | gpt-luna | 2026-09-22 | 66.0* (3) | 50.0* (3) | 70.0* (3) |
| gpt-6-1-terra | openai/gpt-6.1-terra | openai | gpt-terra | 2026-10-26 | 77.5 (4) | 70.0* (3) | 78.0* (3) |
| gpt-6-1-sol | openai/gpt-6.1-sol | openai | gpt-sol | 2026-09-29 | 82.2 (4) | 78.0* (3) | 83.0* (3) |
| gpt-6-astra | openai/gpt-6-astra | openai | gpt-astra | 2026-09-04 | 83.9 (5) | 80.5 (4) | 89.7 (4) |
| composer-2-5 | cursor/composer-2.5 | cursor | composer | 2026-10-20 | 80.0 (2, kind `estimated`) | — | — |

With `classWeight` 0.10 and the family table, the fixture gives `S` (coding / agentic / reasoning) and class: Haiku 64.2 / 50.7 / 69.7 Light; Sonnet 80.9 / 75.4 / 83.6 Advanced; Opus 5.5 86.2 / 81.3 / 89.0 Frontier; Opus 5 79.5 / 75.0 / 84.0 Advanced; Fable 5.1 84.5 / 83.0 / 89.3 Frontier; Fable 5.2 88.6 / 86.9 / 93.2 Frontier; Luna 61.9 / 47.5 / 65.5 Light; Terra 74.8 / 68.0 / 75.2 Daily; Sol 81.5 / 77.7 / 82.2 Advanced; Astra 85.5 / 82.5 / 90.7 Frontier; Composer 2.5 80.0 / — / — Advanced (no hint, `S = E`). Cuts per need: coding `low` 68 `mid` 76 `high` 84; agentic 60 / 70 / 80; reasoning 70 / 78 / 86.

---

### Task 1: Snapshot types, parser and catalog; move id helpers

**Files:**
- Create: `src/placements/ids.ts`, `src/evidence/snapshot.ts`, `src/evidence/catalog.ts`, `tests/fixtures/evidence-mini.json`, `tests/evidence/snapshot.test.ts`
- Modify: `src/placements/score.ts` (import the three helpers from `ids.ts` and re-export them so nothing else moves yet), `src/types.ts` (`ModelMeta`: remove `outputCost` and `efforts`; add the `Axis` re-export)
- Commit also: `docs/superpowers/specs/2026-11-10-orca-compass-v2-design.md`, `docs/superpowers/plans/2026-11-10-orca-compass-v2.md`

**Interfaces:**
- Produces: `parseSnapshot(text: string | undefined): EvidenceSnapshot | undefined` (undefined for missing text, bad JSON, wrong `schemaVersion`, a source without a `license` in `ALLOWED_LICENSES = ['CC BY 4.0', 'CC0 1.0', 'MIT']`, a model without `id`, a `bands` entry that is not three ascending numbers, or an axis weight naming a benchmark absent from `benchmarks`); `SNAPSHOT_SCHEMA = 1`; `toModelIndex(snapshot: EvidenceSnapshot): ModelIndex` (one `ModelMeta { id, provider, name, family?, releaseDate? }` per model keyed by `id`, with every alias also keyed after `normalizeModelId`); `normalizeModelId`, `compact`, `stripVersion` from `src/placements/ids.ts` (bodies unchanged).

- [ ] **Step 1: Write `tests/fixtures/evidence-mini.json`** from the table above (every model has `results: []`; `sources: [{ id: 'llmbenchmark', label: 'LLMBenchmark.ai', url: 'https://llmbenchmark.ai', license: 'CC BY 4.0', fetchedAt: '2026-11-10', dataDate: '2026-11-10' }]`; `benchmarks` and `axes` copied from the spec's 7.3 example, with `unit` per benchmark: `webdev_arena` `elo`, `aa_agentic_index` `points`, all others `percent`).

- [ ] **Step 2: Write the failing tests**

```ts
// tests/evidence/snapshot.test.ts
it('parses the fixture and keeps every model', () => { expect(parseSnapshot(fixture('evidence-mini.json'))!.models).toHaveLength(11); });
it.each([['not json', '{'], ['schema 2', JSON.stringify({ ...mini, schemaVersion: 2 })], ['unlicensed source', JSON.stringify({ ...mini, sources: [{ ...mini.sources[0], license: undefined }] })], ['bands not ascending', JSON.stringify({ ...mini, bands: { ...mini.bands, coding: [84, 76, 68] } })], ['weight on an unknown benchmark', JSON.stringify({ ...mini, axes: { ...mini.axes, coding: { weights: { nope: 100 } } } })]])('rejects %s', (_, text) => { expect(parseSnapshot(text)).toBeUndefined(); });
it('builds the catalog with aliases normalized', () => {
  const index = toModelIndex(parseSnapshot(fixture('evidence-mini.json'))!);
  expect(index['gpt-6-1-terra']).toEqual({ id: 'gpt-6-1-terra', provider: 'openai', name: 'GPT-6.1 Terra', family: 'gpt-terra', releaseDate: '2026-10-26' });
  expect(index['gpt-6-1-terra']).toBe(index[normalizeModelId('openai/gpt-6.1-terra')]);
});
```

- [ ] **Step 3: Run `npx vitest run tests/evidence/snapshot.test.ts`** — expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/placements/ids.ts`, `src/evidence/snapshot.ts`, `src/evidence/catalog.ts`; edit `score.ts` to import/re-export from `ids.ts`; edit `ModelMeta`.** `toModelIndex` keys `model.id` and `normalizeModelId(alias)` for each alias to the same object.

- [ ] **Step 5: Run `npx vitest run` and `npx tsc --noEmit`** — expected: all green (existing tests still pass because `score.ts` re-exports; `tests/helpers/env.ts` and `tests/placements/agents/agents.test.ts` must drop `outputCost`/`efforts` from their `ModelMeta` literals — do that here).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-11-10-orca-compass-v2-design.md docs/superpowers/plans/2026-11-10-orca-compass-v2.md src/placements/ids.ts src/placements/score.ts src/evidence/snapshot.ts src/evidence/catalog.ts src/types.ts tests/fixtures/evidence-mini.json tests/evidence/snapshot.test.ts tests/helpers/env.ts tests/placements/agents/agents.test.ts
git commit -m "feat: add evidence snapshot types and catalog"
```

---

### Task 2: Axis scoring

**Files:**
- Create: `src/evidence/scoring.ts`, `tests/evidence/scoring.test.ts`

**Interfaces:**
- Produces: `AXIS_WEIGHTS: Record<Axis, Record<string, number>>` (spec 7.3 table: coding `tbench_4_0` 25, `vibe_code_bench` 20, `livebench_coding` 15, `swe_bench_vals` 15, `frontiercode` 15, `webdev_arena` 10; agentic `tbench_4_0` 30, `livebench_long_agentic` 30, `livebench_browser` 20, `aa_agentic_index` 20; reasoning `gpqa_diamond` 30, `hle` 30, `livebench_reasoning` 20, `arc_agi_2` 20); `BENCHMARKS: EvidenceSnapshot['benchmarks']` (ranges: `tbench_4_0` [0, 75], `frontiercode` [0, 65], `webdev_arena` [1200, 1900] elo, `aa_agentic_index` [0, 65] points, `hle` [0, 70], all others [0, 100] percent; `source` strings from the spec table); `rescale(value: number, range: [number, number]): number` (0–100, clamped); `axisScore(results: Pick<SnapshotResult, 'benchmark' | 'value' | 'kind'>[], axis: Axis, benchmarks = BENCHMARKS, weights = AXIS_WEIGHTS[axis]): { score: number; benchmarks: number } | undefined` — uses only `kind: 'measured'` rows, the best value per benchmark, present-benchmark weights rescaled to sum 100, undefined under two benchmarks; `MIN_BENCHMARKS = 2`.

- [ ] **Step 1: Write the failing tests** (values are Opus 5.5's real rows on 2026-11-10; `percent` rows are stored as percentages, i.e. the dataset's ratio × 100)

```ts
const opus = [
  { benchmark: 'tbench_4_0', value: 65.15, kind: 'measured' }, { benchmark: 'vibe_code_bench', value: 90.29, kind: 'measured' },
  { benchmark: 'livebench_coding', value: 87.1, kind: 'measured' }, { benchmark: 'frontiercode', value: 54.64, kind: 'measured' },
  { benchmark: 'webdev_arena', value: 1817.7, kind: 'measured' },
];
it('recomputes Opus 5.5 coding as LLMBenchmark does', () => { expect(axisScore(opus, 'coding')).toEqual({ score: expect.closeTo(87.4, 0), benchmarks: 5 }); });
it('needs two benchmarks', () => { expect(axisScore(opus.slice(0, 1), 'coding')).toBeUndefined(); });
it('keeps the best run per benchmark and ignores vendor rows', () => {
  expect(axisScore([...opus, { benchmark: 'tbench_4_0', value: 70, kind: 'measured' }], 'coding')!.score).toBeGreaterThan(axisScore(opus, 'coding')!.score);
  expect(axisScore([...opus, { benchmark: 'swe_bench_vals', value: 99, kind: 'vendor' }], 'coding')).toEqual(axisScore(opus, 'coding'));
});
it('clamps outside the range', () => { expect(rescale(80, [0, 75])).toBe(100); expect(rescale(1100, [1200, 1900])).toBe(0); });
```

- [ ] **Step 2: Run `npx vitest run tests/evidence/scoring.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement `src/evidence/scoring.ts`.** Score rounded to one decimal.
- [ ] **Step 4: Run the test** — expected: PASS.
- [ ] **Step 5: Commit** — `git add src/evidence/scoring.ts tests/evidence/scoring.test.ts && git commit -m "feat: score the three axes from benchmark rows"`

---

### Task 3: Snapshot builder from the LLMBenchmark dataset (measured scores, diff, calibration)

**Files:**
- Create: `src/evidence/refresh.ts`, `tests/evidence/refresh.test.ts`, `tests/fixtures/llmb-dataset-mini.json`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `axisScore`/`BENCHMARKS`/`AXIS_WEIGHTS`, `knownModelVersion` from `src/placements/tiers.ts`, `FAMILY_TIERS`/`MODEL_LINE_TIERS`.
- Produces: `METRIC_MAP: Record<string, { benchmark: string; priority: number }>` (dataset metric → snapshot benchmark: `vals_terminal_bench_4→tbench_4_0`, `vals_vibe_code→vibe_code_bench`, `livebench_coding`, `vals_swe_bench→swe_bench_vals`, `epoch_frontiercode→frontiercode`, `webdev_elo→webdev_arena`, `livebench_long_agentic`, `livebench_browser`, `aa_agentic_index`, `epoch_gpqa_diamond→gpqa_diamond` priority 1, `aa_gpqa→gpqa_diamond` 2, `gpqa_accuracy→gpqa_diamond` 3, `aa_hle→hle` 1, `scale_hle→hle` 2, `livebench_reasoning`, `epoch_arc_agi_2→arc_agi_2`; when several metrics map to one benchmark only the lowest-priority-number metric present for the model is used); `familyOfSlug(slug: string): string | undefined` (`knownModelVersion(slug)?.family`, else the slug up to its first `-<digit>` segment, e.g. `grok-4-7→grok`, `gemini-3-1-pro→gemini`, `composer-2-5→composer`; undefined for a slug that starts with a digit); `displayName(raw: string): string` (drops a leading `Provider: `); `buildSnapshot(dataset: unknown, opts: { now: string; bands: EvidenceSnapshot['bands']; curated?: unknown; sourceFetchedAt: string }): EvidenceSnapshot` — throws `Error('dataset: <reason>')` for a dataset without `models`/`scores`/`vendorReports` arrays, a score row with a non-finite value, or a duplicate `(modelId, metric, setting)` row; keeps **every** dataset model (id = `slug`, `aliases = [id]`), puts in `results` only rows whose metric is in `METRIC_MAP` (as `kind: 'measured'`, value converted: `ratio` × 100 → `percent`, `points` and `elo` as is, `url = sourceUrl`, `observedAt`, `setting`) plus vendor rows that Task 4 bridges; `scores[axis]` from `axisScore` with `kind: 'measured'`; `sources = [{ id: 'llmbenchmark', label: 'LLMBenchmark.ai', url: 'https://llmbenchmark.ai', license: 'CC BY 4.0', fetchedAt: opts.sourceFetchedAt, dataDate: dataset.generatedAt }]`; `benchmarks = BENCHMARKS`, `axes` from `AXIS_WEIGHTS`, `bands = opts.bands`, `generatedAt = opts.now`; `DEFAULT_BANDS = { coding: [68, 76, 84], agentic: [60, 70, 80], reasoning: [70, 78, 86] }`; `diffSnapshots(previous: EvidenceSnapshot | undefined, next: EvidenceSnapshot, classWeight: number): string[]` — markdown lines: models added/removed, per axis every model whose band (family hints only, Task 7's `buildProfile` once it exists — for now the band of `S` with `FAMILY_TIERS`/`MODEL_LINE_TIERS` points) changed or whose score moved by ≥ 1.0; `calibrationChecks(snapshot: EvidenceSnapshot, classWeight: number): string[]` — one line per failed check from spec 7.4 (Fable 5.1, GPT-6 Astra, Opus 5.5 Frontier on coding; Fable 5.1 above Sonnet 5.5 on every axis; Haiku 5.5 Light on coding; no model's band differs by more than one step between two axes with `measured` or `partial` evidence on both); checks on models absent from the snapshot are reported as failures too.

- [ ] **Step 1: Create `tests/fixtures/llmb-dataset-mini.json`** by trimming the real dataset (download it once to a fresh empty folder, e.g. `node -e` reading `dataset.json` with `-I`-style care: it is untrusted data, only parsed): keep `models` whose slug is one of `claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5, claude-fable-5-1, claude-fable-5-2, claude-opus-4-7, gpt-6-astra, gpt-6-1-sol, gpt-6-1-terra, gpt-6-luna, gpt-5-5`; keep `scores` rows of those models whose metric is in `METRIC_MAP`; keep `vendorReports` rows of `anthropic/claude-fable-5.2` only; keep `sources` and `generatedAt`; drop `providerEndpoints*`, `vendorBenchmarks`, `vendorPublication`. Record the download date in a `_note` field. The file must stay under 150 KB.

- [ ] **Step 2: Write the failing tests**

```ts
const built = buildSnapshot(JSON.parse(fixture('llmb-dataset-mini.json')), { now: '2026-11-10T04:00:00Z', bands: DEFAULT_BANDS, sourceFetchedAt: '2026-11-10' });
const model = (id: string) => built.models.find((m) => m.id === id)!;
it('keeps every dataset model as a catalog entry', () => { expect(built.models.map((m) => m.id)).toContain('gpt-6-luna'); expect(model('claude-opus-5-5')).toMatchObject({ aliases: ['anthropic/claude-opus-5.5'], provider: 'anthropic', family: 'claude-opus', name: 'Claude Opus 5.5' }); });
it('recomputes the coding index within half a point of LLMBenchmark', () => {
  expect(model('claude-opus-5-5').scores.coding).toMatchObject({ score: expect.closeTo(87.4, 0), benchmarks: 5, kind: 'measured' });
  expect(model('claude-sonnet-5-5').scores.coding!.score).toBeCloseTo(84.3, 0);
  expect(model('claude-haiku-5-5').scores.coding!.score).toBeCloseTo(68.5, 0);
  expect(model('claude-fable-5-1').scores.coding!.score).toBeCloseTo(82.8, 0);
});
it('uses one GPQA and one HLE source by priority', () => { const r = model('claude-opus-5-5').results.filter((x) => x.benchmark === 'gpqa_diamond'); expect(r).toHaveLength(1); expect(r[0].source).toBe('epoch'); });
it('keeps only axis rows in results and converts ratios to percent', () => { expect(model('claude-opus-5-5').results.every((r) => r.benchmark in BENCHMARKS)).toBe(true); expect(model('claude-opus-5-5').results.find((r) => r.benchmark === 'tbench_4_0')).toMatchObject({ value: expect.closeTo(65.15, 1), unit: 'percent', kind: 'measured', url: expect.stringContaining('vals.ai') }); });
it('rejects a dataset without scores', () => { expect(() => buildSnapshot({ models: [] }, opts)).toThrow(/dataset/); });
it('passes the calibration checks on the real numbers', () => { expect(calibrationChecks(built, 0.1)).toEqual([]); });
it('reports a Sonnet above Fable as a failure', () => { const bad = structuredClone(built); bad.models.find((m) => m.id === 'claude-fable-5-1')!.scores.coding!.score = 60; expect(calibrationChecks(bad, 0.1).join('\n')).toMatch(/fable-5-1.*sonnet-5-5|sonnet-5-5.*fable-5-1/i); });
it('diffs bands and scores', () => { const next = structuredClone(built); next.models.find((m) => m.id === 'claude-haiku-5-5')!.scores.coding!.score = 80; expect(diffSnapshots(built, next, 0.1).join('\n')).toMatch(/claude-haiku-5-5.*coding/); expect(diffSnapshots(undefined, built, 0.1)[0]).toMatch(/added/i); });
```

- [ ] **Step 3: Run `npx vitest run tests/evidence/refresh.test.ts`** — expected: FAIL.
- [ ] **Step 4: Implement `src/evidence/refresh.ts`** (measured path, `diffSnapshots`, `calibrationChecks`; leave an `estimateScores` stub returning the input for Task 4). The band computation needed by `diffSnapshots`/`calibrationChecks` before Task 7 exists: `S = (1 − w)·E + w·points` with points Light 25 / Daily 50 / Advanced 75 / Frontier 100 from `FAMILY_TIERS[family]` or the first matching `MODEL_LINE_TIERS` pattern, else `S = E`; put that in a small exported `hintPointsOf(model: SnapshotModel): number | undefined` that Task 7 then reuses.
- [ ] **Step 5: Run the test** — expected: PASS. If a coding score misses the half-point tolerance, print the per-benchmark rescaled values and compare with the spec's weights before touching the tolerance.
- [ ] **Step 6: Commit** — `git add src/evidence/refresh.ts tests/evidence/refresh.test.ts tests/fixtures/llmb-dataset-mini.json && git commit -m "feat: build the evidence snapshot from the LLMBenchmark dataset"`

---

### Task 4: Estimates (vendor bridge) and the curated file

**Files:**
- Modify: `src/evidence/refresh.ts`, `tests/evidence/refresh.test.ts`
- Create: `data/evidence-curated.json`

**Interfaces:**
- Produces: `VENDOR_BRIDGE: Record<string, string>` (vendor benchmark slug → snapshot benchmark id; initial entries `terminal-bench-4-0→tbench_4_0`, `swe-bench-verified→swe_bench_vals`, `gpqa→gpqa_diamond`, `epoch-hle→hle`, `hle→hle`, `arc-agi-2→arc_agi_2`; grown from the data); `estimateScores(models: SnapshotModel[], benchmarks: EvidenceSnapshot['benchmarks']): SnapshotModel[]` — for every model and axis without a `measured` score: for each of its `vendor`/`reported` rows whose benchmark is an axis benchmark or any percent benchmark shared with another model, find reference models with a measured score on that axis and a row on the same benchmark (measured rows preferred; else vendor/reported rows), candidate = reference axis score + (rescaled target − rescaled reference), where axis benchmarks rescale by their range and other percent benchmarks by [0, 100]; the estimate is the median over all candidates and needs at least two distinct shared benchmarks; writes `scores[axis] = { score, benchmarks: <distinct shared>, kind: 'estimated' }`; `mergeCurated(models: SnapshotModel[], curated: unknown): SnapshotModel[]` — curated file shape `{ models: [{ id, aliases?, provider, name, family?, releasedAt?, results: SnapshotResult[] }] }`; a curated model absent from the dataset is appended, a present one gets the rows appended; rows must carry `kind` `vendor` or `reported`, `url` and `observedAt`, else `Error('curated: <reason>')`. `buildSnapshot` runs: measured scores → merge curated → estimates. Vendor rows kept in `results` are only those that bridged to a benchmark used by an estimate.

- [ ] **Step 1: Write `data/evidence-curated.json`** with Composer 2.5 (`id: composer-2-5`, `provider: cursor`, `name: Composer 2.5`, `family: composer`) and the reference rows from Cursor's comparison page as `kind: 'reported'` for `claude-opus-4-7` and `gpt-5-5` on the same benchmarks: `terminal-bench-2-0` (Composer 69.3, Opus 4.7 69.4, GPT-5.5 82.7) and `swe-bench-multilingual` (79.8, 80.5, 77.8), `unit: 'percent'`, `source: 'cursor'`, `url` = the Cursor page, `observedAt` = the date it was read. Composer's own rows are `kind: 'vendor'`.

- [ ] **Step 2: Write the failing tests**

```ts
it('estimates Fable 5.2 from its vendor rows against measured neighbours', () => {
  const stripped = structuredClone(dataset); stripped.scores = stripped.scores.filter((s) => s.modelId !== 'anthropic/claude-fable-5.2');
  const snap = buildSnapshot(stripped, opts);
  const fable = snap.models.find((m) => m.id === 'claude-fable-5-2')!;
  expect(fable.scores.reasoning).toMatchObject({ kind: 'estimated', benchmarks: expect.any(Number) });
  expect(fable.scores.reasoning!.score).toBeGreaterThan(snap.models.find((m) => m.id === 'claude-opus-5-5')!.scores.reasoning!.score - 5);
});
it('needs two shared benchmarks', () => { /* keep one vendor row only → no estimated score on that axis */ });
it('merges the curated Composer 2.5 near Opus 4.7 on coding', () => {
  const snap = buildSnapshot(dataset, { ...opts, curated: JSON.parse(readFileSync('data/evidence-curated.json', 'utf8')) });
  const composer = snap.models.find((m) => m.id === 'composer-2-5')!;
  expect(composer.scores.coding).toMatchObject({ kind: 'estimated', benchmarks: 2 });
  expect(Math.abs(composer.scores.coding!.score - snap.models.find((m) => m.id === 'claude-opus-4-7')!.scores.coding!.score)).toBeLessThan(3);
});
it('rejects a curated row without a url', () => { expect(() => mergeCurated([], { models: [{ id: 'x', provider: 'p', name: 'x', results: [{ benchmark: 'b', value: 1, unit: 'percent', kind: 'vendor', source: 's', observedAt: '2026-01-01' }] }] })).toThrow(/curated/); });
```

If `claude-opus-4-7` or `gpt-5-5` has no measured coding score in the mini dataset, extend the fixture (Task 3 Step 1 command) with their rows rather than weakening the test.

- [ ] **Step 3: Run `npx vitest run tests/evidence/refresh.test.ts`** — expected: FAIL.
- [ ] **Step 4: Implement `estimateScores`, `mergeCurated`, `VENDOR_BRIDGE`; wire into `buildSnapshot`.**
- [ ] **Step 5: Run `npx vitest run`** — expected: PASS.
- [ ] **Step 6: Commit** — `git add src/evidence/refresh.ts tests/evidence/refresh.test.ts data/evidence-curated.json tests/fixtures/llmb-dataset-mini.json && git commit -m "feat: estimate sparse models from vendor rows and curated data"`

---

### Task 5: Evidence loader, refresh script, bundled data, workflow, NOTICE

**Files:**
- Create: `src/evidence/source.ts`, `tests/evidence/source.test.ts`, `scripts/refresh-evidence.mjs`, `.github/workflows/refresh-evidence.yml`, `data/evidence-snapshot.json`, `data/evidence-manifest.json`
- Modify: `NOTICE`, `package.json` (`"refresh-evidence": "node scripts/refresh-evidence.mjs"` script; drop `"snapshot"`)
- Delete: `scripts/make-snapshot.mjs`

**Interfaces:**
- Produces: `EVIDENCE_MANIFEST_URL = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/data/evidence-manifest.json'`, `EVIDENCE_SNAPSHOT_URL = '.../data/evidence-snapshot.json'`; `interface Manifest { generatedAt: string; schemaVersion: number; sha256: string; bytes: number }`; `parseManifest(raw: unknown): Manifest | undefined`; `interface Evidence { snapshot: EvidenceSnapshot; source: DataSource; fetchedAt: number }`; `loadEvidence(opts: { ttlHours: number; now?: number; fetchImpl?: typeof fetch; refresh?: boolean; cacheDir?: string }): Promise<Evidence>` — cache files `evidence-snapshot.json` (the snapshot as fetched) and `evidence-check.json` (`{ checkedAt, generatedAt }`); order: a cached snapshot whose `checkedAt` is within `ttlHours` and `!refresh` → `cache`; else fetch the manifest (10 s timeout, `redirect: 'error'`): same `generatedAt` as the cache → write `checkedAt`, return `network`; different → download the snapshot, verify `sha256` and `parseSnapshot`, write both files, return `network`; any failure → the cached snapshot (`cache`) if valid, else the bundled `data/evidence-snapshot.json` (`snapshot`); the bundled file failing to parse is a thrown `Error('bundled evidence snapshot unreadable')`; `fetchedAt` is the cache's `checkedAt`, the fetch time, or the bundled `generatedAt` as epoch ms.

- [ ] **Step 1: Write the failing tests** (use `ORCACOMPASS_HOME` temp dirs as `tests/cli.test.ts` does; a `fetchImpl` stub keyed by URL)

```ts
it('uses the bundled snapshot offline', async () => { const e = await loadEvidence({ ttlHours: 24, now: NOW, fetchImpl: async () => { throw new Error('offline'); } }); expect(e.source).toBe('snapshot'); expect(e.snapshot.models.length).toBeGreaterThan(50); });
it('downloads when the manifest is newer and caches it', async () => { /* manifest generatedAt '2099-01-01', snapshot = mini with that generatedAt and matching sha256 → source 'network', second call within ttl → 'cache' with no fetch */ });
it('confirms an unchanged snapshot without downloading it', async () => { /* cache present, manifest same generatedAt → 'network', only one URL fetched */ });
it.each(['{', JSON.stringify({ ...mini, schemaVersion: 2 }), '{"schemaVersion":1'])('falls back when the downloaded snapshot is unusable: %s', async (body) => { /* manifest newer, snapshot body → source 'cache' when a cache exists, else 'snapshot' */ });
it('falls back when the sha256 does not match', async () => { /* source 'snapshot' */ });
```

- [ ] **Step 2: Run `npx vitest run tests/evidence/source.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement `src/evidence/source.ts`.** Bundled path: `new URL('../../data/evidence-snapshot.json', import.meta.url)` (same relative depth from `src/evidence/` and `dist/evidence/`).
- [ ] **Step 4: Write `scripts/refresh-evidence.mjs`** (imports from `../dist/evidence/*.js`, so `npm run build` first): flags `--from <file>` (use a local dataset instead of downloading `https://llmbenchmark.ai/data/dataset.json`), `--out <dir>` (default `data`), `--diff <file>` (write the markdown diff there, for the PR body), `--check-methodology` (fetch `https://llmbenchmark.ai/methodology`, warn to stderr when any of the weight percentages or ranges in `AXIS_WEIGHTS`/`BENCHMARKS` is not found in the page text; never fails the run). Flow: read the previous `evidence-snapshot.json` (bands come from it, else `DEFAULT_BANDS`), read `evidence-curated.json`, `buildSnapshot`, `calibrationChecks` (print; exit 1 when any fail, without writing), write the snapshot (top level 2-space indented, but each entry of `models` serialized compact on its own line so the file stays near its compact size and a git diff still shows one changed model per line; trailing newline), write the manifest (`generatedAt`, `schemaVersion`, `sha256` of the file bytes, `bytes`), print `diffSnapshots`. Download goes to a temporary folder; the raw file is never written under `data/`.
- [ ] **Step 5: Generate the data**: `npm run build && node scripts/refresh-evidence.mjs --from <downloaded dataset path>` (or without `--from` online). Expected: checks pass, `data/evidence-snapshot.json` written (verify it is under 1.2 MB: `wc -c`; the Task 4 full-data smoke build was 943 KB compact), manifest written. If a calibration check fails on the real data, adjust `DEFAULT_BANDS` per axis (spec 7.4/8) and re-run; record the final bands in the commit message body.
- [ ] **Step 6: Write `.github/workflows/refresh-evidence.yml`**: `on: workflow_dispatch`; `permissions: { contents: write, pull-requests: write }`; steps: checkout, setup-node 24, `npm ci`, `npm run build`, `node scripts/refresh-evidence.mjs --diff /tmp/evidence-diff.md --check-methodology`, then if `git status --porcelain data/` is non-empty: branch `evidence/refresh-$(date -u +%F)`, `git add data/evidence-snapshot.json data/evidence-manifest.json`, commit `chore(data): refresh evidence snapshot`, push, `gh pr create --fill --body-file /tmp/evidence-diff.md` (env `GH_TOKEN: ${{ github.token }}`). The owner's own automation runs the same script and the same git steps locally.
- [ ] **Step 7: Rewrite `NOTICE`**: keep the Apache header; replace the two data sections with one for `data/evidence-snapshot.json` (LLMBenchmark.ai, https://llmbenchmark.ai, CC BY 4.0 with the license URL, "source boards keep their own terms; each row keeps its source URL and date") and one line for `data/evidence-curated.json` (vendor-published figures with their URLs). Remove Models.dev and The Model Index.
- [ ] **Step 8: Delete `scripts/make-snapshot.mjs`; update `package.json` scripts.** Run `npx vitest run` and `npx tsc --noEmit` — expected: PASS (nothing imports the deleted script).
- [ ] **Step 9: Commit**

```bash
git add src/evidence/source.ts tests/evidence/source.test.ts scripts/refresh-evidence.mjs .github/workflows/refresh-evidence.yml data/evidence-snapshot.json data/evidence-manifest.json NOTICE package.json
git rm scripts/make-snapshot.mjs
git commit -m "feat: fetch the evidence snapshot from the repository and add the refresh script"
```

---

### Task 6: Config keys

**Files:**
- Modify: `src/config.ts`, `src/types.ts` (`Config`), `tests/config.test.ts`, `config.example.json`

**Interfaces:**
- Produces: `Config` gains `classWeight: number` (0..1, default `0.10`), `handoutMinutes: number` (default 10), `handoutPercent: number` (default 5), `evidenceTtlHours: number` (default 24); loses `scoreWeight` and `modelsDevTtlHours`; `cursorAuto` stays (doc comment: "Offer Cursor's `auto` as a fallback when no named model can be routed"). `loadConfig(path = configPath(), warn?: (message: string) => void): Config` — calls `warn` once per removed key present in the file: `scoreWeight is no longer used (OrcaCompass 0.3 ranks models by benchmark evidence; see classWeight)`, `modelsDevTtlHours is no longer used (the evidence snapshot is the catalog; see evidenceTtlHours)`; removed keys are otherwise ignored (no validation). `updateConfigFile` keeps unknown keys untouched as today.

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`: defaults include the four new keys with the values above and exclude the two removed ones; `{"classWeight":0.3,"handoutMinutes":0,"handoutPercent":12.5,"evidenceTtlHours":1}` loads; `{"classWeight":1.5}`, `{"classWeight":"a"}`, `{"handoutMinutes":-1}` throw `ConfigError` naming the key; `{"scoreWeight":0.4,"modelsDevTtlHours":12}` loads to the defaults and calls `warn` twice with the messages above; `updateConfigFile` on a file with `scoreWeight` keeps the key in place. Replace every `scoreWeight` expectation in the existing tests with `classWeight` (`0.1`); the `'{"priceThresholds":{"light":"cheap"},"scoreWeight":0}'` unknown-key test becomes `'{"priceThresholds":{"light":"cheap"},"classWeight":0}'`.
- [ ] **Step 2: Run `npx vitest run tests/config.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement.** `config.example.json`: replace `scoreWeight`/`modelsDevTtlHours` with `classWeight: 0.1`, `handoutMinutes: 10`, `handoutPercent: 5`, `evidenceTtlHours: 24`.
- [ ] **Step 4: Run `npx vitest run tests/config.test.ts` and `npx tsc --noEmit`** — the type check fails in `table.ts`/`build.ts`/`tiers.ts` (they read `scoreWeight`/`modelsDevTtlHours`): change those reads to `classWeight`/`evidenceTtlHours` minimally so the build is green; their real rewrite is Tasks 7–8. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/config.ts src/types.ts tests/config.test.ts config.example.json src/placements/table.ts src/placements/build.ts src/placements/tiers.ts tests/placements/table.test.ts tests/placements/tiers.test.ts && git commit -m "feat: replace scoreWeight with classWeight and add hand-out and evidence settings"`

---

### Task 7: Profiles (hints, class points, bands, assumed inheritance)

**Files:**
- Create: `src/placements/profiles.ts`, `tests/placements/profiles.test.ts`
- Modify: `src/placements/tiers.ts` (remove `findAnchors`, `scoreScale`, `byScore`, `classifyModel`'s score branch, `classifyLaunch`, `Scales`, `CURSOR_AUTO_TIERS`, `isCursorAuto`, `isLadderVendor`; keep `FAMILY_TIERS`, `MODEL_LINE_TIERS`, `knownModelVersion`, `modelFamily`, `lineupTier`), `src/types.ts` (`Classification.source`, `CLASSIFICATION_SOURCES`, `PlacedModel`, `Profile`/`AxisProfile`/`EvidenceLabel` live in `profiles.ts` and are re-exported from `types.ts`), `tests/placements/tiers.test.ts` (drop score cases; keep family/line/override/lineup cases against `hintFor`), `src/evidence/refresh.ts` (`diffSnapshots`/`calibrationChecks` now call `buildProfile`)
- Delete: `src/placements/score.ts`, `tests/placements/score.test.ts` (nothing else imports `score.ts` after Task 1's move; `router.ts` still imports `isLadderVendor` — stub it out there until Task 9 by deleting that tie-break line now)

**Interfaces:**
- Consumes: Task 1 snapshot types, `normalizeModelId`/`stripVersion`/`compact`.
- Produces: `CLASS_POINTS: Record<Tier, number> = { light: 25, daily: 50, advanced: 75, frontier: 100 }`; `hintFor(modelId: string, meta: ModelMeta | undefined, lineup: string | undefined, config: Config): Classification | undefined` — override by id, override by family, `MODEL_LINE_TIERS`, `FAMILY_TIERS`, then `lineupTier(lineup)` (detail = the quoted description as today); `bandOf(score: number, bands: [number, number, number]): Tier`; `findSnapshotModel(modelId: string, snapshot: EvidenceSnapshot): SnapshotModel | undefined` — exact `id`, then normalized id, then any normalized alias, then `stripVersion`, then dashless `compact` equality, then with a trailing `-YYYYMMDD` removed; `buildProfile(modelId: string, meta: ModelMeta | undefined, lineup: string | undefined, snapshot: EvidenceSnapshot, config: Config): Profile` — per axis `E` from the matched snapshot model (`label` `measured` when `kind === 'measured'` and `benchmarks >= 3`, `partial` when `measured` and 2, `estimated` when `kind === 'estimated'`), else assumed inheritance (below), else `unranked`; `S = round1((1 − w)·E + w·CLASS_POINTS[hint.tier])` or `round1(E)` without a hint; `band = bandOf(S, snapshot.bands[axis])`; an `override` hint sets `band` to the override tier on every axis regardless of `S`; `class` = highest band, `null` when every axis is unranked; `vendorOfFamily(family: string | undefined): string | undefined` (`claude-*→anthropic`, `gpt-*→openai`, `gemini*→google`, `grok*→xai`, else undefined); assumed inheritance for a model with a hint and no snapshot score on the axis: among snapshot models of the same vendor (`meta.provider` or `vendorOfFamily`) with a `measured`/`estimated` score on the axis, take those of the same family, or whose own class (via `hintFor` with family hints only) is at or below this model's hint tier; pick the highest score (ties: newest `releasedAt`); `label: 'assumed'`, `inheritedFrom: <that id>`; none → `unranked`; `profileModels(discoveries: AgentDiscovery[], snapshot: EvidenceSnapshot, config: Config): PlacedAgent[]` — collects the lineup per `modelId` across agents (first non-empty wins) and builds one `Profile` per model; Cursor `auto` (`agent === 'cursor' && modelId === 'auto'`) gets `{ class: null, hint: null, axes: all unranked }` without a lookup. Scores rounded to one decimal.

- [ ] **Step 1: Write the failing tests** against `evidence-mini.json`

```ts
const snap = parseSnapshot(fixture('evidence-mini.json'))!;
const p = (id: string, lineup?: string, config = DEFAULT_CONFIG) => buildProfile(id, undefined, lineup, snap, config);
it('scores Sonnet 5.5 as Advanced on every axis and below Fable 5.1 everywhere', () => {
  expect(p('claude-sonnet-5-5').axes.coding).toMatchObject({ score: 80.9, evidence: 84.3, band: 'advanced', label: 'measured', benchmarks: 5 });
  expect(p('claude-sonnet-5-5').class).toBe('advanced');
  for (const a of AXES) expect(p('claude-fable-5-1').axes[a].score!).toBeGreaterThan(p('claude-sonnet-5-5').axes[a].score!);
});
it('ranks Opus 5.5 above Fable 5.1 on coding, both Frontier', () => { expect(p('claude-opus-5-5').axes.coding.score).toBe(86.2); expect(p('claude-fable-5-1').axes.coding.score).toBe(84.5); expect(p('claude-opus-5-5').class).toBe('frontier'); });
it('labels two benchmarks partial and estimates as estimated', () => { expect(p('composer-2-5').axes.coding).toMatchObject({ score: 80, label: 'estimated', band: 'advanced' }); expect(p('composer-2-5').axes.agentic.label).toBe('unranked'); expect(p('composer-2-5').class).toBe('advanced'); });
it('family table beats the lineup words', () => { expect(p('claude-sonnet-5-5', 'For complex work and everyday tasks').hint).toEqual({ tier: 'daily', source: 'family' }); });
it('an override sets the band on every axis', () => { const o = p('claude-haiku-5-5', undefined, { ...DEFAULT_CONFIG, tierOverrides: { 'claude-haiku-5-5': 'frontier' } }); expect(AXES.map((a) => o.axes[a].band)).toEqual(['frontier', 'frontier', 'frontier']); expect(o.hint?.source).toBe('override'); });
it('finds a model by dotted id, alias, prefix, date suffix and Cursor spelling', () => {
  for (const id of ['gpt-6.1-terra', 'openai/gpt-6.1-terra', 'gpt-6-1-terra-20261026', 'GPT-6.1-Terra']) expect(findSnapshotModel(id, snap)?.id).toBe('gpt-6-1-terra');
  expect(findSnapshotModel('claude-sonnet-5-5-20260928', snap)?.id).toBe('claude-sonnet-5-5');
});
it('a brand-new Fable inherits from the vendor\'s best model at or below Frontier, labelled assumed', () => {
  const f = p('claude-fable-5-3');
  expect(f.axes.coding).toMatchObject({ label: 'assumed', inheritedFrom: 'claude-fable-5-2', evidence: 87.3 });
  expect(f.class).toBe('frontier');
});
it('a new Sonnet inherits from Sonnet, never from Opus', () => { expect(p('claude-sonnet-5-6').axes.coding.inheritedFrom).toBe('claude-sonnet-5-5'); });
it('no hint and no evidence is unranked with class null', () => { expect(p('mystery-9').class).toBeNull(); });
it('profileModels gives Cursor auto no profile and shares one lineup per model', () => { /* two agents list claude-opus-5-5, only one with a lineup → both get the same hint; auto → class null */ });
```

- [ ] **Step 2: Run `npx vitest run tests/placements/profiles.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement `profiles.ts`; trim `tiers.ts`; delete `score.ts` and its test; re-point `refresh.ts` at `buildProfile`; fix `tiers.test.ts`.** To keep this commit compiling, `PlacedModel` keeps a transitional `placements: Classification[]` (the hint as a one-element array, `[]` without one) and `tiers: Tier[]` (`[class]` or `[]`) beside `profile`, so `build.ts`, `router.ts` and `cli.ts` still type-check; `build.ts` calls `profileModels` with the snapshot that Task 8 will load (until then, `buildPlacements` passes the snapshot parsed from the bundled file through `deps`). Task 8 removes the two transitional fields.
- [ ] **Step 4: Run `npx vitest run tests/placements`** — expected: PASS for profiles and tiers.
- [ ] **Step 5: Commit** — `git add src/placements/profiles.ts src/placements/tiers.ts src/types.ts src/evidence/refresh.ts tests/placements/profiles.test.ts tests/placements/tiers.test.ts && git rm src/placements/score.ts tests/placements/score.test.ts && git commit -m "feat: build per-model profiles from evidence and hints"`

---

### Task 8: Placement table schema 3, build from the snapshot, remove the old sources

**Files:**
- Modify: `src/placements/table.ts`, `src/placements/build.ts`, `src/routing/environment.ts`, `src/types.ts` (`PlacementTable`, `BuiltWith`, `Environment`; drop the transitional `placements`/`tiers` fields from `PlacedModel`), `src/placements/agents/claude.ts`, `src/placements/agents/codex.ts` (`efforts: DEFAULT_EFFORTS, effortSource: 'assumed'` where `meta.efforts` was read), `src/placements/agents/cursor.ts` (pool rule: `own = g.cursorTrained || base.startsWith('composer') || base.startsWith('grok') || base === 'auto'`, spec 7.2), `tests/placements/table.test.ts`, `tests/placements/build.test.ts`, `tests/placements/local-models.test.ts`, `tests/routing/environment.test.ts`, `tests/placements/agents/agents.test.ts`, `tests/helpers/env.ts`, `tests/helpers/fakes.ts`, `tests/cli.test.ts` (only the imports and `catalog`/`scores` expectations so it compiles; the command output changes are Task 11)
- Delete: `src/placements/sources/modelsdev.ts`, `src/placements/sources/modelindex.ts`, `tests/placements/sources/modelsdev.test.ts`, `tests/placements/sources/modelindex.test.ts`, `tests/fixtures/modelsdev-mini.json`, `tests/fixtures/modelindex-mini.json`, `data/models-snapshot.json`, `data/modelindex-snapshot.json`

**Interfaces:**
- Consumes: `loadEvidence` (Task 5), `profileModels` (Task 7), `toModelIndex` (Task 1).
- Produces: `PLACEMENTS_SCHEMA = 3`; `BuiltWith = Pick<Config, 'tierOverrides' | 'classWeight'>`; `PlacementTable.sources = { evidence: SourceInfo & { generatedAt: string } }` (`models` = snapshot model count); `PlacementTable.bands: EvidenceSnapshot['bands']`; `parseTable` validates `profile` on every model (`class` a tier or null, three axes with the `AxisProfile` shape) and rejects schema 2 files; `staleness` gains `'evidence'`: the table's `sources.evidence.generatedAt` differs from `opts.evidenceGeneratedAt` when the caller passes one (the CLI passes the cached snapshot's `generatedAt` read without a network call; `loadPlacements` reads `evidence-check.json` through `deps.readFile`); `buildPlacements(config, deps)` calls `loadEvidence({ ttlHours: config.evidenceTtlHours, now, fetchImpl, refresh, cacheDir })`, builds `index = toModelIndex(snapshot)` for the adapters, then `profileModels(discoveries, snapshot, config)`; `Environment` gets `evidenceSource: DataSource` and `evidenceGeneratedAt: string`, keeps `catalogSource` (same value as `evidenceSource`, one release) and `scoreSource` (same value); `tests/helpers/env.ts`: `placed(env, { config?, snapshot? })` uses `profileModels` with `parseSnapshot(fixture('evidence-mini.json'))` by default; `machineEnv()` unchanged otherwise; remove `CURSOR_AUTO`'s tiers assumptions (keep the constant).

- [ ] **Step 1: Update the tests**: `agents.test.ts` gains `it('bills any Grok model to Cursor Models', ...)`: a `cursor-agent models` listing with `grok-4.7-high - Grok 4.7 High` (no `cursor-` prefix) gives `poolNames: ['monthly', 'bucket:Cursor Models']`, while `claude-opus-5-5-high` keeps `bucket:Other Models`; `table.test.ts` (schema 3 fixture with a `profile` per model, `builtWith` without `cursorAuto`/`scoreWeight`, staleness `'evidence'` case); `build.test.ts` (offline build → `table.sources.evidence.source === 'snapshot'`, every discovered Claude model has a `profile`, the fetch stub is called only for `EVIDENCE_MANIFEST_URL`); `environment.test.ts` (`env.evidenceSource === 'snapshot'`, `env.scoreSource === env.evidenceSource`); `agents.test.ts` (`index = toModelIndex(parseSnapshot(fixture('evidence-mini.json'))!)`; `effortSource: 'catalog'` expectations become `'assumed'` with the `DEFAULT_EFFORTS` list; `meta` comparisons use the new `ModelMeta` shape); `local-models.test.ts` (replace the Models.dev/Model Index fetch stubs with the manifest/snapshot URLs or an offline stub).
- [ ] **Step 2: Run `npx vitest run`** — expected: FAIL on the updated files.
- [ ] **Step 3: Implement `table.ts`, `build.ts`, `environment.ts`, agent effort fallbacks; delete the old sources, tests, fixtures and data files.**
- [ ] **Step 4: Run `npx vitest run && npx tsc --noEmit && npm run build`** — expected: PASS (router/cli tests that assert V1 tier outcomes may now fail: list them in the commit body; they are rewritten in Tasks 9 and 11. If more than a handful fail, mark them `it.todo` with the task number rather than leaving red tests at a commit).
- [ ] **Step 5: Commit**

```bash
git add src/placements/table.ts src/placements/build.ts src/routing/environment.ts src/types.ts src/placements/agents/claude.ts src/placements/agents/codex.ts src/placements/agents/cursor.ts tests/placements/table.test.ts tests/placements/build.test.ts tests/placements/local-models.test.ts tests/routing/environment.test.ts tests/placements/agents/agents.test.ts tests/helpers/env.ts tests/helpers/fakes.ts tests/cli.test.ts tests/routing/router.test.ts
git rm src/placements/sources/modelsdev.ts src/placements/sources/modelindex.ts tests/placements/sources/modelsdev.test.ts tests/placements/sources/modelindex.test.ts tests/fixtures/modelsdev-mini.json tests/fixtures/modelindex-mini.json data/models-snapshot.json data/modelindex-snapshot.json
git commit -m "feat: build the placement table from evidence profiles"
```

---

### Task 9: Needs, adequacy and the routing decision

**Files:**
- Create: `src/routing/needs.ts`, `src/routing/adequacy.ts`, `tests/routing/needs.test.ts`, `tests/routing/adequacy.test.ts`
- Modify: `src/routing/router.ts`, `src/types.ts` (`RouteRequest`, `Decision`, `Alternative`, `Quality`), `tests/routing/router.test.ts`, `src/setup.ts` and `src/cli.ts` only as far as the changed types require (`route({ tier })` keeps working)

**Interfaces:**
- Consumes: `Profile` (Task 7), `Environment` (Task 8).
- Produces (`needs.ts`): `type Need = 'min' | 'low' | 'mid' | 'high'`, `NEEDS`, `type Needs = Record<Axis, Need>`; `parseNeeds(text: string): Needs` — accepts `coding=high,agentic=mid,reasoning=low` in any order, lowercases levels and axes, throws `Error` with message `` --need must name all three axes, e.g. --need coding=high,agentic=mid,reasoning=low (levels: min, low, mid, high) `` on a missing/duplicate/unknown axis or an unknown level or empty text; `needsFromTier(tier: Tier): Needs` (light→min, daily→low, advanced→mid, frontier→high on all axes); `tierOfNeeds(needs: Needs): Tier` (the highest level mapped back).
- Produces (`adequacy.ts`): `cutFor(need: Need, bands: [number, number, number]): number | null` (`min` → null, `low` → bands[0], `mid` → bands[1], `high` → bands[2]); `NEED_STEP: Record<Need, number> = { min: 0, low: 1, mid: 2, high: 3 }`; `coverage(profile: Profile, needs: Needs): { covers: boolean; shortfall: number; overshoot: number; below: { axis: Axis; score: number | null; cut: number }[] }` — per axis band step = `TIERS.indexOf(band)` (unranked = −1 and never covers a need above `min`); shortfall = Σ max(0, NEED_STEP − step), overshoot = Σ max(0, step − NEED_STEP); `jobEvidence(profile, needs): EvidenceLabel` — weakest label among axes rated `low` or above (order measured > partial > estimated > assumed > unranked; all axes `min` → `measured`); `needWeightedScore(profile, needs): number` = Σ NEED_STEP · (score ?? 0).
- Produces (`router.ts`): `RouteRequest` gains `needs?: Needs` (exactly one of `needs`/`tier`; the router derives `needs = req.needs ?? needsFromTier(req.tier!)` and `requestedTier = req.tier ?? tierOfNeeds(needs)`); `interface Quality { class: Tier | null; covers: boolean; shortfall: number; overshoot: number; evidence: EvidenceLabel; axes: Record<Axis, { score: number | null; band: Tier | null; evidence: EvidenceLabel; benchmarks: number; need: Need; cut: number | null }> }`; `Decision` gains `needs: Needs`, `needsSource: 'need' | 'tier'`, `quality?: Quality | null`; `Alternative` gains `quality: Quality`, its `tier` is the model's class. Candidate collection: one candidate per discovered model with `profile.class !== null` (unranked models go to `skipped` with reason `unranked: no evidence or estimate`), `newestPerFamily` keyed by `(agent, family|model)`; Cursor `auto` is never a candidate (kept aside as `fallback` when `config.cursorAuto`, cursor is an eligible agent, auto is discovered, not banned and `canApplyEffort` or no `--effort`). Groups in order: fit group (covering models of the lowest class among covering candidates of the eligible agents), then — only when every fit route is blocked and `!noDowngrade` — downgrade groups by increasing shortfall over non-covering candidates, then — only when there is no covering candidate at all — nothing more (covering higher classes are already the fit group by construction, so the spec's "higher classes" rule is: the fit group *is* the lowest covering class whatever its level; `upgraded` is set when that class is above `requestedTier`). Order inside a group: `compareRanked` = blocked, rank (headroom), hot session, confidence, `jobEvidence` (stronger first), `needWeightedScore` (higher first), non-fast, newest `releaseDate`, agent id, model id; the ladder-vendor tie-break is removed. Pins: `config.pins[requestedTier]`, looked up among all candidates of that agent (any class, unranked included); risk-limit swap looks for `safer` inside the fit group; a pinned model that does not cover adds the reason `preferred route does not cover the job: <axis> <score> < <cut>, ...`. Fallback: after the groups find nothing and `!noDowngrade`, an unblocked `fallback` candidate is returned as `status: 'ok'` with `route: { agent: 'cursor', model: 'auto', effort: null }`, `tier` undefined, `quality: null`, `confidence` capped at `medium`, reason `cursor auto: fallback, no named model could be routed (Cursor picks the model)`; before that, `lastResortAgents` handling stays as today (`selectRoute` tries the deferred agents' named models before the fallback). `confidence` = usage only (`high` fresh, `medium` stale beyond `usageStaleMinutes` or hand-out adjusted, `low` unknown/very stale). Reasons: first line as today; then `needs coding=<l> agentic=<l> reasoning=<l>; fit group: <class> class (<n> models)` (or `from tier <t>` when `needsSource === 'tier'`); then the quality line `coding 86.2 measured, agentic 81.3 measured, reasoning 89.0 measured`; `downgraded from <requestedTier>: <why>` and `upgraded from <requestedTier>: no <requestedTier>-class model covers the job` keep their prefixes; the downgrade warning becomes `<model> falls short of the job's needs by <n> band step(s) (<axes>); effort is not raised to make up for it: split the job or add stronger checks`; the hand-out note from Task 10 is appended by `describe` when a pool carries `handouts`.

- [ ] **Step 1: Write the failing tests** for `needs.ts` and `adequacy.ts` (parse round-trips, the error message, `tierOfNeeds({coding:'high',agentic:'min',reasoning:'low'}) === 'frontier'`; `coverage` on the fixture: Sonnet with high/mid/low → `{ covers: false, shortfall: 1, below: [{ axis: 'coding', score: 80.9, cut: 84 }] }`; Fable 5.2 with high/mid/low → `{ covers: true, overshoot: 3 }`; composer with low/min/min covers, with low/low/min does not (unranked agentic)).

- [ ] **Step 2: Rewrite `tests/routing/router.test.ts`** against `machineEnv()` (fixture profiles above; claude pools: session 10 %, weekly 50 % resets in 14 h, fableWeekly 75 %; codex weekly 20 % resets in 5.8 d; cursor monthly 2.5 % / Other Models 6.25 % resets in 22 d). Expected decisions:

```ts
it('frontier: Claude Opus 5.5 (weekly headroom 45%) beats Cursor Fable/Opus (20%), Claude Fable (18%) and Codex Astra', () => {
  expect(r({ tier: 'frontier' })).toMatchObject({ status: 'ok', tier: 'frontier', route: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, needsSource: 'tier', needs: { coding: 'high', agentic: 'high', reasoning: 'high' } });
  expect(r({ tier: 'frontier' }).alternatives.map((a) => `${a.agent} ${a.model}`)).toEqual(['cursor claude-fable-5-1-high', 'cursor claude-opus-5-5-high', 'claude claude-fable-5-1', 'codex gpt-6-astra']);
});
it('advanced: the Advanced class covers mid on every axis, so Sonnet (Claude, 45%) is the fit group winner', () => { expect(r({ tier: 'advanced' }).route).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }); expect(r({ tier: 'advanced' }).quality).toMatchObject({ class: 'advanced', covers: true, overshoot: 0 }); });
it('daily: the only Daily-class model is Codex Terra, whatever its headroom', () => { expect(r({ tier: 'daily' }).route).toEqual({ agent: 'codex', model: 'gpt-6.1-terra', effort: 'medium' }); expect(r({ tier: 'daily' }).launchArgs).toEqual(['--agent', 'codex', '--model', 'gpt-6.1-terra', '--effort', 'medium']); });
it('light: Claude Haiku over Codex Luna by headroom; never a higher class in the alternatives', () => { expect(r({ tier: 'light' }).route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' }); expect(r({ tier: 'light' }).alternatives.every((a) => a.tier === 'light')).toBe(true); });
it('needs high/mid/low: Fable 5.1 and Opus 5.5 both cover; quota decides', () => { const d = r({ needs: { coding: 'high', agentic: 'mid', reasoning: 'low' } }); expect(d.route?.model).toBe('claude-opus-5-5'); expect(d.needsSource).toBe('need'); expect(d.requestedTier).toBe('frontier'); expect(d.reasons).toContain('needs coding=high agentic=mid reasoning=low; fit group: frontier class (5 models)'); });
it('needs low/low/min on Claude only: Sonnet is the lowest covering class and the decision says it went up', () => { const d = route({ needs: { coding: 'low', agentic: 'low', reasoning: 'min' }, agents: ['claude'] }, env, DEFAULT_CONFIG); expect(d).toMatchObject({ route: { model: 'claude-sonnet-5-5' }, upgraded: true, tier: 'advanced', requestedTier: 'daily' }); expect(d.skipped).toContainEqual({ agent: 'claude', model: 'claude-haiku-5-5', reason: 'below need on coding (64.2 < 68)' }); });
it('downgrades by shortfall when the fit group is blocked, keeping the effort', () => {
  const cfg = { ...DEFAULT_CONFIG, banModels: ['claude-opus-5-5'] };
  const d = route({ tier: 'frontier', agents: ['claude'] }, placed(withPool(env, 'claude', 'fableWeekly', { usedPercent: 96 }), { config: cfg }), cfg);
  expect(d).toMatchObject({ status: 'ok', tier: 'advanced', downgraded: true, route: { model: 'claude-sonnet-5-5', effort: 'high' }, quality: { covers: false, shortfall: 3 } });
  expect(d.reasons.some((s) => /^downgraded from frontier: /.test(s))).toBe(true);
  expect(d.warnings).toContain('claude-sonnet-5-5 falls short of the job\'s needs by 3 band steps (coding, agentic, reasoning); effort is not raised to make up for it: split the job or add stronger checks');
});
it('waits instead of downgrading with noDowngrade', () => { /* same setup + noDowngrade → status 'wait', waitUntil 1793282400000 */ });
it('a blocked fit group never promotes to a higher class', () => {
  // Daily job: the fit group is Codex Terra alone. With codex weekly at 96% it is blocked, so the route
  // downgrades to Haiku (shortfall 1); Sonnet covers but sits in a higher class and is never reached.
  const d = route({ tier: 'daily' }, withPool(env, 'codex', 'weekly', { usedPercent: 96 }), DEFAULT_CONFIG);
  expect(d).toMatchObject({ status: 'ok', downgraded: true, route: { agent: 'claude', model: 'claude-haiku-5-5' } });
});
it('structural: only Opus installed takes a light job as an upgrade', () => { expect(route({ tier: 'light', agents: ['claude'] }, onlyModels(env, 'claude', ['claude-opus-5-5']), DEFAULT_CONFIG)).toMatchObject({ tier: 'frontier', upgraded: true, route: { model: 'claude-opus-5-5' } }); });
it('ties inside a group go to stronger evidence, then the need-weighted score', () => { /* cursor Fable vs cursor Opus share the Other Models pool: with needs high/high/high Fable (770.4) precedes Opus (769.5); mark cursor Opus coding as partial in a copied env → Fable still first; mark cursor Fable reasoning as estimated → Opus first */ });
it('Cursor auto is a fallback only', () => {
  const withAuto = withCursorModels(withPool(env, 'cursor', 'bucket:Other Models', { usedPercent: 96 }), [CURSOR_AUTO]);
  const d = route({ tier: 'frontier', agents: ['cursor'] }, withAuto, DEFAULT_CONFIG);
  expect(d).toMatchObject({ status: 'ok', route: { agent: 'cursor', model: 'auto', effort: null }, quality: null, confidence: 'medium' });
  expect(d.tier).toBeUndefined();
  expect(d.reasons).toContain('cursor auto: fallback, no named model could be routed (Cursor picks the model)');
  expect(route({ tier: 'frontier', agents: ['cursor'], noDowngrade: true }, withAuto, DEFAULT_CONFIG).status).toBe('wait');
  expect(route({ tier: 'frontier', agents: ['cursor'] }, withAuto, { ...DEFAULT_CONFIG, cursorAuto: false }).status).toBe('wait');
  const named = route({ tier: 'frontier', agents: ['cursor'] }, withCursorModels(env, [CURSOR_AUTO]), DEFAULT_CONFIG);
  expect(named.route?.model).not.toBe('auto'); expect(named.alternatives.some((a) => a.model === 'auto')).toBe(false);
});
it('a pinned agent with only unranked models still yields a decision', () => { /* cursor lists only { modelId: 'mystery-9' }; pins.frontier = { agent: 'cursor' } → status ok via claude, warnings contain 'preferred cursor skipped: not available (unranked: no evidence or estimate)' */ });
it('a pinned model is used even when it does not cover, and says so', () => { /* pins.frontier = { agent: 'claude', model: 'claude-sonnet-5-5' } → route Sonnet, reasons contain /preferred route does not cover the job: coding 80.9 < 84/ */ });
it('last-resort agents are tried before the Cursor auto fallback', () => { /* opencode has a covering model with no usage window; every other named model blocked; auto present → route opencode with the last-resort warning, not auto */ });
```

Keep the V1 tests that the spec lists as unchanged behaviour (bans, `--effort` constraint and its "no route supports effort" message, rejections, Orca switches, expired pools, stale usage, `formatLaunch`, `agentSkipReason`), updating only the models they expect per the fixture classes above.

- [ ] **Step 3: Run `npx vitest run tests/routing`** — expected: FAIL.
- [ ] **Step 4: Implement `needs.ts`, `adequacy.ts`; rewrite `router.ts`'s `routeOnce`, `collectCandidates`, `compareRanked`, `finish`, `alternative`, pins; delete `autoFirst`, `isLadderVendor` use and `scoreDetail`.** `effortPlan` uses `config.defaultEffort[requestedTier]` for `tier-default`.
- [ ] **Step 5: Run `npx vitest run && npx tsc --noEmit`** — expected: PASS (CLI tests may still fail on text; Task 11).
- [ ] **Step 6: Commit** — `git add src/routing/needs.ts src/routing/adequacy.ts src/routing/router.ts src/types.ts src/setup.ts src/cli.ts tests/routing/needs.test.ts tests/routing/adequacy.test.ts tests/routing/router.test.ts && git commit -m "feat: route by per-axis needs, lowest covering class and quota"`

---

### Task 10: Hand-out ledger

**Files:**
- Create: `src/routing/handouts.ts`, `tests/routing/handouts.test.ts`
- Modify: `src/routing/environment.ts` (`gather` applies live hand-outs to usage before building `env`; `Gathered` gains `handouts: Handout[]`), `src/routing/router.ts` (`describe`/`summary` append the pool note), `src/types.ts` (`UsagePool.handouts?: number`), `src/cli.ts` (`routeCommand` records a hand-out after an `ok` decision; `status` lists live hand-outs — JSON `handouts` array and a text line `hand-outs (last 10m): claude claude-opus-5-5 2m ago (weekly +5%)`), `tests/routing/environment.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: `interface Handout { at: number; agent: AgentId; model: string; pools: string[]; needs: Needs }`; `HANDOUTS_FILE = 'handouts.json'` in the cache dir, shape `{ handouts: Handout[] }`; `parseHandouts(text: string | undefined): Handout[]` (malformed → `[]`, entries missing a field dropped); `readHandouts(readFile, dir): Handout[]`; `liveHandouts(list, now, minutes): Handout[]` (`now - at < minutes·60000`); `recordHandout(h: Handout, minutes: number, dir = cacheDir()): void` (appends, drops expired, atomic write as `writeTable` does); `applyHandouts(usage: Record<AgentId, AgentUsage>, live: Handout[], percent: number): Record<AgentId, AgentUsage>` — pure copy where each live entry adds `percent` to `usedPercent` of every named pool that exists on that agent and increments `pool.handouts`; pools the agent no longer reports are ignored. Router: `describe` adds `; <n> worker(s) routed in the last <handoutMinutes>m, counted as +<n·percent>%` for the ranked pool when `handouts > 0`; a candidate whose ranked pool has `handouts` is capped at `medium` confidence.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds the percent per live entry and ignores stale, corrupt and unknown-pool entries', () => {
  const live = liveHandouts([{ at: NOW - 60_000, agent: 'claude', model: 'claude-opus-5-5', pools: ['weekly', 'gone'], needs }, { at: NOW - 11 * 60_000, agent: 'claude', model: 'x', pools: ['weekly'], needs }], NOW, 10);
  expect(live).toHaveLength(1);
  const usage = applyHandouts(env.usage, live, 5);
  expect(usage.claude.pools.weekly).toMatchObject({ usedPercent: 55, handouts: 1 });
  expect(parseHandouts('{')).toEqual([]); expect(parseHandouts(JSON.stringify({ handouts: [{ at: 1 }] }))).toEqual([]);
});
it('routing sees the adjustment: two hand-outs on Claude weekly make Cursor win Frontier and the reason says so', () => { /* apply 2 entries on claude weekly (+10 → 60% used → headroom below cursor's 20%) → route cursor claude-fable-5-1-high; reasons[0] of the claude alternative (or decision reasons) matches /2 workers routed in the last 10m, counted as \+10%/ */ });
it('recordHandout keeps only live entries and survives a corrupt file', () => { /* write '{' then record → file has one entry */ });
it('route records a hand-out and status lists it', async () => { /* CLI: route --tier daily --json → handouts.json has one entry with pools ['weekly'] and needs low/low/low; status --json → handouts length 1; status text has the hand-outs line */ });
```

- [ ] **Step 2: Run `npx vitest run tests/routing/handouts.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement.** In `gather`: `const live = liveHandouts(readHandouts(readFile, dir), now, config.handoutMinutes); usage = applyHandouts(usage, live, config.handoutPercent)`. In `routeCommand`: after `route(...)` with `status === 'ok'`, find the chosen model in `env.discoveries` by `launchIds` and call `recordHandout({ at: env.now, agent, model, pools: model.poolNames, needs: d.needs }, config.handoutMinutes, deps.cacheDir ?? cacheDir())`; a write failure only warns.
- [ ] **Step 4: Run `npx vitest run && npx tsc --noEmit`** — expected: PASS.
- [ ] **Step 5: Commit** — `git add src/routing/handouts.ts src/routing/environment.ts src/routing/router.ts src/types.ts src/cli.ts tests/routing/handouts.test.ts tests/routing/environment.test.ts tests/cli.test.ts && git commit -m "feat: remember recent hand-outs when ranking usage"`

---

### Task 11: CLI — `route --need`, `ranking`, `tiers --axis`, status/refresh text, JSON contract

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `scripts/test-package.mjs`

**Interfaces:**
- Produces: `route` options add `need: { type: 'string' }`; `--tier` no longer required: exactly one of `--need`/`--tier` (`--need is required (or --tier as a shorthand)`; both → `use either --need or --tier, not both`); `parseNeeds` errors are usage errors (exit 1, message printed with `USAGE`). `route --json` adds `needs`, `needsSource`, `quality`, `evidenceSource`, keeps `catalogSource` and `scoreSource` (same value), `placementsBuiltAt`. Text output: head line `frontier → claude · claude-opus-5-5 · high (high confidence)` as today, then reasons (which now include the needs and quality lines). New command `ranking [--axis <coding|agentic|reasoning>] [--json]`: text = one line per discovered model (deduplicated by `modelId`) sorted by class then need-weighted-equal score (`Σ S_a`), e.g. `claude-opus-5-5  frontier  coding 86.2 F measured(5)  agentic 81.3 F measured(4)  reasoning 89.0 F measured(4)  agents: claude, cursor  hint: family claude-opus (advanced)`; with `--axis`, sorted by that axis's score and showing only it; unranked axes print `unranked`; `--json` = `{ generatedAt, sources, bands, models: [{ id, class, hint, axes, agents }] }`. `tiers [--axis <a>] [--json]`: text = per axis the bands line `coding: light < 68 ≤ daily < 76 ≤ advanced < 84 ≤ frontier` then the models per band; `--json` = the table as today (schema 3) plus `age`. `status`: JSON replaces `catalog`/`scores`/`scored`/`scoreScale` with `evidence: { source, fetchedAt, generatedAt, models }` and `handouts`; `unclassified` lists models with `profile.class === null`; text first line `evidence: snapshot, 425 models (LLMBenchmark.ai, CC BY 4.0, data of 2026-11-10), fetched 3h ago`. `refresh`: text `evidence: network, 425 models (snapshot of 2026-11-10T04:00:00Z)` / stderr `could not reach the OrcaCompass repository; still using the cache from …`; JSON `{ evidence, placements }`. `USAGE` updated (route line shows `--need coding=<l>,agentic=<l>,reasoning=<l> | --tier <t>`, `ranking`, `tiers [--axis <axis>]`). `loadConfig` is called through a local `readConfig(io)` that passes `(m) => io.err(\`warning: ${m}\`)`. `scripts/test-package.mjs`: the help regex checks `route --need`, the data loop reads `evidence-snapshot.json` (`models.length > 0`) and `evidence-manifest.json` (`sha256` is 64 hex chars), the "removed" list adds `data/models-snapshot.json`, `data/modelindex-snapshot.json`, `dist/placements/sources/modelsdev.js`, `dist/placements/sources/modelindex.js`, `dist/placements/score.js`.

- [ ] **Step 1: Write the failing tests** in `tests/cli.test.ts`

```ts
it.each([['coding=high,agentic=mid', /must name all three axes/], ['coding=high,agentic=mid,reasoning=low,coding=min', /must name all three axes/], ['coding=huge,agentic=mid,reasoning=low', /must name all three axes/], ['coding = high, agentic=mid,reasoning=low', /must name all three axes/]])('rejects --need %s', async (need, re) => { expect(await main(['route', '--need', need], io, deps)).toBe(1); expect(err()).toMatch(re); });
it('accepts any axis order (levels and axes are lowercase only; uppercase is a usage error per Review Focus 1 and Task 9\'s parser)', async () => { expect(await main(['route', '--need', 'reasoning=low,coding=high,agentic=mid', '--json'], io, deps)).toBe(0); expect(JSON.parse(out())).toMatchObject({ needs: { coding: 'high', agentic: 'mid', reasoning: 'low' }, needsSource: 'need', evidenceSource: 'snapshot', scoreSource: 'snapshot', catalogSource: 'snapshot' }); expect(await main(['route', '--need', 'reasoning=LOW,coding=High,agentic=mid'], io, deps)).toBe(1); });
it('refuses --need with --tier and requires one of them', async () => { /* exit 1 both ways with the messages above */ });
it('route --json carries quality on the route and the alternatives', async () => { /* quality.axes.coding has score, band, evidence, benchmarks, need, cut */ });
it('ranking lists every discovered model once with three axes', async () => { /* text has one line matching /^claude-opus-5-5\s+frontier\s+coding 86\.2 F measured\(5\)/m; --axis coding sorts Opus above Fable 5.1; --json models[].axes */ });
it('tiers prints the bands per axis and takes --axis', async () => { /* /^coding: light < 68 ≤ daily < 76 ≤ advanced < 84 ≤ frontier$/m */ });
it('status reports the evidence source and hand-outs', async () => { /* JSON evidence.source 'snapshot', handouts []; text /^evidence: snapshot, \d+ models \(LLMBenchmark\.ai, CC BY 4\.0, data of \d{4}-\d{2}-\d{2}\)/m */ });
it('warns once about removed config keys', async () => { /* config file with scoreWeight → stderr has 'warning: scoreWeight is no longer used' exactly once for a route call */ });
```

Update the existing `metadata output` test (`not.toMatch(/benchmark/i)`) to `not.toMatch(/models\.dev|model index/i)`, and the `refresh`/`status`/`tiers` expectations to the new text.

- [ ] **Step 2: Run `npx vitest run tests/cli.test.ts`** — expected: FAIL.
- [ ] **Step 3: Implement the CLI changes and `scripts/test-package.mjs`.**
- [ ] **Step 4: Run `npx vitest run && npx tsc --noEmit && npm run build && npm run test:package`** — expected: PASS.
- [ ] **Step 5: Commit** — `git add src/cli.ts tests/cli.test.ts scripts/test-package.mjs && git commit -m "feat: add --need routing, ranking and per-axis tiers to the CLI"`

---

### Task 12: Skill, docs, README, changelog, version

**Files:**
- Modify: `skills/orcacompass/SKILL.md`, `README.md`, `docs/model-data.md`, `docs/tiers-and-routing.md`, `docs/commands.md`, `docs/configuration.md`, `docs/skill-workflow.md`, `docs/roadmap.md`, `docs/how-it-works.md`, `docs/effort.md`, `docs/models-and-agents.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, `SECURITY.md` (if it names Models.dev), `package.json` (`"version": "0.3.0"`), `tests/version.test.ts` (if it pins the version)
- Create: `CHANGELOG.md`

- [ ] **Step 1: Skill** (`skills/orcacompass/SKILL.md`): replace "Choose a task tier" with "Rate the three needs" using the rubric in spec 7.9 verbatim (per axis: `min`/`low`/`mid`/`high` with the examples); the route command example becomes `orcacompass route --need coding=mid,agentic=low,reasoning=low --demand moderate --tier-reason "..." --json`; keep `--tier` as "the rare job that is the same on all axes"; rename "reasoning demand" to "effort demand" everywhere (flag unchanged); replace the tier-derivation paragraph (family ladder, Model Index, price) with: profiles from LLMBenchmark evidence, hints as a nudge, class = highest band, fit group = lowest covering class, `orcacompass ranking`; explain `quality` (class, covers, shortfall, evidence labels; `estimated`/`assumed` are provisional and worth mentioning when asked why); say hand-outs are remembered so spreading workers over `alternatives` by hand is unnecessary; say Cursor `auto` is a fallback, not a recommendation; setup step 3 ("Favorites") still works per tier.
- [ ] **Step 2: Docs**: `docs/model-data.md` rewritten around the one data file (snapshot schema, where it comes from, the daily owner-run refresh and PR, the manifest check and `evidenceTtlHours`, the bundled fallback, licenses); `docs/tiers-and-routing.md` rewritten around profiles, needs, fit/downgrade groups, the Cursor `auto` fallback section replacing "Cursor Auto", confidence = usage only; `docs/commands.md` adds `ranking`, `tiers --axis`, `route --need`, the new JSON fields and `evidenceSource`; `docs/configuration.md` replaces `scoreWeight`/`modelsDevTtlHours` rows with `classWeight`, `handoutMinutes`, `handoutPercent`, `evidenceTtlHours`, rewrites the `cursorAuto` row and the "rebuild triggers" sentence (changed snapshot rebuilds the table); `docs/skill-workflow.md` mirrors the Skill; `docs/roadmap.md` removes what V2 delivers; `docs/effort.md` and `docs/models-and-agents.md` drop "Cursor Auto serves Light and Daily"; `README.md` short section update. Run `npm run docs:build` — expected: no broken internal links.
- [ ] **Step 3: `CHANGELOG.md`** with a `0.3.0` section: removed Model Index and Models.dev sources and the price term; removed `scoreWeight`, `modelsDevTtlHours` (warn), `scoreSource` kept one release as an alias of `evidenceSource`; new `--need`, `quality`, `needs`, `needsSource`, `evidenceSource`; new `ranking`, `tiers --axis`; hand-out ledger; Cursor `auto` now a fallback; placement table schema 3 (rebuilt on first run); evidence snapshot refreshed daily from LLMBenchmark.ai (CC BY 4.0).
- [ ] **Step 4: Bump `package.json` to 0.3.0**; run `npx vitest run && npm run build && npm run test:package && npm run docs:build` — expected: PASS.
- [ ] **Step 5: Commit** — `git add skills/orcacompass/SKILL.md README.md CHANGELOG.md docs/*.md SECURITY.md package.json package-lock.json tests/version.test.ts && git commit -m "docs: describe need-based routing and the evidence snapshot; release 0.3.0"` (stage only the files that changed; check `git status` first).

---

### Task 13: Whole-branch verification

- [ ] **Step 1:** `npm ci && npm test && npx tsc --noEmit && npm run build && npm run test:package && npm run docs:build` — all green.
- [ ] **Step 2:** `node dist/cli.js route --need coding=high,agentic=mid,reasoning=low --json` on this machine: the decision has `quality`, `evidenceSource`, no `Model Index`/`models.dev` strings anywhere in `status`, `tiers`, `ranking`, `refresh` output.
- [ ] **Step 3:** `node dist/cli.js ranking` shows Fable 5.2 (if Claude Code lists it) Frontier on all three axes with `measured`/`partial` labels, Sonnet 5.5 below Fable 5.1 on every axis, Haiku 5.5 Light on coding.
- [ ] **Step 4:** `grep -rn "scoreWeight\|modelsDevTtlHours\|models\.dev\|Model Index\|modelindex\|autoFirst\|CURSOR_AUTO_TIERS" src scripts docs skills README.md NOTICE` returns only the changelog, the config warnings and the spec/plan.
- [ ] **Step 5:** Do not push. Report the branch state (`git log --oneline main..HEAD`) to the owner for local review.

---

## Self-review notes

- Spec coverage: 7.2 identity/catalog and the Cursor pool fix → Tasks 1, 7, 8; 7.3 snapshot/refresh → Tasks 2–5; 7.4 profiles/calibration → Tasks 3, 7; 7.5 estimates → Tasks 4, 7; 7.6 decision, pins, fallback, hand-outs → Tasks 9, 10; 7.7 maintenance/manifest → Tasks 5, 8; 7.8 CLI/JSON/config → Tasks 6, 11; 7.9 Skill → Task 12; 7.10 tests/release/package → Tasks 11–13.
- Deviations recorded for the owner: `tier` is omitted (undefined) rather than `null` on a Cursor `auto` route; need-skips appear in `route --json`'s `skipped` but the text `skipped:` line lists at most six of them with "… n more"; `CHANGELOG.md` is new (the repository had none); fixture bands differ per axis (coding 68/76/84, agentic 60/70/80, reasoning 70/78/86) and the same values are the production starting bands — the calibration checks in Task 5 Step 5 decide whether they stay.
- Type consistency: `Profile`/`AxisProfile`/`EvidenceLabel` are defined once in `profiles.ts` and re-exported from `types.ts`; `Needs`/`Need` in `needs.ts`; `Quality` in `types.ts`; `Handout` in `handouts.ts`.
