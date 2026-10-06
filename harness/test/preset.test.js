// Tests for harness/preset.js: the preset reader (#71 part 2b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { PRESET_FILE, PRESET_ROOTS, readPreset, presetFilePath } from '../preset.js';

const VALID_YML = 'name: team-x\nversion: "1.0.0"\n';

/** A preset dir with preset.yml text `yml` (null = absent) and `files` under files/; `fn` gets the dir. */
async function withPreset(yml, files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-preset-'));
  try {
    if (yml !== null) writeFileSync(join(dir, PRESET_FILE), yml);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'files', rel)), { recursive: true });
      writeFileSync(join(dir, 'files', rel), content);
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert readPreset fails with an error matching `re`. */
async function assertRejected(yml, files, re) {
  await withPreset(yml, files, async (dir) => {
    const got = await readPreset(dir);
    assert.equal(got.ok, false, `expected rejection matching ${re}`);
    assert.match(got.errors.join('\n'), re);
  });
}

test('PRESET_ROOTS — exactly the four allowed target roots', () => {
  assert.deepEqual([...PRESET_ROOTS], ['scripts/hooks/', 'ai/extensions/', '.claude/agents/', 'docs/']);
});

test('readPreset — a valid preset with settings and files; files sorted posix paths', async () => {
  const files = { 'docs/b.md': 'b\n', '.claude/agents/a.md': 'a\n', 'scripts/hooks/pre-wave/x.sh': 'x\n', 'ai/extensions/e.md': 'e\n' };
  await withPreset(`${VALID_YML}settings:\n  hooks_dir: hooks\n`, files, async (dir) => {
    assert.deepEqual(await readPreset(dir), {
      ok: true,
      preset: { name: 'team-x', version: '1.0.0', settings: { hooks_dir: 'hooks' }, files: Object.keys(files).sort() },
    });
  });
});

test('readPreset — settings only is valid', async () => {
  await withPreset(`${VALID_YML}settings:\n  high_risk_patterns: "auth"\n`, {}, async (dir) => {
    const got = await readPreset(dir);
    assert.equal(got.ok, true, JSON.stringify(got.errors));
    assert.deepEqual(got.preset.files, []);
  });
});

test('readPreset — files only is valid; settings is undefined', async () => {
  await withPreset(VALID_YML, { 'docs/a.md': 'a\n' }, async (dir) => {
    const got = await readPreset(dir);
    assert.equal(got.ok, true, JSON.stringify(got.errors));
    assert.equal(got.preset.settings, undefined);
    assert.deepEqual(got.preset.files, ['docs/a.md']);
  });
});

test('readPreset — missing preset.yml', async () => {
  await assertRejected(null, { 'docs/a.md': 'a\n' }, /preset\.yml is missing/);
});

test('readPreset — unparseable YAML', async () => {
  await assertRejected('name: [unclosed\n', {}, /cannot parse preset\.yml/);
});

test('readPreset — YAML that is not a mapping', async () => {
  await assertRejected('- a\n- b\n', {}, /preset\.yml must be a YAML mapping/);
  await assertRejected('just a string\n', {}, /preset\.yml must be a YAML mapping/);
});

test('readPreset — an unknown top-level key is named', async () => {
  await assertRejected(`${VALID_YML}extra: 1\n`, { 'docs/a.md': 'a\n' }, /unknown key 'extra'/);
});

test('readPreset — a bad name (uppercase, leading dash, empty, missing)', async () => {
  for (const name of ['Team-X', '"-team"', '""', 'team_x']) {
    await assertRejected(`name: ${name}\nversion: "1"\n`, { 'docs/a.md': 'a\n' }, /name must be kebab-case/);
  }
  await assertRejected('version: "1"\n', { 'docs/a.md': 'a\n' }, /name must be kebab-case/);
});

test('readPreset — an empty, blank, missing or non-string version', async () => {
  for (const version of ['""', '"  "', '1.0']) {
    await assertRejected(`name: team-x\nversion: ${version}\n`, { 'docs/a.md': 'a\n' }, /version must be a non-empty string/);
  }
  await assertRejected('name: team-x\n', { 'docs/a.md': 'a\n' }, /version must be a non-empty string/);
});

test('readPreset — invalid settings are rejected, naming the key', async () => {
  await assertRejected(`${VALID_YML}settings:\n  hooks_dir: "-x"\n`, {}, /settings\.hooks_dir/);
  await assertRejected(`${VALID_YML}settings:\n  nope: y\n`, {}, /unknown key settings\.nope/);
  await assertRejected(`${VALID_YML}settings: [a]\n`, {}, /settings must be a mapping/);
});

test('readPreset — a symlink under files/ is refused, never followed', async () => {
  await withPreset(VALID_YML, { 'docs/a.md': 'a\n' }, async (dir) => {
    symlinkSync(join(dir, 'files/docs/a.md'), join(dir, 'files/docs/link.md'));
    symlinkSync(join(dir, 'files/docs'), join(dir, 'files/ai'));
    const got = await readPreset(dir);
    assert.equal(got.ok, false);
    assert.match(got.errors.join('\n'), /files\/docs\/link\.md: not a regular file/);
    assert.match(got.errors.join('\n'), /files\/ai: not a regular file/);
  });
});

test('readPreset — a symlinked files/ dir or preset.yml is refused', async () => {
  await withPreset(VALID_YML, { 'docs/a.md': 'a\n' }, async (dir) => {
    const other = mkdtempSync(join(tmpdir(), 'rad-preset-other-'));
    try {
      const linked = join(other, 'p');
      mkdirSync(linked);
      symlinkSync(join(dir, PRESET_FILE), join(linked, PRESET_FILE));
      assert.match((await readPreset(linked)).errors.join('\n'), /preset\.yml .* is not a regular file/);
      rmSync(join(linked, PRESET_FILE));
      writeFileSync(join(linked, PRESET_FILE), VALID_YML);
      symlinkSync(join(dir, 'files'), join(linked, 'files'));
      assert.match((await readPreset(linked)).errors.join('\n'), /files\/ is not a directory/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

test('readPreset — a file outside the allowed roots is refused, naming the path', async () => {
  for (const rel of ['harness/x.js', '.rad/config.yml', 'README.md', 'scripts/x.sh', 'ai/guardrails.md']) {
    await assertRejected(VALID_YML, { [rel]: 'x\n' }, new RegExp(`files/${rel.replace(/\./g, '\\.')}: outside the allowed preset roots`));
  }
});

test('readPreset — a backslash in a file name fails isSafeRelPath', async () => {
  await assertRejected(VALID_YML, { 'docs/a\\b.md': 'x\n' }, /files\/docs\/a\\b\.md: unsafe path/);
});

test('readPreset — an empty preset (no settings, no files, or settings: {}) is refused', async () => {
  await assertRejected(VALID_YML, {}, /neither settings nor files/);
  await assertRejected(`${VALID_YML}settings: {}\n`, {}, /neither settings nor files/);
});

test('readPreset — .DS_Store litter is skipped, not an error', async () => {
  await withPreset(VALID_YML, { 'docs/a.md': 'a\n', '.DS_Store': 'x', 'docs/.DS_Store': 'x' }, async (dir) => {
    const got = await readPreset(dir);
    assert.equal(got.ok, true, JSON.stringify(got.errors));
    assert.deepEqual(got.preset.files, ['docs/a.md']);
  });
});

test('presetFilePath — absolute path under files/; unsafe paths throw', async () => {
  await withPreset(VALID_YML, { 'docs/a.md': 'a\n' }, async (dir) => {
    assert.equal(presetFilePath(dir, 'docs/a.md'), join(dir, 'files', 'docs/a.md'));
    for (const bad of ['../preset.yml', '/etc/passwd', 'docs/../../x', '']) {
      assert.throws(() => presetFilePath(dir, bad), /unsafe preset file path/);
    }
  });
});
