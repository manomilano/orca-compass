<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
const props = defineProps<{ command: string; label: string; output?: string; outputLabel?: string }>()
const ready = ref(false)
const message = ref('')
const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => { ready.value = true })
onBeforeUnmount(() => clearTimeout(resetTimer))
async function copy() {
  clearTimeout(resetTimer)
  message.value = ''
  try {
    await navigator.clipboard.writeText(props.command)
    message.value = 'Copied command.'
    copied.value = true
  } catch {
    message.value = 'Copy unavailable. Select and copy the command below.'
    copied.value = false
  }
  resetTimer = setTimeout(() => { copied.value = false; message.value = '' }, 4000)
}
</script>

<template>
  <div class="command-block">
    <div class="command-block__header"><span>{{ label }}</span><button :class="{ 'command-block__copy--pending': !ready }" :tabindex="ready ? undefined : -1" :aria-hidden="ready ? undefined : true" type="button" :aria-label="`Copy ${label.toLowerCase()} command`" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button></div>
    <pre tabindex="0" :aria-label="`${label} command`"><code>{{ command }}</code></pre>
    <template v-if="output"><p class="command-block__caption">{{ outputLabel || 'Illustrative output' }}</p><pre tabindex="0" :aria-label="outputLabel || 'Illustrative output'"><code>{{ output }}</code></pre></template>
    <p class="oc-sr-only" role="status">{{ message }}</p>
    <p v-if="message && !copied" class="command-block__status" aria-hidden="true">{{ message }}</p>
  </div>
</template>

<style scoped>
.command-block { min-width: 0; max-width: 100%; border: var(--oc-border-hair) solid var(--oc-color-line); border-radius: var(--oc-radius-sm); background: var(--oc-color-code-bg); color: var(--oc-color-text); }
.command-block__header { display: flex; align-items: center; justify-content: space-between; gap: var(--oc-space-3); padding: var(--oc-space-2) var(--oc-space-4); border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); font-size: var(--oc-text-sm); font-weight: 600; }
button { flex: none; min-width: 5rem; min-height: 44px; padding: var(--oc-space-2) var(--oc-space-3); border: var(--oc-border-hair) solid var(--oc-color-line); border-radius: var(--oc-radius-sm); background: var(--oc-color-surface); color: var(--oc-color-text); font: inherit; cursor: pointer; }
button:hover { text-decoration: underline; text-underline-offset: 3px; }
.command-block__copy--pending { visibility: hidden; }
pre { max-width: 100%; margin: 0; padding: var(--oc-space-4); overflow-x: auto; font: var(--oc-text-sm) / var(--oc-leading-body) var(--oc-font-mono); white-space: pre; }
pre code { font: inherit; }
.command-block__caption { margin: 0; padding: var(--oc-space-3) var(--oc-space-4) 0; border-top: var(--oc-border-hair) solid var(--oc-color-rule); font: var(--oc-text-xs) / var(--oc-leading-body) var(--oc-font-mono); color: var(--oc-color-text-subtle); }
.command-block__status { margin: 0; padding: 0 var(--oc-space-4) var(--oc-space-3); color: var(--oc-color-text-muted); font-size: var(--oc-text-sm); }
</style>
