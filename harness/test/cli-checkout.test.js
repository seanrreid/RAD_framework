/**
 * `rad checkout` (AC#1) against a real temp repo with a bare origin.
 *
 * git and the real scripts/checkout-plan.sh both run for real: the script is
 * copied into the temp repo's scripts/ and committed on main, so every work
 * branch carries it. The injected `sh` only threads the test env through, so
 * RAD_BRANCH_PREFIX reaches both the script and conventionWorkBranch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { checkoutCommand } from '../checkout.js';

const REAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'checkout-plan.sh');
const SCRIPT_REL = 'scripts/checkout-plan.sh';
const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const PLAN_TEXT = '# Plan: Demo\nStatus: approved\nBranch: rad/demo\n\n## Context\n';
const EXECUTABLE_MODE = 0o755;

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

/** A work clone whose main (with the real checkout script) is pushed to a bare origin. */
async function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rad-checkout-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  try {
    git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    git(root, ['init', '-q', '-b', 'main']);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'Tester'], ['commit.gpgsign', 'false']]) {
      git(root, ['config', k, v]);
    }
    copyFileSync(REAL_SCRIPT, join(root, SCRIPT_REL));
    chmodSync(join(root, SCRIPT_REL), EXECUTABLE_MODE);
    git(root, ['add', SCRIPT_REL]);
    git(root, ['commit', '-q', '-m', 'seed']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', 'main']);
    return await fn({ root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Commit one file on the current branch; returns the new sha. */
function commitFile(root, rel, text, message) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  git(root, ['add', rel]);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** Push `branch` to origin with the plan (or only `other.txt`) and leave it absent locally. */
function publishBranch(root, branch, { withPlan = true } = {}) {
  git(root, ['checkout', '-q', '-b', branch, 'main']);
  const sha = withPlan
    ? commitFile(root, PLAN_REL, PLAN_TEXT, 'plan')
    : commitFile(root, 'other.txt', 'x\n', 'no plan');
  git(root, ['push', '-q', 'origin', branch]);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['branch', '-q', '-D', branch]);
  return sha;
}

/** `sh` that runs for real with the base env minus RAD_BRANCH_PREFIX, plus opts.env. */
function testSh(file, args, opts = {}) {
  const env = { ...process.env };
  delete env.RAD_BRANCH_PREFIX;
  Object.assign(env, opts.env ?? {});
  const res = spawnSync(file, args, { cwd: opts.cwd, env, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function runCheckout(root, argv, env = {}) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  const calls = [];
  const sh = (file, args, opts) => { calls.push({ file, args }); return testSh(file, args, opts); };
  process.stdout.write = (c) => { stdout += c; return true; };
  process.stderr.write = (c) => { stderr += c; return true; };
  try {
    const code = await checkoutCommand(argv, { repoRoot: root, sh, env });
    return { code, stdout, stderr, calls };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const currentBranch = (root) => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

function assertOk(r, root, { branch = BRANCH, head, ahead = '' }) {
  assert.equal(r.code, 0, r.stderr);
  assert.equal(currentBranch(root), branch);
  assert.equal(r.stdout, `rad checkout: ok feature=${SLUG} branch=${branch} head=${head} plan=${PLAN_REL}${ahead}\n`);
}

for (const [label, arg] of [['bare name', SLUG], ['.md suffix', `${SLUG}.md`], ['full plan path', PLAN_REL]]) {
  test(`checkout: ${label} argument → branch only on origin becomes a tracking branch, exit 0`, () =>
    withRepo(async ({ root }) => {
      const sha = publishBranch(root, BRANCH);
      const r = await runCheckout(root, [arg]);
      assertOk(r, root, { head: sha });
      assert.equal(git(root, ['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`]), `origin/${BRANCH}`);
    }));
}

test('checkout: existing local branch behind origin → fast-forwards to the remote tip', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH);
    git(root, ['checkout', '-q', '-b', BRANCH, '--track', `origin/${BRANCH}`]);
    const tip = commitFile(root, 'more.txt', 'more\n', 'more');
    git(root, ['push', '-q', 'origin', BRANCH]);
    git(root, ['reset', '-q', '--hard', 'HEAD~1']);
    git(root, ['checkout', '-q', 'main']);
    const r = await runCheckout(root, [SLUG]);
    assertOk(r, root, { head: tip });
  }));

/** Track the branch locally, then add `count` unpushed commits; returns the local tip. */
function addUnpushedCommits(root, count) {
  git(root, ['checkout', '-q', '-b', BRANCH, '--track', `origin/${BRANCH}`]);
  let tip = '';
  for (let i = 0; i < count; i += 1) tip = commitFile(root, `local-${i}.txt`, `${i}\n`, `local ${i}`);
  git(root, ['checkout', '-q', 'main']);
  return tip;
}

for (const count of [1, 2]) {
  test(`checkout: local branch ahead of origin by ${count} → exit 0, commits kept, ahead=${count}`, () =>
    withRepo(async ({ root }) => {
      publishBranch(root, BRANCH);
      const tip = addUnpushedCommits(root, count);
      const r = await runCheckout(root, [SLUG]);
      assertOk(r, root, { head: tip, ahead: ` ahead=${count}` });
    }));
}

test('checkout: ahead-only script run passes with the ahead note on stderr', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH);
    addUnpushedCommits(root, 2);
    git(root, ['checkout', '-q', BRANCH]);
    const res = testSh(join(root, SCRIPT_REL), [BRANCH], { cwd: root });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, new RegExp(`note: local '${BRANCH}' is 2 commit\\(s\\) ahead of origin \\(unpushed\\)`));
  }));

test('checkout: behind-only success line carries no ahead field', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH);
    const r = await runCheckout(root, [SLUG]);
    assert.doesNotMatch(r.stdout, /ahead=/);
  }));

test('checkout: a failing rev-list omits ahead= and does not fail the checkout', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH);
    const tip = addUnpushedCommits(root, 1);
    const out = process.stdout.write.bind(process.stdout);
    let stdout = '';
    const sh = (file, args, opts) =>
      args[0] === 'rev-list' ? { status: 128, stdout: '', stderr: 'boom' } : testSh(file, args, opts);
    process.stdout.write = (c) => { stdout += c; return true; };
    let code;
    try {
      code = await checkoutCommand([SLUG], { repoRoot: root, sh, env: {} });
    } finally {
      process.stdout.write = out;
    }
    assert.equal(code, 0);
    assert.equal(stdout, `rad checkout: ok feature=${SLUG} branch=${BRANCH} head=${tip} plan=${PLAN_REL}\n`);
  }));

test('checkout: diverged local branch → exit 1 with the script divergence message', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH);
    git(root, ['checkout', '-q', '-b', BRANCH, '--track', `origin/${BRANCH}`]);
    commitFile(root, 'remote.txt', 'r\n', 'remote side');
    git(root, ['push', '-q', 'origin', BRANCH]);
    git(root, ['reset', '-q', '--hard', 'HEAD~1']);
    commitFile(root, 'local.txt', 'l\n', 'local side');
    git(root, ['checkout', '-q', 'main']);
    const r = await runCheckout(root, [SLUG]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /diverged from origin/);
    assert.equal(r.stdout, '');
  }));

test('checkout: branch missing on origin → exit 1, stays on main', () =>
  withRepo(async ({ root }) => {
    const r = await runCheckout(root, [SLUG]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found on origin/);
    assert.equal(currentBranch(root), 'main');
  }));

test('checkout: branch present but its plan file missing → exit 1 with a clear message', () =>
  withRepo(async ({ root }) => {
    publishBranch(root, BRANCH, { withPlan: false });
    const r = await runCheckout(root, [SLUG]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${PLAN_REL.replace(/\./g, '\\.')} is missing`));
    assert.equal(r.stdout, '');
  }));

test('checkout: RAD_BRANCH_PREFIX honored by the branch and the script', () =>
  withRepo(async ({ root }) => {
    const prefixed = `feat/${SLUG}`;
    const sha = publishBranch(root, prefixed);
    const r = await runCheckout(root, [SLUG], { RAD_BRANCH_PREFIX: 'feat/' });
    assertOk(r, root, { branch: prefixed, head: sha });
  }));

const REFUSALS = [
  ['reserved _architecture slug', ['_architecture'], /invalid feature '_architecture'/],
  ['unsafe name', ['Bad Name'], /invalid feature 'Bad Name'/],
  ['other path shape', ['plans/demo.md'], /expected <feature>/],
  ['no argument', [], /expected exactly one <feature>, got 0/],
  ['two arguments', [SLUG, 'other'], /expected exactly one <feature>, got 2/],
  ['unknown option', ['--force'], /unknown option '--force'/],
];
for (const [label, argv, reason] of REFUSALS) {
  test(`checkout: ${label} → exit 2 with usage, no git call`, () =>
    withRepo(async ({ root }) => {
      const r = await runCheckout(root, argv);
      assert.equal(r.code, 2);
      assert.match(r.stderr, reason);
      assert.match(r.stderr, /usage: rad checkout /);
      assert.deepEqual(r.calls, []);
      assert.equal(currentBranch(root), 'main');
    }));
}

test('checkout: --help prints usage and exits 0', () =>
  withRepo(async ({ root }) => {
    const r = await runCheckout(root, ['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: rad checkout /);
  }));
