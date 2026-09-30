import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSettings, validateSettings } from './settings-store.js';

test('writes settings as JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  const path = join(dir, 'settings.json');
  await saveSettings(path, { theme: 'dark' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { theme: 'dark' });
});

test('rejects a non-object', () => {
  assert.throws(() => validateSettings(null), TypeError);
});
