<script setup lang="ts">
import { withBase } from 'vitepress'
import docsIcon from '../../../../public/brand/icons/docs.svg?raw'
import arrowIcon from '../../../../public/brand/icons/arrow-right.svg?raw'

// Shortcuts into the full documentation index and sidebar.
const groups = [
  { title: 'Start', summary: 'Install and set up.', pages: [
    ['getting-started', 'Getting started'],
    ['skill-workflow', 'Skill workflow'],
  ] },
  { title: 'Use', summary: 'Commands and settings.', pages: [
    ['commands', 'Commands'],
    ['configuration', 'Configuration'],
  ] },
  { title: 'Understand', summary: 'How routing works.', pages: [
    ['how-it-works', 'How it works'],
    ['tiers-and-routing', 'Tiers and routing'],
  ] },
  { title: 'Get help', summary: 'Fixes and limitations.', pages: [
    ['troubleshooting', 'Troubleshooting'],
    ['roadmap', 'Roadmap and limitations'],
  ] },
]
</script>

<template>
  <section id="docs" class="landing-section" aria-labelledby="docs-title">
    <div class="oc-container">
      <SectionHeading id="docs-title" title="Start with the docs" />
      <nav class="chart-index" aria-label="Documentation by task">
        <section v-for="group in groups" :key="group.title" class="chart-index__group" :aria-labelledby="`docs-${group.title.toLowerCase().replace(/\s+/g, '-')}`">
          <header class="chart-index__heading">
            <h3 :id="`docs-${group.title.toLowerCase().replace(/\s+/g, '-')}`">{{ group.title }}</h3>
            <p>{{ group.summary }}</p>
          </header>
          <ul>
            <li v-for="[path, title] in group.pages" :key="path">
              <a class="chart-index__link" :href="withBase(`/${path}.html`)">
                <span class="chart-index__title">{{ title }}<span class="chart-index__arrow" aria-hidden="true" v-html="arrowIcon" /></span>
              </a>
            </li>
          </ul>
        </section>
      </nav>
      <p class="docs__index-link"><span aria-hidden="true" v-html="docsIcon" />
        <a :href="withBase('/guide.html')">All documentation</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.chart-index { display: grid; gap: var(--oc-space-4); }
.chart-index__group { display: grid; gap: var(--oc-space-4); padding: var(--oc-space-5); border: var(--oc-border-hair) solid var(--oc-color-line); }
.chart-index__heading { display: grid; align-content: start; }
.chart-index h3 { margin: 0; font-size: var(--oc-text-xl); font-weight: 700; line-height: var(--oc-leading-snug); }
.chart-index__heading p { margin: var(--oc-space-2) 0 0; color: var(--oc-color-text-muted); }
.chart-index ul { margin: 0; padding: 0; list-style: none; min-width: 0; }
.chart-index li + li { border-top: var(--oc-border-hair) solid var(--oc-color-rule); }
.chart-index a { display: grid; gap: var(--oc-space-1); padding-block: var(--oc-space-3); text-decoration: none; min-height: 44px; }
.chart-index__title { display: flex; align-items: center; gap: var(--oc-space-2); font-weight: 700; color: var(--oc-color-link); text-decoration: underline; text-underline-offset: 3px; }
.chart-index__arrow { display: inline-flex; flex: none; }
.chart-index a:hover .chart-index__title { color: var(--oc-color-link-hover); }
.docs__index-link { display: flex; flex-wrap: wrap; align-items: center; gap: var(--oc-space-2); margin: var(--oc-space-5) 0 0; color: var(--oc-color-text-muted); }
.docs__index-link > span { display: inline-flex; }
@media (min-width: 640px) {
  .chart-index { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (min-width: 1280px) {
  .chart-index { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
</style>
