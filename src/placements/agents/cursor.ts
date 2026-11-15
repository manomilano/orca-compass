import { join } from 'node:path';
import { normalizeModelId } from '../ids.js';
import { EFFORT_LADDER, parseEffort } from '../../routing/effort.js';
import type { AgentDiscovery, Effort, LaunchModel } from '../../types.js';
import type { AgentDeps, Locator } from './deps.js';
import { listModels, savedNote, type ListedModel } from './list-cache.js';

const EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/;
const THINKING = /-thinking(?=-|$)/g;
// Older Cursor Claude ids put the version first: claude-4.6-sonnet is Anthropic's claude-sonnet-4-6.
const OLD_CLAUDE = /^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)$/;

/** Cursor bakes effort, speed and thinking into the id: claude-opus-5-thinking-high-fast. */
export function normalizeCursorId(id: string): { base: string; effort?: Effort; fast: boolean; thinking: boolean } {
  let base = id;
  const fast = base.endsWith('-fast');
  if (fast) base = base.slice(0, -'-fast'.length);
  const thinking = base.search(THINKING) >= 0;
  base = base.replace(THINKING, '');
  const m = EFFORT_SUFFIX.exec(base);
  const effort = m ? parseEffort(m[1]) : undefined;
  if (m) base = base.slice(0, m.index);
  if (base.startsWith('cursor-')) base = base.slice('cursor-'.length);
  const old = OLD_CLAUDE.exec(base);
  if (old) base = `claude-${old[2]}-${old[1].replace('.', '-')}`;
  return { base, ...(effort ? { effort } : {}), fast, thinking };
}

interface Variant extends ReturnType<typeof normalizeCursorId> {
  id: string;
  label: string;
}

function parseList(text: string): ListedModel[] {
  const variants: ListedModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+) - (.+)$/.exec(line.trim());
    if (m) variants.push({ id: m[1], label: m[2] });
  }
  return variants;
}

// Fast variants burn more usage; thinking matches what --effort means on the claude/codex routes.
const better = (a: Variant, b: Variant): boolean =>
  a.fast !== b.fast ? !a.fast : a.thinking !== b.thinking ? a.thinking : false;

interface Group {
  byEffort: Map<Effort, Variant>;
  fallback?: Variant;
  /** Some variant id had the cursor- prefix, i.e. a Cursor-trained model (cursor-grok-4.6-high). */
  cursorTrained: boolean;
}

function toLaunchModels(variants: Variant[], deps: AgentDeps): LaunchModel[] {
  const groups = new Map<string, Group>();
  for (const v of variants) {
    const g: Group = groups.get(v.base) ?? { byEffort: new Map(), cursorTrained: false };
    groups.set(v.base, g);
    if (v.id.startsWith('cursor-')) g.cursorTrained = true;
    if (v.effort) {
      const cur = g.byEffort.get(v.effort);
      if (!cur || better(v, cur)) g.byEffort.set(v.effort, v);
    } else if (!g.fallback || better(v, g.fallback)) {
      g.fallback = v;
    }
  }
  return [...groups].map(([base, g]) => {
    // The unsuffixed id is Cursor's default, i.e. medium effort.
    if (g.fallback && g.byEffort.size > 0 && !g.byEffort.has('medium')) g.byEffort.set('medium', g.fallback);
    // Drop fast-only levels so a request snaps to a non-fast id instead of silently picking one.
    if ([...g.byEffort.values()].some((v) => !v.fast)) {
      for (const [e, v] of g.byEffort) if (v.fast) g.byEffort.delete(e);
    }
    const efforts = EFFORT_LADDER.filter((e) => g.byEffort.has(e));
    const chosen = [...g.byEffort.values(), ...(g.fallback ? [g.fallback] : [])];
    const meta = deps.index[base] ?? deps.index[normalizeModelId(base)];
    const own = g.cursorTrained || base.startsWith('composer') || base.startsWith('grok') || base === 'auto';
    const bucket = own ? 'bucket:Cursor Models' : 'bucket:Other Models';
    return {
      agent: 'cursor',
      modelId: base,
      ...(meta ? { meta } : {}),
      efforts,
      effortSource: 'provider' as const,
      launch: {
        kind: 'variant',
        ids: Object.fromEntries(efforts.map((e) => [e, g.byEffort.get(e)!.id])),
        ...(g.fallback ? { defaultId: g.fallback.id } : {}),
      },
      // Heuristic: Orca only reports the two Cursor buckets, not which models draw on which.
      poolNames: ['monthly', bucket],
      ...(chosen.every((v) => v.fast) ? { fast: true } : {}),
      ...(chosen.some((v) => v.label.includes('NO ZDR')) ? { noZdr: true } : {}),
    };
  });
}

export function locateCursor(deps: Locator): string | undefined {
  const extra = deps.env.LOCALAPPDATA ? [join(deps.env.LOCALAPPDATA, 'cursor-agent')] : [];
  return deps.find('cursor-agent', extra);
}

export async function discoverCursor(deps: AgentDeps): Promise<AgentDiscovery> {
  const exe = locateCursor(deps);
  if (!exe) return { agent: 'cursor', installed: false, models: [], note: 'cursor-agent not found' };

  const listing = await listModels(deps, exe, ['models'], 'cursor', parseList);
  if (!listing.items) {
    const note = listing.signedOut ? `not signed in: ${listing.error}` : `cursor-agent models failed: ${listing.error}`;
    return { agent: 'cursor', installed: true, models: [], note, ...(listing.signedOut ? { signedOut: true } : {}) };
  }
  const note = savedNote('cursor-agent models', listing, deps.now);
  return { agent: 'cursor', installed: true, models: toLaunchModels(listing.items.map((m) => ({ id: m.id, label: m.label ?? '', ...normalizeCursorId(m.id) })), deps), ...(note ? { note } : {}) };
}
