<script setup lang="ts">
/**
 * Comic caption box: hand-lettered narration in an inked frame.
 * Text stays real HTML; uppercase is applied with CSS only.
 */
withDefaults(
  defineProps<{
    /** Element to render: 'p' for narration, 'figcaption' inside a figure, 'span' inline. */
    tag?: 'p' | 'div' | 'span' | 'figcaption'
    /** Colour treatment. 'yellow' is the classic caption; 'ink' and 'paper' are quieter. */
    tone?: 'yellow' | 'ink' | 'paper'
  }>(),
  { tag: 'p', tone: 'yellow' },
)
</script>

<template>
  <component :is="tag" class="oc-caption" :class="`oc-caption--${tone}`">
    <slot />
  </component>
</template>

<style scoped>
.oc-caption {
  display: inline-block;
  box-sizing: border-box;
  max-width: min(100%, 36ch);
  margin: 0;
  padding: 0.5em 0.8em 0.45em;
  border: var(--oc-border-strong) solid var(--oc-ink);
  border-radius: var(--oc-radius-sm);
  font-family: var(--oc-font-caption);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  line-height: var(--oc-leading-snug);
  letter-spacing: var(--oc-tracking-caption);
  text-transform: uppercase;
  overflow-wrap: anywhere;
}

/* Fixed colours: captions look the same in every theme and tone. */
.oc-caption--yellow {
  background: var(--oc-caption);
  color: var(--oc-ink);
}

.oc-caption--ink {
  background: var(--oc-ink);
  color: var(--oc-foam);
}

.oc-caption--paper {
  background: var(--oc-foam);
  color: var(--oc-ink);
}

@media (min-width: 768px) {
  .oc-caption {
    font-size: 0.9375rem;
  }
}
</style>
