import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const base = '/orca-compass/';
const hostname = `https://manomilano.github.io${base}`;
const sitePath = (path: string) => base + path.replace(/^\//, '');
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = (relativePath: string) => ({
  'guide.md': 'docs/README.md',
  'changelog.md': 'CHANGELOG.md',
}[relativePath] ?? `docs/${relativePath}`);

// Included pages follow the content's Git history, rather than the wrapper's date.
function updatedAt(relativePath: string): number | undefined {
  try {
    const timestamp = execFileSync('git', ['log', '-1', '--format=%ct', '--', sourcePath(relativePath)], {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return timestamp ? Number(timestamp) * 1000 : undefined;
  } catch {
    return undefined; // Source archives may have no Git history; do not invent a date.
  }
}

export default defineConfig({
  title: 'OrcaCompass',
  description: 'Choose the agent, model and reasoning effort for each Orca worker.',
  lang: 'en-US',
  base,
  srcExclude: ['README.md', 'superpowers/**'],
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: sitePath('brand/favicon.svg') }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: sitePath('brand/favicon-32.png') }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: sitePath('brand/apple-touch-icon.png') }],
    ['link', { rel: 'manifest', href: sitePath('site.webmanifest') }],
    ['meta', { name: 'theme-color', content: '#fcfdfe', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#06182b', media: '(prefers-color-scheme: dark)' }],
  ],
  sitemap: {
    hostname,
    transformItems: items => items.filter(item => item.url !== '404.html').map(item => ({
      ...item,
      lastmod: updatedAt(item.url === '' ? 'index.md' : item.url.replace(/\.html$/, '.md')),
    })),
  },
  transformPageData(pageData) {
    pageData.lastUpdated = updatedAt(pageData.relativePath);
  },
  transformHead({ page, title, description }) {
    const missing = page === '404.md';
    const url = new URL(page === 'index.md' ? '' : page.replace(/\.md$/, '.html'), hostname).href;
    const socialTitle = missing ? 'Off the chart | OrcaCompass' : title;
    const socialDescription = missing ? 'Find your way back to OrcaCompass or search the user guide.' : description;
    return [
      ...(missing
        ? [['meta', { name: 'robots', content: 'noindex, follow' }] as [string, Record<string, string>]]
        : [['link', { rel: 'canonical', href: url }] as [string, Record<string, string>]]),
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'OrcaCompass' }],
      ['meta', { property: 'og:locale', content: 'en_US' }],
      ['meta', { property: 'og:title', content: socialTitle }],
      ['meta', { property: 'og:description', content: socialDescription }],
      ...(!missing ? [['meta', { property: 'og:url', content: url }] as [string, Record<string, string>]] : []),
      ['meta', { property: 'og:image', content: new URL('art/social-card.jpg', hostname).href }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: 'The OrcaCompass home page: the headline Pick the right model for every job, the install command, and a diagram of an orchestrator asking OrcaCompass for a model and starting three Orca workers.' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: socialTitle }],
      ['meta', { name: 'twitter:description', content: socialDescription }],
      ['meta', { name: 'twitter:image', content: new URL('art/social-card.jpg', hostname).href }],
      ['meta', { name: 'twitter:image:alt', content: 'The OrcaCompass home page: the headline Pick the right model for every job, the install command, and a diagram of an orchestrator asking OrcaCompass for a model and starting three Orca workers.' }],
    ];
  },
  transformHtml(html, _id, { page, content }) {
    if (page !== '404.md') return;
    // VitePress otherwise leaves the generated 404 shell empty until JavaScript runs.
    return html.replace('<div id="app"></div>', `<div id="app">${content}</div>`)
      .replace('<title>404 | OrcaCompass</title>', '<title>Off the chart | OrcaCompass</title>')
      .replace('content="Not Found"', 'content="Find your way back to OrcaCompass or search the user guide."');
  },
  themeConfig: {
    siteTitle: 'OrcaCompass',
    logo: {
      light: { src: '/brand/mark-on-light.svg', width: 32, height: 32, alt: '' },
      dark: { src: '/brand/mark-on-dark.svg', width: 32, height: 32, alt: '' },
    },
    nav: [
      { text: 'Get started', link: '/getting-started' },
      { text: 'Docs', link: '/guide' },
      { text: 'Reference', items: [
        { text: 'Commands', link: '/commands' },
        { text: 'Configuration', link: '/configuration' },
        { text: 'Tiers and routing', link: '/tiers-and-routing' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
      ] },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/manomilano/orca-compass', ariaLabel: 'OrcaCompass on GitHub' },
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Getting started', link: '/getting-started' },
        { text: 'User guide', link: '/guide' },
        { text: 'How it works', link: '/how-it-works' },
      ] },
      { text: 'Work with OrcaCompass', items: [
        { text: 'Skill workflow', link: '/skill-workflow' },
        { text: 'Examples', link: '/examples' },
        { text: 'Verify and rejections', link: '/verify-and-rejections' },
        { text: 'Commands', link: '/commands' },
        { text: 'Configuration', link: '/configuration' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
      ] },
      { text: 'Routing reference', items: [
        { text: 'Tiers and routing', link: '/tiers-and-routing' },
        { text: 'Reasoning effort', link: '/effort' },
        { text: 'Models and agents', link: '/models-and-agents' },
        { text: 'Orca agents', link: '/orca-agents' },
        { text: 'Model data', link: '/model-data' },
      ] },
      { text: 'Project and community', items: [
        { text: 'Roadmap and limitations', link: '/roadmap' },
        { text: 'Changelog', link: '/changelog' },
        { text: 'Contributing', link: '/contributing' },
        { text: 'Community and support', link: '/community' },
      ] },
    ],
    search: {
      provider: 'local',
      options: { translations: { button: { buttonText: 'Search', buttonAriaLabel: 'Search' } } },
    },
    outline: [2, 3],
    lastUpdated: { text: 'Last updated', formatOptions: { dateStyle: 'medium' } },
    footer: {
      message: 'Released under the <a href="https://github.com/manomilano/orca-compass/blob/main/LICENSE">Apache-2.0 License</a>.',
      copyright: 'OrcaCompass recommends; Orca launches.',
    },
    editLink: {
      text: 'Edit this page on GitHub',
      pattern: ({ relativePath }) => 'https://github.com/manomilano/orca-compass/edit/main/' + (
        relativePath === 'guide.md' ? 'docs/README.md' :
        relativePath === 'changelog.md' ? 'CHANGELOG.md' : 'docs/' + relativePath
      ),
    },
  },
});
