<script setup lang="ts">
/**
 * Responsive comic-page grid: panels flow into as many columns as fit,
 * separated by the panel gutter. One column on a phone.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Element to render. Use 'ol' or 'ul' when the panels are a sequence or list (panels then use tag="li"). */
    tag?: 'div' | 'ol' | 'ul'
    /** Minimum column width before the grid drops a column. */
    min?: string
    /** Maximum number of columns on wide screens. */
    maxColumns?: number
  }>(),
  { tag: 'div', min: '16rem', maxColumns: 3 },
)

const style = computed(() => ({
  '--_min': props.min,
  '--_max-cols': String(props.maxColumns),
}))
</script>

<template>
  <component :is="tag" class="oc-panel-grid" :style="style">
    <slot />
  </component>
</template>

<style scoped>
.oc-panel-grid {
  --_gap: var(--oc-panel-gutter);
  display: grid;
  /* Columns are at least --_min wide and at most --_max-cols per row. */
  grid-template-columns: repeat(
    auto-fit,
    minmax(max(min(100%, var(--_min)), (100% - (var(--_max-cols) - 1) * var(--_gap)) / var(--_max-cols)), 1fr)
  );
  gap: var(--_gap);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
