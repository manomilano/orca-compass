#!/usr/bin/env node
// Build first with npm run build. Reads the LLMBenchmark dataset committed at
// data/llmbenchmark/dataset.json (or --from <file>; --fetch downloads a fresh copy
// there first) and rebuilds data/evidence-snapshot.json and its manifest. Existing
// snapshot bands are retained; to change the cuts, edit the previous snapshot's
// bands before running this script. data/evidence-archive.json keeps every score row
// the dataset has published; rows the dataset dropped come back from it for 180 days.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mergeArchive, parseArchive, RETAIN_DAYS, serializeArchive } from '../dist/evidence/archive.js';
import { planRefresh, serializeManifest } from '../dist/evidence/refresh.js';
import { AXIS_WEIGHTS, BENCHMARKS } from '../dist/evidence/scoring.js';
import { parseSnapshot } from '../dist/evidence/snapshot.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET_URL = 'https://llmbenchmark.ai/data/dataset.json';
const DATASET_PATH = join(root, 'data', 'llmbenchmark', 'dataset.json');
const METHODOLOGY_URL = 'https://llmbenchmark.ai/methodology';

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function checkMethodology() {
  try {
    const text = (await getText(METHODOLOGY_URL)).replace(/<[^>]*>/g, ' ')
      .replace(/&(?:ndash|mdash);|&#(?:8211|8212);|&#x201[34];/gi, '–').replace(/&nbsp;|&#160;/gi, ' ');
    for (const weight of new Set(Object.values(AXIS_WEIGHTS).flatMap((weights) => Object.values(weights)))) {
      if (!new RegExp(`\\b${weight}\\s*%`).test(text)) console.error(`Warning: methodology no longer mentions weight ${weight}%`);
    }
    for (const range of new Set(Object.values(BENCHMARKS).map(({ range }) => range.join(':')))) {
      const [low, high] = range.split(':');
      const formatted = (value) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',?');
      if (!new RegExp(`\\b${formatted(low)}\\s*(?:%\\s*)?(?:[–—-]|to)\\s*${formatted(high)}\\b`, 'i').test(text)) {
        console.error(`Warning: methodology no longer mentions range ${low}–${high}`);
      }
    }
  } catch (error) {
    console.error(`Warning: methodology check unavailable: ${error.message}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, out: { type: 'string' }, diff: { type: 'string' },
    fetch: { type: 'boolean', default: false },
    'check-methodology': { type: 'boolean', default: false },
  } });
  const out = resolve(values.out ?? join(root, 'data'));
  const snapshotPath = join(out, 'evidence-snapshot.json');
  const previousText = await optionalText(snapshotPath);
  const previous = parseSnapshot(previousText);
  if (previousText !== undefined && !previous) throw new Error('previous evidence snapshot unreadable');
  const curatedText = await optionalText(join(root, 'data', 'evidence-curated.json'));
  const curated = curatedText === undefined ? undefined : JSON.parse(curatedText);
  if (values['check-methodology']) await checkMethodology();

  const from = resolve(values.from ?? DATASET_PATH);
  if (values.fetch) {
    if (values.from) throw new Error('--fetch replaces the repository dataset; it cannot be combined with --from');
    await mkdir(dirname(from), { recursive: true });
    await writeFile(from, await getText(DATASET_URL));
    console.log(`Fetched ${DATASET_URL} to ${from}`);
  }
  const datasetText = await optionalText(from);
  if (datasetText === undefined) throw new Error(`dataset not found: ${from} (commit it there, pass --from <file>, or use --fetch)`);
  const archivePath = join(out, 'evidence-archive.json');
  const archiveText = await optionalText(archivePath);
  const merged = mergeArchive(parseArchive(archiveText), JSON.parse(datasetText));
  const dataset = merged.dataset;
  const manifestPath = join(out, 'evidence-manifest.json');
  const plan = planRefresh({ dataset, now: new Date().toISOString(), previous, previousText,
    previousManifestText: await optionalText(manifestPath), curated });
  for (const warning of plan.warnings) console.error(`WARNING: ${warning}`);
  if (plan.failures.length) {
    for (const failure of plan.failures) console.error(`Calibration failed: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('Calibration checks passed');
  const retained = merged.retained.length ? [
    `Kept ${merged.retained.length} score rows for ${new Set(merged.retained.map((row) => row.modelId)).size} models that the dataset no longer has, ` +
    `last seen ${merged.retained.map((row) => row.lastSeen).sort()[0]} or later (rows return for ${RETAIN_DAYS} days).`, ''] : [];
  const diff = ['# Evidence snapshot refresh', '', ...(plan.changed ? (plan.diff.length ? plan.diff : ['No model profile changes.']) : ['No changes.']), '', ...retained].join('\n');
  await mkdir(out, { recursive: true });
  const nextArchiveText = serializeArchive(merged.archive);
  if (nextArchiveText !== archiveText?.replace(/\r\n/g, '\n')) await writeFile(archivePath, nextArchiveText);
  if (plan.writeSnapshot) await writeFile(snapshotPath, plan.text);
  if (plan.writeManifest) await writeFile(manifestPath, serializeManifest(plan.manifest));
  if (values.diff) await writeFile(values.diff, diff);
  if (plan.changed) console.log(`Wrote ${plan.snapshot.models.length} models (${plan.manifest.bytes} bytes) to ${snapshotPath}`);
  else console.log(`Evidence unchanged (${plan.snapshot.models.length} models); kept ${snapshotPath}${plan.writeManifest ? ' and rewrote its stale manifest' : ''}`);
  console.log(diff);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
