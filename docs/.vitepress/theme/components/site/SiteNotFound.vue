<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <main class="site-not-found" aria-labelledby="not-found-title">
    <p class="site-not-found__code">404</p>
    <h1 id="not-found-title">Off the chart</h1>
    <p>This route leads to open water. Let's find your bearing.</p>
    <nav aria-label="Find your way back">
      <a :href="withBase('/')">OrcaCompass home</a>
      <a :href="withBase('/guide.html')">User guide</a>
    </nav>
    <p>Use Search in the navigation bar to look up a command or topic.</p>
  </main>
</template>

<style scoped>
.site-not-found {
  max-width: var(--oc-container-narrow);
  margin: auto;
  padding: var(--oc-space-9) var(--oc-gutter);
  color: var(--oc-color-text);
  text-align: center;
}
.site-not-found__code {
  font-family: var(--oc-font-mono);
  color: var(--oc-color-text-muted);
}
h1 {
  margin: var(--oc-space-4) 0;
  font-family: var(--oc-font-display);
  font-size: var(--oc-text-3xl);
  line-height: var(--oc-leading-tight);
}
p { line-height: var(--oc-leading-body); text-wrap: pretty; }
nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--oc-space-4);
  margin: var(--oc-space-6) 0;
}
a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: var(--oc-space-2) var(--oc-space-4);
  border: var(--oc-border-hair) solid var(--oc-color-link);
  border-radius: var(--oc-radius-md);
  color: var(--oc-color-link);
  text-decoration: underline;
  text-underline-offset: 3px;
}
a:hover { color: var(--oc-color-link-hover); }
a:focus-visible { outline: 2px solid var(--oc-color-focus); outline-offset: 4px; }
</style>
