<script setup lang="ts">
/**
 * Three-panel graphic-novel strip, then the plain-words version of the problem.
 * Panels stack on phones and sit side by side from 900 px.
 */
import StoryPanel from './story/StoryPanel.vue'
</script>

<template>
  <section id="story" class="landing-section story" aria-labelledby="story-title">
    <div class="oc-container">
      <SectionHeading id="story-title" title="Every worker needs a route" />

      <ol class="story__strip">
        <StoryPanel
          name="story-1"
          alt="Five orcas travel together through blue northern water beneath a bright mountain sky."
        >
          The pod trusted their leader to match each job to its best model.
        </StoryPanel>
        <StoryPanel
          name="story-2"
          caption-placement="bottom"
          alt="A lone orca faces intersecting ocean currents beneath storm clouds and distant mountains."
        >
          But the leader wasn't sure which model fit each job, or how to share the load.
        </StoryPanel>
        <StoryPanel
          name="story-3"
          alt="A golden compass lights three sea routes, each followed by an orca toward a separate island."
        >
          With OrcaCompass, every worker had a route.
        </StoryPanel>
      </ol>

      <div class="story__after">
        <RouteLine class="story__route" />
        <p>
          OrcaCompass picks a model that can do the job and still has usage left; Orca launches
          the worker on it.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story__strip {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--oc-panel-gutter);
  max-width: 36rem;
  margin: 0 auto;
  padding: 0;
  list-style: none;
}

/* Wide enough for the closing sentence to sit on one line on a desktop screen. */
.story__after {
  margin: clamp(var(--oc-space-6), 4vw, var(--oc-space-7)) auto 0;
}

.story__route {
  margin-bottom: var(--oc-space-5);
}

.story__after p {
  margin: 0;
  font-size: var(--oc-text-md);
  line-height: var(--oc-leading-body);
  color: var(--oc-color-text-muted);
  text-wrap: pretty;
}

@media (min-width: 900px) {
  .story__strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-width: none;
    /* Room for the panel shadows at the edge of the grid. */
    padding-right: 5px;
    padding-bottom: 5px;
  }

  .story__after {
    margin-inline: 0;
  }
}
</style>
