<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import CommandBlock from './demo/CommandBlock.vue'
const ready = ref(false)
const active = ref(0)
const tabs = ['Everyday job', 'Three needs', 'Why this route?', 'Launch → verify']
onMounted(() => { ready.value = true })
async function navigate(event: KeyboardEvent, index: number) {
  if (event.key === ' ') {
    event.preventDefault()
    active.value = index
    return
  }
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!direction && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  active.value = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length
  await nextTick()
  document.getElementById(`demo-tab-${active.value}`)?.focus()
}
const daily = `{
  "status": "ok", "tier": "light",
  "route": { "agent": "claude", "model": "claude-haiku-5-5", "effort": "medium" },
  "launchArgs": ["--agent", "claude", "--model", "claude-haiku-5-5", "--effort", "medium"]
}`
const needs = `{
  "status": "ok",
  "needs": { "coding": "mid", "agentic": "low", "reasoning": "low" },
  "needsSource": "need",
  "tier": "daily",
  "route": { "agent": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
  "launchArgs": ["--agent", "claude", "--model", "claude-sonnet-5-5", "--effort", "medium"]
}`
const readable = `daily → claude · claude-sonnet-5-5 · medium (high confidence)
  claude claude-sonnet-5-5: weekly 40% reported + 1.5 pp reserved (1 worker) + 1.5 pp for this worker = 43% prospective (available), resets in 2d
  cost: daily ($4.00/M blended, maker price)
  reserved rsv_3f9a1c2b7d10: weekly +1.5 pp; after worker-start run: orcacompass verify --dispatch <id> --reservation rsv_3f9a1c2b7d10`
</script>

<template>
  <section id="demo" class="landing-section landing-section--alt" aria-labelledby="demo-title">
    <div class="oc-container">
      <SectionHeading id="demo-title" title="Read a route and its reasons" lead="Illustrative routes show what your orchestrator receives and how it uses the result." />
      <!-- Always dark, like the route chart above: a screen set on the page. -->
      <div class="demo-terminal oc-tone-deep">
        <div class="demo-terminal__label"><span>OrcaCompass / routing log</span><span>Illustrative examples</span></div>
        <div class="demo-tabs" :role="ready ? 'tablist' : undefined" aria-label="Routing examples">
          <!-- VitePress captures anchor clicks before Vue; buttons switch in place after hydration. -->
          <component :is="ready ? 'button' : 'a'" v-for="(tab, index) in tabs" :id="`demo-tab-${index}`" :key="tab" class="demo-tab" :href="ready ? undefined : `#demo-panel-${index}`" :type="ready ? 'button' : undefined" :role="ready ? 'tab' : undefined" :aria-selected="ready ? active === index : undefined" :aria-controls="`demo-panel-${index}`" :tabindex="ready && active !== index ? -1 : 0" @click="active = index" @keydown="navigate($event, index)">{{ tab }}</component>
        </div>
        <div id="demo-panel-0" class="demo-panel" :role="ready ? 'tabpanel' : undefined" aria-labelledby="demo-tab-0" :hidden="ready && active !== 0" :tabindex="ready ? 0 : undefined">
          <div class="demo-panel__code">
            <CommandBlock command="orcacompass route --tier daily --json" label="Route an everyday job" :output="daily" output-label="Illustrative JSON excerpt" />
          </div>
          <ol class="demo-notes">
            <li><strong>The pick</strong><p>Only <code>status: "ok"</code> carries a route.</p></li>
            <li><strong>The cost tier</strong><p>The returned <code>tier</code> is the chosen model’s cost tier: a light-cost model covers this everyday job.</p></li>
            <li><strong>The launch arguments</strong><p>Pass <code>launchArgs</code> to Orca to launch the worker.</p></li>
          </ol>
        </div>
        <div id="demo-panel-1" class="demo-panel" :role="ready ? 'tabpanel' : undefined" aria-labelledby="demo-tab-1" :hidden="ready && active !== 1" :tabindex="ready ? 0 : undefined">
          <CommandBlock command="orcacompass route --need coding=mid,agentic=low,reasoning=low --demand moderate --json" label="Rate the three needs" :output="needs" output-label="Illustrative JSON excerpt" />
          <ol class="demo-notes">
            <li><strong>Three separate needs</strong><p><code>--tier</code> is shorthand for equal needs on all three axes.</p></li>
            <li><strong>Effort follows demand</strong><p>Effort demand maps to supported effort through your effort policy.</p></li>
            <li><strong>Arguments, ready to pass</strong><p>Pass each <code>launchArgs</code> element as a separate, properly quoted argument.</p></li>
          </ol>
        </div>
        <div id="demo-panel-2" class="demo-panel" :role="ready ? 'tabpanel' : undefined" aria-labelledby="demo-tab-2" :hidden="ready && active !== 2" :tabindex="ready ? 0 : undefined">
          <CommandBlock command="orcacompass route --tier advanced" label="Read an advanced request in plain text" :output="readable" output-label="Illustrative output excerpt · README example" />
          <ol class="demo-notes">
            <li><strong>Capability and cost</strong><p>This advanced request finds a daily-cost route covering its needs.</p></li>
            <li><strong>Usage in context</strong><p>Reported usage, what running workers reserve, and this worker's own share add up per quota. Nothing is forecast.</p></li>
            <li><strong>Your result will vary</strong><p>Your installed models and current usage determine the recommendation.</p></li>
          </ol>
        </div>
        <div id="demo-panel-3" class="demo-panel" :role="ready ? 'tabpanel' : undefined" aria-labelledby="demo-tab-3" :hidden="ready && active !== 3" :tabindex="ready ? 0 : undefined">
          <div class="demo-panel__code">
            <p class="demo-context">Launch with the returned arguments, then verify using the receipt’s dispatch ID.</p>
            <CommandBlock command='orca orchestration worker-start --spec "&lt;actual task&gt;" --agent claude --model claude-sonnet-5-5 --effort medium' label="Launch with the returned arguments" />
            <CommandBlock command="orcacompass verify --dispatch ctx_example" label="Check the launched worker" output="started: claude · claude-sonnet-5-5 — working for 8s with no refusal&#10;next:&#10;  1. nothing: wait for worker_done as usual" output-label="Illustrative output · example dispatch ID" />
          </div>
          <ol class="demo-notes">
            <li><strong>The orchestrator launches</strong><p>OrcaCompass recommends; Orca launches.</p></li>
            <li><strong>Check the verdict</strong><p><code>started</code> confirms observed startup without refusal; continue supervising the worker’s code.</p></li>
            <li><strong>After refusal</strong><p>After <code>rejected</code>, complete the returned cleanup steps before routing a replacement.</p></li>
          </ol>
        </div>
      </div>
      <div class="demo-more"><CompassButton href="/examples" variant="secondary" arrow>More routing examples</CompassButton></div>
    </div>
  </section>
</template>

<style scoped>
.landing-section { --oc-section-pad: var(--oc-space-6); }
@media (min-width: 768px) {
  .landing-section { --oc-section-pad: var(--oc-space-8); }
}

.demo-terminal { min-width: 0; border: var(--oc-border-strong) solid var(--oc-color-line); border-radius: var(--oc-radius-sm); background: var(--oc-color-surface); box-shadow: var(--oc-shadow-panel); }
.demo-terminal__label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--oc-space-2); padding: var(--oc-space-4) var(--oc-space-5); font: var(--oc-text-xs) var(--oc-font-mono); color: var(--oc-color-text-muted); border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); }
.demo-tabs { display: flex; flex-wrap: wrap; gap: var(--oc-space-2); padding: var(--oc-space-4); border-bottom: var(--oc-border-hair) solid var(--oc-color-rule); }
.demo-tab { display: flex; align-items: center; justify-content: center; min-height: 44px; padding: var(--oc-space-2) var(--oc-space-4); color: var(--oc-color-text); background: var(--oc-color-bg-soft); border: var(--oc-border-strong) solid var(--oc-color-line); border-radius: var(--oc-radius-sm); font: inherit; font-weight: 600; text-decoration: none; }
.demo-tab[aria-selected='true'] { background: var(--oc-color-accent); color: var(--oc-color-on-accent); border-color: var(--oc-color-accent); box-shadow: inset 0 -3px 0 var(--oc-ink); }
.demo-tab:hover { border-color: var(--oc-color-focus); }
.demo-tab:active { transform: translateY(1px); }
@media (prefers-reduced-motion: reduce) { .demo-tab:active { transform: none; } }
.demo-panel { display: grid; gap: var(--oc-space-6); padding: var(--oc-space-5); min-width: 0; }
.demo-panel[hidden] { display: none; }
.demo-panel > *, .demo-panel__code { min-width: 0; }
.demo-panel__code { display: grid; align-content: start; gap: var(--oc-space-5); }
.demo-context { margin: 0; color: var(--oc-color-text-muted); }
.demo-notes { display: grid; align-content: start; gap: var(--oc-space-4); margin: 0; padding: 0; list-style: none; counter-reset: bearing; }
.demo-notes li { border-top: var(--oc-border-hair) solid var(--oc-color-rule); padding-top: var(--oc-space-4); counter-increment: bearing; }
.demo-notes strong { font-size: var(--oc-text-lg); }
.demo-notes strong::before { content: '0' counter(bearing) ' / '; color: var(--oc-color-link); font: var(--oc-text-sm) var(--oc-font-mono); }
.demo-notes p { margin: var(--oc-space-2) 0 0; color: var(--oc-color-text-muted); }
.demo-more { margin-top: var(--oc-space-6); }
@media (max-width: 480px) {
  .demo-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .demo-tab { padding-inline: var(--oc-space-2); }
}
@media (min-width: 960px) { .demo-panel { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); padding: var(--oc-space-6); } }
</style>
