<script setup lang="ts">
/**
 * Animated diagram beside the hero headline: how one request becomes routed workers.
 *
 * It follows the Skill's own order (skills/orcacompass/SKILL.md, "Route, then launch"), once
 * per worker: the orchestrator asks OrcaCompass about a job (`orcacompass route`), OrcaCompass
 * answers with an agent, model and effort, the orchestrator launches the worker with them
 * (`orca orchestration worker-start`), and `orcacompass verify` reports `started`.
 *
 * Plain SVG in a viewBox, so the server-rendered page already holds the finished picture: all
 * three workers launched. The motion is CSS only and runs only when the reader allows motion.
 * The three workers are parts of the one job the request names. Their routes are illustrative;
 * the model ids follow docs/examples.md.
 */
import { withBase } from 'vitepress'

const workers = [
  { job: 'Build the export endpoint', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { job: 'Stream million-row exports', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { job: 'Add the download button', agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
].map((worker, i) => {
  const y = 265 + i * 58
  return {
    ...worker,
    y,
    /** From the orchestrator down the trunk and into this worker's box. */
    launch: `M22,176 V${y - 8} Q22,${y} 30,${y} H44`,
  }
})

const label =
  'You give the orchestrator one sentence. For each job it asks OrcaCompass, gets back an agent, ' +
  `model and effort, and launches an Orca worker with them: ${workers
    .map((w) => `${w.job} runs on ${w.agent} with ${w.model} at ${w.effort} effort`)
    .join('; ')}.`

const mark = withBase('/brand/mark.svg')
const ASK = 'M151,141 H360'
const ANSWER = 'M360,157 H151'
</script>

<template>
  <svg class="flow" viewBox="0 0 440 408" role="img" :aria-label="label" focusable="false">
    <!-- The request -->
    <rect class="flow__shadow" x="6" y="17" width="432" height="70" rx="2" />
    <rect class="flow__box flow__box--ink" x="1" y="12" width="432" height="70" rx="2" />
    <rect class="flow__tag" x="1" y="12" width="74" height="21" />
    <text class="flow__tag-text" x="38" y="23" text-anchor="middle">You say</text>
    <text class="flow__say" x="14" y="50">Add CSV export to reports. <tspan class="flow__strong">Split it across Orca</tspan></text>
    <text class="flow__say flow__strong" x="14" y="68">workers and use OrcaCompass to pick each model.</text>

    <!-- Fixed lines: request to orchestrator, the two lanes to OrcaCompass, the trunk to the workers -->
    <path class="flow__line" d="M75,82 V122" />
    <path class="flow__line" :d="ASK" />
    <path class="flow__line" :d="ANSWER" />
    <path class="flow__line" d="M353,136 L360,141 L353,146 M158,152 L151,157 L158,162" />
    <path v-for="worker in workers" :key="`line-${worker.job}`" class="flow__line" :d="worker.launch" />

    <!-- One round per worker: ask, answer, launch -->
    <g v-for="(worker, i) in workers" :key="worker.job" :style="{ '--i': i }">
      <path class="flow__trail" :d="worker.launch" pathLength="1" />
      <circle class="flow__dot flow__dot--ask" :style="{ offsetPath: `path('${ASK}')` }" r="5.5" />
      <circle class="flow__dot flow__dot--answer" :style="{ offsetPath: `path('${ANSWER}')` }" r="5.5" />
      <circle class="flow__dot flow__dot--launch" :style="{ offsetPath: `path('${worker.launch}')` }" r="5.5" />
      <text class="flow__ask" :class="{ 'flow__first': i === 0 }" x="255" y="127" text-anchor="middle">{{ worker.job }}?</text>
      <text class="flow__answer" :class="{ 'flow__first': i === 0 }" x="255" y="174" text-anchor="middle">{{ worker.model }} · {{ worker.effort }}</text>
    </g>

    <!-- Orchestrator -->
    <rect class="flow__box" x="1" y="122" width="150" height="54" rx="2" />
    <text class="flow__heading" x="14" y="141">Orchestrator</text>
    <text class="flow__sub" x="14" y="160">rates each job</text>

    <!-- OrcaCompass -->
    <text class="flow__heading" x="390" y="108" text-anchor="middle">OrcaCompass</text>
    <circle class="flow__pulse" cx="390" cy="149" r="30" />
    <image :href="mark" x="360" y="119" width="60" height="60" />
    <text class="flow__sub" x="390" y="196" text-anchor="middle">evidence · usage</text>

    <!-- Workers -->
    <text class="flow__heading" x="44" y="228">Orca workers</text>
    <text class="flow__command" x="433" y="228" text-anchor="end">orca orchestration worker-start</text>
    <g v-for="(worker, i) in workers" :key="`worker-${worker.job}`">
      <rect class="flow__slot" x="44" :y="worker.y - 25" width="389" height="50" rx="2" />
      <g class="flow__worker" :style="{ '--i': i }">
        <rect class="flow__box" x="44" :y="worker.y - 25" width="389" height="50" rx="2" />
        <text class="flow__job" x="58" :y="worker.y - 9">{{ worker.job }}</text>
        <text class="flow__route" x="58" :y="worker.y + 11">{{ worker.agent }} · {{ worker.model }} · {{ worker.effort }}</text>
        <rect class="flow__chip" x="349" :y="worker.y - 11" width="74" height="22" rx="2" />
        <path class="flow__check" :d="`M357,${worker.y} l3.5,3.5 l6,-7`" />
        <text class="flow__chip-text" x="372" :y="worker.y">started</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.flow { --flow-loop: 12s; display: block; width: 100%; height: auto; overflow: visible; }

.flow text { dominant-baseline: central; fill: var(--oc-color-text); }
.flow__box { fill: var(--oc-color-surface); stroke: var(--oc-color-line); stroke-width: 2; }
.flow__box--ink { stroke-width: 3; }
.flow__shadow { fill: var(--oc-color-shadow); }
/* Fixed colours, like every caption box. */
.flow__tag { fill: var(--oc-caption); stroke: var(--oc-ink); stroke-width: 2; }
.flow .flow__tag-text { fill: var(--oc-ink); font: 700 10.5px var(--oc-font-caption); letter-spacing: 0.04em; text-transform: uppercase; }
.flow .flow__say { fill: var(--oc-color-text-muted); font: 13.5px var(--oc-font-text); }
.flow .flow__strong { fill: var(--oc-color-text); font-weight: 700; }

.flow__line { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1.25; opacity: 0.55; }
.flow__trail { fill: none; stroke: var(--oc-color-route); stroke-width: 3; stroke-linecap: round; stroke-dasharray: 1; }
/* Shown only while travelling; without motion the finished picture says it all. */
.flow__dot { fill: var(--oc-color-route); stroke: var(--oc-color-text); stroke-width: 1.5; opacity: 0; }
.flow__pulse { fill: none; stroke: var(--oc-color-route); stroke-width: 3; opacity: 0; transform-box: fill-box; transform-origin: center; }

.flow .flow__heading { fill: var(--oc-color-text-subtle); font: 700 11px var(--oc-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
.flow .flow__sub { fill: var(--oc-color-text-muted); font: 12px var(--oc-font-text); }
.flow .flow__command { fill: var(--oc-color-text-subtle); font: 10px var(--oc-font-mono); }
.flow .flow__ask { font: 600 12.5px var(--oc-font-text); opacity: 0; }
.flow .flow__answer { font: 700 11.5px var(--oc-font-mono); opacity: 0; }
.flow .flow__first { opacity: 1; }

.flow__slot { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1.25; stroke-dasharray: 4 4; opacity: 0.55; }
.flow .flow__job { font: 600 13.5px var(--oc-font-text); }
.flow .flow__route { fill: var(--oc-color-text-muted); font: 11px var(--oc-font-mono); }
.flow__chip { fill: var(--oc-color-accent); }
.flow__check { fill: none; stroke: var(--oc-color-on-accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.flow .flow__chip-text { fill: var(--oc-color-on-accent); font: 700 11px var(--oc-font-mono); }

/*
 * One 12 s loop per worker, each starting 4 s after the one before: ask, answer, launch, then
 * the worker stays up until its next round. Everything above is the finished picture, which
 * is what a reader who prefers reduced motion sees.
 */
@media (prefers-reduced-motion: no-preference) {
  .flow__trail, .flow__dot, .flow__ask, .flow__answer, .flow__worker {
    animation: var(--flow-loop) linear calc(var(--i) * var(--flow-loop) / 3) infinite backwards;
  }
  .flow__trail { animation-name: flow-trail; }
  .flow__ask { animation-name: flow-ask; }
  .flow__answer { animation-name: flow-answer; }
  .flow__worker { animation-name: flow-worker; }
  .flow__pulse { animation: flow-pulse calc(var(--flow-loop) / 3) ease-out infinite; }
  @supports (offset-path: path('M0,0')) {
    .flow__dot--ask { animation-name: flow-dot-ask; }
    .flow__dot--answer { animation-name: flow-dot-answer; }
    .flow__dot--launch { animation-name: flow-dot-launch; }
  }
}

@keyframes flow-dot-ask {
  0% { offset-distance: 0%; opacity: 0; }
  1%, 7% { opacity: 1; }
  8%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-dot-answer {
  0%, 12.5% { offset-distance: 0%; opacity: 0; }
  13.5%, 19% { opacity: 1; }
  20%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-dot-launch {
  0%, 20% { offset-distance: 0%; opacity: 0; }
  21%, 27% { opacity: 1; }
  28%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-ask {
  0%, 21%, 100% { opacity: 0; }
  2%, 18% { opacity: 1; }
}
@keyframes flow-answer {
  0%, 12%, 33%, 100% { opacity: 0; }
  14%, 30% { opacity: 1; }
}
@keyframes flow-trail {
  0%, 20% { stroke-dashoffset: 1; opacity: 1; }
  28%, 92% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes flow-worker {
  0%, 26%, 100% { opacity: 0; }
  30%, 92% { opacity: 1; }
}
/* OrcaCompass weighs the job between the question and the answer. */
@keyframes flow-pulse {
  0%, 22% { opacity: 0; transform: scale(1); }
  26% { opacity: 0.9; transform: scale(1); }
  40%, 100% { opacity: 0; transform: scale(1.35); }
}
</style>
