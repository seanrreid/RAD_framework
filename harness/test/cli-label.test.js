/**
 * `rad label` (AC#1) with an injected `sh` that records each call.
 *
 * scripts/rad-label.sh talks to GitHub, so it never runs here: the fake `sh`
 * returns a canned result and the tests assert the exact script args, the
 * refusals that make no call, and the exit-status passthrough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { labelCommand, LABEL_USAGE } from '../label.js';

const ROOT = '/tmp/rad-label-root';
const SCRIPT = join(ROOT, 'scripts/rad-label.sh');

/** A fake `sh` returning `result` and recording every call. */
function fakeSh(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, cwd: opts?.cwd });
    return result;
  };
  return { sh, calls };
}

/** Run labelCommand with stdout/stderr captured. */
async function run(argv, sh) {
  const out = { stdout: '', stderr: '' };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.stdout += chunk; return true; };
  process.stderr.write = (chunk) => { out.stderr += chunk; return true; };
  try {
    out.code = await labelCommand(argv, { repoRoot: ROOT, sh, env: {} });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return out;
}

test('a valid call runs rad-label.sh with the exact args from the repo root', async () => {
  const { sh, calls } = fakeSh({ status: 0, stdout: 'labeled #42 rad:draft\n', stderr: '' });
  const out = await run(['42', 'draft'], sh);
  assert.equal(out.code, 0);
  assert.deepEqual(calls, [{ file: SCRIPT, args: ['42', 'draft'], cwd: ROOT }]);
  assert.match(out.stdout, /labeled #42 rad:draft/);
});

test('#N is accepted and passed to the script as N', async () => {
  const { sh, calls } = fakeSh();
  const out = await run(['#7', 'in-progress'], sh);
  assert.equal(out.code, 0);
  assert.deepEqual(calls[0].args, ['7', 'in-progress']);
});

for (const [name, argv, reason] of [
  ['a bad number', ['abc', 'draft'], /invalid issue 'abc'/],
  ['zero', ['0', 'draft'], /invalid issue '0'/],
  ['a negative number', ['-3', 'draft'], /invalid issue '-3'/],
  ['an unknown status', ['42', 'shipped'], /unknown status 'shipped'/],
  ['a missing argument', ['42'], /expected <issue> and <status>, got 1/],
  ['no arguments', [], /expected <issue> and <status>, got 0/],
  ['an extra argument', ['42', 'draft', 'x'], /expected <issue> and <status>, got 3/],
]) {
  test(`${name} exits 2 with the usage line and no script call`, async () => {
    const { sh, calls } = fakeSh();
    const out = await run(argv, sh);
    assert.equal(out.code, 2);
    assert.equal(calls.length, 0);
    assert.match(out.stderr, /^rad label: /);
    assert.match(out.stderr, reason);
    assert.ok(out.stderr.includes(`usage: ${LABEL_USAGE}`));
  });
}

test("the script's non-zero exit is passed through as 1 with its output", async () => {
  const { sh, calls } = fakeSh({ status: 1, stdout: '', stderr: 'ERROR: gh edit failed\n' });
  const out = await run(['42', 'approved'], sh);
  assert.equal(out.code, 1);
  assert.equal(calls.length, 1);
  assert.match(out.stderr, /ERROR: gh edit failed/);
});

test('--help prints the usage line and exits 0 with no script call', async () => {
  const { sh, calls } = fakeSh();
  const out = await run(['--help'], sh);
  assert.equal(out.code, 0);
  assert.equal(calls.length, 0);
  assert.equal(out.stdout, `usage: ${LABEL_USAGE}\n`);
});
