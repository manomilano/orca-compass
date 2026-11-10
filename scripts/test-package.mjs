import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package');
assert.ok(existsSync(join(root, 'dist/cli.js')), 'Run npm run build before checking the package');
// A space, because users' home folders have them. Not an accent: on Windows, npm pack run inside such a
// folder silently leaves the `files` folders out of the tarball (installing into one works).
const temporary = mkdtempSync(join(tmpdir(), 'orcacompass package-'));

function run(args, cwd = temporary) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    // A parent publish preview must still create and install the temporary test package.
    env: { ...process.env, npm_config_dry_run: 'false', ORCACOMPASS_HOME: join(temporary, 'home') },
  });
  assert.ifError(result.error);
  return result;
}

try {
  // Pack the compiled files without rebuilding; installation must stand on its own.
  const staged = join(temporary, 'staged');
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const name of [...source.files, 'LICENSE', 'README.md']) {
    cpSync(join(root, name), join(staged, name), { recursive: true });
  }
  // npm 10 runs prepare during pack even with --ignore-scripts, and CI has no compiler here.
  delete source.scripts.prepare;
  writeFileSync(join(staged, 'package.json'), JSON.stringify(source, null, 2));
  const packed = run([npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], staged);
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const installed = run([
    npmCli, 'install', '--prefix', temporary, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev', join(temporary, filename),
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  const packageRoot = join(temporary, 'node_modules', 'orcacompass');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const bin = join(packageRoot, manifest.bin.orcacompass);
  const shim = join(temporary, 'node_modules', '.bin', process.platform === 'win32' ? 'orcacompass.cmd' : 'orcacompass');
  assert.ok(existsSync(shim), 'npm must create the executable link/shim');
  assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node/);
  const entry = process.platform === 'win32' ? bin : shim;
  const help = run([entry, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: orcacompass <command>/);
  assert.match(help.stdout, /route --need coding=<l>,agentic=<l>,reasoning=<l>/);
  assert.match(help.stdout, /install \[-g\|--global/);
  assert.equal(help.stderr, '');
  const invalid = run([entry, 'not-a-command']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /unknown command: not-a-command/);
  const evidence = JSON.parse(readFileSync(join(packageRoot, 'data', 'evidence-snapshot.json'), 'utf8'));
  assert.ok(evidence.models.length > 0, 'Evidence snapshot must contain bundled models');
  const evidenceManifest = JSON.parse(readFileSync(join(packageRoot, 'data', 'evidence-manifest.json'), 'utf8'));
  assert.match(evidenceManifest.sha256, /^[a-f0-9]{64}$/);
  for (const removed of ['data/models-snapshot.json', 'data/modelindex-snapshot.json', 'dist/placements/sources/modelsdev.js', 'dist/placements/sources/modelindex.js', 'dist/placements/score.js', 'data/benchmarks.json', 'dist/placements/benchmark.js', 'dist/placements/sources/benchmarks.js', 'dist/placements/sources/artificialanalysis.js']) {
    assert.ok(!existsSync(join(packageRoot, removed)), `Removed data integration must not ship: ${removed}`);
  }
  assert.match(readFileSync(join(packageRoot, 'skills/orcacompass/SKILL.md'), 'utf8'), /orcacompass/);
  assert.ok(existsSync(join(packageRoot, 'NOTICE')), 'Metadata attribution must ship');
  console.log('Packaged CLI: installation, help, exit codes, snapshots and Skill passed on ' + process.version);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
