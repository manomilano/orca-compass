<script setup lang="ts">
/**
 * A golden route line: the dotted track a worker follows. Use it to link
 * steps or to divide content. Decorative and hidden from assistive tech.
 */
withDefaults(
  defineProps<{
    /** 'horizontal' fills the available width; 'vertical' fills the available height. */
    orientation?: 'horizontal' | 'vertical'
    /** Soft glow around the dots, for dark tones. */
    glow?: boolean
    /** Slow drift of the dots along the route. Disabled under prefers-reduced-motion. */
    animated?: boolean
  }>(),
  { orientation: 'horizontal', glow: false, animated: false },
)
</script>

<template>
  <span
    class="oc-route"
    :class="[`oc-route--${orientation}`, { 'oc-route--glow': glow, 'oc-route--animated': animated }]"
    aria-hidden="true"
  />
</template>

<style scoped>
.oc-route {
  --_dot: radial-gradient(circle, var(--oc-color-route) 1.6px, transparent 2.2px);
  display: block;
  flex: 1 1 auto;
}

.oc-route--horizontal {
  width: 100%;
  min-width: 24px;
  height: 6px;
  background: var(--_dot) 0 50% / 12px 6px repeat-x;
}

.oc-route--vertical {
  width: 6px;
  min-height: 24px;
  height: 100%;
  background: var(--_dot) 50% 0 / 6px 12px repeat-y;
}

.oc-route--glow {
  filter: drop-shadow(0 0 3px var(--oc-glow));
}

.oc-route--animated.oc-route--horizontal {
  animation: oc-route-drift-x var(--oc-duration-ambient) linear infinite;
}

.oc-route--animated.oc-route--vertical {
  animation: oc-route-drift-y var(--oc-duration-ambient) linear infinite;
}

@keyframes oc-route-drift-x {
  to {
    background-position: 120px 50%;
  }
}

@keyframes oc-route-drift-y {
  to {
    background-position: 50% 120px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .oc-route--animated.oc-route--horizontal,
  .oc-route--animated.oc-route--vertical {
    animation: none;
  }
}
</style>
