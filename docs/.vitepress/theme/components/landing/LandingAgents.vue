<script setup lang="ts">
import { withBase } from 'vitepress'
import agentsIcon from '../../../../public/brand/icons/agents.svg?raw'

// Sources: docs/models-and-agents.md and src/placements/agents/<agent>.ts.
const crew = [
  { name: 'Claude Code', id: 'claude', status: 'Supported' },
  { name: 'Codex', id: 'codex', status: 'Supported' },
  { name: 'Cursor', id: 'cursor', status: 'Supported' },
  { name: 'Grok Build', id: 'grok', status: 'Supported' },
  { name: 'Antigravity', id: 'antigravity', status: 'Basic support (quota unavailable on Orca 1.4.280+ pending Orca/Antigravity update)' },
  { name: 'Muse', id: 'muse', status: 'Basic support' },
  { name: 'OpenCode', id: 'opencode', status: 'Last resort by default' },
]
</script>

<template>
  <section id="agents" class="landing-section landing-section--alt" aria-labelledby="agents-title">
    <div class="oc-container">
      <SectionHeading id="agents-title" title="One pod. Different routes." />
      <div class="manifest">
        <div class="manifest__masthead">
          <span class="manifest__symbol" aria-hidden="true" v-html="agentsIcon" />
          <p>Agent support</p>
        </div>
        <ul class="manifest__list">
          <li v-for="agent in crew" :key="agent.id" class="manifest__entry">
            <h3>{{ agent.name }}</h3>
            <p class="manifest__status">{{ agent.status }}</p>
          </li>
        </ul>
      </div>
      <p class="agents__footer">
        See <a :href="withBase('/models-and-agents.html')">model discovery and usage windows</a>
        and <a :href="withBase('/orca-agents.html')">Orca agent support</a>.
      </p>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

.manifest { border: var(--oc-border-strong) solid var(--oc-color-line); background: var(--oc-color-surface); }
.manifest__masthead { display: flex; align-items: center; gap: var(--oc-space-3); padding: var(--oc-space-3) var(--oc-space-4); border-bottom: var(--oc-border-strong) solid var(--oc-color-line); background: var(--oc-color-bg-soft); }
.manifest__masthead p { margin: 0; font-family: var(--oc-font-caption); font-size: var(--oc-text-sm); font-weight: 700; text-transform: uppercase; }
.manifest__symbol { display: inline-flex; flex: none; color: var(--oc-color-text); }
.manifest__list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); list-style: none; margin: 0; padding: 0; }
.manifest__entry { display: flex; flex-direction: column; gap: var(--oc-space-1); padding: var(--oc-space-4); min-width: 0; border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); }
.manifest__entry h3 { margin: 0; font-size: var(--oc-text-base); font-weight: 700; line-height: var(--oc-leading-snug); overflow-wrap: anywhere; }
.manifest__status { margin: 0; font-size: var(--oc-text-sm); line-height: var(--oc-leading-snug); color: var(--oc-color-text-muted); }
.agents__footer { margin: var(--oc-space-5) 0 0; color: var(--oc-color-text-muted); }
.agents__footer a { color: var(--oc-color-link); text-decoration: underline; text-underline-offset: 3px; }
.agents__footer a:hover { color: var(--oc-color-link-hover); }
@media (min-width: 768px) {
  .manifest__list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .manifest__entry { padding: var(--oc-space-5); }
}
</style>
