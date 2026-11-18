<script setup lang="ts">
/**
 * The five routing steps drawn as waypoints on a navigation chart: a gold
 * route runs from the compass through each waypoint. Vertical on phones and
 * tablets, horizontal from 1280 px. The chart is always dark (abyss tone);
 * the nautical-chart illustration is a quiet backdrop that text never needs.
 */
import { withBase } from 'vitepress'

interface Waypoint {
  title: string
  /** Plain sentences; `code` segments render as <code>. */
  text: { code?: boolean; value: string }[]
  link: { href: string; label: string }
}

const waypoints: Waypoint[] = [
  {
    title: 'Rate the job',
    text: [{ value: 'Rate coding, agentic and reasoning needs, then thinking demand separately.' }],
    link: { href: '/skill-workflow#_1-rate-the-job', label: 'Rating guide' },
  },
  {
    title: 'Build profiles',
    text: [{ value: 'Model profiles keep capability evidence separate from cost tiers.' }],
    link: { href: '/tiers-and-routing#cost-tiers-and-capability', label: 'Model profiles' },
  },
  {
    title: 'Choose a route',
    text: [{ value: 'Compare every route that covers the job: the most usage headroom wins, after a small price adjustment.' }],
    link: { href: '/tiers-and-routing#ranking-covering-routes', label: 'Routing rules' },
  },
  {
    title: 'Launch',
    text: [{ value: 'The orchestrator passes the returned launch arguments to Orca, which launches the worker.' }],
    link: { href: '/skill-workflow#_3-launch', label: 'Launch guide' },
  },
  {
    title: 'Verify',
    text: [{ value: 'After launch, verify checks whether the agent accepted the model.' }],
    link: { href: '/verify-and-rejections', label: 'Verification guide' },
  },
]

/** "/page#hash" -> base + "/page.html#hash". */
function pageUrl(href: string): string {
  const [path, hash] = href.split('#')
  return withBase(`${path}.html`) + (hash ? `#${hash}` : '')
}

const art = (width: number, format: 'avif' | 'webp') => `${withBase(`/art/workflow-${width}.${format}`)} ${width}w`
const artSrcset = (format: 'avif' | 'webp') => [640, 1280, 1920].map((w) => art(w, format)).join(', ')
const artSizes = '(min-width: 1296px) 1200px, 100vw'
</script>

<template>
  <ComicPanel class="wf-chart" tone="abyss" raised>
    <picture class="wf-chart__art" aria-hidden="true">
      <source type="image/avif" :srcset="artSrcset('avif')" :sizes="artSizes" />
      <source type="image/webp" :srcset="artSrcset('webp')" :sizes="artSizes" />
      <img
        :src="withBase('/art/workflow-1280.webp')"
        alt=""
        width="1280"
        height="549"
        loading="lazy"
        decoding="async"
      />
    </picture>

    <div class="wf-chart__inner">
      <p class="wf-chart__legend" aria-hidden="true">
        <CompassMark :size="28" :bearing="58" />
        <span>Route chart · 5 waypoints</span>
      </p>

      <div class="wf-route">
        <ol class="wf-route__list">
          <li v-for="(wp, i) in waypoints" :key="wp.title" class="wf-wp">
            <template v-if="i < waypoints.length - 1">
              <RouteLine class="wf-wp__leg wf-wp__leg--v" orientation="vertical" glow />
              <RouteLine class="wf-wp__leg wf-wp__leg--h" glow />
            </template>
            <span class="wf-wp__marker" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
            <div class="wf-wp__body">
              <h3 class="wf-wp__title">{{ wp.title }}</h3>
              <p class="wf-wp__text">
                <template v-for="(part, j) in wp.text" :key="j">
                  <code v-if="part.code">{{ part.value }}</code>
                  <template v-else>{{ part.value }}</template>
                </template>
              </p>
              <a class="wf-wp__link" :href="pageUrl(wp.link.href)">
                {{ wp.link.label }}<span aria-hidden="true">&nbsp;→</span>
              </a>
            </div>
          </li>
        </ol>
      </div>
    </div>
  </ComicPanel>
</template>

<style scoped>
.wf-chart {
  --_marker: 44px;
  overflow: hidden;
  isolation: isolate;
}

/* Quiet backdrop: covers the frame, sits under everything, never needed for contrast. */
.wf-chart__art {
  position: absolute;
  z-index: -1;
  inset: 0;
  pointer-events: none;
}

.wf-chart__art img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 70% 50%;
  opacity: 0.45;
}

.wf-chart__inner {
  position: relative;
}

.wf-chart__legend {
  display: flex;
  align-items: center;
  gap: var(--oc-space-3);
  margin: 0 0 var(--oc-space-5);
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-xs);
  font-weight: 700;
  letter-spacing: var(--oc-tracking-eyebrow);
  text-transform: uppercase;
  color: var(--oc-color-text-muted);
}

.wf-route {
  position: relative;
}

.wf-route__list {
  --_gap: var(--oc-space-4);
  position: relative;
  display: grid;
  gap: var(--_gap);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Route legs: each runs from a waypoint's marker to the next one (vertical below 1280 px). */
.wf-wp > .wf-wp__leg {
  position: absolute;
}

.wf-wp > .wf-wp__leg--v {
  top: calc(var(--_marker) / 2);
  bottom: calc(-1 * var(--_gap));
  left: calc(var(--_marker) / 2 - 3px);
  height: auto;
  min-height: 0;
}

.wf-wp > .wf-wp__leg--h {
  display: none;
}

.wf-wp {
  position: relative;
  display: grid;
  align-content: start;
  grid-template-columns: var(--_marker) minmax(0, 1fr);
  gap: var(--oc-space-4);
  align-items: start;
}

.wf-wp__marker {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: var(--_marker);
  height: var(--_marker);
  box-sizing: border-box;
  border: var(--oc-border-strong) solid var(--oc-color-route);
  border-radius: 50%;
  background: var(--oc-color-bg);
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  color: var(--oc-color-text);
}

.wf-wp__body {
  min-width: 0;
  max-width: var(--oc-measure);
  padding-top: var(--oc-space-2);
}

.wf-wp__title {
  margin: 0 0 var(--oc-space-2);
  border: 0;
  padding: 0;
  font-family: var(--oc-font-text);
  font-size: var(--oc-text-lg);
  font-weight: 700;
  line-height: var(--oc-leading-snug);
  letter-spacing: 0;
  color: var(--oc-color-text);
}

.wf-wp__text {
  margin: 0;
  font-size: var(--oc-text-base);
  color: var(--oc-color-text-muted);
  overflow-wrap: break-word;
}

.wf-wp__text code {
  overflow-wrap: anywhere;
  color: var(--oc-color-text);
}

.wf-wp__link {
  display: inline-block;
  min-height: 44px;
  align-content: center;
  padding-block: var(--oc-space-2);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  color: var(--oc-color-link);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.wf-wp__link:hover {
  color: var(--oc-color-link-hover);
}

/* Horizontal chart: five waypoints across, the route through their markers. */
@media (min-width: 1280px) {
  .wf-route__list {
    --_gap: var(--oc-space-5);
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .wf-wp > .wf-wp__leg--v {
    display: none;
  }

  .wf-wp > .wf-wp__leg--h {
    display: block;
    top: calc(var(--_marker) / 2 - 3px);
    left: calc(var(--_marker) / 2);
    right: calc(-1 * var(--_gap));
    width: auto;
    min-width: 0;
  }

  .wf-wp {
    grid-template-columns: 1fr;
    gap: var(--oc-space-4);
  }

  .wf-wp__body {
    padding-top: 0;
  }
}
</style>
