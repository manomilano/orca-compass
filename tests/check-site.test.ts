import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/check-site.mjs', import.meta.url));
const pages = ['index', 'commands', 'configuration', 'effort', 'getting-started', 'how-it-works',
  'model-data', 'models-and-agents', 'orca-agents', 'roadmap', 'skill-workflow', 'tiers-and-routing',
  'troubleshooting', 'verify-and-rejections', '404'];
const temporary: string[] = [];

async function fixture(extra = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'check-site-'));
  temporary.push(root);
  await mkdir(path.join(root, 'assets'));
  const html = `<!doctype html><html lang='en'><head><title>Fixture</title>
    <meta content='A fixture site' name='description'>
    <link rel='stylesheet' href='/orca-compass/assets/style.css'>
    <script src='/orca-compass/assets/app.js' type='module'></script></head>
    <body><h1 id='hello'>Hello</h1><a href='commands.html?q=1&amp;x=2#hello'>Commands</a>
    <img src='/orca-compass/assets/pixel.svg' alt='' width='10' height='10'>${extra}</body></html>`;
  await Promise.all(pages.map(page => writeFile(path.join(root, `${page}.html`), html)));
  await writeFile(path.join(root, 'assets', 'style.css'), `/* url(https://ignored.invalid/x) */
    @font-face {font-family:fixture;src:url('./font.woff2?version=1')} .x{background:url("pixel.svg")}`);
  await writeFile(path.join(root, 'assets', 'font.woff2'), 'fixture font');
  await writeFile(path.join(root, 'assets', 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root, 'assets', 'app.js'), 'export {};');
  await writeFile(path.join(root, 'assets', '@localSearchIndexroot.fixture.js'), 'export default {};');
  return root;
}

async function run(root: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, [script, '--dist', root, ...args], { timeout: 20_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function append(root: string, html: string) {
  const file = path.join(root, 'index.html');
  await writeFile(file, (await readFile(file, 'utf8')).replace('</body>', `${html}</body>`));
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('site publication gate', () => {
  it('passes a complete build, requests direct and extensionless URLs, and prints one JSON document', async () => {
    const root = await fixture(`<a href='https://example.com/'>External link</a>
      <style>.example::after{content:'url(https://ignored.invalid/x)'}</style>
      <img alt='Variants' width='20' height='10' srcset='assets/pixel.svg 1x, assets/pixel.svg?v=2&amp;x=3 2x'>`);
    const result = await run(root, '--json', '--strict');
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: true, errors: 0, warnings: 0, totals: { HTML: { count: 15 } } });
    expect(report.checks.served.checked).toBeGreaterThanOrEqual(34);
    expect(report.largestFiles).toHaveLength(10);
  });

  it.each([
    ['dead internal link', '<a href="missing.html?x=1">Broken</a>', 'missing.html?x=1', 'Missing internal target'],
    ['dead fragment', '<a href="commands.html#absent">Broken</a>', 'commands.html#absent', 'Missing fragment #absent in commands.html'],
    ['root absolute link', '<a href="/commands.html">Broken</a>', '/commands.html', 'outside base /orca-compass/'],
    ['remote script', '<script src="https://cdn.example.com/app.js"></script>', 'https://cdn.example.com/app.js', 'Remote runtime reference'],
    ['missing alt', '<img src="assets/pixel.svg" width="1" height="1">', 'assets/pixel.svg', 'missing alt attribute'],
  ])('rejects a %s and identifies its file and reference', async (_, markup, reference, message) => {
    const root = await fixture();
    await append(root, markup);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('ERROR index.html');
    expect(result.stdout).toContain(reference);
    expect(result.stdout).toContain(message);
  });

  it('rejects a missing legacy page', async () => {
    const root = await fixture();
    await rm(path.join(root, 'roadmap.html'));
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('roadmap.html — roadmap.html: Missing legacy page');
  });

  it('warns about image dimensions and fails them in strict mode', async () => {
    const root = await fixture();
    await append(root, '<img alt="Decorative" src="assets/pixel.svg">');
    const normal = await run(root);
    expect(normal.code).toBe(0);
    expect(normal.stdout).toContain('WARN index.html — assets/pixel.svg: Layout-shift risk');
    const strict = await run(root, '--strict');
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain('ERROR index.html — assets/pixel.svg: Layout-shift risk');
  });

  it('finds remote CSS imports, escaped URLs, inline styles and metadata images', async () => {
    const root = await fixture();
    await append(root, `<style>@import'https://cdn.example.com/style.css';
      @import/**/"https://cdn.example.com/another.css";
      .a{background:url(https\\3a //cdn.example.com/image.png)}</style>
      <div style="background:url('/bad.svg')"></div>
      <meta property='og:image' content='/orca-compass/missing-social.png'>`);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('https://cdn.example.com/style.css');
    expect(result.stdout).toContain('https://cdn.example.com/another.css');
    expect(result.stdout).toContain('https://cdn.example.com/image.png');
    expect(result.stdout).toContain('/bad.svg');
    expect(result.stdout).toContain('missing-social.png');
  });

  it('checks same-site absolute references as internal targets', async () => {
    const root = await fixture();
    await append(root, `<meta property='og:image' content='https://example.org/orca-compass/assets/pixel.svg'>
      <link rel='canonical' href='https://example.org/orca-compass/commands.html#hello'>
      <img alt='' width='1' height='1' srcset='https://example.org/orca-compass/assets/pixel.svg 1x'>
      <style>.x{background:url(https://example.org/orca-compass/assets/pixel.svg)}</style>`);
    const result = await run(root, '--site-url', 'https://example.org', '--json');
    expect(result.code, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).siteUrl).toBe('https://example.org');
  });

  it.each([
    ['missing file', 'https://manomilano.github.io/orca-compass/missing-social.png', 'Missing internal target /orca-compass/missing-social.png'],
    ['outside base', 'https://manomilano.github.io/other/social.png', 'outside base /orca-compass/'],
    ['another origin', 'https://cdn.example.com/social.png', 'Remote runtime reference is forbidden'],
  ])('rejects an absolute social image with %s', async (_, url, message) => {
    const root = await fixture();
    await append(root, `<meta property='og:image' content='${url}'>`);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(url);
    expect(result.stdout).toContain(message);
  });

  it('checks fragments in same-site absolute links', async () => {
    const root = await fixture();
    await append(root, `<a href='https://manomilano.github.io/orca-compass/commands.html#absent'>Broken</a>`);
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Missing fragment #absent in commands.html');
  });

  it('rejects assets that resolve to the wrong content type', async () => {
    const root = await fixture();
    await append(root, '<script src="commands.html"></script><img alt="" width="1" height="1" src="assets/app.js">');
    const result = await run(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Expected text/javascript content; commands.html has type text/html');
    expect(result.stdout).toContain('Expected image/ content; assets/app.js has type text/javascript');
  });

  it('checks metadata and local search availability', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'index.html'), '<html><title> </title><h1>One</h1><h1>Two</h1></html>');
    await rm(path.join(root, 'assets', '@localSearchIndexroot.fixture.js'));
    const result = await run(root);
    expect(result.code).toBe(1);
    for (const message of ['empty title', 'meta description', 'language', 'found 2', 'Missing VitePress local search index']) expect(result.stdout).toContain(message);
  });

  it('supports directory indexes, URL entities, quoted tag boundaries and encoded fragments', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'guide'));
    await writeFile(path.join(root, 'guide', 'index.html'), `<!doctype html><html lang='en'><title>Guide</title>
      <meta name='description' content='Guide'><h1 id='a&amp;b'>Guide</h1><a href='../index.html'>Home</a></html>`);
    await writeFile(path.join(root, 'custom-index.html'), await readFile(path.join(root, 'commands.html')));
    await append(root, `<a title='a > b' href='guide/?x=1&amp;y=2#a%26b'>Guide</a><a href='guide?x=1'>Directory redirect</a>
      <script>const fake = '<img src="not-real.svg">';</script>
      <img alt='' width='1' height='1' srcset='data:image/svg+xml,%3Csvg%3E 1x, assets/pixel.svg 2x'>`);
    const result = await run(root);
    expect(result.code, result.stdout).toBe(0);
  });

  it('accepts another base, including the root base', async () => {
    const root = await fixture();
    for (const page of pages) {
      const file = path.join(root, `${page}.html`);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('/orca-compass/', '/'));
    }
    expect((await run(root, '--base', '/')).code).toBe(0);
  });

  it.each([['--base', 'relative'], ['--dist'], ['--unknown'], ['--json', '--json']])('returns usage exit 2 for %j', async (...args) => {
    const result = await run(await fixture(), ...args);
    expect(result.code).toBe(2);
  });

  it('returns exit 2 for a missing build, with machine-readable errors', async () => {
    const result = await run(path.join(await fixture(), 'absent'), '--json');
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error).toContain('Missing build');
  });
});
