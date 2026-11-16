<script setup lang="ts">
/**
 * Inline compass rose: ink rings and bearing ticks in currentColor, a gold
 * north needle. Decorative by default; pass `label` to make it an image.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Rendered width and height in px, or any CSS length. */
    size?: number | string
    /** Accessible name. Without it the mark is hidden from assistive tech. */
    label?: string
    /** Rotate the needle to a bearing in degrees (0 = north). */
    bearing?: number
  }>(),
  { size: 40, bearing: 0 },
)

const cssSize = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
const ticks = Array.from({ length: 32 }, (_, i) => i * 11.25)
</script>

<template>
  <svg
    class="oc-compass"
    viewBox="0 0 64 64"
    :width="cssSize"
    :height="cssSize"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    focusable="false"
  >
    <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="2" />
    <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="1" opacity="0.6" />
    <line
      v-for="angle in ticks"
      :key="angle"
      x1="32"
      :y1="angle % 90 === 0 ? 2 : angle % 45 === 0 ? 4 : 5.5"
      x2="32"
      y2="8"
      stroke="currentColor"
      :stroke-width="angle % 45 === 0 ? 1.6 : 0.8"
      :transform="`rotate(${angle} 32 32)`"
    />
    <g :transform="`rotate(${bearing} 32 32)`">
      <path d="M32 9 L37 32 L27 32 Z" class="oc-compass__north" />
      <path d="M32 55 L27 32 L37 32 Z" fill="currentColor" />
    </g>
    <circle cx="32" cy="32" r="2.5" fill="currentColor" />
  </svg>
</template>

<style scoped>
.oc-compass {
  display: inline-block;
  flex: none;
  vertical-align: middle;
  overflow: visible;
}

.oc-compass__north {
  fill: var(--oc-color-route);
}
</style>
