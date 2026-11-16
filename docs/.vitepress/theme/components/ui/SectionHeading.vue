<script setup lang="ts">
/**
 * Section heading block: optional eyebrow (small bearing label), the title in
 * the display face, and an optional lead paragraph. Each part also has a slot
 * of the same name for rich content (links, <code>).
 */
import { computed, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Short label above the title, e.g. "How it works". Rendered uppercase. */
    eyebrow?: string
    /** Heading text. Required unless the `title` slot is used. */
    title?: string
    /** One or two sentences under the title. */
    lead?: string
    /** Heading level. Only the hero uses 1; landing sections use 2. */
    level?: 1 | 2 | 3
    /** Alignment of the whole block. */
    align?: 'start' | 'center'
    /** id for the heading element, so the section can use aria-labelledby. */
    id?: string
  }>(),
  { level: 2, align: 'start' },
)

const slots = useSlots()
const headingTag = computed(() => `h${props.level}`)
</script>

<template>
  <header class="oc-heading" :class="[`oc-heading--h${level}`, `oc-heading--${align}`]">
    <p v-if="eyebrow || slots.eyebrow" class="oc-heading__eyebrow">
      <slot name="eyebrow">{{ eyebrow }}</slot>
    </p>
    <component :is="headingTag" :id="id" class="oc-heading__title">
      <slot name="title">{{ title }}</slot>
    </component>
    <p v-if="lead || slots.lead" class="oc-heading__lead">
      <slot name="lead">{{ lead }}</slot>
    </p>
  </header>
</template>

<style scoped>
.oc-heading {
  display: flex;
  flex-direction: column;
  gap: var(--oc-space-3);
  max-width: 52rem;
  margin-bottom: clamp(var(--oc-space-6), 4vw, var(--oc-space-7));
}

.oc-heading--center {
  align-items: center;
  margin-inline: auto;
  text-align: center;
}

.oc-heading__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.75em;
  margin: 0;
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-xs);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: var(--oc-tracking-eyebrow);
  text-transform: uppercase;
  color: var(--oc-color-eyebrow);
}

/* Bearing tick before the eyebrow */
.oc-heading__eyebrow::before {
  content: '';
  flex: none;
  width: 28px;
  height: 7px;
  background:
    linear-gradient(var(--oc-color-route), var(--oc-color-route)) left center / 2px 7px no-repeat,
    repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 6px) left center / 100% 4px
      no-repeat;
}

.oc-heading__title {
  margin: 0;
  border: 0;
  padding: 0;
  font-family: var(--oc-font-display);
  font-weight: 400;
  line-height: var(--oc-leading-tight);
  letter-spacing: var(--oc-tracking-display);
  color: var(--oc-color-text);
  text-wrap: balance;
  overflow-wrap: break-word;
}

.oc-heading--h1 .oc-heading__title {
  font-size: var(--oc-text-display);
}

.oc-heading--h2 .oc-heading__title {
  font-size: var(--oc-text-3xl);
}

.oc-heading--h3 .oc-heading__title {
  font-size: var(--oc-text-xl);
  line-height: var(--oc-leading-snug);
}

.oc-heading__lead {
  max-width: var(--oc-measure);
  margin: 0;
  font-size: var(--oc-text-md);
  line-height: var(--oc-leading-body);
  color: var(--oc-color-text-muted);
  text-wrap: pretty;
}

.oc-heading--h1 .oc-heading__lead {
  font-size: clamp(var(--oc-text-md), 1rem + 0.5vw, 1.375rem);
}
</style>
