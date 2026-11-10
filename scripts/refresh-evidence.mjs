#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSnapshot, calibrationChecks, calibrationWarnings, DEFAULT_BANDS, diffSnapshots } from '../dist/evidence/refresh.js';
import { AXIS_WEIGHTS, BENCHMARKS } from '../dist/evidence/scoring.js';
import { parseSnapshot } from '../dist/evidence/snapshot.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET_URL = 'https://llmbenchmark.ai/data/dataset.json';
const METHODOLOGY_URL = 'https://llmbenchmark.ai/methodology';
const CLASS_WEIGHT = 0.10;

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

function serializeSnapshot(snapshot) {
  const { models, ...header } = snapshot;
  const start = JSON.stringify(header, null, 2).slice(0, -2);
  return `${start},\n  "models": [\n${models.map((model) => `    ${JSON.stringify(model)}`).join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, out: { type: 'string' }, diff: { type: 'string' },
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

  let temporary;
  try {
    let from = values.from;
    if (!from) {
      temporary = await mkdtemp(join(tmpdir(), 'orcacompass-evidence-'));
      from = join(temporary, 'dataset.json');
      await writeFile(from, await getText(DATASET_URL));
    }
    const dataset = JSON.parse(await readFile(from, 'utf8'));
    const now = new Date().toISOString();
    const snapshot = buildSnapshot(dataset, { now, sourceFetchedAt: now, bands: previous?.bands ?? DEFAULT_BANDS, curated });
    const failures = calibrationChecks(snapshot, CLASS_WEIGHT);
    for (const warning of calibrationWarnings(snapshot, CLASS_WEIGHT)) console.error(`WARNING: ${warning}`);
    if (failures.length) {
      for (const failure of failures) console.error(`Calibration failed: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log('Calibration checks passed');
    const bytes = Buffer.from(serializeSnapshot(snapshot));
    const manifest = { generatedAt: snapshot.generatedAt, schemaVersion: snapshot.schemaVersion,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const lines = diffSnapshots(previous, snapshot, CLASS_WEIGHT);
    const diff = ['# Evidence snapshot refresh', '', ...(lines.length ? lines : ['No model profile changes.']), ''].join('\n');
    await mkdir(out, { recursive: true });
    await writeFile(snapshotPath, bytes);
    await writeFile(join(out, 'evidence-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (values.diff) await writeFile(values.diff, diff);
    console.log(`Wrote ${snapshot.models.length} models (${bytes.length} bytes) to ${snapshotPath}`);
    console.log(diff);
  } finally {
    // Only remove the temporary directory created by this invocation.
    if (temporary && dirname(resolve(temporary)) === resolve(tmpdir()) && basename(temporary).startsWith('orcacompass-evidence-')) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
