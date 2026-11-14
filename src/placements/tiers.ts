import { normalizeModelId } from './ids.js';
import type { ModelMeta, Tier } from '../types.js';

// Families are stable across releases, so new versions get a tier automatically.
export const FAMILY_TIERS: Record<string, Tier> = {
  'claude-haiku': 'light',
  'claude-sonnet': 'daily',
  'claude-opus': 'advanced',
  'claude-fable': 'frontier',
  'gpt-luna': 'light',
  'gpt-terra': 'daily',
  'gpt-sol': 'advanced',
  'gpt-astra': 'frontier',
  'gemini-flash-lite': 'light',
};

/** Numeric releases of known Claude/GPT families; unrelated names and moving aliases are not inferred. */
export function knownModelVersion(modelId: string): { family: string; version: number[] } | undefined {
  const id = normalizeModelId(modelId).replace(/-\d{8}$/, '');
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id);
  const gpt = /^gpt-(\d+(?:-\d+)*)-([a-z]+)$/.exec(id);
  const family = claude ? `claude-${claude[1]}` : gpt ? `gpt-${gpt[2]}` : undefined;
  if (!family || !Object.hasOwn(FAMILY_TIERS, family)) return undefined;
  const version = (claude ? claude[2] : gpt![1]).split('-').map(Number);
  return version.every(Number.isSafeInteger) ? { family, version } : undefined;
}

/** Catalog family when available, otherwise a narrowly recognized versioned model family. */
export const modelFamily = (modelId: string, meta?: ModelMeta): string | undefined => meta?.family ?? knownModelVersion(modelId)?.family;

/** Model lines matched by id, where the family is too broad: Models.dev files Gemini Argon under `gemini` and every Grok under `grok`. */
export const MODEL_LINE_TIERS: readonly { pattern: RegExp; tier: Tier }[] = [
  { pattern: /^gemini(-\d+)+-argon(-|$)/, tier: 'frontier' },
  // Grok 4.7 to 4.9 and 5+; older releases (4.20 is from early 2026) and Grok Build need snapshot evidence.
  { pattern: /^grok-(4-[7-9]|[5-9]|\d{2,})(-\d+)*$/, tier: 'advanced' },
];

// Providers describe each model's place in their lineup in a few words; the strongest claim wins.
const LINEUP_WORDS: readonly [Tier, RegExp][] = [
  ['frontier', /frontier|toughest|most demanding|most capable|most intelligent|hardest/],
  ['light', /\bfast(est)?\b|quick|affordable|easier|cheapest|lightweight|\bsmall/],
  ['advanced', /complex|workhorse|demanding/],
  ['daily', /simpler|everyday|efficient|balanced|straightforward|general/],
];

/** The tier a provider's own description places a model in, or undefined when it says nothing usable. */
export function lineupTier(description: string | undefined): Tier | undefined {
  const text = description?.toLowerCase() ?? '';
  return LINEUP_WORDS.find(([, words]) => words.test(text))?.[0];
}
