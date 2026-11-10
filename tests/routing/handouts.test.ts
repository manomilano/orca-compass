import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { applyHandouts, liveHandouts, parseHandouts, recordHandout } from '../../src/routing/handouts.js';
import { route } from '../../src/routing/router.js';
import { machineEnv, NOW, withPool } from '../helpers/env.js';

const needs = { coding: 'low', agentic: 'low', reasoning: 'low' } as const;
const handout = { at: NOW - 60_000, agent: 'claude', model: 'claude-opus-5-5', pools: ['weekly', 'gone'], needs };
it('applies live entries without mutating usage and ignores corrupt and unknown pools', () => {
  const env = machineEnv();
  const live = liveHandouts([handout, { ...handout, at: NOW - 11 * 60_000 }], NOW, 10);
  expect(live).toHaveLength(1);
  const usage = applyHandouts(env.usage, live, 5);
  expect(usage.claude.pools.weekly).toMatchObject({ usedPercent: 55, handouts: 1 });
  expect(env.usage.claude.pools.weekly.usedPercent).toBe(50);
  expect(usage.claude.pools.gone).toBeUndefined();
  expect(() => applyHandouts(env.usage, [{ ...handout, agent: '__proto__', pools: ['constructor'] }], 5)).not.toThrow();
  expect(parseHandouts('{')).toEqual([]);
  expect(parseHandouts(JSON.stringify({ handouts: [{ at: 1 }] }))).toEqual([]);
});
it('adjusted pools affect ranking, explanations and confidence', () => {
  const env = withPool(machineEnv(), 'claude', 'weekly', { usedPercent: 70 });
  const usage = applyHandouts(env.usage, [handout, handout], 5);
  const d = route({ tier: 'frontier', agents: ['claude', 'cursor'] }, { ...env, usage }, DEFAULT_CONFIG);
  expect(d.route?.agent).toBe('cursor');
  const alternative = d.alternatives.find((a) => a.agent === 'claude')!;
  expect(alternative.reason).toMatch(/2 workers routed in the last 10m, counted as \+10%/);
  expect(alternative.confidence).toBe('medium');
});
it('records atomically after corrupt data and removes expired entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handouts-'));
  try {
    writeFileSync(join(dir, 'handouts.json'), '{');
    recordHandout(handout, 10, dir);
    expect(JSON.parse(readFileSync(join(dir, 'handouts.json'), 'utf8')).handouts).toEqual([handout]);
    recordHandout({ ...handout, at: NOW + 11 * 60_000 }, 10, dir);
    expect(JSON.parse(readFileSync(join(dir, 'handouts.json'), 'utf8')).handouts).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
