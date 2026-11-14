/** Lowercase, no provider prefix, dashes only: anthropic/claude-opus-5.5 → claude-opus-5-5. */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replace(/[._\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export const compact = (id: string): string => id.replace(/-/g, '');

/** Drops a trailing ".0" version (and a "1.0" after a name): muse-wonder-1-0 → muse-wonder, grok-4-6-0 → grok-4-6. */
export function stripVersion(id: string): string {
  const parts = id.split('-');
  const n = parts.length;
  while (parts.length > 1 && parts.at(-1) === '0') parts.pop();
  if (parts.length < n && parts.length > 2 && parts.at(-1) === '1' && !/^\d+$/.test(parts.at(-2)!)) parts.pop();
  return parts.join('-');
}
