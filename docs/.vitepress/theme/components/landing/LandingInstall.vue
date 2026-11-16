<script setup lang="ts">
import { withBase } from 'vitepress'
import CommandBlock from './demo/CommandBlock.vue'
</script>

<template>
  <section id="install" class="landing-section" aria-labelledby="install-title">
    <div class="oc-container">
      <SectionHeading id="install-title" title="Install and take your first route" />
      <aside class="install-requirements" aria-labelledby="install-requirements-title">
        <h3 id="install-requirements-title" class="oc-sr-only">Before you begin</h3>
        <p>Use Node.js 24 (recommended), signed-in agent CLIs and running Orca; <a :href="withBase('/getting-started.html#requirements')">check requirements</a>.</p>
      </aside>
      <div class="install-main">
        <div class="install-step">
          <h3><span>01 /</span> Install in your project</h3>
          <CommandBlock command="npx orcacompass install" label="Project install" />
          <p>Install the shared CLI and project Skill, keeping Project if asked for scope.</p>
        </div>
        <div class="install-step">
          <h3><span>02 /</span> Set your preferences</h3>
          <CommandBlock command="orcacompass setup" label="Setup preferences" />
          <p>Choose agents, favorites and bans, then confirm the settings.</p>
        </div>
        <div class="install-step">
          <h3><span>03 /</span> Read your first route</h3>
          <CommandBlock command="orcacompass route --tier daily --json" label="First route" />
          <p>Request an everyday route for your orchestrator to launch with the returned arguments.</p>
        </div>
      </div>
      <p class="install-more"><a :href="withBase('/getting-started.html#other-options')">Other install, update and uninstall options</a></p>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

.install-requirements { margin-bottom: var(--oc-space-5); }
p { margin: 0; color: var(--oc-color-text-muted); }
a { color: var(--oc-color-link); text-decoration: underline; text-underline-offset: 3px; }
a:hover { color: var(--oc-color-link-hover); }
.install-main { display: grid; gap: var(--oc-space-5); }
.install-step { display: grid; align-content: start; gap: var(--oc-space-4); min-width: 0; border-top: var(--oc-border-hair) solid var(--oc-color-line); padding-top: var(--oc-space-5); }
h3 { margin: 0; font-size: var(--oc-text-lg); line-height: var(--oc-leading-snug); font-weight: 700; }
h3 span { color: var(--oc-color-eyebrow); font: var(--oc-text-sm) var(--oc-font-mono); }
.install-more { margin-top: var(--oc-space-5); }
.install-more a { display: inline-block; min-height: 44px; align-content: center; }
@media (min-width: 960px) {
  .install-main { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
