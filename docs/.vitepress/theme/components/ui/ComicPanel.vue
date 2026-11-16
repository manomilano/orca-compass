<script setup lang="ts">
/**
 * Ink-framed comic panel. The default slot is the panel body; the optional
 * `caption` slot renders a CaptionBox pinned to a corner of the frame.
 */
import { computed, useSlots } from 'vue'
import CaptionBox from './CaptionBox.vue'

const props = withDefaults(
  defineProps<{
    /** Element to render. With 'figure' the caption becomes a <figcaption>. */
    tag?: 'div' | 'article' | 'figure' | 'li' | 'section'
    /** 'inherit' uses the surrounding tone's surface; the others force a tone inside the panel. */
    tone?: 'inherit' | 'paper' | 'deep' | 'abyss'
    /** Corner that holds the caption. */
    captionPlacement?: 'top' | 'bottom'
    /** Caption box colour, passed to CaptionBox. */
    captionTone?: 'yellow' | 'ink' | 'paper'
    /** No inner padding: for illustrations and media that fill the frame. Caption overlays the media. */
    flush?: boolean
    /** Hard offset ink shadow, for the one panel that should come forward. */
    raised?: boolean
    /** Subtle printed halftone texture on the panel background. */
    halftone?: boolean
  }>(),
  {
    tag: 'div',
    tone: 'inherit',
    captionPlacement: 'top',
    captionTone: 'yellow',
    flush: false,
    raised: false,
    halftone: false,
  },
)

const slots = useSlots()

const classes = computed(() => [
  props.tone !== 'inherit' && `oc-tone-${props.tone}`,
  props.tone !== 'inherit' && 'oc-panel--toned',
  `oc-panel--caption-${props.captionPlacement}`,
  {
    'oc-panel--flush': props.flush,
    'oc-panel--raised': props.raised,
    'oc-halftone': props.halftone,
  },
])

const captionTag = computed(() => (props.tag === 'figure' ? 'figcaption' : 'div'))
</script>

<template>
  <component :is="tag" class="oc-panel" :class="classes">
    <CaptionBox
      v-if="slots.caption"
      class="oc-panel__caption"
      :tag="captionTag"
      :tone="captionTone"
    >
      <slot name="caption" />
    </CaptionBox>
    <div class="oc-panel__body">
      <slot />
    </div>
  </component>
</template>

<style scoped>
.oc-panel {
  --_pad: clamp(1rem, 0.75rem + 1vw, 1.5rem);
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  margin: 0;
  padding: var(--_pad);
  border: var(--oc-border-ink) solid var(--oc-color-line);
  border-radius: var(--oc-radius-sm);
  background-color: var(--oc-color-surface);
  color: var(--oc-color-text);
  list-style: none;
}

.oc-panel--toned {
  background-color: var(--oc-color-bg);
}

.oc-panel--raised {
  box-shadow: var(--oc-shadow-panel);
}

.oc-panel__body {
  flex: 1 1 auto;
  min-width: 0;
}

.oc-panel__body > :deep(:first-child) {
  margin-top: 0;
}

.oc-panel__body > :deep(:last-child) {
  margin-bottom: 0;
}

/* Caption pulled into the frame's corner, borders touching. */
.oc-panel .oc-panel__caption {
  align-self: flex-start;
  margin: calc(-1 * var(--_pad)) 0 var(--oc-space-4) calc(-1 * var(--_pad));
  border-top: 0;
  border-left: 0;
  border-radius: 0;
}

.oc-panel.oc-panel--caption-bottom .oc-panel__caption {
  order: 2;
  align-self: flex-end;
  margin: var(--oc-space-4) calc(-1 * var(--_pad)) calc(-1 * var(--_pad)) 0;
  border: var(--oc-border-strong) solid var(--oc-ink);
  border-bottom: 0;
  border-right: 0;
}

/* Flush panels: media fills the frame and the caption overlays it. */
.oc-panel--flush {
  padding: 0;
  overflow: hidden;
}

.oc-panel.oc-panel--flush .oc-panel__caption {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 0;
  max-width: min(85%, 36ch);
  margin: 0;
}

.oc-panel--flush.oc-panel--caption-bottom .oc-panel__caption {
  top: auto;
  left: auto;
  right: 0;
  bottom: 0;
}

.oc-panel--flush .oc-panel__body > :deep(img),
.oc-panel--flush .oc-panel__body > :deep(picture),
.oc-panel--flush .oc-panel__body > :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
