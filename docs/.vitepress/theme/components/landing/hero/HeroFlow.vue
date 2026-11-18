<script setup lang="ts">
/**
 * Animated diagram beside the hero headline: how one request becomes routed workers.
 *
 * It follows the Skill's own order (skills/orcacompass/SKILL.md, "Route, then launch"), once
 * per worker: the orchestrator asks OrcaCompass about a job (`orcacompass route`), OrcaCompass
 * answers with an agent, model and effort, the orchestrator launches the worker with them
 * (`orca orchestration worker-start`), and `orcacompass verify` reports `started`.
 *
 * Two colours carry the two halves of the request through the picture: blue for the split
 * into workers, gold for what OrcaCompass picks.
 *
 * Plain SVG in a viewBox, so the server-rendered page already holds the finished picture: the
 * first three workers launched. The motion is CSS only and runs only when the reader allows
 * motion. The jobs are parts of the one job the request names; there are more of them than
 * worker slots, so each slot shows two jobs in turn.
 *
 * The routes are illustrative, and each is one OrcaCompass can return for that job: the model
 * meets the job's needs in the bundled evidence snapshot. Both hard jobs ask for high effort,
 * and only the enemy AI gets Opus: it is rated `high` on all three needs, which Sonnet misses
 * on the agentic axis. The physics engine needs `mid` there, so the cheaper Sonnet covers it.
 * Cursor carries the effort inside the model id, so its routes have no separate effort
 * (docs/effort.md).
 */
import { withBase } from 'vitepress'

/** Width of one character in the mono face, as a share of the font size. */
const MONO = 0.6

/** The two actors: small round portraits, each centred under its name, joined by an ask lane and an answer lane. */
const orchestrator = { x: 50, y: 149, r: 30, art: withBase('/art/flow-orchestrator.webp') }
const compass = { x: 390, y: 149, r: 30, art: withBase('/art/flow-compass.webp') }
const ASK = `M${orchestrator.x + 33},141 H${compass.x - 33}`
const ANSWER = `M${compass.x - 33},157 H${orchestrator.x + 33}`
/** Centre of the lanes, where the question and the answer are written. */
const MID = (orchestrator.x + compass.x) / 2

/** A worker's box, right of the trunk that drops from the orchestrator. */
const BOX = { x: 76, width: 362 }

/** Worker boxes on screen. Job `i` lands in slot `i % SLOTS`. */
const SLOTS = 3

/** In the order they are routed. The CSS timing below is written for exactly six. */
const workers = [
  { job: 'Build the physics engine', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  { job: 'Design the levels', agent: 'codex', model: 'gpt-6.2-sol', effort: 'medium' },
  { job: 'Add the start screen', agent: 'cursor', model: 'grok-4.7-low', effort: null },
  { job: 'Write the enemy AI', agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { job: 'Add keyboard controls', agent: 'cursor', model: 'grok-4.7-medium', effort: null },
  { job: 'Save the high scores', agent: 'codex', model: 'gpt-6.1-terra', effort: 'low' },
].map((worker, i) => {
  const y = 251 + (i % SLOTS) * 58
  const pick = worker.effort ? `${worker.model} · ${worker.effort}` : worker.model
  const route = `${worker.agent} · ${pick}`
  return {
    ...worker,
    y,
    pick,
    pickWidth: pick.length * 11.5 * MONO,
    route,
    routeWidth: route.length * 11 * MONO,
    /** From the orchestrator down the trunk and into this worker's box. */
    launch: `M${orchestrator.x},${orchestrator.y + orchestrator.r} V${y - 8} Q${orchestrator.x},${y} ${orchestrator.x + 8},${y} H${BOX.x}`,
  }
})
/** One entry per slot, for the parts drawn once per box. */
const slots = workers.slice(0, SLOTS)

/**
 * The request, in three runs. Widths are the runs' measured widths in the text face at 13.5px;
 * `textLength` holds each run to its width so the highlight behind it fits in any fallback font.
 */
const say = {
  job: { text: 'Build a browser game.', x: 14, y: 47, width: 131.3 },
  split: { text: 'Split it across Orca workers.', x: 153, y: 47, width: 177.7 },
  pick: { text: 'Use OrcaCompass to pick each model.', x: 18, y: 68, width: 244.2 },
}

const label =
  `You tell the orchestrator: ${say.job.text} ${say.split.text} ${say.pick.text} ` +
  'For each job it asks OrcaCompass, gets back an agent, model and effort, and launches an Orca ' +
  `worker with them. Illustrative routes: ${workers
    .map((w) => `${w.job} runs on ${w.agent} with ${w.model}${w.effort ? ` at ${w.effort} effort` : ''}`)
    .join('; ')}.`
</script>

<template>
  <svg class="flow" viewBox="0 0 440 412" role="img" :aria-label="label" focusable="false">
    <defs>
      <clipPath id="flow-clip-orchestrator"><circle :cx="orchestrator.x" :cy="orchestrator.y" :r="orchestrator.r" /></clipPath>
      <clipPath id="flow-clip-compass"><circle :cx="compass.x" :cy="compass.y" :r="compass.r" /></clipPath>
    </defs>

    <!-- The request -->
    <rect class="flow__shadow" x="6" y="17" width="432" height="70" rx="2" />
    <rect class="flow__box flow__box--ink" x="1" y="12" width="432" height="70" rx="2" />
    <rect class="flow__tag" x="1" y="12" width="74" height="21" />
    <text class="flow__tag-text" x="38" y="23" text-anchor="middle">You say</text>
    <text class="flow__say" :x="say.job.x" :y="say.job.y" :textLength="say.job.width">{{ say.job.text }}</text>
    <rect class="flow__mark flow__mark--split" :x="say.split.x - 4" :y="say.split.y - 9" :width="say.split.width + 8" height="18" rx="2" />
    <text class="flow__marked" :x="say.split.x" :y="say.split.y" :textLength="say.split.width">{{ say.split.text }}</text>
    <rect class="flow__mark flow__mark--pick" :x="say.pick.x - 4" :y="say.pick.y - 9" :width="say.pick.width + 8" height="18" rx="2" />
    <text class="flow__marked" :x="say.pick.x" :y="say.pick.y" :textLength="say.pick.width">{{ say.pick.text }}</text>

    <!-- Fixed lines: the two lanes to OrcaCompass, the trunk to the workers -->
    <path class="flow__line" :d="ASK" />
    <path class="flow__line" :d="ANSWER" />
    <path class="flow__line" :d="`M${compass.x - 40},136 l7,5 l-7,5 M${orchestrator.x + 40},152 l-7,5 l7,5`" />
    <path v-for="slot in slots" :key="`line-${slot.job}`" class="flow__line" :d="slot.launch" />

    <!-- One round per worker: ask, answer, launch -->
    <g v-for="(worker, i) in workers" :key="worker.job" :style="{ '--i': i }">
      <path class="flow__trail" :d="worker.launch" pathLength="1" />
      <circle class="flow__dot flow__dot--ask" :style="{ offsetPath: `path('${ASK}')` }" r="5.5" />
      <circle class="flow__dot flow__dot--answer" :style="{ offsetPath: `path('${ANSWER}')` }" r="5.5" />
      <circle class="flow__dot flow__dot--launch" :style="{ offsetPath: `path('${worker.launch}')` }" r="5.5" />
      <text class="flow__ask" :class="{ 'flow__first': i === 0 }" :x="MID" y="127" text-anchor="middle">{{ worker.job }}?</text>
      <g class="flow__answer" :class="{ 'flow__first': i === 0 }">
        <rect class="flow__mark flow__mark--pick" :x="MID - worker.pickWidth / 2 - 5" y="165" :width="worker.pickWidth + 10" height="18" rx="2" />
        <text class="flow__pick" :x="MID" y="174" text-anchor="middle" :textLength="worker.pickWidth">{{ worker.pick }}</text>
      </g>
    </g>

    <!-- Orchestrator -->
    <text class="flow__heading" :x="orchestrator.x" y="104" text-anchor="middle">Orchestrator</text>
    <image :href="orchestrator.art" :x="orchestrator.x - orchestrator.r" :y="orchestrator.y - orchestrator.r" :width="orchestrator.r * 2" :height="orchestrator.r * 2" clip-path="url(#flow-clip-orchestrator)" preserveAspectRatio="xMidYMid slice" />
    <circle class="flow__ring" :cx="orchestrator.x" :cy="orchestrator.y" :r="orchestrator.r" />

    <!-- OrcaCompass -->
    <text class="flow__heading" :x="compass.x" y="104" text-anchor="middle">OrcaCompass</text>
    <circle class="flow__pulse" :cx="compass.x" :cy="compass.y" :r="compass.r" />
    <image :href="compass.art" :x="compass.x - compass.r" :y="compass.y - compass.r" :width="compass.r * 2" :height="compass.r * 2" clip-path="url(#flow-clip-compass)" preserveAspectRatio="xMidYMid slice" />
    <circle class="flow__ring" :cx="compass.x" :cy="compass.y" :r="compass.r" />

    <!-- Workers -->
    <text class="flow__heading flow__heading--split" :x="BOX.x" y="212">Orca workers</text>
    <text class="flow__command" x="438" y="212" text-anchor="end">orca orchestration worker-start</text>
    <rect v-for="slot in slots" :key="`slot-${slot.job}`" class="flow__slot" :x="BOX.x" :y="slot.y - 25" :width="BOX.width" height="50" rx="2" />
    <g v-for="(worker, i) in workers" :key="`worker-${worker.job}`" class="flow__worker" :class="{ 'flow__later': i >= SLOTS }" :style="{ '--i': i }">
      <rect class="flow__box flow__box--split" :x="BOX.x" :y="worker.y - 25" :width="BOX.width" height="50" rx="2" />
      <text class="flow__job" :x="BOX.x + 14" :y="worker.y - 10">{{ worker.job }}</text>
      <rect class="flow__mark flow__mark--pick" :x="BOX.x + 10" :y="worker.y + 2" :width="worker.routeWidth + 8" height="17" rx="2" />
      <text class="flow__route" :x="BOX.x + 14" :y="worker.y + 10.5" :textLength="worker.routeWidth">{{ worker.route }}</text>
      <rect class="flow__chip" x="354" :y="worker.y - 11" width="74" height="22" rx="2" />
      <path class="flow__check" :d="`M362,${worker.y} l3.5,3.5 l6,-7`" />
      <text class="flow__chip-text" x="377" :y="worker.y">started</text>
    </g>
    <text class="flow__command" x="438" y="405" text-anchor="end">Illustrative routes</text>
  </svg>
</template>

<style scoped>
.flow {
  /* One job is routed every step; the loop is six steps, one per job. */
  --flow-step: 4s;
  --flow-loop: calc(var(--flow-step) * 6);
  /* Lines and frames; the highlights behind text are fixed so ink stays readable on them. */
  --flow-split: var(--oc-color-link);
  --flow-pick: var(--oc-color-route);
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.flow text { dominant-baseline: central; fill: var(--oc-color-text); }
.flow__box { fill: var(--oc-color-surface); stroke: var(--oc-color-line); stroke-width: 2; }
.flow__box--ink { stroke-width: 3; }
.flow__box--split { stroke: var(--flow-split); }
.flow__shadow { fill: var(--oc-color-shadow); }
.flow__ring { fill: none; stroke: var(--oc-color-line); stroke-width: 2.5; }
/* Fixed colours, like every caption box. */
.flow__tag { fill: var(--oc-caption); stroke: var(--oc-ink); stroke-width: 2; }
.flow .flow__tag-text { fill: var(--oc-ink); font: 700 10.5px var(--oc-font-caption); letter-spacing: 0.04em; text-transform: uppercase; }
.flow .flow__say { fill: var(--oc-color-text-muted); font: 13.5px var(--oc-font-text); }
.flow__mark--split { fill: var(--oc-sky); }
.flow__mark--pick { fill: var(--oc-gold); }
.flow .flow__marked { fill: var(--oc-ink); font: 700 13.5px var(--oc-font-text); }

.flow__line { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1.25; opacity: 0.55; }
.flow__trail { fill: none; stroke: var(--flow-split); stroke-width: 3; stroke-dasharray: 1; }
/* Shown only while travelling; without motion the finished picture says it all. */
.flow__dot { fill: var(--flow-pick); stroke: var(--oc-color-text); stroke-width: 1.5; opacity: 0; }
.flow__dot--launch { fill: var(--flow-split); }
.flow__pulse { fill: none; stroke: var(--flow-pick); stroke-width: 3; opacity: 0; transform-box: fill-box; transform-origin: center; }

.flow .flow__heading { fill: var(--oc-color-text-subtle); font: 700 11px var(--oc-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
.flow .flow__heading--split { fill: var(--flow-split); }
.flow .flow__command { fill: var(--oc-color-text-subtle); font: 10px var(--oc-font-mono); }
.flow .flow__ask { font: 600 12.5px var(--oc-font-text); opacity: 0; }
.flow__answer { opacity: 0; }
.flow .flow__pick { fill: var(--oc-ink); font: 700 11.5px var(--oc-font-mono); }
.flow .flow__first { opacity: 1; }
/* Jobs past the first three share a slot with an earlier one, so they wait their turn. */
.flow__later { opacity: 0; }

.flow__slot { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1.25; stroke-dasharray: 4 4; opacity: 0.55; }
.flow .flow__job { font: 600 13.5px var(--oc-font-text); }
.flow .flow__route { fill: var(--oc-ink); font: 11px var(--oc-font-mono); }
.flow__chip { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1.25; }
.flow__check { fill: none; stroke: var(--oc-color-text); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.flow .flow__chip-text { font: 700 11px var(--oc-font-mono); }

/*
 * Each job runs the same 24 s loop, starting one 4 s step after the job before it. In its
 * first step it is asked about, answered and launched; its worker then stays up for two more
 * steps and fades as the other job of its slot is asked about. Everything above is the
 * finished picture, which is what a reader who prefers reduced motion sees.
 */
@media (prefers-reduced-motion: no-preference) {
  .flow__trail, .flow__dot, .flow__ask, .flow__answer, .flow__worker {
    animation: var(--flow-loop) linear calc(var(--i) * var(--flow-step)) infinite backwards;
  }
  .flow__trail { animation-name: flow-trail; }
  .flow__ask { animation-name: flow-ask; }
  .flow__answer { animation-name: flow-answer; }
  .flow__worker { animation-name: flow-worker; }
  .flow__pulse { animation: flow-pulse var(--flow-step) ease-out infinite; }
  @supports (offset-path: path('M0,0')) {
    .flow__dot--ask { animation-name: flow-dot-ask; }
    .flow__dot--answer { animation-name: flow-dot-answer; }
    .flow__dot--launch { animation-name: flow-dot-launch; }
  }
}

@keyframes flow-dot-ask {
  0% { offset-distance: 0%; opacity: 0; }
  0.5%, 3.5% { opacity: 1; }
  4%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-dot-answer {
  0%, 6.25% { offset-distance: 0%; opacity: 0; }
  6.75%, 9.5% { opacity: 1; }
  10%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-dot-launch {
  0%, 10% { offset-distance: 0%; opacity: 0; }
  10.5%, 13.5% { opacity: 1; }
  14%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-ask {
  0%, 10.5%, 100% { opacity: 0; }
  1%, 9% { opacity: 1; }
}
@keyframes flow-answer {
  0%, 6%, 16.5%, 100% { opacity: 0; }
  7%, 15% { opacity: 1; }
}
@keyframes flow-trail {
  0%, 10% { stroke-dashoffset: 1; opacity: 1; }
  14%, 46% { stroke-dashoffset: 0; opacity: 1; }
  50%, 100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes flow-worker {
  0%, 13%, 50%, 100% { opacity: 0; }
  15%, 46% { opacity: 1; }
}
/* OrcaCompass weighs the job between the question and the answer. */
@keyframes flow-pulse {
  0%, 22% { opacity: 0; transform: scale(1); }
  26% { opacity: 0.9; transform: scale(1); }
  40%, 100% { opacity: 0; transform: scale(1.35); }
}
</style>
