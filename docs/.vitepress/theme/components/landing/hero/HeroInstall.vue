<script setup lang="ts">
/**
 * One-line install command with a copy button.
 * The button is a native <button>, so Enter and Space work; the result is
 * announced through a polite live region that is always in the DOM.
 */
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(defineProps<{ command?: string }>(), {
  command: 'npx orcacompass install',
})

const copied = ref(false)
const announcement = ref('')
let resetTimer: ReturnType<typeof setTimeout> | undefined

/** Fallback for browsers or contexts without the async clipboard API. */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  return ok
}

async function copy() {
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.command)
      ok = true
    } else {
      ok = legacyCopy(props.command)
    }
  } catch {
    ok = legacyCopy(props.command)
  }

  clearTimeout(resetTimer)
  copied.value = ok
  // Clear first so repeated copies are announced again.
  announcement.value = ''
  setTimeout(() => {
    announcement.value = ok
      ? 'Install command copied to the clipboard.'
      : 'Copy failed. Select the command and copy it by hand.'
  }, 30)
  resetTimer = setTimeout(() => {
    copied.value = false
    announcement.value = ''
  }, 2500)
}

onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<template>
  <div class="install">
    <p class="install__label">Install in your project</p>
    <div class="install__frame">
      <span class="install__prompt" aria-hidden="true">$</span>
      <code class="install__command">{{ command }}</code>
      <button
        type="button"
        class="install__copy"
        :class="{ 'install__copy--done': copied }"
        @click="copy"
      >
        <svg
          class="install__icon"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
        >
          <path v-if="!copied" d="M5 1h9v10H5zM3 4H1v11h9v-2" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path v-else d="M2 8.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        <span class="install__copy-text">{{ copied ? 'Copied' : 'Copy' }}</span>
        <span class="oc-sr-only"> install command</span>
      </button>
    </div>
    <p class="oc-sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
  </div>
</template>

<style scoped>
.install {
  max-width: 34rem;
}

.install__label {
  margin: 0 0 var(--oc-space-2);
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-xs);
  font-weight: 700;
  letter-spacing: var(--oc-tracking-eyebrow);
  text-transform: uppercase;
  color: var(--oc-color-text-muted);
}

.install__frame {
  display: flex;
  align-items: stretch;
  min-width: 0;
  border: var(--oc-border-strong) solid var(--oc-color-line);
  border-radius: var(--oc-radius-sm);
  background: var(--oc-abyss-deep);
  color: var(--oc-foam);
}

.install__prompt {
  display: flex;
  align-items: center;
  padding-inline: var(--oc-space-3) 0;
  font-family: var(--oc-font-mono);
  font-weight: 700;
  color: var(--oc-color-route);
  user-select: none;
}

.install .install__command {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: var(--oc-space-3) var(--oc-space-3);
  background: none;
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-base);
  color: inherit;
  overflow-x: auto;
  white-space: nowrap;
  user-select: all;
}

.install__copy {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--oc-space-2);
  min-width: 44px;
  min-height: 44px;
  padding: 0 var(--oc-space-4);
  border: 0;
  border-left: var(--oc-border-strong) solid var(--oc-color-line);
  background: var(--oc-trench);
  color: var(--oc-foam);
  font-family: var(--oc-font-text);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--oc-duration-fast) var(--oc-ease-out);
}

.install__copy:hover {
  background: var(--oc-deep-sea);
}

.install__copy:focus-visible {
  outline-offset: -4px;
}

.install__copy--done,
.install__copy--done:hover {
  background: var(--oc-foam);
  color: var(--oc-ink);
}

.install__icon {
  flex: none;
}

/* Keep the whole command visible on the narrowest phones. */
@media (max-width: 479px) {
  .install__prompt {
    padding-inline: var(--oc-space-2) 0;
  }

  .install .install__command {
    padding-inline: var(--oc-space-2);
    font-size: var(--oc-text-xs);
  }

  .install__copy {
    gap: var(--oc-space-1);
    padding-inline: var(--oc-space-3);
  }
}
</style>
