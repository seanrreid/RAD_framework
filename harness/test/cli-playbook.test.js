/**
 * `rad playbook` (AC#3) against a temp root: lint with and without a playbooks
 * directory, valid and invalid files, explicit files; check-ref ok, stale and
 * failures; every usage error; the `playbook_kinds` override.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { playbookCommand } from '../playbook-command.js';
import { main } from '../cli.js';

/** The minimum valid config; tests append `playbook_kinds:`. */
const BASE_CONFIG = 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect: [alice]\n';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rad-playbook-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A valid playbook of `kind--slug` with versions 1..version. */
function playbookText({ kind, slug, version }) {
  const entries = Array.from({ length: version }, (_, i) => `### Version ${i + 1} — 2026-01-0${i + 1}\n\nChange ${i + 1}.\n`);
  const meta = JSON.stringify({ kind, slug, version, summary: 'A test playbook' });
  return `---\n${meta}\n---\n\n## Steps\n\nDo it.\n\n## Upgrade Guide\n\n${entries.join('\n')}`;
}

function writePlaybook(name, text, base = root) {
  const dir = join(base, '.agents/playbooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

function writeConfig(text) {
  mkdirSync(join(root, '.rad'), { recursive: true });
  writeFileSync(join(root, '.rad/config.yml'), text);
}

/** Run playbookCommand with stdout/stderr captured. */
async function run(argv, cwdRoot = root) {
  const out = { stdout: '', stderr: '' };
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.stdout += chunk; return true; };
  process.stderr.write = (chunk) => { out.stderr += chunk; return true; };
  try {
    out.code = await playbookCommand(argv, { repoRoot: cwdRoot });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return out;
}

test('lint with no playbooks directory prints playbooks ok (0)', async () => {
  const out = await run(['lint']);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'playbooks ok (0)\n');
});

test('lint with no config file uses the default kinds', async () => {
  writePlaybook('env-knob--add-flag.md', playbookText({ kind: 'env-knob', slug: 'add-flag', version: 1 }));
  const out = await run(['lint']);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'playbooks ok (1)\n');
});

test('lint skips README.md and counts only playbooks', async () => {
  writePlaybook('README.md', 'not a playbook');
  writePlaybook('env-knob--a.md', playbookText({ kind: 'env-knob', slug: 'a', version: 1 }));
  writePlaybook('event-type--b.md', playbookText({ kind: 'event-type', slug: 'b', version: 2 }));
  const out = await run(['lint']);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'playbooks ok (2)\n');
});

test('lint prints one <file>: <error> line per problem and exits 1', async () => {
  const path = writePlaybook('env-knob--bad.md', 'no frontmatter here');
  const out = await run(['lint']);
  assert.equal(out.code, 1);
  assert.match(out.stdout, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: missing frontmatter`, 'm'));
  assert.doesNotMatch(out.stdout, /playbooks ok/);
});

test('lint of explicit files validates only those files', async () => {
  const good = writePlaybook('env-knob--good.md', playbookText({ kind: 'env-knob', slug: 'good', version: 1 }));
  writePlaybook('env-knob--bad.md', 'broken');
  const out = await run(['lint', good]);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'playbooks ok (1)\n');
});

test('lint --root points at another root', async () => {
  const other = mkdtempSync(join(tmpdir(), 'rad-playbook-other-'));
  try {
    writePlaybook('env-knob--a.md', playbookText({ kind: 'env-knob', slug: 'a', version: 1 }), other);
    const out = await run(['lint', '--root', other]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'playbooks ok (1)\n');
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test('check-ref prints ok current=N for a current pin', async () => {
  writePlaybook('env-knob--a.md', playbookText({ kind: 'env-knob', slug: 'a', version: 2 }));
  const out = await run(['check-ref', 'env-knob/a@2']);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'ok current=2\n');
});

test('check-ref prints stale current=N for an older pin', async () => {
  writePlaybook('env-knob--a.md', playbookText({ kind: 'env-knob', slug: 'a', version: 3 }));
  const out = await run(['check-ref', 'env-knob/a@1']);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'stale current=3\n');
});

test('check-ref failures print rad playbook: <reason> to stderr and exit 1', async () => {
  writePlaybook('env-knob--a.md', playbookText({ kind: 'env-knob', slug: 'a', version: 1 }));
  for (const [ref, reason] of [
    ['env-knob/a@5', /ahead of/],
    ['env-knob/missing@1', /not found/],
    ['not-a-ref', /not a valid playbook ref/],
    ['bogus-kind/a@1', /not an allowed playbook kind/],
  ]) {
    const out = await run(['check-ref', ref]);
    assert.equal(out.code, 1, ref);
    assert.match(out.stderr, new RegExp(`^rad playbook: `));
    assert.match(out.stderr, reason);
    assert.equal(out.stdout, '');
  }
});

test('playbook_kinds in the root config overrides the default kinds', async () => {
  writeConfig(`${BASE_CONFIG}playbook_kinds: [custom-kind]\n`);
  writePlaybook('custom-kind--a.md', playbookText({ kind: 'custom-kind', slug: 'a', version: 1 }));
  assert.equal((await run(['check-ref', 'custom-kind/a@1'])).code, 0);
  writePlaybook('env-knob--b.md', playbookText({ kind: 'env-knob', slug: 'b', version: 1 }));
  const out = await run(['check-ref', 'env-knob/b@1']);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /not an allowed playbook kind/);
});

test('an invalid config is refused with exit 2, not defaulted', async () => {
  writeConfig(`${BASE_CONFIG}playbook_kinds: []\n`);
  const out = await run(['lint']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /unreadable config/);
});

test('usage errors exit 2 with the usage line', async () => {
  for (const argv of [
    [],
    ['bogus'],
    ['check-ref'],
    ['check-ref', 'a/b@1', 'extra'],
    ['lint', '--nope'],
    ['check-ref', '--nope', 'a/b@1'],
    ['lint', '--root'],
  ]) {
    const out = await run(argv);
    assert.equal(out.code, 2, JSON.stringify(argv));
    assert.match(out.stderr, /usage: rad playbook/);
  }
});

test('--help prints usage and exits 0', async () => {
  const out = await run(['--help']);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /usage: rad playbook lint/);
});

test('rad --help lists playbook, and main dispatches to it', async () => {
  const help = { stdout: '' };
  const origOut = process.stdout.write;
  process.stdout.write = (chunk) => { help.stdout += chunk; return true; };
  try {
    assert.equal(await main(['--help'], { repoRoot: root }), 0);
    help.stdout += '|';
    assert.equal(await main(['playbook', 'lint'], { repoRoot: root }), 0);
  } finally {
    process.stdout.write = origOut;
  }
  assert.match(help.stdout, /playbook/);
  assert.match(help.stdout, /playbooks ok \(0\)/);
});
