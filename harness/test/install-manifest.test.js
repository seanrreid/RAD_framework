import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_PATH, PENDING_DIR, BACKUP_DIR, PRESET_LAYER, listCoreFiles, hashFile, readManifest, planInstall, applyInstall,
  backupStamp, installDrift, isSafeRelPath, planLayerInstall, planPresetInstall, applyPresetInstall, presetFilesRoot,
  PRESET_NEEDS_CORE_ERROR,
} from '../install-manifest.js';
import { GENERATED_MARKER, generatedSource } from '../generated-marker.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-05T12:34:56.789Z');
const RAD_VERSION = 'abc123';

/** Core files every fixture source carries (path -> content). */
const CORE_FIXTURE = {
  '.claude/commands/team/rad-plan.md': 'plan v1\n',
  '.claude/skills/kickoff/SKILL.md': 'kickoff\n',
  'ai/guardrails.md': 'guardrails\n',
  'scripts/lint-plan.sh': '#!/bin/sh\necho lint\n',
  'scripts/hook.mjs': '// hook\n',
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
  'scripts/sub/deep.mjs': '// nested\n',
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
  assert.ok(files.includes('scripts/deliver-gate-hook.mjs'), 'top-level scripts/*.mjs ships');
  assert.ok(!files.includes('CLAUDE.md'));
  assert.ok(!files.some((p) => p.startsWith('harness/node_modules/')), 'nothing under harness/node_modules/');
  const SHIPPED_RAD = ['.rad/skills/', '.rad/agents/'];
  assert.ok(!files.some((p) => p.startsWith('.rad/') && !SHIPPED_RAD.some((d) => p.startsWith(d))), 'only .rad sources ship');
  for (const prefix of ['.agents/', '.claude/agents/', '.codex/agents/']) {
    const unshipped = files.filter((p) => p.startsWith(prefix)
      && !SHIPPED_RAD.some((d) => generatedSource(read(REPO_ROOT, p))?.startsWith(d)));
    assert.deepEqual(unshipped, [], `only outputs of shipped sources under ${prefix}`);
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
      { modified: [{ path: 'ai/guardrails.md', layer: 'core' }], missing: [{ path: 'harness/cli.js', layer: 'core' }] });
  });
});

// ---------------------------------------------------------------------------
// Layers (#71 part 2a): core is the only layer written; others are carried
// ---------------------------------------------------------------------------

/** Rewrite the target manifest after `mutate(files)` edits its entries. */
function editManifest(target, mutate) {
  const m = JSON.parse(read(target, MANIFEST_PATH));
  mutate(m.files);
  writeFileSync(join(target, MANIFEST_PATH), `${JSON.stringify(m, null, 2)}\n`);
}

/** Write a preset-owned file into the target and record it under `layer`. */
function addLayered(target, path, layer = PRESET_LAYER) {
  writeTree(target, { [path]: `${layer} content\n` });
  editManifest(target, (files) => { files[path] = { layer, sha256: hashFile(join(target, path)) }; });
}

test('PRESET_LAYER — exported as "preset"', () => {
  assert.equal(PRESET_LAYER, 'preset');
});

test('planInstall — first install (manifest null): no stale, no conflicts, nothing carried', () => {
  withRoots(({ source, target }) => {
    const plan = planInstall({ sourceRoot: source, targetRoot: target, manifest: null });
    assert.deepEqual(plan.stale, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.carried, {});
  });
});

test('upgrade — preset entries are carried unchanged into the new manifest and never stale', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    addLayered(target, '.claude/agents/preset-agent.md');
    const recorded = JSON.parse(read(target, MANIFEST_PATH)).files['.claude/agents/preset-agent.md'];
    const { plan, result } = install(source, target);
    assert.deepEqual(plan.stale, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(result.manifest.files['.claude/agents/preset-agent.md'], recorded);
    assert.deepEqual(Object.keys(result.manifest.files), Object.keys(result.manifest.files).sort(), 'keys stay sorted');
  });
});

test('upgrade — a manifest with only preset entries carries them and installs core fresh', () => {
  withRoots(({ source, target }) => {
    mkdirSync(join(target, '.rad'), { recursive: true });
    writeFileSync(join(target, MANIFEST_PATH), JSON.stringify({ version: 1, rad_version: 'x', installed_at: 'y', files: {} }));
    addLayered(target, 'presets/p.md');
    const { plan, result } = install(source, target);
    assert.deepEqual(plan.stale, []);
    assert.ok(plan.actions.every((a) => a.action === 'write'));
    assert.equal(result.manifest.files['presets/p.md'].layer, PRESET_LAYER);
    for (const p of Object.keys(CORE_FIXTURE)) assert.equal(result.manifest.files[p].layer, 'core', p);
  });
});

test('upgrade — a preset entry whose file was deleted is still carried; drift reports it missing as preset', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    addLayered(target, 'presets/gone.md');
    unlinkSync(join(target, 'presets/gone.md'));
    const { result } = install(source, target);
    assert.equal(result.manifest.files['presets/gone.md'].layer, PRESET_LAYER);
    assert.deepEqual(installDrift({ targetRoot: target, manifest: result.manifest }),
      { modified: [], missing: [{ path: 'presets/gone.md', layer: PRESET_LAYER }] });
  });
});

test('upgrade — an unknown layer string is non-core: carried, never stale', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    addLayered(target, 'custom/x.md', 'team-overlay');
    const { plan, result } = install(source, target);
    assert.deepEqual(plan.stale, []);
    assert.equal(result.manifest.files['custom/x.md'].layer, 'team-overlay');
  });
});

test('upgrade — a core entry core no longer ships is still stale alongside a carried preset', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    addLayered(target, 'presets/p.md');
    unlinkSync(join(source, 'harness/test/x.test.js'));
    const { plan, result } = install(source, target);
    assert.deepEqual(plan.stale, ['harness/test/x.test.js']);
    assert.ok(!('harness/test/x.test.js' in result.manifest.files));
    assert.ok('presets/p.md' in result.manifest.files);
  });
});

test('planInstall — a non-core path core now ships is a conflict; applyInstall refuses before writing', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    editManifest(target, (files) => { files['ai/guardrails.md'].layer = PRESET_LAYER; });
    writeFileSync(join(target, 'ai/guardrails.md'), 'preset guardrails\n');
    writeFileSync(join(source, 'ai/guardrails.md'), 'core v2\n');
    const before = read(target, MANIFEST_PATH);
    const read1 = readManifest(target);
    const plan = planInstall({ sourceRoot: source, targetRoot: target, manifest: read1.manifest });
    assert.deepEqual(plan.conflicts, ['ai/guardrails.md']);
    assert.deepEqual(plan.stale, []);
    assert.throws(() => applyInstall({ sourceRoot: source, targetRoot: target, plan, now: NOW, radVersion: RAD_VERSION }),
      /refusing to install.*ai\/guardrails\.md/);
    assert.equal(read(target, 'ai/guardrails.md'), 'preset guardrails\n', 'the preset file is untouched');
    assert.equal(read(target, MANIFEST_PATH), before, 'the manifest is untouched');
  });
});

test('installDrift — modified entries carry their layer, sorted by path across layers', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    addLayered(target, 'presets/p.md');
    const { manifest } = readManifest(target);
    writeFileSync(join(target, 'presets/p.md'), 'edited\n');
    writeFileSync(join(target, 'ai/guardrails.md'), 'edited\n');
    assert.deepEqual(installDrift({ targetRoot: target, manifest }), {
      modified: [{ path: 'ai/guardrails.md', layer: 'core' }, { path: 'presets/p.md', layer: PRESET_LAYER }],
      missing: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Layer-generic install: presets (#71 part 2b)
// ---------------------------------------------------------------------------

const PRESET_META = { name: 'team-x', version: '1.0.0' };
/** Files a fixture preset ships (path under files/ -> content). */
const PRESET_FIXTURE = {
  'docs/team.md': 'team doc v1\n',
  'scripts/hooks/pre-wave/check.sh': '#!/bin/sh\necho check\n',
};

/** Write a preset dir beside `source` with `files` under files/; returns its path. */
function writePreset(source, files = PRESET_FIXTURE) {
  const presetDir = join(dirname(source), 'preset');
  rmSync(presetDir, { recursive: true, force: true });
  writeTree(join(presetDir, 'files'), files);
  return presetDir;
}

/** Plan + apply a preset over the target's current manifest; returns { plan, result }. */
function installPreset(presetDir, target, files = Object.keys(PRESET_FIXTURE)) {
  const read1 = readManifest(target);
  assert.ok(read1.ok, read1.error ?? 'manifest missing');
  const planned = planPresetInstall({ presetDir, files, targetRoot: target, manifest: read1.manifest });
  assert.ok(planned.ok, planned.error);
  const result = applyPresetInstall({ presetDir, targetRoot: target, plan: planned.plan, now: NOW, ...PRESET_META });
  return { plan: planned.plan, result };
}

test('isSafeRelPath — exported; rejects absolute, backslash, empty, ".", ".." segments', () => {
  assert.equal(isSafeRelPath('docs/a.md'), true);
  for (const bad of ['', '/abs', 'a\\b', 'a//b', './a', 'a/../b', '..', 'a/.', 7, null]) {
    assert.equal(isSafeRelPath(bad), false, JSON.stringify(bad));
  }
});

test('preset install — fresh files written under the preset layer; core entries carried; preset block recorded', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const before = JSON.parse(read(target, MANIFEST_PATH));
    const presetDir = writePreset(source);
    chmodSync(join(presetDir, 'files/scripts/hooks/pre-wave/check.sh'), 0o755);
    const { plan, result } = installPreset(presetDir, target);
    assert.deepEqual(plan.actions.map((a) => a.action), ['write', 'write']);
    assert.deepEqual([plan.stale, plan.conflicts], [[], []]);
    assert.equal(read(target, 'docs/team.md'), 'team doc v1\n');
    assert.equal(statSync(join(target, 'scripts/hooks/pre-wave/check.sh')).mode & 0o777, 0o755, 'exec bit carried');
    const m = JSON.parse(read(target, MANIFEST_PATH));
    assert.deepEqual(Object.keys(m), ['version', 'rad_version', 'installed_at', 'preset', 'files']);
    assert.deepEqual(m.preset, { ...PRESET_META, source: presetDir });
    assert.equal(m.rad_version, RAD_VERSION, 'rad_version kept from the existing manifest');
    assert.equal(m.installed_at, NOW.toISOString());
    assert.deepEqual(m.files['docs/team.md'], { layer: PRESET_LAYER, sha256: hashFile(join(presetDir, 'files/docs/team.md')) });
    for (const p of Object.keys(CORE_FIXTURE)) assert.deepEqual(m.files[p], before.files[p], p);
    assert.deepEqual(result.manifest, m);
  });
});

test('preset install — a null manifest is refused by the planner (core must be installed first)', () => {
  withRoots(({ source, target }) => {
    const presetDir = writePreset(source);
    const planned = planPresetInstall({ presetDir, files: Object.keys(PRESET_FIXTURE), targetRoot: target, manifest: null });
    assert.deepEqual(planned, { ok: false, error: PRESET_NEEDS_CORE_ERROR });
    assert.equal(existsSync(join(target, 'docs')), false);
  });
});

test('preset install — a path recorded as core is a conflict; apply refuses before writing', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const presetDir = writePreset(source, { 'ai/guardrails.md': 'preset guardrails\n' });
    const before = read(target, MANIFEST_PATH);
    const planned = planPresetInstall({ presetDir, files: ['ai/guardrails.md'], targetRoot: target, manifest: readManifest(target).manifest });
    assert.deepEqual(planned.plan.conflicts, ['ai/guardrails.md']);
    assert.throws(() => applyPresetInstall({ presetDir, targetRoot: target, plan: planned.plan, now: NOW, ...PRESET_META }),
      /refusing to install: preset ships paths another layer owns: ai\/guardrails\.md/);
    assert.equal(read(target, 'ai/guardrails.md'), 'guardrails\n');
    assert.equal(read(target, MANIFEST_PATH), before);
  });
});

test('preset install — an existing unbaselined differing target file is backed up then overwritten', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    writeTree(target, { 'docs/team.md': 'user doc\n' });
    const { plan, result } = installPreset(writePreset(source), target);
    assert.equal(actionOf(plan, 'docs/team.md'), 'backup-write');
    assert.equal(read(target, join(result.backupDir, 'docs/team.md')), 'user doc\n');
    assert.equal(read(target, 'docs/team.md'), 'team doc v1\n');
  });
});

test('preset upgrade — a locally edited preset file is kept and the new version staged', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const presetDir = writePreset(source);
    installPreset(presetDir, target);
    const v1 = hashFile(join(target, 'docs/team.md'));
    writeFileSync(join(target, 'docs/team.md'), 'local edit\n');
    writeFileSync(join(presetDir, 'files/docs/team.md'), 'team doc v2\n');
    const { plan, result } = installPreset(presetDir, target);
    assert.equal(actionOf(plan, 'docs/team.md'), 'keep');
    assert.equal(read(target, 'docs/team.md'), 'local edit\n');
    assert.equal(read(target, join(PENDING_DIR, 'docs/team.md')), 'team doc v2\n');
    assert.equal(result.manifest.files['docs/team.md'].sha256, v1, 'old baseline kept');
  });
});

test('preset upgrade — a file the preset dropped is stale: out of the manifest, left on disk; core untouched', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const presetDir = writePreset(source);
    installPreset(presetDir, target);
    const { plan, result } = installPreset(presetDir, target, ['docs/team.md']);
    assert.deepEqual(plan.stale, ['scripts/hooks/pre-wave/check.sh']);
    assert.ok(!('scripts/hooks/pre-wave/check.sh' in result.manifest.files));
    assert.ok(existsSync(join(target, 'scripts/hooks/pre-wave/check.sh')));
    for (const p of Object.keys(CORE_FIXTURE)) assert.equal(result.manifest.files[p].layer, 'core', p);
  });
});

test('install-core after a preset install keeps the preset entries and the preset block', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const presetDir = writePreset(source);
    installPreset(presetDir, target);
    const { plan, result } = install(source, target);
    assert.deepEqual([plan.stale, plan.conflicts], [[], []]);
    assert.deepEqual(result.manifest.preset, { ...PRESET_META, source: presetDir });
    assert.equal(result.manifest.files['docs/team.md'].layer, PRESET_LAYER);
    assert.deepEqual(readManifest(target).manifest, result.manifest);
  });
});

test('planLayerInstall — refuses an unsafe path or a symlinked source before anything is written', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const presetDir = writePreset(source);
    symlinkSync(join(source, 'ai/guardrails.md'), join(presetDir, 'files/docs/link.md'));
    const manifest = readManifest(target).manifest;
    const plan = (files) => planLayerInstall({ layer: PRESET_LAYER, files, sourceRoot: presetFilesRoot(presetDir), targetRoot: target, manifest });
    assert.throws(() => plan(['../source/ai/guardrails.md']), /unsafe path/);
    assert.throws(() => plan(['docs/link.md']), /not a regular file/);
    assert.throws(() => plan(['docs/missing.md']), /not a regular file/);
  });
});

test('readManifest — a malformed preset block is rejected', () => {
  withRoots(({ source, target }) => {
    install(source, target);
    const base = JSON.parse(read(target, MANIFEST_PATH));
    const cases = [
      [{ name: 'a', version: '1' }, /'preset\.source' is not a string/],
      ['team-x', /'preset' is not an object/],
      [null, /'preset' is not an object/],
      [['a'], /'preset' is not an object/],
      [{ name: 'a', version: 1, source: '/p' }, /'preset\.version' is not a string/],
    ];
    for (const [preset, re] of cases) {
      writeFileSync(join(target, MANIFEST_PATH), JSON.stringify({ ...base, preset }));
      const got = readManifest(target);
      assert.equal(got.ok, false);
      assert.match(got.error, re);
    }
    writeFileSync(join(target, MANIFEST_PATH), JSON.stringify({ ...base, preset: { name: 'a', version: '1', source: '/p' } }));
    assert.ok(readManifest(target).ok);
  });
});

// Generated sources and marked outputs ship through core (#171 part 2, AC#4)

/** A file carrying the generated marker in its markdown (frontmatter) position. */
const markedMd = (name) => `---\nname: ${name}\n---\n<!-- ${GENERATED_MARKER} (source: .rad/agents/${name}.md) -->\n\nBody.\n`;
/** A file carrying the generated marker in its first-line (TOML/YAML) position. */
const markedHash = (name) => `# ${GENERATED_MARKER} (source: .rad/agents/${name}.md)\nname = "${name}"\n`;
/** One marked output under each new root. */
const MARKED_FIXTURE = {
  '.claude/agents/quality-reviewer.md': markedMd('quality-reviewer'),
  '.agents/skills/quality-review/SKILL.md': markedMd('quality-review'),
  '.agents/skills/quality-review/agents/openai.yaml': markedHash('quality-review'),
  '.codex/agents/quality-reviewer.toml': markedHash('quality-reviewer'),
};
/** The generator source trees. */
const SOURCE_FIXTURE = {
  '.rad/skills/quality-review/SKILL.md': 'source skill\n',
  '.rad/skills/quality-review/codex.md': 'codex body\n',
  '.rad/agents/quality-reviewer.md': 'source agent\n',
};

test('listCoreFiles — a marked file under each new root ships', () => {
  withRoots(({ source }) => {
    writeTree(source, MARKED_FIXTURE);
    const files = listCoreFiles(source);
    for (const p of Object.keys(MARKED_FIXTURE)) assert.ok(files.includes(p), `${p} ships`);
  });
});

test('listCoreFiles — unmarked files under the new roots never ship (marker out of position too)', () => {
  withRoots(({ source }) => {
    writeTree(source, {
      '.codex/agents/internal.toml': 'name = "internal"\n',
      '.agents/skills/mine/SKILL.md': `Body mentions ${GENERATED_MARKER}\n`,
      '.claude/agents/late.md': `---\nname: late\n---\n\n<!-- ${GENERATED_MARKER} -->\n`,
    });
    const files = listCoreFiles(source);
    for (const p of ['.claude/agents/me.md', '.codex/agents/internal.toml', '.agents/skills/mine/SKILL.md',
      '.claude/agents/late.md', '.agents/plans/p.md']) {
      assert.ok(!files.includes(p), `${p} not shipped`);
    }
  });
});

/** A marked output (markdown form) whose marker records `sourcePath`. */
const markedFrom = (name, sourcePath) => `---\nname: ${name}\n---\n<!-- ${GENERATED_MARKER} (source: ${sourcePath}) -->\n`;
/** A marked output (first-line form) whose marker records `sourcePath`. */
const hashFrom = (name, sourcePath) => `# ${GENERATED_MARKER} (source: ${sourcePath})\nname = "${name}"\n`;

test('listCoreFiles — a marked output ships only when its source lies under a shipped source tree', () => {
  withRoots(({ source }) => {
    const shipped = {
      '.claude/agents/from-agents.md': markedFrom('from-agents', '.rad/agents/from-agents.md'),
      '.agents/skills/from-skills/SKILL.md': markedFrom('from-skills', '.rad/skills/from-skills/SKILL.md'),
      '.codex/agents/from-agents.toml': hashFrom('from-agents', '.rad/agents/from-agents.md'),
    };
    const internal = {
      '.claude/agents/orchestrator.md': markedFrom('orchestrator', '.rad/agents-internal/orchestrator.md'),
      '.codex/agents/orchestrator.toml': hashFrom('orchestrator', '.rad/agents-internal/orchestrator.md'),
      '.claude/agents/bare-tree.md': markedFrom('bare-tree', '.rad/agents'),
      '.claude/agents/elsewhere.md': markedFrom('elsewhere', 'docs/agents/elsewhere.md'),
      '.claude/agents/no-source.md': `---\nname: no-source\n---\n<!-- ${GENERATED_MARKER} -->\n`,
      '.codex/agents/no-source.toml': `# ${GENERATED_MARKER}\nname = "no-source"\n`,
    };
    writeTree(source, { ...shipped, ...internal });
    const files = listCoreFiles(source);
    for (const p of Object.keys(shipped)) assert.ok(files.includes(p), `${p} ships`);
    for (const p of Object.keys(internal)) assert.ok(!files.includes(p), `${p} not shipped`);
  });
});

test('listCoreFiles — .rad/skills and .rad/agents ship whole; .rad/config.yml and installed.json never do', () => {
  withRoots(({ source }) => {
    writeTree(source, { ...SOURCE_FIXTURE, [MANIFEST_PATH]: '{}\n', '.rad/upgrade-pending/x.md': 'x\n' });
    const files = listCoreFiles(source);
    for (const p of Object.keys(SOURCE_FIXTURE)) assert.ok(files.includes(p), `${p} ships`);
    assert.deepEqual(files.filter((p) => p.startsWith('.rad/')), Object.keys(SOURCE_FIXTURE).sort());
  });
});

test('listCoreFiles — a symlinked marked file or root is never followed', () => {
  withRoots(({ source }) => {
    writeTree(source, { 'outside/marked.md': markedMd('outside'), 'outside/dir/a.toml': markedHash('a') });
    mkdirSync(join(source, '.codex'), { recursive: true });
    symlinkSync(join(source, 'outside/marked.md'), join(source, '.claude/agents/linked.md'));
    symlinkSync(join(source, 'outside/dir'), join(source, '.codex/agents'));
    symlinkSync(join(source, 'outside/dir'), join(source, '.rad/agents'));
    const files = listCoreFiles(source);
    assert.ok(!files.includes('.claude/agents/linked.md'));
    assert.ok(!files.some((p) => p.startsWith('.codex/') || p.startsWith('.rad/') || p.startsWith('outside/')));
  });
});

test('listCoreFiles — core set unchanged when no sources or marked files exist; output sorted and deterministic', () => {
  withRoots(({ source }) => {
    assert.deepEqual(listCoreFiles(source), Object.keys(CORE_FIXTURE).sort());
    writeTree(source, { ...SOURCE_FIXTURE, ...MARKED_FIXTURE });
    const expected = [...Object.keys(CORE_FIXTURE), ...Object.keys(SOURCE_FIXTURE), ...Object.keys(MARKED_FIXTURE)].sort();
    assert.deepEqual(listCoreFiles(source), expected);
    assert.deepEqual(listCoreFiles(source), expected);
  });
});
