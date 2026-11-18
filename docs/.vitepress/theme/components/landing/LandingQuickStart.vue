<script setup lang="ts">
/**
 * Landing section "quick-start": the one sentence that puts OrcaCompass to work, next to what
 * comes back. The Skill triggers whenever the orchestrator delegates to Orca workers
 * (skills/orcacompass/SKILL.md), so the request needs no command or flag.
 * The routes are illustrative; their model ids follow docs/examples.md.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

const prompt = 'Split this job across Orca workers. Use OrcaCompass to pick the model for each one.'

const routes = [
  { job: 'Rename a config key', agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
  { job: 'Add an export endpoint', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { job: 'Fix a sync race condition', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
]

const ready = ref(false)
const copied = ref(false)
const message = ref('')
let resetTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => { ready.value = true })
onBeforeUnmount(() => clearTimeout(resetTimer))

async function copy() {
  clearTimeout(resetTimer)
  message.value = ''
  try {
    await navigator.clipboard.writeText(prompt)
    message.value = 'Copied request.'
    copied.value = true
  } catch {
    message.value = 'Copy unavailable. Select and copy the request.'
    copied.value = false
  }
  resetTimer = setTimeout(() => { copied.value = false; message.value = '' }, 4000)
}
</script>

<template>
  <section id="quick-start" class="landing-section landing-section--alt" aria-labelledby="quick-start-title">
    <div class="oc-container">
      <SectionHeading
        id="quick-start-title"
        title="One sentence is all it takes"
        lead="Install it, then tell the agent coordinating your work:"
      />

      <div class="quick">
        <ComicPanel class="quick__say" raised>
          <template #caption>You say</template>
          <p class="quick__prompt">{{ prompt }}</p>
          <!-- Hidden until hydrated: the button does nothing without JavaScript. -->
          <button
            class="quick__copy"
            :class="{ 'quick__copy--pending': !ready }"
            :tabindex="ready ? undefined : -1"
            :aria-hidden="ready ? undefined : true"
            type="button"
            aria-label="Copy the request"
            @click="copy"
          >
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <p class="oc-sr-only" role="status">{{ message }}</p>
          <p v-if="message && !copied" class="quick__status" aria-hidden="true">{{ message }}</p>
        </ComicPanel>

        <ComicPanel class="quick__get" caption-tone="paper">
          <template #caption>Each worker gets a route</template>
          <ul class="quick__routes">
            <li v-for="route in routes" :key="route.job">
              <span class="quick__job">{{ route.job }}</span>
              <span class="quick__route">{{ route.agent }} · {{ route.model }} · {{ route.effort }}</span>
            </li>
          </ul>
          <p class="quick__note">Illustrative. Yours depend on your models and remaining usage.</p>
        </ComicPanel>
      </div>

      <p class="quick__more">
        <a :href="withBase('/skill-workflow.html')">How your orchestrator uses the Skill</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

/* The lead runs into the panels, so the heading sits closer than a section's usual gap. */
.landing-section :deep(.oc-heading) { margin-bottom: var(--oc-space-5); }

.quick { display: grid; gap: var(--oc-space-5); }
.quick > * { min-width: 0; }

.quick__prompt { margin: 0; font-size: var(--oc-text-xl); font-weight: 700; line-height: var(--oc-leading-snug); text-wrap: balance; }
.quick__copy { min-width: 5rem; min-height: 44px; margin-top: var(--oc-space-4); padding: var(--oc-space-2) var(--oc-space-3); border: var(--oc-border-strong) solid var(--oc-color-line); border-radius: var(--oc-radius-sm); background: var(--oc-color-bg-soft); color: var(--oc-color-text); font: inherit; font-weight: 600; cursor: pointer; }
.quick__copy:hover { border-color: var(--oc-color-focus); }
.quick__copy--pending { visibility: hidden; }
.quick__status { margin: var(--oc-space-2) 0 0; color: var(--oc-color-text-muted); font-size: var(--oc-text-sm); }

.quick__routes { margin: 0; padding: 0; list-style: none; }
.quick__routes li { display: grid; gap: var(--oc-space-1); padding-block: var(--oc-space-3); border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); }
.quick__routes li:first-child { padding-top: 0; }
.quick__job { font-weight: 700; }
.quick__route { font: var(--oc-text-sm) / var(--oc-leading-snug) var(--oc-font-mono); color: var(--oc-color-text-muted); overflow-wrap: anywhere; }
.quick__note { margin: var(--oc-space-3) 0 0; font-size: var(--oc-text-sm); color: var(--oc-color-text-subtle); }

.quick__more { margin: var(--oc-space-5) 0 0; }
.quick__more a { display: inline-block; min-height: 44px; align-content: center; }

@media (min-width: 960px) {
  .quick { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
