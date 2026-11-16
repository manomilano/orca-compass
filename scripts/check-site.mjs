#!/usr/bin/env node
// A dependency-free static and HTTP gate for a VitePress/GitHub Pages build.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

export const legacyPages = ['index', 'commands', 'configuration', 'effort', 'getting-started',
  'how-it-works', 'model-data', 'models-and-agents', 'orca-agents', 'roadmap', 'skill-workflow',
  'tiers-and-routing', 'troubleshooting', 'verify-and-rejections', '404'].map(name => `${name}.html`);
const origin = 'http://site.invalid';
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0',
  colon: ':', sol: '/', period: '.', num: '#', quest: '?', equals: '=', percnt: '%',
  comma: ',', semi: ';', lpar: '(', rpar: ')', Tab: '\t', NewLine: '\n' };

export function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (whole, entity) => {
    if (entity[0] !== '#') return entities[entity] ?? whole;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd';
  });
}

export function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

// Scan quoted tag boundaries; raw-text elements must not produce phantom tags.
export function parseHtml(source) {
  const tags = [];
  const pattern = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    if (!match[1] || match[0].startsWith('</')) continue;
    const tag = { name: match[1].toLowerCase(), attrs: parseAttributes(match[2]), text: '' };
    if (['script', 'style', 'title', 'textarea'].includes(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'gi');
      close.lastIndex = pattern.lastIndex;
      const end = close.exec(source);
      tag.text = source.slice(pattern.lastIndex, end?.index ?? source.length);
      pattern.lastIndex = end ? close.lastIndex : source.length;
    }
    tags.push(tag);
  }
  return tags;
}

// Follow the srcset tokenization rule: commas inside data URLs belong to the URL.
export function parseSrcset(source) {
  const urls = [];
  let i = 0;
  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? '') && i < source.length) i++;
    const start = i;
    while (i < source.length && !/\s/.test(source[i])) i++;
    let url = source.slice(start, i);
    if (!url) break;
    const trailing = /,+$/.test(url);
    url = url.replace(/,+$/, '');
    urls.push(url);
    if (trailing) continue;
    let depth = 0;
    while (i < source.length) {
      if (source[i] === '(') depth++;
      if (source[i] === ')') depth--;
      if (source[i++] === ',' && depth === 0) break;
    }
  }
  return urls;
}

export function decodeCss(value) {
  return value.replace(/\\(?:([\da-f]{1,6})\s?|\r?\n|(.))/gi, (_, hex, char) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char ?? '');
}

export function parseCss(source) {
  const urls = [];
  // Consume comments and strings first so their apparent url() calls are ignored.
  const token = /\/\*[\s\S]*?(?:\*\/|$)|@import(?:\s|\/\*[\s\S]*?\*\/)*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^)\\])*?))\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi;
  for (const match of source.matchAll(token)) {
    const value = match.slice(1).find(part => part !== undefined);
    if (value !== undefined) urls.push(decodeCss(value.trim()));
  }
  return urls;
}

export function parseOptions(args) {
  const options = { dist: 'docs/.vitepress/dist', base: '/orca-compass/', siteUrl: 'https://manomilano.github.io', json: false, strict: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--dist', '--base', '--site-url', '--json', '--strict'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--json' || flag === '--strict') options[flag.slice(2)] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag === '--site-url' ? 'siteUrl' : flag.slice(2)] = value;
    }
  }
  if (!/^\/(?:[^?#%\\\s]*\/)?$/.test(options.base) || options.base.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(options.base)) {
    throw new Error(`Invalid base path: ${options.base}; expected / or /path/`);
  }
  try {
    const url = new URL(options.siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    options.siteUrl = url.origin;
  } catch { throw new Error(`Invalid site URL: ${options.siteUrl}`); }
  return options;
}

async function inventory(root, dir = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(root, name));
    else if (entry.isFile()) files.push({ file: name, bytes: (await stat(path.join(root, name))).size });
    else throw new Error(`Unsupported build entry (symlinks are not publishable files): ${name}`);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

function resolveFile(pathname, base, files) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (!decoded.startsWith(base) || /[\\\0]/.test(decoded)) return undefined;
  const rel = decoded.slice(base.length);
  if (rel.split('/').some(part => part === '..' || part === '.')) return undefined;
  const candidates = rel.endsWith('/') || !rel ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  return candidates.find(candidate => files.has(candidate));
}

function directoryRedirect(pathname, base, target) {
  if (!target || pathname.endsWith('/')) return false;
  return target === `${decodeURIComponent(pathname).slice(base.length)}/index.html`;
}

const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain', '.xml': 'application/xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.map': 'application/json' };
const mime = file => mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

export async function checkSite(options) {
  const siteOrigin = new URL(options.siteUrl ?? 'https://manomilano.github.io').origin;
  const root = path.resolve(options.dist);
  try { if (!(await stat(root)).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error(`Missing build: ${root}; run npm run docs:build first`); }
  const files = await inventory(root);
  const names = new Set(files.map(item => item.file));
  const checks = Object.fromEntries(['legacy', 'references', 'fragments', 'metadata', 'images', 'origins', 'search', 'served']
    .map(name => [name, { checked: 0, errors: [], warnings: [] }]));
  const issue = (check, file, reference, message, warning = false) => {
    checks[check][warning ? 'warnings' : 'errors'].push({ file, reference, message });
  };
  for (const file of legacyPages) {
    checks.legacy.checked++;
    if (!names.has(file)) issue('legacy', file, file, 'Missing legacy page');
  }
  const html = files.filter(item => item.file.endsWith('.html'));
  if (!html.length) throw new Error(`Missing build: ${root} contains no HTML files`);
  const pages = new Map();
  const refs = [];
  const add = (file, value, context, runtime = true, expectedType) => refs.push({ file, value, context, runtime, expectedType });
  for (const { file } of html) {
    const tags = parseHtml(await readFile(path.join(root, file), 'utf8'));
    pages.set(file, new Set(tags.flatMap(tag => 'id' in tag.attrs ? [tag.attrs.id] : [])));
    checks.metadata.checked++;
    if (!tags.some(tag => tag.name === 'title' && decodeEntities(tag.text).trim())) issue('metadata', file, '<title>', 'Missing or empty title');
    if (!tags.some(tag => tag.name === 'meta' && tag.attrs.name?.toLowerCase() === 'description' && tag.attrs.content?.trim())) issue('metadata', file, 'meta[name=description]', 'Missing or empty meta description');
    if (!tags.some(tag => tag.name === 'html' && tag.attrs.lang?.trim())) issue('metadata', file, '<html lang>', 'Missing or empty language');
    const h1 = tags.filter(tag => tag.name === 'h1').length;
    // VitePress deliberately emits a client-rendered 404 shell without an h1.
    if (h1 !== 1 && !(file === '404.html' && h1 === 0)) issue('metadata', file, '<h1>', `Expected exactly one h1; found ${h1}`);
    for (const { name, attrs, text } of tags) {
      if (name === 'base') issue('references', file, attrs.href ?? '<base>', 'HTML base elements are unsupported; use the configured site base');
      if (name === 'img') {
        checks.images.checked++;
        const ref = attrs.src ?? attrs.srcset ?? '<img>';
        if (!('alt' in attrs)) issue('images', file, ref, 'Image is missing alt attribute');
        if (!/^\d+(?:\.\d+)?$/.test(attrs.width ?? '') || !/^\d+(?:\.\d+)?$/.test(attrs.height ?? '') || Number(attrs.width) <= 0 || Number(attrs.height) <= 0) {
          issue('images', file, ref, 'Layout-shift risk: image needs positive width and height', !options.strict);
        }
      }
      for (const attr of ['href', 'src', 'poster', 'srcset', 'imagesrcset']) {
        if (!(attr in attrs)) continue;
        const runtime = !(attr === 'href' && (['a', 'area'].includes(name) ||
          (name === 'link' && /^(?:canonical|alternate|author|license)$/i.test(attrs.rel ?? ''))));
        let expectedType;
        if (name === 'script' && attr === 'src') expectedType = 'text/javascript';
        else if (name === 'link' && attr === 'href') {
          const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/);
          if (rels.includes('stylesheet') || attrs.as === 'style') expectedType = 'text/css';
          else if (rels.includes('modulepreload') || attrs.as === 'script') expectedType = 'text/javascript';
          else if (attrs.as === 'font') expectedType = 'font/';
          else if (attrs.as === 'image' || rels.some(rel => ['icon', 'apple-touch-icon', 'mask-icon'].includes(rel))) expectedType = 'image/';
        } else if (name === 'img' || attr === 'poster' || attr.endsWith('srcset')) expectedType = 'image/';
        for (const value of attr.endsWith('srcset') ? parseSrcset(attrs[attr]) : [attrs[attr]]) add(file, value, `${name}[${attr}]`, runtime, expectedType);
      }
      if (name === 'meta' && /^(?:og:(?:image|video|audio)(?::(?:url|secure_url))?|twitter:image(?::src)?|image|msapplication-tileimage)$/i.test(attrs.property ?? attrs.name ?? attrs.itemprop ?? '')) {
        if (attrs.content) add(file, attrs.content, 'meta[content]');
      }
      if (name === 'style') for (const value of parseCss(text)) add(file, value, 'inline style url()');
      if (attrs.style) for (const value of parseCss(attrs.style)) add(file, value, 'style attribute url()');
    }
  }
  for (const { file } of files.filter(item => /\.css$/i.test(item.file))) {
    for (const value of parseCss(await readFile(path.join(root, file), 'utf8'))) add(file, value, 'CSS url()/@import');
  }
  const requests = new Map();
  const pageUrl = file => options.base + file.split('/').map(encodeURIComponent).join('/');
  for (const ref of refs) {
    checks.references.checked++;
    const label = `${ref.context}: ${ref.value}`;
    const value = ref.value.trim();
    if (/&(?:#\w+|[a-z][\da-z]+);/i.test(value)) {
      issue('references', ref.file, label, 'Unresolved HTML entity in URL'); continue;
    }
    let url;
    try { url = new URL(value, origin + pageUrl(ref.file)); }
    catch { issue('references', ref.file, label, 'Invalid URL'); continue; }
    if (url.origin !== siteOrigin && (url.origin !== origin || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value))) {
      checks.origins.checked++;
      if (ref.runtime && !['data:', 'blob:'].includes(url.protocol)) issue('origins', ref.file, label, 'Remote runtime reference is forbidden');
      else if (ref.runtime && url.protocol === 'blob:') issue('origins', ref.file, label, 'Blob URL cannot be resolved in a static build');
      continue;
    }
    if (!url.pathname.startsWith(options.base)) {
      issue('references', ref.file, label, `URL is outside base ${options.base}`); continue;
    }
    const target = resolveFile(url.pathname, options.base, names);
    if (!target) { issue('references', ref.file, label, `Missing internal target ${url.pathname}`); continue; }
    if (ref.expectedType && !mime(target).startsWith(ref.expectedType)) {
      issue('references', ref.file, label, `Expected ${ref.expectedType} content; ${target} has type ${mime(target)}`);
    }
    requests.set(url.pathname + url.search, { file: ref.file, reference: label, target });
    if (url.hash && pages.has(target)) {
      checks.fragments.checked++;
      let id;
      try { id = decodeURIComponent(url.hash.slice(1)); } catch { id = url.hash.slice(1); }
      // Browser text-fragment directives follow the ordinary element fragment.
      id = id.split(':~:text=')[0];
      if (id && !pages.get(target).has(id)) issue('fragments', ref.file, label, `Missing fragment #${id} in ${target}`);
    }
  }
  checks.search.checked++;
  const indexes = files.filter(item => /(?:^|\/)@localSearchIndex[^/]*\.js$/.test(item.file));
  if (!indexes.length) issue('search', 'assets/', '@localSearchIndex*.js', 'Missing VitePress local search index');
  for (const item of indexes) {
    if (!item.bytes) issue('search', item.file, item.file, 'Local search index is empty');
    requests.set(pageUrl(item.file), { file: item.file, reference: 'local search index', target: item.file });
  }
  for (const { file } of html) {
    const request = { file, reference: 'direct HTML URL', target: file };
    requests.set(pageUrl(file), request);
    requests.set(pageUrl(file).slice(0, -5), { ...request, reference: 'extensionless HTML URL' });
    if (file === 'index.html' || file.endsWith('/index.html')) requests.set(pageUrl(file).slice(0, -10), { ...request, reference: 'directory index URL' });
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const target = resolveFile(url.pathname, options.base, names);
      if (directoryRedirect(url.pathname, options.base, target)) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}`, 'Content-Type': 'text/html' });
        res.end();
        return;
      }
      res.statusCode = target ? 200 : 404;
      res.setHeader('Content-Type', mime(target ?? '404.html'));
      res.end(target || names.has('404.html') ? await readFile(path.join(root, target ?? '404.html')) : 'Not found');
    } catch { res.statusCode = 500; res.end('Server error'); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const host = `http://127.0.0.1:${server.address().port}`;
    let missing = `${options.base}__check_site_missing__`;
    while (resolveFile(missing, options.base, names)) missing += '_';
    requests.set(missing, { file: '404.html', reference: 'made-up URL', target: undefined });
    if (options.base !== '/') requests.set('/__outside_base__', { file: '404.html', reference: 'outside-base URL', target: undefined });
    for (const [url, request] of requests) {
      checks.served.checked++;
      try {
        const response = await fetch(host + url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const pathname = new URL(url, origin).pathname;
        const redirect = directoryRedirect(pathname, options.base, request.target);
        const expectedStatus = redirect ? 301 : request.target ? 200 : 404;
        const expectedType = mime(request.target ?? '404.html');
        const body = Buffer.from(await response.arrayBuffer());
        if (response.status !== expectedStatus || response.headers.get('content-type')?.split(';')[0] !== expectedType) {
          issue('served', request.file, `${request.reference}: ${url}`, `Expected ${expectedStatus} ${expectedType}; got ${response.status} ${response.headers.get('content-type')}`);
        }
        if (redirect && response.headers.get('location') !== `${pathname}/${new URL(url, origin).search}`) issue('served', request.file, url, 'Incorrect directory redirect location');
        const expectedFile = redirect ? undefined : request.target ?? (names.has('404.html') ? '404.html' : undefined);
        if (expectedFile && !body.equals(await readFile(path.join(root, expectedFile)))) issue('served', request.file, url, `Response does not match ${expectedFile}`);
      } catch (error) { issue('served', request.file, url, `HTTP request failed: ${error.message}`); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const categories = { HTML: /\.html$/i, CSS: /\.css$/i, JavaScript: /\.(?:m?js)$/i,
    fonts: /\.(?:woff2?|ttf|otf|eot)$/i, images: /\.(?:png|jpe?g|svg|gif|webp|avif|ico|bmp)$/i };
  const totals = Object.fromEntries(Object.entries(categories).map(([name, pattern]) => {
    const selected = files.filter(item => pattern.test(item.file));
    return [name, { count: selected.length, bytes: selected.reduce((sum, item) => sum + item.bytes, 0) }];
  }));
  const errors = Object.values(checks).reduce((sum, check) => sum + check.errors.length, 0);
  const warnings = Object.values(checks).reduce((sum, check) => sum + check.warnings.length, 0);
  return { ok: errors === 0, base: options.base, dist: options.dist, siteUrl: siteOrigin, checks, errors, warnings, totals,
    largestFiles: [...files].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file)).slice(0, 10) };
}

export function formatReport(report) {
  const lines = [`Site verification: ${report.ok ? 'PASS' : 'FAIL'} (${report.base})`];
  for (const [name, check] of Object.entries(report.checks)) {
    lines.push(`${name}: ${check.checked} checked, ${check.errors.length} errors, ${check.warnings.length} warnings`);
    for (const level of ['errors', 'warnings']) for (const item of check[level]) lines.push(`  ${level === 'errors' ? 'ERROR' : 'WARN'} ${item.file} — ${item.reference}: ${item.message}`);
  }
  lines.push(`Total: ${report.errors} errors, ${report.warnings} warnings`, 'Build totals:');
  for (const [name, total] of Object.entries(report.totals)) lines.push(`  ${name}: ${total.count} files, ${total.bytes} bytes`);
  lines.push('Ten largest files:');
  for (const item of report.largestFiles) lines.push(`  ${item.bytes} bytes  ${item.file}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
    const options = parseOptions(process.argv.slice(2));
    const report = await checkSite(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const report = { ok: false, error: error.message, exitCode: 2 };
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
    else console.error(`Site verification: ${error.message}\nUsage: node scripts/check-site.mjs [--dist directory] [--base /path/] [--site-url url] [--json] [--strict]`);
    process.exitCode = 2;
  }
}
