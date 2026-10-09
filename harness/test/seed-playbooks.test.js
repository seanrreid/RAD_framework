// The seed playbooks in .agents/playbooks/ lint clean and stay accurate: every
// repo path a `## Files typically touched` table names exists, and every test
// title a seed quotes appears in the test file it points at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlaybook } from '../playbook.js';
import { DEFAULT_PLAYBOOK_KINDS } from '../config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYBOOK_DIR = join(ROOT, '.agents', 'playbooks');
const README = 'README.md';
const SEEDS = readdirSync(PLAYBOOK_DIR).filter((f) => f !== README).sort();
const TABLE_PATH_ROW = /^\| ([\w./-]+\/[\w./-]+) \|/gm;

/** Test titles each seed quotes, keyed by the test file that must contain them. */
const QUOTED_TESTS = Object.freeze({
  'env-knob--timeout-style.md': {
    'harness/test/cli.test.js': [
      'deliver — malformed RAD_WAVE_TIMEOUT_SECONDS',
      'deliver acp — RAD_WAVE_TIMEOUT_SECONDS reaches the adapter',
      'deliver acp — unset or empty RAD_WAVE_TIMEOUT_SECONDS keeps the default',
    ],
  },
  'event-type--audit-only.md': {
    'harness/test/events.test.js': ['run-resumed is audit-only: it establishes no phase and leaves the folded phase unchanged'],
    'harness/test/spine-prepare.test.js': ['absent prepare port → event sequence identical to a baseline run'],
  },
});

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const seedText = (name) => readFileSync(join(PLAYBOOK_DIR, name), 'utf8');

test('the playbooks directory holds a README and at least one seed', () => {
  assert.ok(existsSync(join(PLAYBOOK_DIR, README)));
  assert.ok(SEEDS.length >= 1);
});

for (const name of SEEDS) {
  test(`seed ${name} — validates against the default kinds`, () => {
    const errors = validatePlaybook({ fileName: name, text: seedText(name), kinds: [...DEFAULT_PLAYBOOK_KINDS] });
    assert.deepEqual(errors, []);
  });

  test(`seed ${name} — every path in its Files table exists`, () => {
    const paths = [...seedText(name).matchAll(TABLE_PATH_ROW)].map((m) => m[1]);
    assert.ok(paths.length >= 4, `expected a populated table, got ${JSON.stringify(paths)}`);
    for (const p of paths) assert.ok(existsSync(join(ROOT, p)), `${name} names missing file ${p}`);
  });

  test(`seed ${name} — every quoted test title exists in its test file`, () => {
    for (const [file, titles] of Object.entries(QUOTED_TESTS[name] ?? {})) {
      const source = read(file);
      for (const title of titles) assert.ok(source.includes(title), `${file} has no test titled ${title}`);
    }
  });
}
