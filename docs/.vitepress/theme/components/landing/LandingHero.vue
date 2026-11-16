<script setup lang="ts">
/**
 * Landing hero: full-bleed illustration with the headline in a solid panel.
 * Phones: picture on top, panel below (no text over the image).
 * 960 px and up: the picture fills the section and the panel sits on its dark left third.
 * The hero picture is the page's LCP element: eager, fetchpriority high.
 */
import { withBase } from 'vitepress'
import HeroInstall from './hero/HeroInstall.vue'

const widths = [640, 1280, 1920, 2400]
const srcset = (format: 'avif' | 'webp') =>
  widths.map((w) => `${withBase(`/art/hero-${w}.${format}`)} ${w}w`).join(', ')

const sizes = '100vw'
const fallback = withBase('/art/hero-1280.jpg')
</script>

<template>
  <section id="hero" class="landing-section oc-tone-abyss hero" aria-labelledby="hero-title">
    <picture class="hero__picture">
      <source media="(max-width: 480px)" type="image/avif" :srcset="withBase('/art/hero-640.avif')" />
      <source media="(max-width: 480px)" type="image/webp" :srcset="withBase('/art/hero-640.webp')" />
      <source type="image/avif" :srcset="srcset('avif')" :sizes="sizes" />
      <source type="image/webp" :srcset="srcset('webp')" :sizes="sizes" />
      <img
        class="hero__img"
        :src="fallback"
        width="1280"
        height="720"
        alt="A lead orca rises beside a glowing golden compass as its pod follows lit routes toward northern islands."
        loading="eager"
        fetchpriority="high"
        decoding="async"
      />
    </picture>

    <div class="oc-container hero__inner">
      <div class="hero__panel">
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
    </div>
  </section>
</template>

<style scoped>
/* The picture owns the top of the section on phones, so the section has no top padding. */
.hero {
  --oc-text-display: clamp(2.75rem, 2rem + 2.6vw, 4.25rem);
  padding-block: 0 var(--oc-section-pad);
  border-bottom: var(--oc-border-ink) solid var(--oc-color-line);
  overflow: hidden;
}

.hero__picture {
  display: block;
  border-bottom: var(--oc-border-ink) solid var(--oc-color-line);
  background: var(--oc-abyss-deep);
}

.hero__img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  object-position: 72% 50%;
}

.hero__inner {
  padding-top: var(--oc-space-6);
}

.hero__panel {
  display: flex;
  flex-direction: column;
  gap: var(--oc-space-5);
  min-width: 0;
}

.hero__panel :deep(.oc-heading) {
  margin-bottom: 0;
}

.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--oc-space-3);
}

@media (min-width: 640px) {
  .hero__img {
    aspect-ratio: 16 / 9;
  }
}

@media (min-width: 960px) {
  .hero {
    display: grid;
    align-items: center;
    min-height: clamp(38rem, 56vw, 54rem);
    padding-block: var(--oc-space-8);
    border-bottom: 0;
  }

  .hero__picture {
    position: absolute;
    inset: 0;
    border-bottom: 0;
  }

  .hero__img {
    width: 100%;
    height: 100%;
    aspect-ratio: auto;
    object-position: 80% 50%;
  }

  .hero__inner {
    position: relative;
    padding-top: 0;
  }

  /* Solid panel: contrast never depends on the picture behind it. */
  .hero__panel {
    width: min(100%, 37rem);
    box-sizing: border-box;
    padding: var(--oc-space-6);
    border: var(--oc-border-ink) solid var(--oc-color-line);
    border-radius: var(--oc-radius-sm);
    background-color: var(--oc-abyss);
    box-shadow: var(--oc-shadow-panel);
  }
}
</style>
