<script setup lang="ts">
import { withBase } from 'vitepress'
import manifest from '../../../../public/art/manifest.json'
import externalIcon from '../../../../public/brand/icons/external-link.svg?raw'

const art = manifest.images.community
const imageSet = (format: string) => art.files
  .filter(file => file.format === format)
  .map(file => `${withBase(`/art/${file.file}`)} ${file.width}w`).join(', ')
const links = [
  { label: 'Report a bug or request a feature', href: 'https://github.com/manomilano/orca-compass/issues/new/choose' },
  { label: 'orcacompass on npm', href: 'https://www.npmjs.com/package/orcacompass' },
  { label: 'Apache-2.0 license', href: 'https://github.com/manomilano/orca-compass/blob/main/LICENSE' },
]
</script>

<template>
  <section id="community" class="landing-section" aria-labelledby="community-title">
    <div class="oc-container">
      <ComicPanel tag="figure" flush class="community__art">
        <picture>
          <source type="image/avif" :srcset="imageSet('avif')" sizes="(min-width: 1280px) 1200px, 100vw" />
          <source type="image/webp" :srcset="imageSet('webp')" sizes="(min-width: 1280px) 1200px, 100vw" />
          <img :src="withBase('/art/community-1280.webp')" width="1280" height="549" :alt="art.alt" loading="lazy" decoding="async" />
        </picture>
      </ComicPanel>
      <div class="community__closing">
        <div>
          <SectionHeading id="community-title" title="The next route is ours to chart."
            lead="Help shape OrcaCompass with bug reports, feature requests or contributions to the code and documentation." />
        </div>
        <nav class="community__links" aria-label="Project and community links">
          <a v-for="link in links" :key="link.href" :href="link.href">
            <span>{{ link.label }}</span><span class="community__external" aria-hidden="true" v-html="externalIcon" /><span class="oc-sr-only"> (external site)</span>
          </a>
          <a :href="withBase('/contributing.html')">Contributing guide</a>
          <a :href="withBase('/community.html')">Community and support</a>
        </nav>
      </div>
      <RouteLine glow />
      <div class="community__actions">
        <CompassButton href="#install" arrow>Install OrcaCompass</CompassButton>
        <CompassButton href="https://github.com/manomilano/orca-compass" variant="secondary">
          View on GitHub<span class="oc-sr-only"> (external site)</span>
        </CompassButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.community__art.oc-panel { margin-bottom: var(--oc-space-7); }
.community__art img { display: block; width: 100%; height: auto; }
.community__closing { display: grid; gap: var(--oc-space-6); margin-bottom: var(--oc-space-7); }
.community__links { display: flex; flex-direction: column; align-self: start; border-top: var(--oc-border-strong) solid var(--oc-color-line); }
.community__links a { display: flex; align-items: center; justify-content: space-between; gap: var(--oc-space-3); min-height: 44px; padding-block: var(--oc-space-3); border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); color: var(--oc-color-link); text-decoration: underline; text-underline-offset: 3px; }
.community__links a:hover { color: var(--oc-color-link-hover); }
.community__external { display: inline-flex; flex: none; }
.community__external :deep(svg) { width: 18px; height: 18px; }
.community__actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--oc-space-5); padding-top: var(--oc-space-6); }
.community__actions :deep(.oc-button__label) { display: inline-flex; align-items: center; gap: 0.45em; }
@media (min-width: 960px) {
  .community__closing { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--oc-space-8); }
}
</style>
