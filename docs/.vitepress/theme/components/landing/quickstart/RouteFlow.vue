<script setup lang="ts">
/**
 * Animated diagram for the "quick-start" section: the workers of one job travel through
 * OrcaCompass, and each arrives at the model picked for it.
 *
 * Drawn twice from the same data: `wide` (workers, compass and models in a row) from 960 px,
 * `tall` (pills on the left, the compass on a spine to their right) below. CSS shows one.
 * Both are plain SVG in a viewBox, so the server-rendered page already holds the finished
 * picture; the motion is CSS only and runs only when the reader allows motion.
 *
 * The routes are illustrative; the model ids follow docs/examples.md and README.md.
 */
import { withBase } from 'vitepress'

const workers = [
  { job: 'Build the export endpoint', model: 'claude-sonnet-5-5', effort: 'medium' },
  { job: 'Stream million-row exports', model: 'gpt-6.1-sol', effort: 'high' },
  { job: 'Add the download button', model: 'claude-haiku-5-5', effort: 'low' },
]
/** Every model on offer; one stays unpicked to show that the route is a choice. */
const models = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol']

const label = `One job split across three Orca workers, each routed by OrcaCompass: ${workers
  .map((w) => `${w.job} goes to ${w.model} at ${w.effort} effort`)
  .join('; ')}.`

const PILL_H = 38
const mark = withBase('/brand/mark.svg')

interface Pill { x: number; y: number; text: string }
interface Layout {
  name: 'wide' | 'tall'
  width: number
  height: number
  pillWidth: number
  hub: { x: number; y: number; r: number }
  hubLabel: { x: number; y: number; anchor: 'middle' | 'end' }
  headings: { x: number; y: number; text: string; anchor: 'start' | 'end' }[]
  workers: Pill[]
  models: (Pill & { effort?: string; index?: number })[]
  /** Faint lines for every possible connection. */
  links: string[]
  /** One path per worker: its pill, through the compass, to its model. */
  routes: string[]
}

/** Centre lines of `count` pills, the first at `first`. */
const rows = (count: number, first: number, pitch: number) =>
  Array.from({ length: count }, (_, i) => first + i * pitch)

function build(name: 'wide' | 'tall'): Layout {
  const wide = name === 'wide'
  const pillWidth = wide ? 250 : 268
  const width = wide ? 1000 : 360
  const modelYs = wide ? rows(models.length, 43, 50) : rows(models.length, 262, 46)
  const workerYs = wide ? rows(workers.length, 68, 50) : rows(workers.length, 43, 46)
  const hub = wide ? { x: 500, y: 118, r: 36 } : { x: 316, y: 195, r: 30 }
  const workerX = 1
  const modelX = wide ? width - pillWidth - 1 : 1

  // Path from a worker's pill into the compass, and from the compass out to a model's pill.
  const into = (y: number) =>
    wide
      ? `M${workerX + pillWidth},${y} C370,${y} 370,${hub.y} ${hub.x - hub.r},${hub.y}`
      : `M${workerX + pillWidth},${y} C${hub.x},${y} ${hub.x},${y} ${hub.x},${hub.y - hub.r}`
  const out = (y: number, join: 'M' | 'L') =>
    wide
      ? `${join}${hub.x + hub.r},${hub.y} C630,${hub.y} 630,${y} ${modelX},${y}`
      : `${join}${hub.x},${hub.y + hub.r} C${hub.x},${y} ${hub.x},${y} ${modelX + pillWidth},${y}`

  return {
    name,
    width,
    height: (modelYs.at(-1) ?? 0) + PILL_H / 2 + 2,
    pillWidth,
    hub,
    hubLabel: wide
      ? { x: hub.x, y: hub.y + hub.r + 18, anchor: 'middle' }
      : { x: hub.x - hub.r - 10, y: hub.y, anchor: 'end' },
    // Each column's heading sits just above its first pill.
    headings: [
      { x: workerX, y: workerYs[0] - PILL_H / 2 - 13, text: 'Workers', anchor: 'start' },
      wide
        ? { x: width - 1, y: modelYs[0] - PILL_H / 2 - 13, text: 'Models', anchor: 'end' }
        : { x: modelX, y: modelYs[0] - PILL_H / 2 - 13, text: 'Models', anchor: 'start' },
    ],
    workers: workers.map((w, i) => ({ x: workerX, y: workerYs[i], text: w.job })),
    models: models.map((id, i) => {
      const index = workers.findIndex((w) => w.model === id)
      return { x: modelX, y: modelYs[i], text: id, effort: workers[index]?.effort, index: index < 0 ? undefined : index }
    }),
    links: [...workerYs.map((y) => into(y)), ...modelYs.map((y) => out(y, 'M'))],
    routes: workers.map((w, i) => `${into(workerYs[i])} ${out(modelYs[models.indexOf(w.model)], 'L')}`),
  }
}

const layouts = [build('wide'), build('tall')]

/** Width of an effort chip for its text, in viewBox units. */
const chipWidth = (text: string) => text.length * 7 + 16
</script>

<template>
  <div class="flow">
    <svg
      v-for="layout in layouts"
      :key="layout.name"
      class="flow__svg"
      :class="`flow__svg--${layout.name}`"
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      role="img"
      :aria-label="label"
      focusable="false"
    >
      <path v-for="d in layout.links" :key="d" class="flow__link" :d="d" />
      <path
        v-for="(d, i) in layout.routes"
        :key="`route-${i}`"
        class="flow__route"
        :style="{ '--i': i }"
        :d="d"
        pathLength="1"
      />
      <circle
        v-for="(d, i) in layout.routes"
        :key="`dot-${i}`"
        class="flow__dot"
        :style="{ '--i': i, offsetPath: `path('${d}')` }"
        r="6"
      />

      <image
        :href="mark"
        :x="layout.hub.x - layout.hub.r"
        :y="layout.hub.y - layout.hub.r"
        :width="layout.hub.r * 2"
        :height="layout.hub.r * 2"
      />
      <text class="flow__heading" :x="layout.hubLabel.x" :y="layout.hubLabel.y" :text-anchor="layout.hubLabel.anchor">OrcaCompass</text>
      <text
        v-for="heading in layout.headings"
        :key="heading.text"
        class="flow__heading"
        :x="heading.x"
        :y="heading.y"
        :text-anchor="heading.anchor"
      >{{ heading.text }}</text>

      <g v-for="pill in layout.workers" :key="pill.text">
        <rect class="flow__pill" :x="pill.x" :y="pill.y - PILL_H / 2" :width="layout.pillWidth" :height="PILL_H" rx="3" />
        <text class="flow__job" :x="pill.x + 14" :y="pill.y">{{ pill.text }}</text>
      </g>

      <g
        v-for="pill in layout.models"
        :key="pill.text"
        class="flow__model"
        :class="{ 'flow__model--picked': pill.effort }"
        :style="{ '--i': pill.index }"
      >
        <rect class="flow__pill" :x="pill.x" :y="pill.y - PILL_H / 2" :width="layout.pillWidth" :height="PILL_H" rx="3" />
        <text class="flow__id" :x="pill.x + 14" :y="pill.y">{{ pill.text }}</text>
        <g v-if="pill.effort" class="flow__effort">
          <rect
            :x="pill.x + layout.pillWidth - chipWidth(pill.effort) - 8"
            :y="pill.y - 11"
            :width="chipWidth(pill.effort)"
            height="22"
            rx="2"
          />
          <text :x="pill.x + layout.pillWidth - chipWidth(pill.effort) / 2 - 8" :y="pill.y" text-anchor="middle">{{ pill.effort }}</text>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.flow__svg { display: block; width: 100%; height: auto; overflow: visible; }
.flow__svg--wide { display: none; }
.flow__svg--tall { max-width: 26rem; }
@media (min-width: 960px) {
  .flow__svg--wide { display: block; }
  .flow__svg--tall { display: none; }
}

.flow__link { fill: none; stroke: var(--oc-color-text-subtle); stroke-width: 1; opacity: 0.45; }
.flow__route { fill: none; stroke: var(--oc-color-route); stroke-width: 3; stroke-linecap: round; stroke-dasharray: 1; }
/* Shown only while travelling; without motion the finished routes say it all. */
.flow__dot { fill: var(--oc-color-route); stroke: var(--oc-color-text); stroke-width: 1.5; opacity: 0; }

.flow__pill { fill: var(--oc-color-surface); stroke: var(--oc-color-line); stroke-width: 2; }
.flow__job, .flow__id, .flow__effort text { dominant-baseline: central; fill: var(--oc-color-text); }
.flow__job { font: 600 14px var(--oc-font-text); }
.flow__id { font: 13px var(--oc-font-mono); }
.flow__heading { fill: var(--oc-color-text-subtle); font: 700 11px var(--oc-font-mono); letter-spacing: 0.14em; text-transform: uppercase; dominant-baseline: central; }
.flow__model { opacity: 0.5; }
.flow__model--picked { opacity: 1; }
.flow__effort rect { fill: var(--oc-color-accent); }
.flow__effort text { fill: var(--oc-color-on-accent); font: 700 11px var(--oc-font-mono); }

/*
 * One 9 s loop per worker, each starting 2.2 s after the one before: the dot travels, its
 * route and model stay lit, then both fade before the next round. Everything above is the
 * finished picture, which is what a reader who prefers reduced motion sees.
 */
@media (prefers-reduced-motion: no-preference) {
  .flow__route, .flow__dot, .flow__model--picked, .flow__effort {
    animation: var(--oc-duration-ambient) linear calc(var(--i) * 2.2s) infinite backwards;
  }
  .flow__route { animation-name: flow-route; }
  .flow__model--picked { animation-name: flow-model; }
  .flow__effort { animation-name: flow-effort; }
  @supports (offset-path: path('M0,0')) {
    .flow__dot { animation-name: flow-dot; }
  }
}

@keyframes flow-dot {
  0% { offset-distance: 0%; opacity: 0; }
  2%, 20% { opacity: 1; }
  22%, 100% { offset-distance: 100%; opacity: 0; }
}
@keyframes flow-route {
  0% { stroke-dashoffset: 1; opacity: 1; }
  22%, 92% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes flow-model {
  0%, 20% { opacity: 0.5; }
  24%, 92% { opacity: 1; }
  100% { opacity: 0.5; }
}
@keyframes flow-effort {
  0%, 20% { opacity: 0; }
  24%, 92% { opacity: 1; }
  100% { opacity: 0; }
}
</style>
