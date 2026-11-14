import { readFileSync } from 'node:fs';

// Prints the CHANGELOG.md section of a version, for the release workflow.
// usage: node scripts/release-notes.mjs <version> [<latest published version>]
// With the published version, also checks that the new one is newer and warns when it is not the next patch.
const [version, latest] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/release-notes.mjs <version> [<latest published version>]');
  process.exit(1);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replaceAll('\r', '');
const lines = changelog.split('\n');
const start = lines.indexOf(`## ${version}`);
const length = start < 0 ? -1 : lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
const notes = start < 0 ? '' : lines.slice(start + 1, length < 0 ? undefined : start + 1 + length).join('\n').trim();
if (!notes) {
  console.error(`::error::CHANGELOG.md has no "## ${version}" section with notes`);
  process.exit(1);
}

if (latest) {
  const parts = (v) => v.split('.').map(Number);
  const [major, minor, patch] = parts(latest);
  const next = parts(version);
  const newer = next[0] !== major ? next[0] > major : next[1] !== minor ? next[1] > minor : next[2] > patch;
  if (!newer) {
    console.error(`::error::${version} is not newer than ${latest}, the latest version on npm`);
    process.exit(1);
  }
  // Releases normally raise the patch number; anything else should be a decision, not an accident.
  if (version !== `${major}.${minor}.${patch + 1}`) {
    console.error(`::warning::${version} is not the next patch after ${latest} (${major}.${minor}.${patch + 1}); approve the release only if that is intended`);
  }
}

console.log(notes);
