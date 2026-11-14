import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real npm/npx and skills, with a local registry for unpublished test releases.
// Every write goes to a temporary profile, npm prefix and cache; nothing is published.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run with npm run test:install');
const npxCli = join(dirname(npmCli), 'npx-cli.js');
const root = mkdtempSync(join(tmpdir(), 'orcacompass install-'));
const source = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
const skill = readFileSync(join(sourceRoot, 'skills/orcacompass/SKILL.md'), 'utf8');
// The newest release on npm, exactly as published: its users must be able to update to this source.
const published = await fetch('https://registry.npmjs.org/orcacompass/latest', { signal: AbortSignal.timeout(30_000) }).then(response => response.json());
const [major, minor, patch] = published.version.split('.').map(Number);
const oldVersion = '0.0.1';
// This source, numbered as the release after the published one so that it is the registry's latest.
const newVersion = `${major}.${minor}.${patch + 1}`;
const tarballs = new Map();
let registry;

function environment(name) {
  const folder = join(root, name);
  const profile = join(folder, 'profile');
  const project = join(folder, 'project');
  const prefix = join(folder, 'prefix');
  for (const dir of [profile, project, join(profile, 'AppData/Local'), join(profile, 'AppData/Roaming')]) mkdirSync(dir, { recursive: true });
  const userconfig = join(folder, 'npmrc');
  writeFileSync(userconfig, '');
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|ComSpec)$/i.test(key)));
  const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const env = {
    ...system, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: root, TMP: root, TMPDIR: root,
    USERPROFILE: profile, HOME: profile, XDG_CONFIG_HOME: join(profile, '.config'),
    APPDATA: join(profile, 'AppData/Roaming'), LOCALAPPDATA: join(profile, 'AppData/Local'),
    PATH: [bin, dirname(process.execPath), ...(process.platform === 'win32'
      ? [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot] : ['/usr/bin', '/bin'])].join(delimiter),
    npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_userconfig: userconfig,
    npm_config_registry: registry || 'https://registry.npmjs.org', npm_config_audit: 'false', npm_config_fund: 'false',
    ORCACOMPASS_HOME: join(profile, 'orcacompass'),
    // Windows must exercise the product's own skills telemetry mitigation, not
    // inherit one from this harness. Coordinator detection matches a real install.
    ...(process.platform === 'win32' ? { CODEX_THREAD_ID: 'isolated-installer-check' }
      : { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' }),
  };
  return { folder, profile, project, prefix, env };
}

async function run(test, label, args, expectedCode = 0, cwd = test.project) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: test.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  writeFileSync(join(test.folder, `${label}.log`), `${result.stdout}\n${result.stderr}`);
  assert.equal(result.code, expectedCode, `${label}:\n${result.stdout}\n${result.stderr}`);
  return result;
}

const packEnv = environment('pack');
for (const version of [oldVersion, newVersion]) {
  const staging = join(root, `package-${version}`);
  for (const name of [...source.files, 'LICENSE', 'README.md']) cpSync(join(sourceRoot, name), join(staging, name), { recursive: true });
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ ...source, version, scripts: {} }));
  writeFileSync(join(staging, 'skills/orcacompass/SKILL.md'), `${skill}\nInstallation test fixture ${version}.\n`);
  const packed = await run(packEnv, `pack-${version}`, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], 0, staging);
  const [{ filename }] = JSON.parse(packed.stdout);
  tarballs.set(version, readFileSync(join(root, filename)));
}
tarballs.set(published.version, Buffer.from(await (await fetch(published.dist.tarball, { signal: AbortSignal.timeout(30_000) })).arrayBuffer()));

const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'GET', 'This test never publishes or writes to a registry');
    if (req.url === '/orcacompass') {
      const versions = Object.fromEntries([...tarballs].map(([version, tarball]) => [version, {
        name: 'orcacompass', version, bin: source.bin,
        dist: { tarball: `${registry}/orcacompass/-/${version}.tgz`, shasum: createHash('sha1').update(tarball).digest('hex') },
      }]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'orcacompass', 'dist-tags': { latest: newVersion }, versions }));
    } else if (req.url.startsWith('/orcacompass/-/')) {
      const version = req.url.split('/').at(-1).replace(/\.tgz$/, '');
      assert.ok(tarballs.has(version));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarballs.get(version));
    } else {
      // skills@1 and its dependencies are real public packages, downloaded read-only.
      assert.ok(req.url.startsWith('/') && !req.url.startsWith('//'));
      const upstream = await fetch(`https://registry.npmjs.org${req.url}`, { signal: AbortSignal.timeout(30_000) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
registry = `http://127.0.0.1:${server.address().port}`;

const installedRoot = test => join(test.prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules/orcacompass');
const skillPath = test => join(test.profile, '.agents/skills/orcacompass/SKILL.md');
const command = version => [npxCli, '--yes', `orcacompass@${version}`, 'install', '--global', '--yes', '--agent', 'codex', '--agent', 'claude-code'];
// Resolve the user's bare command through the isolated PATH, including Windows npm shims.
const globalCommand = (...args) => ['-e', `const { spawnSync } = require('node:child_process'); const r = spawnSync('orcacompass', process.argv.slice(1), { shell: process.platform === 'win32', stdio: 'inherit' }); if (r.error) console.error(r.error); process.exit(r.status ?? 1);`, ...args];
function verify(test, version) {
  assert.equal(JSON.parse(readFileSync(join(installedRoot(test), 'package.json'), 'utf8')).version, version);
  for (const agent of ['.agents', '.claude']) assert.equal(readFileSync(join(test.profile, agent, 'skills/orcacompass/SKILL.md'), 'utf8'), `${skill}\nInstallation test fixture ${version}.\n`);
}

try {
  const fresh = environment('fresh');
  const home = await run(fresh, 'isolation', ['-e', 'console.log(require("node:os").homedir())']);
  assert.equal(home.stdout.trim(), fresh.profile);
  await run(fresh, 'install', command('latest'));
  verify(fresh, newVersion);
  console.log('PASS: fresh npx install, including a previously missing npm prefix');

  const repeat = await run(fresh, 'repeat', command('latest'));
  assert.match(repeat.stdout, /already current/);
  assert.doesNotMatch(repeat.stdout, /Installing the CLI:|Updating the CLI:/);
  verify(fresh, newVersion);
  console.log('PASS: repeat install keeps the current CLI and refreshes matching Skills');

  const local = environment('local');
  await run(local, 'default-install', [npxCli, '--yes', 'orcacompass@latest', 'install', '--yes', '--agent', 'codex', '--agent', 'claude-code']);
  for (const agent of ['.agents', '.claude']) {
    assert.equal(readFileSync(join(local.project, agent, 'skills/orcacompass/SKILL.md'), 'utf8'), `${skill}\nInstallation test fixture ${newVersion}.\n`);
    assert.equal(existsSync(join(local.profile, agent, 'skills/orcacompass/SKILL.md')), false);
  }
  assert.ok(existsSync(join(installedRoot(local), 'dist/cli.js')), 'The CLI is shared globally even for a local Skill');
  await run(local, 'local-uninstall', globalCommand('uninstall', '--local', '--yes'));
  for (const agent of ['.agents', '.claude']) assert.equal(existsSync(join(local.project, agent, 'skills/orcacompass/SKILL.md')), false);
  assert.ok(existsSync(join(installedRoot(local), 'dist/cli.js')), 'Local uninstall retains the shared CLI');
  await run(local, 'explicit-local-install', globalCommand('install', '--local', '--yes', '--agent', 'codex'));
  assert.ok(existsSync(join(local.project, '.agents/skills/orcacompass/SKILL.md')));
  console.log('PASS: default and explicit local install use project Skills; local uninstall retains the shared CLI');

  const upgrade = environment('upgrade');
  // skills retains shared content for other detected agents during targeted removal.
  mkdirSync(join(upgrade.profile, '.codex'));
  await run(upgrade, 'old-install', command(oldVersion));
  verify(upgrade, oldVersion);
  const config = join(upgrade.env.ORCACOMPASS_HOME, 'config.json');
  mkdirSync(dirname(config), { recursive: true });
  const preferences = JSON.stringify({ allowAgents: ['codex'], banModels: ['example-model'] });
  writeFileSync(config, preferences);
  const cache = join(upgrade.env.ORCACOMPASS_HOME, 'cache.json');
  writeFileSync(cache, 'preserve this cache');
  const updated = await run(upgrade, 'update', globalCommand('update', '--global', '--yes', '--agent', 'codex', '--agent', 'claude-code'));
  assert.ok(updated.stdout.includes(`updated from ${oldVersion} to ${newVersion}`), updated.stdout);
  verify(upgrade, newVersion);
  assert.equal(readFileSync(config, 'utf8'), preferences, 'Updating must preserve user preferences');
  const help = await run(upgrade, 'help', [join(installedRoot(upgrade), 'dist/cli.js'), '--help']);
  assert.match(help.stdout, /usage: orcacompass/);
  assert.equal(readFileSync(cache, 'utf8'), 'preserve this cache');
  console.log('PASS: bare orcacompass update upgrades the older global CLI and Skill through the latest installer');

  await run(upgrade, 'downgrade', command(oldVersion), 1);
  verify(upgrade, newVersion);
  console.log('PASS: older installer preserves the newer CLI and Skill');

  // skills can exit zero on cancellation; verify against its real inventory before npm removal.
  const cancelled = await run(upgrade, 'cancelled-removal', ['--input-type=module', '-e',
    `const { uninstall } = await import(${JSON.stringify(pathToFileURL(join(installedRoot(upgrade), 'dist/install.js')).href)}); process.exit(await uninstall({ global: true }, { interactive: async () => 0, log: console.log }));`], 1);
  assert.match(cancelled.stdout, /CLI was retained/);
  verify(upgrade, newVersion);
  console.log('PASS: zero-status cancelled removal retains CLI when the real Skill inventory still lists it');

  await run(upgrade, 'targeted-uninstall', globalCommand('uninstall', '--global', '--yes', '--agent', 'claude-code'));
  assert.equal(existsSync(join(upgrade.profile, '.claude/skills/orcacompass/SKILL.md')), false);
  assert.ok(existsSync(skillPath(upgrade)), 'Agent-specific removal preserves another agent Skill');
  assert.ok(existsSync(join(installedRoot(upgrade), 'dist/cli.js')), 'Agent-specific removal retains the shared CLI');
  await run(upgrade, 'global-uninstall', globalCommand('uninstall', '--global', '--yes'));
  assert.equal(existsSync(skillPath(upgrade)), false);
  assert.equal(existsSync(installedRoot(upgrade)), false);
  assert.equal(readFileSync(config, 'utf8'), preferences);
  assert.equal(readFileSync(cache, 'utf8'), 'preserve this cache');
  console.log('PASS: partial global removal retains CLI; full global removal removes CLI and preserves config/cache');
  if (process.platform === 'win32') {
    assert.equal(upgrade.env.DISABLE_TELEMETRY, undefined);
    assert.equal(upgrade.env.DO_NOT_TRACK, undefined);
    assert.equal(upgrade.env.CI, undefined);
    console.log('PASS: Windows Skill removal exits cleanly without outer telemetry or CI overrides');
  }

  // The published release, not a copy of this source: its own update command, config and caches.
  const release = environment('published');
  mkdirSync(join(release.profile, '.codex'));
  await run(release, 'published-install', command(published.version));
  assert.equal(JSON.parse(readFileSync(join(installedRoot(release), 'package.json'), 'utf8')).version, published.version);
  const releaseConfig = join(release.env.ORCACOMPASS_HOME, 'config.json');
  mkdirSync(dirname(releaseConfig), { recursive: true });
  // Includes keys that earlier releases accepted and later ones removed.
  const releasePreferences = JSON.stringify({
    denyAgents: ['grok'], tierOverrides: { 'claude-sonnet-5-5': 'daily' }, banModels: ['example-model'],
    scoreWeight: 0.4, modelsDevTtlHours: 24, classWeight: 0.1, placementsTtlHours: 5, preferRiskLimit: 100,
  });
  writeFileSync(releaseConfig, releasePreferences);
  // The published CLI writes its caches; it may warn about keys it does not know.
  for (const args of [['status', '--json'], ['route', '--tier', 'daily', '--json']]) await run(release, `published-${args[0]}`, globalCommand(...args));
  const released = await run(release, 'published-update', globalCommand('update', '--global', '--yes', '--agent', 'codex', '--agent', 'claude-code'));
  assert.ok(released.stdout.includes(`updated from ${published.version} to ${newVersion}`), released.stdout);
  verify(release, newVersion);
  assert.equal(readFileSync(releaseConfig, 'utf8'), releasePreferences, 'Updating must preserve user preferences');
  for (const args of [['status', '--json'], ['route', '--tier', 'daily', '--json'], ['setup', '--json'], ['tiers'], ['agents'], ['prefer'], ['ban']]) {
    const result = await run(release, `updated-${args[0]}`, globalCommand(...args));
    if (args.includes('--json')) JSON.parse(result.stdout);
  }
  console.log(`PASS: published ${published.version} updates itself to this source, which runs on the config and caches it left`);

  const failed = environment('failed-update');
  await run(failed, 'old-install', command(oldVersion));
  const oldSkill = readFileSync(skillPath(failed), 'utf8');
  // The local CLI is runnable, but the registry cannot provide its new version.
  const brokenRegistry = createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise(resolveListen => brokenRegistry.listen(0, '127.0.0.1', resolveListen));
  try {
    failed.env.npm_config_registry = `http://127.0.0.1:${brokenRegistry.address().port}`;
    failed.env.npm_config_cache = join(root, 'empty-cache');
    const lookupFailure = await run(failed, 'failed-latest-lookup', globalCommand('update', '--global', '--yes'), 1);
    assert.match(lookupFailure.stdout, /Cannot resolve the latest installer/);
    verify(failed, oldVersion);
    const result = await run(failed, 'failed-update', [join(root, `package-${newVersion}`, 'dist/cli.js'), 'install', '--global', '--yes'], 1);
    assert.match(result.stdout, /Skill was left unchanged/);
    assert.equal(readFileSync(skillPath(failed), 'utf8'), oldSkill);
    verify(failed, oldVersion);
    const removalFailure = await run(failed, 'failed-skill-removal', globalCommand('uninstall', '--global', '--yes'), 1);
    assert.match(removalFailure.stdout, /CLI was left unchanged/);
    verify(failed, oldVersion);
  } finally {
    brokenRegistry.closeAllConnections();
    await new Promise(resolveClose => brokenRegistry.close(resolveClose));
  }
  console.log('PASS: registry, CLI upgrade and Skill removal failures preserve the old installation');
  assert.ok(existsSync(join(installedRoot(fresh), 'dist/cli.js')));
  console.log(`Installer checks passed on ${process.platform} ${process.version}. Logs: ${root}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}
