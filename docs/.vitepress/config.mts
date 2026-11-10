import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'OrcaCompass',
  description: 'Choose the agent, model and reasoning effort for each Orca worker.',
  base: '/orca-compass/',
  srcExclude: ['README.md', 'superpowers/**'],
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'OrcaCompass · User guide',
    nav: [
      { text: 'User guide', link: '/' },
      { text: 'GitHub', link: 'https://github.com/manomilano/orca-compass' },
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Getting started', link: '/getting-started' },
        { text: 'Skill workflow', link: '/skill-workflow' },
        { text: 'How it works, end to end', link: '/how-it-works' },
      ] },
      { text: 'Use OrcaCompass', items: [
        { text: 'Commands', link: '/commands' },
        { text: 'Configuration', link: '/configuration' },
        { text: 'Verify and rejections', link: '/verify-and-rejections' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
      ] },
      { text: 'Understand routing', items: [
        { text: 'Tiers and routing', link: '/tiers-and-routing' },
        { text: 'Reasoning effort', link: '/effort' },
        { text: 'Models and agents', link: '/models-and-agents' },
        { text: 'Model data', link: '/model-data' },
        { text: 'Orca agents', link: '/orca-agents' },
        { text: 'Roadmap and limitations', link: '/roadmap' },
      ] },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    editLink: {
      pattern: ({ relativePath }) => 'https://github.com/manomilano/orca-compass/edit/main/docs/' + (relativePath === 'index.md' ? 'README.md' : relativePath),
    },
  },
});
