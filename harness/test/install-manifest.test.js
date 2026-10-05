import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_PATH, PENDING_DIR, BACKUP_DIR, listCoreFiles, hashFile, readManifest, planInstall, applyInstall,
  backupStamp, installDrift,
} from '../install-manifest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-05T12:34:56.789Z');
const RAD_VERSION = 'abc123';

/** Core files every fixture source carries (path -> content). */
const CORE_FIXTURE = {
  '.claude/commands/team/rad-plan.md': 'plan v1\n',
  '.claude/skills/kickoff/SKILL.md': 'kickoff\n',
  'ai/guardrails.md': 'guardrails\n',
  'scripts/lint-plan.sh': '#!/bin/sh\necho lint\n',
  'scripts/lib/plan-paths.sh': '#!/bin/sh\necho paths\n',
  'scripts/hooks/post-wave/notify.sh': '#!/bin/sh\necho hook\n',
  'harness/cli.js': '// cli\n',
  'harness/test/x.test.js': '// test\n',
};
/** Files a fixture source carries that must never be core. */
const NON_CORE_FIXTURE = {
  'CLAUDE.md': 'user context\n',
  '.claude/agents/me.md': 'agent\n',
  '.claude/settings.json': '{}\n',
  '.claude/settings.local.json': '{}\n',
  '.agents/plans/p.md': 'plan\n',
  '.rad/config.yml': 'version: 1\n',
  'harness/node_modules/js-yaml/index.js': '// dep\n',
  'scripts/notes.txt': 'not a script\n',
  'scripts/sub/deep.sh': '#!/bin/sh\n',
};
const EXECUTABLES = ['scripts/lint-plan.sh', 'scripts/lib/plan-paths.sh', 'scripts/hooks/post-wave/notify.sh'];

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** A source + target pair in one temp dir; `fn` gets { source, target }. */
function withRoots(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-install-'));
  const source = join(dir, 'source');
  const target = join(dir, 'target');
  mkdirSync(target, { recursive: true });
  writeTree(source, { ...CORE_FIXTURE, ...NON_CORE_FIXTURE });
  for (const p of EXECUTABLES) chmodSync(join(source, p), 0o755);
  try {
    return fn({ source, target });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plan + apply with the fixture clock; returns { plan, result }. */
function install(source, target) {
  const read = readManifest(target);
  assert.ok(read.ok || read.missing, read.error);
  const plan = planInstall({ sourceRoot: source, targetRoot: target, manifest: read.ok ? read.manifest : null });
  const result = applyInstall({ sourceRoot: source, targetRoot: target, plan, now: NOW, radVersion: RAD_VERSION });
  return { plan, result };
}

const actionOf = (plan, path) => plan.actions.find((a) => a.path === path)?.action;
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

test('listCoreFiles — exactly the core fixture, sorted; never user data, node_modules, or nested scripts/*', () => {
  withRoots(({ source }) => {
    assert.deepEqual(listCoreFiles(source), Object.keys(CORE_FIXTURE).sort());
  });
});

test('listCoreFiles — symlinks are skipped, never followed (#168)', () => {
  withRoots(({ source }) => {
    symlinkSync(join(source, 'CLAUDE.md'), join(source, 'ai', 'linked.md'));
    symlinkSync(join(source, '.agents'), join(source, 'harness', 'linked-dir'));
    const files = listCoreFiles(source);
    assert.ok(!files.includes('ai/linked.md'));
    assert.ok(!files.some((p) => p.startsWith('harness/linked-dir')));
  });
});

test('listCoreFiles — empty source yields an empty set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rad-install-empty-'));
  try {
    assert.deepEqual(listCoreFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listCoreFiles — real repo ships scripts/lib/plan-paths.sh and no user data', () => {
  const files = listCoreFiles(REPO_ROOT);
  assert.ok(files.includes('scripts/lib/plan-paths.sh'));
  assert.ok(files.includes('harness/cli.js'));
  assert.ok(!files.includes('CLAUDE.md'));
  for (const prefix of ['.rad/', '.agents/', '.claude/agents/', 'harness/node_modules/']) {
    assert.ok(!files.some((p) => p.startsWith(prefix)), `nothing under ${prefix}`);
  }
  assert.ok(!files.some((p) => /^\.claude\/settings.*\.json$/.test(p)));
});

test('planInstall — fresh install into an empty target: every core file is write, nothing stale', () => {
  withRoots(({ source, target }) => {
    const { plan } = install(source, target);
    assert.ok(plan.actions.every((a) => a.action === 'write' && a.baseline === null));
    assert.deepEqual(plan.stale, []);
    for (const p of Object.keys(CORE_FIXTURE)) assert.equal(read(target, p), CORE_FIXTURE[p]);
    assert.ok(!existsSync(join(target, 'CLAUDE.md')), 'user data never copied');
  });
});

test('planInstall — unmodified upgrade: target == baseline → write the new source', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    writeFileSync(join(source, 'ai/guardrails.md'), 'guardrails v2\n');
    const { plan } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'write');
    assert.equal(read(target, 'ai/guardrails.md'), 'guardrails v2\n');
  });
});

test('planInstall — local edit: keep, stage new version, manifest keeps the OLD baseline', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const oldBaseline = readManifest(target).manifest.files['ai/guardrails.md'].sha256;
    writeFileSync(join(target, 'ai/guardrails.md'), 'my edit\n');
    writeFileSync(join(source, 'ai/guardrails.md'), 'guardrails v2\n');
    const { plan, result } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'keep');
    assert.equal(read(target, 'ai/guardrails.md'), 'my edit\n', 'edit never overwritten');
    assert.equal(read(target, `${PENDING_DIR}/ai/guardrails.md`), 'guardrails v2\n');
    assert.equal(result.manifest.files['ai/guardrails.md'].sha256, oldBaseline);
    assert.equal(install(source, target).plan.actions.find((a) => a.path === 'ai/guardrails.md').action, 'keep');
  });
});

test('planInstall — edit identical to the new source → write (adopts the new baseline)', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    writeFileSync(join(source, 'ai/guardrails.md'), 'guardrails v2\n');
    writeFileSync(join(target, 'ai/guardrails.md'), 'guardrails v2\n');
    const { plan, result } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'write');
    assert.equal(result.manifest.files['ai/guardrails.md'].sha256, hashFile(join(source, 'ai/guardrails.md')));
  });
});

test('planInstall — no baseline and differing target → backup-write to a colon-free timestamp dir', () => {
  withRoots(({ source, target }) => {
    writeTree(target, { 'ai/guardrails.md': 'pre-manifest local copy\n' });
    const { plan, result } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'backup-write');
    assert.equal(result.backupDir, `${BACKUP_DIR}/2026-10-05T12-34-56-789Z`);
    assert.ok(!backupStamp(NOW).includes(':'));
    assert.equal(read(target, `${result.backupDir}/ai/guardrails.md`), 'pre-manifest local copy\n');
    assert.equal(read(target, 'ai/guardrails.md'), CORE_FIXTURE['ai/guardrails.md']);
  });
});

test('planInstall — no baseline and identical target → write, no backup taken', () => {
  withRoots(({ source, target }) => {
    writeTree(target, { 'ai/guardrails.md': CORE_FIXTURE['ai/guardrails.md'] });
    const { plan } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'write');
    assert.ok(!existsSync(join(target, BACKUP_DIR)));
  });
});

test('planInstall — deleted locally: reported, not restored, manifest entry kept', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    unlinkSync(join(target, 'ai/guardrails.md'));
    const { plan, result } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'deleted');
    assert.ok(!existsSync(join(target, 'ai/guardrails.md')));
    assert.ok(result.manifest.files['ai/guardrails.md']);
  });
});

test('planInstall — a symlinked target path is never written through (kept, new version staged)', () => {
  withRoots(({ source, target }) => {
    const outside = join(target, 'outside.md');
    writeFileSync(outside, 'outside\n');
    mkdirSync(join(target, 'ai'), { recursive: true });
    symlinkSync(outside, join(target, 'ai/guardrails.md'));
    const { plan } = install(source, target);
    assert.equal(actionOf(plan, 'ai/guardrails.md'), 'keep');
    assert.equal(read(target, 'outside.md'), 'outside\n');
  });
});

test('planInstall — a manifest path no longer core is stale: left on disk, dropped from the manifest', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    unlinkSync(join(source, 'harness/test/x.test.js'));
    const { plan, result } = install(source, target);
    assert.deepEqual(plan.stale, ['harness/test/x.test.js']);
    assert.ok(existsSync(join(target, 'harness/test/x.test.js')));
    assert.ok(!('harness/test/x.test.js' in result.manifest.files));
  });
});

test('manifest — shape, sorted keys, and determinism except installed_at', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const text = read(target, MANIFEST_PATH);
    const m = JSON.parse(text);
    assert.deepEqual(Object.keys(m), ['version', 'rad_version', 'installed_at', 'files']);
    assert.equal(m.version, 1);
    assert.equal(m.rad_version, RAD_VERSION);
    assert.equal(m.installed_at, NOW.toISOString());
    assert.deepEqual(Object.keys(m.files), Object.keys(CORE_FIXTURE).sort());
    for (const [p, e] of Object.entries(m.files)) assert.deepEqual(e, { layer: 'core', sha256: hashFile(join(source, p)) });
    install(source, target);
    assert.equal(read(target, MANIFEST_PATH), text, 'same inputs → byte-identical manifest');
  });
});

test('readManifest — missing → missing; malformed JSON or wrong shape → error (fail closed)', () => {
  withRoots(({ target }) => {
    assert.deepEqual(readManifest(target), { ok: false, missing: true });
    const sha = 'a'.repeat(64);
    const bad = [
      '{not json',
      '[]',
      JSON.stringify({ version: 2, files: {} }),
      JSON.stringify({ version: 1, files: [] }),
      JSON.stringify({ version: 1, files: { 'a.md': { sha256: sha } } }),
      JSON.stringify({ version: 1, files: { 'a.md': { layer: 'core' } } }),
      JSON.stringify({ version: 1, files: { '../escape.md': { layer: 'core', sha256: sha } } }),
    ];
    mkdirSync(join(target, '.rad'), { recursive: true });
    for (const text of bad) {
      writeFileSync(join(target, MANIFEST_PATH), text);
      const res = readManifest(target);
      assert.equal(res.ok, false, text);
      assert.ok(!res.missing, `${text} must not read as missing`);
      assert.match(res.error, /installed\.json/);
    }
  });
});

test('applyInstall — executable bit preserved on scripts; plain files stay non-executable', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    for (const p of EXECUTABLES) assert.ok(statSync(join(target, p)).mode & 0o100, `${p} is executable`);
    assert.equal(statSync(join(target, 'ai/guardrails.md')).mode & 0o111, 0);
  });
});

test('installDrift — reports modified and missing paths against the manifest', () => {
  withRoots(({ source, target }) => {
    const { result } = install(source, target);
    assert.deepEqual(installDrift({ targetRoot: target, manifest: result.manifest }), { modified: [], missing: [] });
    writeFileSync(join(target, 'ai/guardrails.md'), 'edit\n');
    unlinkSync(join(target, 'harness/cli.js'));
    assert.deepEqual(installDrift({ targetRoot: target, manifest: result.manifest }),
      { modified: ['ai/guardrails.md'], missing: ['harness/cli.js'] });
  });
});
