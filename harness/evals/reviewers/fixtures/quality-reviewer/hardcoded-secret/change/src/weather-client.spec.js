import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchForecast } from './weather-client.js';

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ tempC: 21 }) });
const failingFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

test('returns the parsed forecast on success', async () => {
  assert.deepEqual(await fetchForecast('Oslo', okFetch), { tempC: 21 });
});

test('rejects an empty city', async () => {
  await assert.rejects(fetchForecast('  ', okFetch), TypeError);
});

test('surfaces a non-2xx upstream status', async () => {
  await assert.rejects(fetchForecast('Oslo', failingFetch), /503/);
});
