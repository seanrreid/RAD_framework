import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, squashBody, write } from './delivery-fixtures.js';

const HEADER = '# Plan: alpha\n\n## Files in Scope\n| File | Lines | Change |\n|------|-------|--------|\n';

test('planFor with no paths yields an empty table body', () => {
  assert.equal(planFor('alpha', []), `${HEADER}\n`);
});

test('planFor with one path yields one row', () => {
  assert.equal(planFor('alpha', ['a.js']), `${HEADER}| a.js | 1-10 | edit |\n`);
});

test('planFor with several paths joins rows with newlines', () => {
  assert.equal(
    planFor('alpha', ['a.js', 'b/c.js']),
    `${HEADER}| a.js | 1-10 | edit |\n| b/c.js | 1-10 | edit |\n`,
  );
});

test('squashBody for a plain slug', () => {
  assert.equal(
    squashBody('beta'),
    '* plan: x\n\n* approve: beta\n\nPlan: .agents/plans/beta.md\n\n* deliver(beta): begin execution',
  );
});

test('squashBody for a slug with hyphen and digits', () => {
  assert.equal(
    squashBody('rad-insights-2'),
    '* plan: x\n\n* approve: rad-insights-2\n\nPlan: .agents/plans/rad-insights-2.md\n\n* deliver(rad-insights-2): begin execution',
  );
});

test('write creates a missing nested parent and overwrites an existing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-fixtures-'));
  try {
    write(root, 'a/b/c.txt', 'one');
    assert.equal(readFileSync(join(root, 'a/b/c.txt'), 'utf8'), 'one');
    write(root, 'a/b/c.txt', 'two');
    assert.equal(readFileSync(join(root, 'a/b/c.txt'), 'utf8'), 'two');
    writeFileSync(join(root, 'top.txt'), 'x');
    write(root, 'top.txt', 'y');
    assert.equal(readFileSync(join(root, 'top.txt'), 'utf8'), 'y');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
