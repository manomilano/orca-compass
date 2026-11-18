<script setup lang="ts">
/**
 * "Rate a job": the visitor picks a level for each need and an effort demand,
 * and sees the Skill's definitions and the exact `orcacompass route` command
 * that rating produces. It computes nothing else: the route itself depends on
 * the visitor's installed agents and usage.
 *
 * Native radio groups (arrow keys, one tab stop each); every option is
 * described by its own definition. Server-rendered with the Skill's example
 * rating, so it reads correctly without JavaScript.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { withBase } from 'vitepress'
import {
  AXES,
  DEFAULT_DEMAND,
  DEFAULT_NEEDS,
  DEMAND_SIGNALS,
  DEMANDS,
  NEED_LEVELS,
  routeCommand,
  type AxisId,
  type Demand,
  type NeedLevel,
} from './levels'

const needs = reactive<Record<AxisId, NeedLevel>>({ ...DEFAULT_NEEDS })
const demand = ref<Demand>(DEFAULT_DEMAND)
const command = computed(() => routeCommand(needs, demand.value))
/** Display tokens: lines break between arguments and after commas, never inside `--json`. */
const tokens = computed(() => command.value.split(' ').map((token) => token.split(/(?<=,)/)))

const ready = ref(false)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const commandEl = ref<HTMLElement | null>(null)
let resetTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  ready.value = true
})

onBeforeUnmount(() => clearTimeout(resetTimer))

/** Select the command text so the visitor can copy it by hand. */
function selectCommand(): void {
  const el = commandEl.value
  const selection = window.getSelection()
  if (!el || !selection) return
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

async function copy(): Promise<void> {
  clearTimeout(resetTimer)
  try {
    await navigator.clipboard.writeText(command.value)
    copyState.value = 'copied'
  } catch {
    selectCommand()
    copyState.value = 'failed'
  }
  resetTimer = setTimeout(() => (copyState.value = 'idle'), 4000)
}

const copyStatus = computed(() =>
  copyState.value === 'copied'
    ? 'Command copied to the clipboard.'
    : copyState.value === 'failed'
      ? 'Copying is blocked here. The command is selected: copy it with your keyboard.'
      : '',
)

const id = (...parts: string[]) => ['wf-rate', ...parts].join('-')
const skillHref = withBase('/skill-workflow.html#_1-rate-the-job')
</script>

<template>
  <ComicPanel class="wf-rate" tag="section" aria-labelledby="wf-rate-title">
    <SectionHeading id="wf-rate-title" :level="3" title="Try rating a job">
      <template #lead>
        Choose the job’s needs and reasoning demand to build a routing command.
      </template>
    </SectionHeading>

    <div class="wf-rate__layout">
      <div class="wf-rate__form">
        <fieldset v-for="axis in AXES" :key="axis.id" class="wf-field">
          <legend class="wf-field__legend">
            <span class="wf-field__name">{{ axis.name }}</span><span class="wf-field__measures">{{ ` ${axis.measures}` }}</span>
          </legend>
          <div class="wf-options">
            <label v-for="level in NEED_LEVELS" :key="level" class="wf-option">
              <input
                v-model="needs[axis.id]"
                class="wf-option__input"
                type="radio"
                :name="id(axis.id)"
                :value="level"
                :aria-describedby="id(axis.id, level)"
              />
              <span class="wf-option__face">{{ level }}</span>
            </label>
          </div>
          <span
            v-for="level in NEED_LEVELS"
            :id="id(axis.id, level)"
            :key="level"
            hidden
          >{{ axis.definitions[level] }}</span>
          <p class="wf-field__def">
            <code>{{ needs[axis.id] }}</code> {{ axis.definitions[needs[axis.id]] }}
          </p>
        </fieldset>

        <fieldset class="wf-field wf-field--demand">
          <legend class="wf-field__legend">
            <span class="wf-field__name">Effort demand</span><span class="wf-field__measures">{{ ' how much the worker should think' }}</span>
          </legend>
          <div class="wf-options">
            <label v-for="d in DEMANDS" :key="d" class="wf-option">
              <input
                v-model="demand"
                class="wf-option__input"
                type="radio"
                :name="id('demand')"
                :value="d"
                :aria-describedby="id('demand', d)"
              />
              <span class="wf-option__face">{{ d }}</span>
            </label>
          </div>
          <span v-for="d in DEMANDS" :id="id('demand', d)" :key="d" hidden>{{ DEMAND_SIGNALS[d] }}</span>
          <p class="wf-field__def">
            <code>{{ demand }}</code> {{ DEMAND_SIGNALS[demand] }}
          </p>
        </fieldset>
      </div>

      <div class="wf-rate__result">
        <div class="wf-cmd oc-tone-abyss">
          <div class="wf-cmd__bar">
            <p :id="id('cmd-label')" class="wf-cmd__label">The command this rating produces</p>
            <button
              type="button"
              class="wf-cmd__copy"
              :class="{ 'wf-cmd__copy--pending': !ready }"
              :aria-describedby="id('cmd-label')"
              :tabindex="ready ? undefined : -1"
              :aria-hidden="ready ? undefined : 'true'"
              @click="copy"
            >
              {{ copyState === 'copied' ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <pre class="wf-cmd__pre"><output
            ref="commandEl"
            class="wf-cmd__text"
            :aria-labelledby="id('cmd-label')"
            aria-live="polite"
            aria-atomic="true"
          ><template v-for="(token, i) in tokens" :key="i"><span class="wf-cmd__tok"><template
            v-for="(piece, j) in token" :key="j"><wbr v-if="j > 0" />{{ piece }}</template></span>{{ i < tokens.length - 1 ? ' ' : '' }}</template></output></pre>
          <p class="oc-sr-only" role="status">{{ copyStatus }}</p>
          <p v-if="copyState === 'failed'" class="wf-cmd__hint" aria-hidden="true">
            Copying is blocked here. The command is selected: copy it with your keyboard.
          </p>
        </div>

        <p class="wf-rate__more">
          This builds a command without running it; <a :href="skillHref">read the rating guide</a>.
        </p>
      </div>
    </div>
  </ComicPanel>
</template>

<style scoped>
.wf-rate :deep(.oc-heading) {
  margin-bottom: var(--oc-space-5);
}

.wf-rate :deep(.oc-heading__title) {
  font-size: clamp(1.5rem, 2vw, 1.625rem);
}

.wf-rate__layout {
  display: grid;
  gap: var(--oc-space-6);
}

.wf-rate__form {
  display: grid;
  gap: var(--oc-space-4);
  min-width: 0;
}

/* ---------- Fields ---------- */

.wf-field {
  min-width: 0;
  margin: 0;
  padding: 0 0 var(--oc-space-3);
  border: 0;
  border-bottom: var(--oc-border-hair) solid var(--oc-color-rule);
}

.wf-field--demand {
  padding-bottom: 0;
  border-bottom: 0;
}

.wf-field__legend {
  margin-bottom: var(--oc-space-2);
  padding: 0;
  line-height: var(--oc-leading-snug);
}

.wf-field__name {
  font-size: var(--oc-text-lg);
  font-weight: 700;
  color: var(--oc-color-text);
}

.wf-field__measures {
  white-space: pre-wrap;
  font-size: var(--oc-text-sm);
  color: var(--oc-color-text-subtle);
}

.wf-field__def {
  margin: var(--oc-space-3) 0 0;
  max-width: var(--oc-measure);
  font-size: var(--oc-text-base);
  color: var(--oc-color-text-muted);
}

.wf-field__def code {
  margin-right: var(--oc-space-1);
  font-weight: 700;
  color: var(--oc-color-text);
}

/* ---------- Radio options: native inputs under an inked face ---------- */

.wf-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--oc-space-2);
}

.wf-option {
  position: relative;
  display: inline-flex;
}

.wf-option__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.wf-option__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 2.75rem;
  min-height: 44px;
  padding: 0.4em 0.6em;
  border: var(--oc-border-strong) solid var(--oc-color-line);
  border-radius: var(--oc-radius-md);
  background: var(--oc-color-surface);
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  line-height: 1.2;
  color: var(--oc-color-text);
  transition:
    background-color var(--oc-duration-fast) var(--oc-ease-out),
    color var(--oc-duration-fast) var(--oc-ease-out);
}

.wf-option__input:hover + .wf-option__face {
  background: var(--oc-color-bg-soft);
}

/* Selected: inverted fill, a change in lightness rather than hue. */
.wf-option__input:checked + .wf-option__face {
  border-color: var(--oc-color-text);
  background: var(--oc-color-text);
  color: var(--oc-color-bg);
}

.wf-option__input:focus-visible + .wf-option__face {
  outline: 3px solid var(--oc-color-focus);
  outline-offset: 2px;
}

@media (forced-colors: active) {
  .wf-option__input:checked + .wf-option__face {
    outline: 3px solid Highlight;
    outline-offset: 1px;
  }
}

/* ---------- Command readout ---------- */

.wf-rate__result {
  display: grid;
  gap: var(--oc-space-5);
  align-content: start;
  min-width: 0;
}

.wf-cmd {
  min-width: 0;
  border: var(--oc-border-strong) solid var(--oc-ink);
  border-radius: var(--oc-radius-sm);
}

.wf-cmd__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--oc-space-3);
  padding: var(--oc-space-2) var(--oc-space-2) var(--oc-space-2) var(--oc-space-4);
  border-bottom: var(--oc-border-hair) solid var(--oc-color-rule);
}

.wf-cmd__label {
  margin: 0;
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-xs);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--oc-color-text-muted);
}

.wf-cmd__copy {
  flex: none;
  min-width: 5.5rem;
  min-height: 44px;
  padding: 0.4em 1em;
  border: var(--oc-border-strong) solid var(--oc-color-line);
  border-radius: var(--oc-radius-md);
  background: transparent;
  font-family: var(--oc-font-text);
  font-size: var(--oc-text-sm);
  font-weight: 700;
  color: var(--oc-color-text);
  cursor: pointer;
  transition: background-color var(--oc-duration-fast) var(--oc-ease-out);
}

.wf-cmd__copy:hover {
  background: var(--oc-color-bg-soft);
}

/* Without JavaScript the button cannot copy: keep its space, hide it. */
.wf-cmd__copy--pending {
  visibility: hidden;
}

.wf-cmd__pre {
  margin: 0;
  padding: var(--oc-space-4);
  font-family: var(--oc-font-mono);
  font-size: var(--oc-text-sm);
  line-height: 1.6;
  white-space: normal;
}

.wf-cmd__tok {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.wf-cmd__text {
  display: block;
  color: var(--oc-color-text);
}

/* Shell prompt; not part of the copied command. */
.wf-cmd__text::before {
  content: '$ ';
  color: var(--oc-color-text-subtle);
}

.wf-cmd__hint {
  margin: 0;
  padding: 0 var(--oc-space-4) var(--oc-space-4);
  font-size: var(--oc-text-sm);
  color: var(--oc-color-text-muted);
}

.wf-rate__more {
  margin: 0;
  color: var(--oc-color-text-muted);
}

.wf-rate__more a {
  color: var(--oc-color-link);
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (min-width: 960px) {
  .wf-rate__form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--oc-space-5);
  }

  .wf-field { border-bottom: 0; padding-bottom: 0; }

  .wf-rate__result {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    align-items: center;
  }
}
</style>
