import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile } from '../placements/agents/deps.js';
import { cacheDir } from '../paths.js';
import { AXES } from '../evidence/snapshot.js';
import type { AgentId, AgentUsage, Needs } from '../types.js';

export interface Handout { at: number; agent: AgentId; model: string; pools: string[]; needs: Needs }
export const HANDOUTS_FILE = 'handouts.json';
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function parseHandouts(text: string | undefined): Handout[] {
  try {
    const raw: unknown = JSON.parse(text ?? '');
    if (!object(raw) || !Array.isArray(raw.handouts)) return [];
    return raw.handouts.filter((h: unknown): h is Handout => object(h) && typeof h.at === 'number' && Number.isFinite(h.at) &&
      typeof h.agent === 'string' && h.agent.length > 0 && typeof h.model === 'string' && h.model.length > 0 &&
      Array.isArray(h.pools) && h.pools.every((p: unknown) => typeof p === 'string') && object(h.needs) &&
      AXES.every((axis) => ['min', 'low', 'mid', 'high'].includes((h.needs as Record<string, string>)[axis])));
  } catch { return []; }
}
export function readHandouts(readFile: (p: string) => string | undefined = readTextFile, dir: string = cacheDir()): Handout[] {
  try { return parseHandouts(readFile(join(dir, HANDOUTS_FILE))); } catch { return []; }
}
export function liveHandouts(list: Handout[], now: number, minutes: number): Handout[] {
  return list.filter((h) => now - h.at < minutes * 60_000);
}
export function recordHandout(h: Handout, minutes: number, dir: string = cacheDir()): void {
  const file = join(dir, HANDOUTS_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handouts = liveHandouts([...readHandouts(readTextFile, dir), h], h.at, minutes);
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ handouts }, null, 2)}\n`);
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch { /* renamed or never written */ } }
}
export function applyHandouts(usage: Record<AgentId, AgentUsage>, live: Handout[], percent: number): Record<AgentId, AgentUsage> {
  const result = structuredClone(usage);
  for (const h of live) for (const name of new Set(h.pools)) {
    const agent = Object.hasOwn(result, h.agent) ? result[h.agent] : undefined;
    const pool = agent && Object.hasOwn(agent.pools, name) ? agent.pools[name] : undefined;
    if (pool) { pool.usedPercent += percent; pool.handouts = (pool.handouts ?? 0) + 1; }
  }
  return result;
}
