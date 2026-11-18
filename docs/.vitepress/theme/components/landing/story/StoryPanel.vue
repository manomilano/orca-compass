<script setup lang="ts">
/**
 * One panel of the story strip: an ink-framed illustration with a caption box
 * (real text) pinned to a corner. AVIF and WebP sources with a JPEG fallback;
 * the image sits below the fold, so it loads lazily.
 */
import { withBase } from 'vitepress'

const props = withDefaults(
  defineProps<{
    /** Image base name in /art, e.g. "story-1". */
    name: string
    alt: string
    captionPlacement?: 'top' | 'bottom'
    raised?: boolean
  }>(),
  { captionPlacement: 'top', raised: false },
)

const widths = [640, 1280, 1920]
const srcset = (format: 'avif' | 'webp') =>
  widths.map((w) => `${withBase(`/art/${props.name}-${w}.${format}`)} ${w}w`).join(', ')

// 1 column up to 899 px, three columns above it inside the 1200 px container.
const sizes = '(min-width: 1280px) 390px, (min-width: 900px) 31vw, (min-width: 640px) 560px, calc(100vw - 2rem)'
const fallback = withBase(`/art/${props.name}-1280.jpg`)
</script>

<template>
  <ComicPanel
    tag="li"
    flush
    :raised="raised"
    :caption-placement="captionPlacement"
    class="story-panel"
  >
    <picture>
      <source media="(max-width: 480px)" type="image/avif" :srcset="withBase(`/art/${props.name}-640.avif`)" />
      <source media="(max-width: 480px)" type="image/webp" :srcset="withBase(`/art/${props.name}-640.webp`)" />
      <source type="image/avif" :srcset="srcset('avif')" :sizes="sizes" />
      <source type="image/webp" :srcset="srcset('webp')" :sizes="sizes" />
      <img
        class="story-panel__img"
        :src="fallback"
        width="1280"
        height="960"
        :alt="alt"
        loading="lazy"
        fetchpriority="low"
        decoding="async"
      />
    </picture>
    <template #caption><slot /></template>
  </ComicPanel>
</template>

<style scoped>
.story-panel__img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 3;
  object-fit: cover;
}
</style>
