<script setup lang="ts">
/**
 * Landing hero: full-bleed illustration with the headline in a solid panel.
 * Below 960 px the picture is not shown, so the headline, actions and install command lead
 * the page on their own; a 1x1 transparent source keeps those windows from downloading it.
 * 960 px and up: the picture fills the section and the panel sits on its dark left third.
 * Past 1920 px the picture stops growing and its side edges fade into the section, so the
 * artwork keeps the 1920 px crop instead of cropping ever deeper into the 16:9 scene.
 * On desktop the hero picture is the page's LCP element: eager, fetchpriority high.
 */
import { withBase } from 'vitepress'
import HeroInstall from './hero/HeroInstall.vue'

const widths = [640, 1280, 1920, 2400]
const srcset = (format: 'avif' | 'webp') =>
  widths.map((w) => `${withBase(`/art/hero-${w}.${format}`)} ${w}w`).join(', ')

const sizes = '(min-width: 120rem) 120rem, 100vw'
const fallback = withBase('/art/hero-1280.jpg')
const blank = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
</script>

<template>
  <section id="hero" class="landing-section oc-tone-abyss hero" aria-labelledby="hero-title">
    <picture class="hero__picture">
      <source media="(max-width: 959.98px)" :srcset="blank" />
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
/* Narrow windows: no picture, so the section pads its top like its bottom. */
.hero {
  --oc-text-display: clamp(2.75rem, 2rem + 2.6vw, 4.25rem);
  padding-block: var(--oc-section-pad);
  overflow: hidden;
}

.hero__picture {
  display: none;
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

@media (min-width: 960px) {
  .hero {
    display: grid;
    align-items: center;
    min-height: clamp(38rem, 56vw, 54rem);
    padding-block: var(--oc-space-8);
  }

  /*
   * Capped at 120rem and centred, so the scene keeps its 1920 px composition. The fade grows
   * from 0 at 1920 px to 10rem, hiding the artwork's side edges on wider screens.
   */
  .hero__picture {
    --hero-fade: clamp(0px, 100vw - 120rem, 10rem);
    display: block;
    position: absolute;
    inset: 0;
    max-width: 120rem;
    margin-inline: auto;
    -webkit-mask-image: linear-gradient(
      to right,
      transparent,
      #000 var(--hero-fade),
      #000 calc(100% - var(--hero-fade)),
      transparent
    );
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 var(--hero-fade),
      #000 calc(100% - var(--hero-fade)),
      transparent
    );
  }

  .hero__img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 80% 50%;
  }

  .hero__inner {
    position: relative;
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
