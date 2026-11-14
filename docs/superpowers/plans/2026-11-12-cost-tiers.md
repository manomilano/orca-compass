# Cost Tiers From Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split "what a model can do" (benchmark evidence, unchanged) from "what it costs" (a cost tier from the maker's price in the snapshot), and route each job to the cheapest cost tier whose evidence covers the needs.

**Architecture:** The snapshot carries each model's maker price; `src/placements/profiles.ts` turns it into a cost tier next to the evidence class and drops the hint nudge on scores; `src/routing/router.ts` forms the fit group by cost tier instead of evidence class; the CLI shows both views. Bands are re-set on raw evidence and the calibration checks follow.

**Tech Stack:** Node ≥ 20, TypeScript (`tsc`), Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-orca-compass-v2-design.md`, section 10 (amendment of 2026-11-12); sections 7.4 and 7.6 as amended there.

## Global Constraints

- `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run test:package` and `npm run docs:build` pass at every commit.
- Routing stays a pure function of (environment, request, config); no I/O in `src/routing/router.ts`.
- Clients never contact LLMBenchmark at runtime; the raw dataset lives at `data/llmbenchmark/dataset.json` and never ships in the npm package.
- Price decides the **cost tier only**. No score, band or need cut ever reads a price.
- Blended price is `(3 · inputPerM + outputPerM) / 4`, rounded to two decimals; default `costBands` `[1, 5, 12]` USD per million blended (spec 10.2).
- Evidence scores are raw: `S_a = E_a`. `classWeight` is removed and only warns.
- Starting bands on raw evidence: coding `[70, 78, 82]`, agentic `[60, 72, 80]`, reasoning `[76, 84, 89]` (spec 10.3); the calibration checks of 10.3 must pass on `data/evidence-snapshot.json`.
- Every existing command, config key and `route --json` field keeps working; `quality.class` keeps meaning the evidence class.
- Release stays 0.3.0 (unreleased). Snapshot schema stays 1 (`pricing` is optional). Placement table schema becomes 4 (its `builtWith` shape changes).
- Repository rules: Conventional Commits; stage by explicit path, never `git add -A`; commit only on `manomilano/compass-v2`; **never push**.
- Code, identifiers, comments, commit messages and docs in English.

## Review Focus

1. A dataset model whose `pricing` is missing, `null`, or has a non-finite or negative number must produce a snapshot row **without** `pricing` and must not fail the refresh; the model then takes its cost tier from the hint or its evidence class. Test in Task 1.
2. `costBands` in config that are not three ascending non-negative numbers (`[5, 1, 12]`, `[1, 5]`, `["1", 5, 12]`) must be a config error naming `costBands`, never a silent default. Test in Task 2.
3. A `tierOverrides` entry must change the model's cost tier and leave its evidence bands untouched, so `--need` coverage still follows the benchmarks. Test in Task 2.
4. A cached placement table from the previous schema (3, with `classWeight` in `builtWith`) must be rejected and rebuilt silently, never crash `status`. Test in Task 2.
5. A day-0 model (no snapshot row, so no price) with a family hint must get its cost tier from the hint and still inherit evidence, so it stays routable on its first day. Test in Task 2.

---

## File structure

Modify:
- `src/evidence/snapshot.ts` — `pricing` on `SnapshotModel`, validation.
- `src/evidence/refresh.ts` — copy `pricing` from the dataset and curated rows; checks without `classWeight`; new calibration list.
- `src/placements/profiles.ts` — cost tier; raw scores; override semantics.
- `src/placements/table.ts`, `src/types.ts` — `BuiltWith` with `costBands`, placement schema 4, `CostTier`, `Quality.cost`.
- `src/config.ts` — `costBands`; `classWeight` warning.
- `src/routing/router.ts` — fit group and family rule by cost tier; cost line in reasons.
- `src/cli.ts` — `ranking` and `tiers` by cost tier; JSON additions.
- `scripts/refresh-evidence.mjs` — drop the class-weight argument.
- `data/evidence-snapshot.json`, `data/evidence-manifest.json` — rebuilt with pricing and the new bands; `data/evidence-curated.json` may gain `pricing`.
- `tests/fixtures/evidence-mini.json` — pricing per model; `tests/fixtures/evidence-bundled.json` — regenerated once from the new snapshot.
- Docs: `docs/tiers-and-routing.md`, `docs/configuration.md`, `docs/commands.md`, `docs/model-data.md`, `docs/how-it-works.md`, `docs/getting-started.md`, `README.md`, `skills/orcacompass/SKILL.md`, `CHANGELOG.md`.

## Shared vocabulary

```ts
// src/evidence/snapshot.ts
export interface SnapshotPricing { inputPerM: number; outputPerM: number; basis?: string }
export interface SnapshotModel { /* as today */ pricing?: SnapshotPricing }

// src/placements/profiles.ts
export type CostSource = 'override' | 'price' | 'family' | 'lineup' | 'evidence';
export interface CostTier { tier: Tier; blended: number | null; source: CostSource }
export interface Profile { class: Tier | null; cost: CostTier | null; hint: Classification | null; axes: Record<Axis, AxisProfile> }
export function blendedPrice(pricing: SnapshotPricing): number;              // (3·in + out) / 4, two decimals
export function costTierFor(modelId, meta, lineup, snapshotModel, evidenceClass, config): CostTier | null;

// src/config.ts
costBands: [number, number, number]   // default [1, 5, 12]; classWeight gone

// src/types.ts
export type BuiltWith = Pick<Config, 'tierOverrides' | 'costBands'>;
export interface Quality { class: Tier | null; cost: CostTier | null; /* rest as today */ }
// Decision.tier is the cost tier of the pick.
```

Fixture prices for `tests/fixtures/evidence-mini.json` (USD per million, maker basis; blended and cost tier with `[1, 5, 12]`):

| id | inputPerM | outputPerM | blended | cost tier |
| --- | --- | --- | --- | --- |
| claude-haiku-5-5 | 0.1 | 0.5 | 0.20 | light |
| claude-sonnet-5-5 | 2 | 10 | 4.00 | daily |
| claude-opus-5-5 | 4 | 20 | 8.00 | advanced |
| claude-opus-5 | 5 | 25 | 10.00 | advanced |
| claude-fable-5-1 | 10 | 50 | 20.00 | frontier |
| claude-fable-5-2 | 8 | 40 | 16.00 | frontier |
| gpt-6-luna | 0.1 | 0.5 | 0.20 | light |
| gpt-6-1-terra | 1 | 5 | 2.00 | daily |
| gpt-6-1-sol | 2 | 10 | 4.00 | daily |
| gpt-6-astra | 10 | 50 | 20.00 | frontier |
| composer-2-5 | — | — | — | advanced (no price, no hint: its evidence class, coding 80.0 on the fixture bands) |

The mini fixture keeps its bands (coding 68/76/84, agentic 60/70/80, reasoning 70/78/86); only the production snapshot moves to the spec 10.3 bands. With raw scores the fixture's evidence classes are: Haiku Light (68.5 coding is Daily on 68, 53.5 agentic Light, 74.7 reasoning Daily → class **Daily**); Sonnet Frontier (coding 84.3 ≥ 84); Opus 5.5 Frontier; Opus 5 Advanced; Fable 5.1 Frontier; Fable 5.2 Frontier; Luna Light (66.0 / 50.0 / 70.0 → reasoning Daily → **Daily**); Terra Advanced (77.5 coding); Sol Advanced (82.2 / 78.0 / 83.0); Astra Frontier; Composer Advanced (coding 80.0). These classes only matter for display, `unclassified`, and the `evidence` fallback; routing groups by cost tier.

---

### Task 1: Price in the snapshot

**Files:**
- Modify: `src/evidence/snapshot.ts`, `src/evidence/refresh.ts` (`DatasetModel`, `buildSnapshot`, `mergeCurated`), `tests/fixtures/evidence-mini.json`, `data/evidence-curated.json`
- Test: `tests/evidence/snapshot.test.ts`, `tests/evidence/refresh.test.ts`

**Interfaces:**
- Produces: `SnapshotPricing`, `SnapshotModel.pricing?`; `parseSnapshot` accepts a model with no `pricing`, with `pricing: { inputPerM, outputPerM }` (finite, ≥ 0) optionally plus a string `basis`, and rejects any other shape; `buildSnapshot` copies `pricing` when the dataset row has finite non-negative `inputPerM` and `outputPerM` (keeping `basis` when it is a string) and omits it otherwise; `mergeCurated` keeps a curated row's `pricing` after the same validation.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/evidence/snapshot.test.ts
it('accepts a model with maker pricing and one without', () => {
  const priced = { ...mini, models: [{ ...mini.models[0], pricing: { inputPerM: 2, outputPerM: 10, basis: 'maker' } }, mini.models[1]] };
  expect(parseSnapshot(JSON.stringify(priced))?.models[0].pricing).toEqual({ inputPerM: 2, outputPerM: 10, basis: 'maker' });
});
it.each([{ inputPerM: -1, outputPerM: 1 }, { inputPerM: 1 }, { inputPerM: '2', outputPerM: 10 }, { inputPerM: Infinity, outputPerM: 1 }, null])('rejects malformed pricing %j', (pricing) => {
  expect(parseSnapshot(JSON.stringify({ ...mini, models: [{ ...mini.models[0], pricing }] }))).toBeUndefined();
});
// tests/evidence/refresh.test.ts
it('copies maker pricing from the dataset and drops unusable prices', () => {
  const built = buildSnapshot(dataset, opts);   // llmb-dataset-mini: claude-sonnet-5.5 has inputPerM 2, outputPerM 10, basis 'maker'
  expect(built.models.find((m) => m.id === 'claude-sonnet-5-5')?.pricing).toEqual({ inputPerM: 2, outputPerM: 10, basis: 'maker' });
  const broken = structuredClone(dataset); broken.models.find((m) => m.slug === 'claude-sonnet-5-5').pricing = { inputPerM: null, outputPerM: 10 };
  expect(buildSnapshot(broken, opts).models.find((m) => m.id === 'claude-sonnet-5-5')?.pricing).toBeUndefined();
});
it('keeps a curated row\'s pricing', () => {
  const merged = mergeCurated([], { models: [{ id: 'composer-2-5', provider: 'cursor', name: 'Composer 2.5', results: [], pricing: { inputPerM: 1.25, outputPerM: 6 } }] });
  expect(merged[0].pricing).toEqual({ inputPerM: 1.25, outputPerM: 6 });
});
```

Check the fixture first: `node -e "const d=require('./tests/fixtures/llmb-dataset-mini.json');console.log(d.models.find(m=>m.slug==='claude-sonnet-5-5').pricing)"`. If the trimmed dataset has no `pricing`, add the maker prices from the table in Shared vocabulary to its rows (it is a fixture, not the real dataset).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/evidence/snapshot.test.ts tests/evidence/refresh.test.ts`
Expected: FAIL (pricing is dropped by `parseSnapshot`'s whitelist or undefined after `buildSnapshot`).

- [ ] **Step 3: Implement** `SnapshotPricing` and the validation in `snapshot.ts`; extend `DatasetModel` with `pricing?: { inputPerM?: unknown; outputPerM?: unknown; basis?: unknown } | null` and copy it in `buildSnapshot` through one helper `validPricing(raw: unknown): SnapshotPricing | undefined` shared with `mergeCurated`.

- [ ] **Step 4: Add `pricing` to every priced model in `tests/fixtures/evidence-mini.json`** (table above; Composer has none). Add `pricing` to the Composer row of `data/evidence-curated.json` only if cursor.com publishes per-token API prices for Composer 2.5 (cite the URL in a `priceUrl` field next to it); otherwise leave it out and say so in the commit body.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (fixture changes are additive).

- [ ] **Step 6: Commit**

```bash
git add src/evidence/snapshot.ts src/evidence/refresh.ts tests/evidence/snapshot.test.ts tests/evidence/refresh.test.ts tests/fixtures/evidence-mini.json tests/fixtures/llmb-dataset-mini.json data/evidence-curated.json
git commit -m "feat: carry maker pricing in the evidence snapshot"
```

---

### Task 2: Cost tier in profiles, raw scores, config, calibration and the rebuilt snapshot

**Files:**
- Modify: `src/placements/profiles.ts`, `src/config.ts`, `src/types.ts`, `src/placements/table.ts`, `src/evidence/refresh.ts` (`snapshotProfile`, `diffSnapshots`, `calibrationChecks`, `calibrationWarnings`, `crossAxisFindings`), `scripts/refresh-evidence.mjs`, `data/evidence-snapshot.json`, `data/evidence-manifest.json`
- Test: `tests/placements/profiles.test.ts`, `tests/config.test.ts`, `tests/placements/table.test.ts`, `tests/evidence/refresh.test.ts`

**Interfaces:**
- Consumes: `SnapshotModel.pricing` (Task 1).
- Produces: `CostSource`, `CostTier`, `Profile.cost`, `blendedPrice(pricing): number`, `costTierFor(...)` as in Shared vocabulary; `Config.costBands`, `DEFAULT_CONFIG.costBands = [1, 5, 12]`; `BuiltWith = Pick<Config, 'tierOverrides' | 'costBands'>`; `PLACEMENT_SCHEMA = 4`; `diffSnapshots(previous, next)`, `calibrationChecks(snapshot)`, `calibrationWarnings(snapshot)` without a weight argument.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/placements/profiles.test.ts (fixture evidence-mini with pricing; bands as in the fixture)
it('scores are the raw evidence; hints no longer move them', () => {
  expect(p('claude-sonnet-5-5').axes.coding.score).toBe(84.3);
  expect(p('claude-haiku-5-5').axes.coding).toMatchObject({ score: 68.5, band: 'daily' });
});
it('cost tier comes from the blended maker price', () => {
  expect(p('claude-sonnet-5-5').cost).toEqual({ tier: 'daily', blended: 4, source: 'price' });
  expect(p('claude-opus-5-5').cost).toEqual({ tier: 'advanced', blended: 8, source: 'price' });
  expect(p('claude-fable-5-2').cost).toEqual({ tier: 'frontier', blended: 16, source: 'price' });
  expect(p('claude-haiku-5-5').cost).toEqual({ tier: 'light', blended: 0.2, source: 'price' });
});
it('falls back to the hint, then the evidence class, when there is no price', () => {
  expect(p('claude-fable-5-5').cost).toEqual({ tier: 'frontier', blended: null, source: 'family' });   // day-0: no row, hint frontier, evidence inherited
  expect(p('claude-fable-5-5').axes.coding.label).toBe('assumed');
  expect(p('composer-2.5').cost).toEqual({ tier: 'advanced', blended: null, source: 'evidence' });    // no price, no hint; evidence class
  expect(p('mystery').cost).toBeNull();
});
it('an override sets the cost tier and leaves the evidence bands alone', () => {
  const cfg = { ...DEFAULT_CONFIG, tierOverrides: { 'claude-sonnet-5-5': 'light' as const } };
  const sonnet = p('claude-sonnet-5-5', undefined, cfg);
  expect(sonnet.cost).toEqual({ tier: 'light', blended: 4, source: 'override' });
  expect(sonnet.axes.coding.band).toBe('frontier');
});
it('costBands move the cuts', () => {
  expect(p('claude-sonnet-5-5', undefined, { ...DEFAULT_CONFIG, costBands: [1, 3, 12] }).cost?.tier).toBe('advanced');
});
// tests/config.test.ts
it('reads costBands and rejects malformed ones', () => {
  write('{"costBands":[0.5,4,10]}'); expect(loadConfig().costBands).toEqual([0.5, 4, 10]);
  for (const bad of ['[5,1,12]', '[1,5]', '["1",5,12]', '[-1,5,12]']) { write(`{"costBands":${bad}}`); expect(configErrorOf(loadConfig).message).toMatch(/costBands/); }
});
it('warns that classWeight is no longer used', () => {
  write('{"classWeight":0.3}'); const warnings: string[] = []; loadConfig((w) => warnings.push(w));
  expect(warnings).toContain('classWeight is no longer used (OrcaCompass 0.3 scores models by evidence alone; cost tiers come from price, see costBands)');
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
});
// tests/placements/table.test.ts
it('rejects a schema 3 table and reports builtWith with costBands', () => {
  expect(readTable(tableFixture({ schemaVersion: 3, builtWith: { classWeight: 0.1, tierOverrides: {} } }))).toBeUndefined();
  expect(builtWith(DEFAULT_CONFIG)).toEqual({ tierOverrides: {}, costBands: [1, 5, 12] });
});
// tests/evidence/refresh.test.ts
it('calibration passes on the mini dataset with the spec bands and no longer compares Sonnet to Fable', () => {
  const built = buildSnapshot(dataset, { ...opts, bands: { coding: [70, 78, 82], agentic: [60, 72, 80], reasoning: [76, 84, 89] } });
  expect(calibrationChecks(built)).toEqual([]);
});
```

Replace the existing `classWeight` expectations in these files (`classWeight: 0.1` in the default config, the `classWeight: 0`/`1` score tests, `builtWith` shapes) rather than keeping them beside the new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/placements tests/config.test.ts tests/evidence/refresh.test.ts`
Expected: FAIL (`cost` undefined, `costBands` unknown, scores still nudged).

- [ ] **Step 3: Implement**
  - `profiles.ts`: delete `CLASS_POINTS` and the nudge (`score = evidence.score`); `band` from the raw score for every source (an override no longer sets bands); add `blendedPrice`, `costTierFor` in the source order of spec 10.2 (override by id then family → `pricing` → `hintFor` family/lineup → evidence class → null) and set `profile.cost` after `profile.class`.
  - `config.ts`: `costBands` parsed with a new `bands(value, key)` helper (array of exactly three finite non-negative ascending numbers); `classWeight` removed from `Config` and `DEFAULT_CONFIG`; the warning text above next to the `scoreWeight` warning.
  - `types.ts`: `CostTier`, `Quality.cost`, `BuiltWith`; `table.ts`: schema 4, validate `builtWith.costBands` and `profile.cost` (`null` or `{ tier, blended: number | null, source }`).
  - `refresh.ts`: drop the weight parameter everywhere (`snapshotProfile` builds with `DEFAULT_CONFIG`); `calibrationChecks` list becomes `[['claude-haiku-5-5','light'],['gpt-6-1-terra','daily'],['claude-opus-5-5','frontier'],['claude-fable-5-1','frontier'],['gpt-6-astra','frontier']]` on coding, plus `crossAxisFindings`; delete the Fable-over-Sonnet loop. `scripts/refresh-evidence.mjs`: remove `CLASS_WEIGHT` and the argument.

- [ ] **Step 4: Rebuild the production snapshot with the new bands**

Edit `bands` in `data/evidence-snapshot.json` to `{"coding":[70,78,82],"agentic":[60,72,80],"reasoning":[76,84,89]}` (the script retains the previous snapshot's bands), then:

Run: `npm run build && node scripts/refresh-evidence.mjs --diff "$TEMP/cost-tiers-diff.md"`
Expected: `Calibration checks passed`, 431 models written, and the diff shows the band moves. If a check fails, adjust the failing band by the smallest step that passes and record the final values in the commit body and in spec 10.3.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS except `tests/cli.test.ts`, `tests/setup.test.ts` and `tests/routing/*` (they change in Tasks 3 and 4; list the failures in the commit body).

- [ ] **Step 6: Commit**

```bash
git add src/placements/profiles.ts src/config.ts src/types.ts src/placements/table.ts src/evidence/refresh.ts scripts/refresh-evidence.mjs data/evidence-snapshot.json data/evidence-manifest.json tests/placements/profiles.test.ts tests/config.test.ts tests/placements/table.test.ts tests/evidence/refresh.test.ts
git commit -m "feat: derive a cost tier from price and score models on raw evidence"
```

---

### Task 3: Route by cost tier

**Files:**
- Modify: `src/routing/router.ts` (`collectCandidates`, `newestPerFamilyClass` → `newestPerFamilyTier`, `evaluate`, `needLine`, `finish`), `src/types.ts` (`Decision.tier` doc comment)
- Test: `tests/routing/router.test.ts`, `tests/placements/local-models.test.ts`

**Interfaces:**
- Consumes: `Profile.cost` (Task 2).
- Produces: `Candidate.tier = model.profile.cost?.tier ?? null`; `Quality.cost = model.profile.cost`; `Decision.tier` is the pick's cost tier; reasons gain `fit group: <tier> cost tier (<n> models)` (replacing `… class (…)`) and, with a route, `cost: <tier> (<$x.xx/M blended, maker price | your override | family hint | provider's lineup | evidence class, no price>)`.

- [ ] **Step 1: Write the failing tests** (machine fixture: claude weekly 50 % used, resets in 14 h; codex weekly 20 %, resets in 5.8 d)

```ts
it('daily: Sonnet is a Daily-cost model that covers, and has more headroom than Codex Terra', () => {
  expect(r({ tier: 'daily' })).toMatchObject({ status: 'ok', tier: 'daily', route: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } });
  expect(r({ tier: 'daily' }).reasons).toContain('fit group: daily cost tier (3 models)');       // Terra, Sonnet, Sol (Cursor Sonnet shares the profile but is a 4th route: assert the number the fixture gives and say why in a comment)
  expect(r({ tier: 'daily' }).reasons.some((s) => s.startsWith('cost: daily ($4.00/M blended, maker price)'))).toBe(true);
});
it('advanced: Sonnet covers mid on every axis and is the cheapest tier that does', () => {
  expect(r({ tier: 'advanced' })).toMatchObject({ tier: 'daily', upgraded: false, route: { model: 'claude-sonnet-5-5' } });
});
it('frontier: Opus 5.5 is Advanced cost and covers; Fable 5.2 is reached only when Opus cannot be', () => {
  expect(r({ tier: 'frontier' })).toMatchObject({ tier: 'advanced', route: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  expect(r({ tier: 'frontier' }).quality).toMatchObject({ class: 'frontier', cost: { tier: 'advanced', blended: 8, source: 'price' } });
});
it('light: only Light-cost models form the group', () => {
  const d = r({ tier: 'light' });
  expect(d.route).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  expect([d.route, ...d.alternatives].every((a) => a && ['claude-haiku-5-5', 'gpt-6-luna'].some((id) => a.model.startsWith(id)))).toBe(true);
});
it('a blocked fit group downgrades instead of buying a dearer tier', () => {
  const blocked = withPool(withPool(env, 'codex', 'weekly', { usedPercent: 96 }), 'claude', 'weekly', { usedPercent: 96 });
  expect(route({ tier: 'daily' }, blocked, DEFAULT_CONFIG)).toMatchObject({ status: 'ok', downgraded: true, route: { model: 'claude-haiku-5-5' } });
});
it('an older release of the same cost tier is hidden; a cheaper older release stays', () => {
  // Opus 5 ($10, advanced) hides behind Opus 5.5 ($8, advanced); Sonnet 4.6 at $6 would be advanced cost and stay visible next to Sonnet 5.5 at $4 (daily).
  expect(r({ tier: 'frontier' }).alternatives.some((a) => a.model === 'claude-opus-5')).toBe(false);
});
```

Rewrite the Grok test of 2026-11-12: give the three Grok rows `pricing: { inputPerM: 2, outputPerM: 6 }` (Daily cost, $3.00); assert that a Light job routes to Haiku or Luna with no Grok in the group, that a Daily job skips `grok-4.7` with `below need on …`, and that `grok-4.5` and `grok-4.6` appear nowhere (hidden behind 4.7 in the same cost tier). Update the Fable 5.5 / `gpt-6.2-astra` tests in `local-models.test.ts` only if they fail: day-0 models take the cost tier from the family hint, so the newest-per-tier rule keeps them ahead of their priced siblings.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routing/router.test.ts`
Expected: FAIL (daily still routes to Terra; reasons say `class`).

- [ ] **Step 3: Implement** in `router.ts`: `tier: model.profile.cost?.tier ?? null` in `evaluate` and `cost` in `quality`; the unranked skip in `collectCandidates` stays on `profile.class === null`; `newestPerFamilyTier` keys on `profile.cost?.tier ?? 'unclassified'`; `needLine` and the new cost line in `finish` (source words as in Interfaces).

- [ ] **Step 4: Run the routing and placement tests**

Run: `npx vitest run tests/routing tests/placements && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routing/router.ts src/types.ts tests/routing/router.test.ts tests/placements/local-models.test.ts
git commit -m "feat: route to the cheapest cost tier whose evidence covers the job"
```

---

### Task 4: CLI and setup output, JSON contract, frozen CLI fixture

**Files:**
- Modify: `src/cli.ts` (`rankingModels`, ranking text and JSON, `tiersText`, status `tiers`), `src/setup.ts` (labels only if they name "class"), `tests/fixtures/evidence-bundled.json` (regenerated), `docs/commands.md` (JSON contract)
- Test: `tests/cli.test.ts`, `tests/setup.test.ts`

**Interfaces:**
- Consumes: `Profile.cost`, `Quality.cost`, `Decision.tier` (Tasks 2–3).
- Produces: `ranking` text rows `<id>  <cost tier> <$x.xx/M|no price> <source>  evidence <class|unranked>  coding …  agentic …  reasoning …  agents: …` ordered by cost tier (frontier first), then evidence class, then need-weighted score, then id; `ranking --json` models gain `cost`; `tiers` groups by cost tier with a `cost: light < $1 ≤ daily < $5 ≤ advanced < $12 ≤ frontier (per million tokens, 3:1 blended)` header line, and `tiers --axis` unchanged; `status` tiers unchanged in shape (they come from `route`).

- [ ] **Step 1: Regenerate the frozen fixture**

Run: `cp data/evidence-snapshot.json tests/fixtures/evidence-bundled.json`
This is the one-time refresh spec 10.8 allows; it stays frozen afterwards.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/cli.test.ts
it('ranking shows the cost tier with its price next to the evidence class', async () => {
  expect(await main(['ranking'], io, deps)).toBe(0);
  expect(out()).toMatch(/^claude-sonnet-5-5\s+daily \$4\.00\/M price\s+evidence (advanced|frontier)\s+coding 84\.3 F measured\(5\)/m);
  stdout = [];
  expect(await main(['ranking', '--json'], io, deps)).toBe(0);
  const r = JSON.parse(out());
  expect(r.models.find((m: { id: string }) => m.id === 'claude-sonnet-5-5')).toMatchObject({ cost: { tier: 'daily', blended: 4, source: 'price' } });
  expect(r.models[0].cost.tier).toBe('frontier');
});
it('tiers groups models by cost tier and still prints evidence bands per axis', async () => {
  expect(await main(['tiers'], io, deps)).toBe(0);
  expect(out()).toMatch(/^cost: light < \$1 ≤ daily < \$5 ≤ advanced < \$12 ≤ frontier/m);
  expect(out()).toMatch(/^daily:\n(.*\n)*? {2}claude claude-sonnet-5-5 /m);
  stdout = [];
  expect(await main(['tiers', '--axis', 'coding'], io, deps)).toBe(0);
  expect(out()).toMatch(/^coding: light < 70 ≤ daily < 78 ≤ advanced < 82 ≤ frontier$/m);
});
it('route --json carries quality.cost and the cost reason line', async () => {
  expect(await main(['route', '--tier', 'daily', '--json'], io, deps)).toBe(0);
  const d = JSON.parse(out());
  expect(d.quality.cost).toEqual({ tier: 'daily', blended: 4, source: 'price' });
  expect(d.reasons.some((s: string) => s.startsWith('cost: daily ('))).toBe(true);
});
```

Then update every existing assertion in `tests/cli.test.ts` and `tests/setup.test.ts` that pins a nudged score (64.2 → the raw value in the regenerated fixture), a `… class (n models)` reason, or an evidence-class pick that the cost tier changes (Daily and Advanced now route to Sonnet on the fixture machine; Frontier to Opus 5.5). Keep each test's intent and say in a comment why the number moved.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts tests/setup.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 4: Implement** the `ranking` row and ordering, the `cost` field in `ranking --json`, the cost-tier grouping and header in `tiersText` (keep the per-axis section under `--axis`), and the contract rows in `docs/commands.md` (`quality.cost`, ranking `cost`, the two new reason lines).

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit && npm run build && npm run test:package`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/setup.ts tests/cli.test.ts tests/setup.test.ts tests/fixtures/evidence-bundled.json docs/commands.md
git commit -m "feat: show cost tiers in ranking, tiers and route output"
```

---

### Task 5: Skill, docs and changelog

**Files:**
- Modify: `skills/orcacompass/SKILL.md` (sections "Route, then launch", "Handle the result", the `tiers`/`ranking` sentences), `docs/tiers-and-routing.md`, `docs/configuration.md` (`costBands` row, remove `classWeight`, `builtWith`), `docs/model-data.md` (pricing in the snapshot; delete "No token prices are used"), `docs/how-it-works.md`, `docs/getting-started.md`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the output of Task 4.

- [ ] **Step 1: Write the docs** in the words of spec 10.5–10.7: the fit group is "the cheapest cost tier whose evidence covers the job, then the most headroom"; `tiers` is the cost-tier view, `ranking` the evidence view; `costBands` default `[1, 5, 12]`, blended 3:1; price decides the cost tier only. Add to `CHANGELOG.md` under 0.3.0: "Models get a cost tier from their maker price (LLMBenchmark pricing, blended 3:1, `costBands`); routing takes the cheapest cost tier whose evidence covers the job. Scores are raw evidence; `classWeight` is removed and warns. Placement table schema 4."

- [ ] **Step 2: Verify**

Run: `npm run docs:build && grep -rn "classWeight" README.md docs/*.md skills/ | grep -v "no longer used"`
Expected: build complete; the grep prints nothing.

- [ ] **Step 3: Commit**

```bash
git add skills/orcacompass/SKILL.md docs/tiers-and-routing.md docs/configuration.md docs/model-data.md docs/how-it-works.md docs/getting-started.md README.md CHANGELOG.md
git commit -m "docs: describe cost tiers and evidence-only scoring"
```

---

### Task 6: Whole-branch verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Clean install and full checks**

Run: `npm ci && npm test && npx tsc --noEmit && npm run build && npm run test:package && npm run docs:build`
Expected: all pass; the test count is at least the 700 of the previous branch state.

- [ ] **Step 2: Leftover scan**

Run: `grep -rn "classWeight\|CLASS_POINTS\|class (" src scripts skills docs/*.md README.md | grep -v "no longer used"`
Expected: nothing (the warning text is the only mention).

- [ ] **Step 3: Smoke on the owner's machine** (read-only; delete `handouts.json` from the cache dir before and after so the ledger stays clean)

Run: `node dist/cli.js route --tier daily --effort medium` and `node dist/cli.js ranking | head -12`
Expected: Daily routes to `claude claude-sonnet-5-5` with `cost: daily ($4.00/M blended, maker price)`; the ranking's first rows are Frontier-cost models and Sonnet shows `daily $4.00/M price  evidence …`.

- [ ] **Step 4: Report** the commands, their results and any deviation from the plan; no commit unless something was fixed.

---

## Self-review notes

- Spec coverage: 10.2 price, blended and bands (Tasks 1–2); source order, day-0 (Task 2); 10.3 raw scores, bands, checks (Task 2); 10.4 fit group, per-tier family rule, `Decision.tier`, `quality.cost`, worked example (Task 3); 10.5 output (Task 4); 10.6 snapshot and config (Tasks 1–2); 10.7 Skill (Task 5); 10.8 frozen fixture (Task 4).
- Type consistency: `CostTier`, `Profile.cost`, `Quality.cost`, `costBands`, `newestPerFamilyTier`, `calibrationChecks(snapshot)` are the names used throughout.
- The mini fixture's evidence classes shift because the nudge is gone (Haiku and Luna become Daily by their reasoning scores on the fixture bands); routing no longer groups by class, so only display tests feel it. Task 4 owns those updates.
