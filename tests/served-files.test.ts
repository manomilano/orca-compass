import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_MANIFEST_URL, EVIDENCE_SNAPSHOT_URL, parseManifest } from '../src/evidence/source.js';

// Installed copies of OrcaCompass download these files from the repository's `main` branch.
// Merging a change to `main` changes them for every user at once, including users of older
// releases, so each file must stay present and readable in the shape its readers expect.
const MAIN = 'https://raw.githubusercontent.com/manomilano/orca-compass/main/';
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));

describe('files served from main', () => {
  it('keeps the evidence files 0.2.2 and later download, with a manifest matching the snapshot bytes', () => {
    expect(EVIDENCE_MANIFEST_URL).toBe(`${MAIN}data/evidence-manifest.json`);
    expect(EVIDENCE_SNAPSHOT_URL).toBe(`${MAIN}data/evidence-snapshot.json`);
    const manifest = parseManifest(JSON.parse(read('data/evidence-manifest.json').toString('utf8')));
    expect(manifest).toBeDefined();
    const snapshot = read('data/evidence-snapshot.json');
    expect(snapshot.length).toBe(manifest!.bytes);
    expect(createHash('sha256').update(snapshot).digest('hex')).toBe(manifest!.sha256);
  });

  it('keeps the Model Index scores 0.2.0 and 0.2.1 download', () => {
    // Read by 0.2.0 and 0.2.1 from data/modelindex-snapshot.json; frozen, no longer used by this version.
    expect(existsSync(new URL('data/modelindex-snapshot.json', root))).toBe(true);
    const data = JSON.parse(read('data/modelindex-snapshot.json').toString('utf8'));
    expect(Number.isFinite(data.fetchedAt)).toBe(true);
    expect(Array.isArray(data.ratings)).toBe(true);
    expect(data.ratings.length).toBeGreaterThan(0);
  });
});
