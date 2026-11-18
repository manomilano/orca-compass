<script setup lang="ts">
/**
 * Landing section "quick-start": the one sentence that puts OrcaCompass to work, and a diagram
 * of what follows. The Skill triggers whenever the orchestrator delegates to Orca workers
 * (skills/orcacompass/SKILL.md), so the request needs no command or flag.
 * The diagram's three workers are the parts of the one job the request names.
 */
import { withBase } from 'vitepress'
import RouteFlow from './quickstart/RouteFlow.vue'
</script>

<template>
  <section id="quick-start" class="landing-section landing-section--alt" aria-labelledby="quick-start-title">
    <div class="oc-container">
      <SectionHeading id="quick-start-title" title="One sentence is all it takes" />

      <ComicPanel class="quick__say" raised>
        <template #caption>You say</template>
        <p>
          Add CSV export to reports.
          <strong>Split it across Orca workers and use OrcaCompass to pick each model.</strong>
        </p>
      </ComicPanel>

      <RouteFlow class="quick__flow" />

      <p class="quick__note">
        Illustrative routes; yours depend on your models and remaining usage.
        <a :href="withBase('/skill-workflow.html')">How your orchestrator uses the Skill</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

.landing-section :deep(.oc-heading) { margin-bottom: var(--oc-space-5); }

/* A slim speech panel: tighter than a story panel. */
.quick__say.quick__say { --_pad: var(--oc-space-4); max-width: 38rem; }
.quick__say p { margin: 0; font-size: var(--oc-text-md); line-height: 1.45; color: var(--oc-color-text-muted); }
.quick__say strong { color: var(--oc-color-text); }

.quick__flow { margin-top: var(--oc-space-6); }

.quick__note { margin: var(--oc-space-5) 0 0; font-size: var(--oc-text-sm); color: var(--oc-color-text-subtle); }
</style>
