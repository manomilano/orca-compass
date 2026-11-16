<script setup lang="ts">
/**
 * Site layout: the default theme's layout with OrcaCompass components placed in its slots.
 * Two regions, each with one owner, so two people can extend the layout without colliding.
 */
import DefaultTheme from 'vitepress/theme-without-fonts'

// --- site imports (navigation, not-found page, site-wide chrome) ---
import SiteNotFound from './components/site/SiteNotFound.vue'
import NavigationA11y from './components/site/NavigationA11y.vue'

// --- end site imports ---

const { Layout } = DefaultTheme
function closeSidebar() {
  document.querySelector<HTMLElement>('.VPBackdrop')?.click()
}

// --- documentation imports (components shown around documentation pages) ---
import ReadingTools from './components/docs/ReadingTools.vue'
// --- end documentation imports ---
</script>

<template>
  <Layout>
    <!-- site slots (navigation, not-found page, site-wide chrome) -->
    <template #not-found><SiteNotFound /></template>
    <template #layout-bottom><NavigationA11y /></template>
    <template #sidebar-nav-before>
      <button class="oc-sidebar-close" type="button" @click="closeSidebar">Close menu</button>
    </template>

    <!-- end site slots -->

    <!-- documentation slots (doc-before, doc-after, doc-footer-before, aside-*) -->
    <template #doc-before><ReadingTools /></template>
    <!-- end documentation slots -->
  </Layout>
</template>
