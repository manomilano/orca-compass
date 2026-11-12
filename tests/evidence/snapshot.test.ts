import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseSnapshot } from '../../src/evidence/snapshot.js';
import { toModelIndex } from '../../src/evidence/catalog.js';
import { normalizeModelId } from '../../src/placements/ids.js';

const text = readFileSync(new URL('../fixtures/evidence-mini.json', import.meta.url), 'utf8');
const mini = JSON.parse(text);

it('parses the fixture and keeps every model', () => { expect(parseSnapshot(text)!.models).toHaveLength(11); });
it.each([
  ['missing text', undefined], ['not json', '{'],
  ['schema 2', JSON.stringify({ ...mini, schemaVersion: 2 })],
  ['unlicensed source', JSON.stringify({ ...mini, sources: [{ ...mini.sources[0], license: undefined }] })],
  ['model without id', JSON.stringify({ ...mini, models: [{ ...mini.models[0], id: undefined }] })],
  ['bands not ascending', JSON.stringify({ ...mini, bands: { ...mini.bands, coding: [84, 76, 68] } })],
  ['weight on an unknown benchmark', JSON.stringify({ ...mini, axes: { ...mini.axes, coding: { weights: { nope: 100 } } } })],
])('rejects %s', (_, input) => { expect(parseSnapshot(input)).toBeUndefined(); });
it('builds the catalog with aliases normalized', () => {
  const index = toModelIndex(parseSnapshot(text)!);
  expect(index['gpt-6-1-terra']).toEqual({ id: 'gpt-6-1-terra', provider: 'openai', name: 'GPT-6.1 Terra', family: 'gpt-terra', releaseDate: '2026-10-26' });
  expect(index['gpt-6-1-terra']).toBe(index[normalizeModelId('openai/gpt-6.1-terra')]);
});

it('accepts models with and without maker pricing', () => {
  const priced = { ...mini, models: [{ ...mini.models[0], pricing: { inputPerM: 2, outputPerM: 10, basis: 'maker' } }, { ...mini.models[1], pricing: undefined }] };
  const parsed = parseSnapshot(JSON.stringify(priced))!;
  expect(parsed.models[0].pricing).toEqual({ inputPerM: 2, outputPerM: 10, basis: 'maker' });
  expect(parsed.models[1].pricing).toBeUndefined();
});
it.each([{ inputPerM: -1, outputPerM: 1 }, { inputPerM: 1 }, { inputPerM: '2', outputPerM: 10 }, { inputPerM: Infinity, outputPerM: 1 }, { inputPerM: 0, outputPerM: 1, basis: 1 }, null])('rejects malformed pricing %j', (pricing) => {
  expect(parseSnapshot(JSON.stringify({ ...mini, models: [{ ...mini.models[0], pricing }] }))).toBeUndefined();
});
