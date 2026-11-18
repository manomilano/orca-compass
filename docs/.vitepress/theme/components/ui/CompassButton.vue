<script setup lang="ts">
/**
 * Call-to-action link styled as a primary (gold, "the route") or secondary
 * (outlined) button. Internal links go through withBase; pass them
 * root-relative, e.g. "/getting-started" or "/commands#route".
 */
import { computed } from 'vue'
import { withBase } from 'vitepress'

const props = withDefaults(
  defineProps<{
    /** Root-relative site path ("/guide"), same-page anchor ("#install") or absolute URL. */
    href: string
    /** 'primary' is the one main action in a block; everything else is 'secondary'. */
    variant?: 'primary' | 'secondary'
    /** Show the bearing arrow after the label. */
    arrow?: boolean
  }>(),
  { variant: 'primary', arrow: false },
)

const isExternal = computed(() => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(props.href))

/** "/guide" -> "/guide.html", keeping any query or hash; directories and files with extensions unchanged. */
function toPageUrl(path: string): string {
  const match = /^([^?#]*)(.*)$/.exec(path)
  let pathname = match?.[1] ?? path
  const rest = match?.[2] ?? ''
  if (pathname && !pathname.endsWith('/') && !/\.[a-z\d]+$/i.test(pathname)) pathname += '.html'
  return pathname + rest
}

const resolvedHref = computed(() => {
  if (isExternal.value || props.href.startsWith('#')) return props.href
  return withBase(toPageUrl(props.href))
})
</script>

<template>
  <a
    class="oc-button"
    :class="`oc-button--${variant}`"
    :href="resolvedHref"
    :target="isExternal ? '_blank' : undefined"
    :rel="isExternal ? 'noopener noreferrer' : undefined"
  >
    <span class="oc-button__label"><slot /></span>
    <svg
      v-if="arrow"
      class="oc-button__arrow"
      viewBox="0 0 20 12"
      width="20"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 6h16M11 1l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
    <span v-if="isExternal" class="oc-sr-only"> (opens in a new tab)</span>
  </a>
</template>

<style scoped>
.oc-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.6em;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0.6em 1.25em;
  border: var(--oc-border-strong) solid var(--oc-color-line);
  border-radius: var(--oc-radius-md);
  font-family: var(--oc-font-text);
  font-size: var(--oc-text-base);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.01em;
  text-align: center;
  text-decoration: none;
  transition:
    background-color var(--oc-duration-fast) var(--oc-ease-out),
    box-shadow var(--oc-duration-fast) var(--oc-ease-out),
    transform var(--oc-duration-fast) var(--oc-ease-out);
}

.oc-button--primary {
  border-color: var(--oc-ink);
  background-color: var(--oc-gold);
  color: var(--oc-ink);
  box-shadow: 3px 3px 0 var(--oc-color-shadow);
}

.oc-button--primary:hover {
  background-color: var(--oc-glow);
  box-shadow: 5px 5px 0 var(--oc-color-shadow);
  transform: translate(-2px, -2px);
}

.oc-button--primary:active {
  box-shadow: 1px 1px 0 var(--oc-color-shadow);
  transform: translate(2px, 2px);
}

.oc-button--secondary {
  background-color: transparent;
  color: var(--oc-color-text);
}

.oc-button--secondary:hover {
  background-color: var(--oc-color-bg-soft);
}

.oc-button__arrow {
  flex: none;
  transition: transform var(--oc-duration-fast) var(--oc-ease-out);
}

.oc-button:hover .oc-button__arrow {
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .oc-button,
  .oc-button:hover,
  .oc-button:active,
  .oc-button:hover .oc-button__arrow {
    transform: none;
  }
}
</style>
