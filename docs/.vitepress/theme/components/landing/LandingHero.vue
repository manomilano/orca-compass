<script setup lang="ts">
/**
 * Landing hero: the headline, actions and install command, with an animated diagram of how
 * one request becomes routed workers. The diagram sits beside the text from 1024 px and
 * under it below that. The section follows the light or dark theme.
 */
import HeroFlow from './hero/HeroFlow.vue'
import HeroInstall from './hero/HeroInstall.vue'
</script>

<template>
  <section id="hero" class="landing-section landing-section--alt hero" aria-labelledby="hero-title">
    <div class="oc-container hero__inner">
      <div class="hero__copy">
        <SectionHeading
          id="hero-title"
          :level="1"
          eyebrow="An Agent Skill for Orca"
          title="Pick the right model for every job."
        >
          <template #lead>
            OrcaCompass recommends an agent, model and reasoning effort for each coding job in Orca,
            using model evidence and remaining subscription usage.
          </template>
        </SectionHeading>

        <div class="hero__actions">
          <CompassButton href="#install" arrow>Install OrcaCompass</CompassButton>
          <CompassButton href="/guide" variant="secondary">
            Read the docs
          </CompassButton>
        </div>

        <HeroInstall />
      </div>

      <HeroFlow class="hero__flow" />
    </div>
  </section>
</template>

<style scoped>
/* The tinted band, with a soft light behind the diagram on the right. */
.hero {
  --oc-text-display: clamp(2.75rem, 2rem + 2.6vw, 4.25rem);
  padding-block: var(--oc-space-7);
  background-image:
    radial-gradient(60rem 34rem at 82% 30%, var(--oc-color-band-glow), transparent 70%),
    radial-gradient(var(--oc-color-halftone) 1px, transparent 1.4px);
  background-size: auto, 7px 7px;
}

.hero__inner {
  display: grid;
  align-items: center;
  gap: var(--oc-space-7);
}

.hero__copy {
  display: flex;
  flex-direction: column;
  gap: var(--oc-space-5);
  min-width: 0;
}

.hero__copy :deep(.oc-heading) {
  margin-bottom: 0;
}

.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--oc-space-3);
}

/* Capped so the diagram's text stays near body size on wide screens. */
.hero__flow {
  max-width: 30rem;
}

@media (min-width: 1024px) {
  .hero {
    padding-block: var(--oc-space-8);
  }

  .hero__inner {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .hero__flow {
    justify-self: end;
  }
}
</style>
