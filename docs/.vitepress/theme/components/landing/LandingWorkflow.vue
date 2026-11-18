<script setup lang="ts">
/**
 * Landing section "workflow": how OrcaCompass decides. The five routing steps
 * as waypoints on a chart, then the "Rate a job" explainer. Every statement
 * follows README "How it works", docs/how-it-works.md, docs/tiers-and-routing.md
 * and the Skill; the parts live in ./workflow/.
 */
import RateJobExplainer from './workflow/RateJobExplainer.vue'
import RouteChart from './workflow/RouteChart.vue'
</script>

<template>
  <section
    id="workflow"
    class="landing-section landing-section--alt"
    aria-labelledby="workflow-title"
  >
    <div class="oc-container">
      <SectionHeading id="workflow-title" title="From a job to a running worker" />

      <RouteChart />

      <div class="wf-explainer">
        <RateJobExplainer />
      </div>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

.wf-explainer {
  margin-top: var(--oc-space-6);
}
</style>
