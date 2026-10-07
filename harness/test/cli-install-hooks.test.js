import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync, statSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installHooksCommand } from '../cli.js';
import { DELIVER_GATE_HOOK_COMMAND, DELIVER_GATE_HOOK_MATCHER } from '../claude-settings.js';

// rad install-hooks — #186 AC#3. Each test builds a temp target that carries
// scripts/deliver-gate-hook.mjs (unless the case is about it being absent).

const SETTINGS = '.claude/settings.json';
const HOOK_SCRIPT = 'scripts/deliver-gate-hook.mjs';
/** An mtime far in the past, so any rewrite is detectable whatever the fs timestamp resolution. */
const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

/** Capture stdout AND stderr around an async command call. */
async function captureStdio(fn) {
  const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let stdout = '';
  let stderr = '';
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
}

/** Temp target with the hook script installed (unless withScript is false); cleaned up after fn. */
async function withTarget(fn, { withScript = true } = {}) {
  const target = mkdtempSync(join(tmpdir(), 'rad-install-hooks-'));
  try {
    if (withScript) {
      mkdirSync(join(target, 'scripts'));
      writeFileSync(join(target, HOOK_SCRIPT), '// hook\n');
    }
    await fn(target);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

function runInstallHooks(argv, repoRoot = '/nonexistent-default-target') {
  return captureStdio(() => installHooksCommand(argv, { repoRoot }));
}

function seedSettings(target, text) {
  mkdirSync(join(target, '.claude'), { recursive: true });
  writeFileSync(join(target, SETTINGS), text);
}

function registered(settings) {
  return settings.hooks.PreToolUse.some((e) => e.matcher === DELIVER_GATE_HOOK_MATCHER
    && e.hooks.some((h) => h.type === 'command' && h.command === DELIVER_GATE_HOOK_COMMAND));
}

test('install-hooks AC#3 — absent settings → created, exit 0, file parses with the registration', async () => {
  await withTarget(async (target) => {
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, `rad install-hooks: created ${SETTINGS}\n`);
    assert.ok(registered(JSON.parse(readFileSync(join(target, SETTINGS), 'utf8'))));
  });
});

test('install-hooks AC#3 — --target defaults to the CLI repo root', async () => {
  await withTarget(async (target) => {
    const res = await runInstallHooks([], target);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(target, SETTINGS)));
  });
});

test('install-hooks AC#3 — existing settings with other keys → added, keys kept', async () => {
  await withTarget(async (target) => {
    seedSettings(target, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [] } }));
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, `rad install-hooks: added ${SETTINGS}\n`);
    const settings = JSON.parse(readFileSync(join(target, SETTINGS), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
    assert.deepEqual(settings.hooks.Stop, []);
    assert.ok(registered(settings));
    assert.ok(!existsSync(join(target, '.claude', `settings.json.tmp-${process.pid}`)), 'no temp file left behind');
  });
});

test('install-hooks AC#3 — rerun → present, exit 0, bytes and mtime unchanged', async () => {
  await withTarget(async (target) => {
    assert.equal((await runInstallHooks(['--target', target])).code, 0);
    const path = join(target, SETTINGS);
    utimesSync(path, OLD_MTIME, OLD_MTIME);
    const before = readFileSync(path);
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, `rad install-hooks: present ${SETTINGS}\n`);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).mtimeMs, OLD_MTIME.getTime());
  });
});

test('install-hooks AC#3 — malformed settings → exit 2, reason on stderr, bytes unchanged', async () => {
  for (const text of ['{ not json', '', '[]', '{"hooks": []}']) {
    await withTarget(async (target) => {
      seedSettings(target, text);
      const res = await runInstallHooks(['--target', target]);
      assert.equal(res.code, 2, `text ${JSON.stringify(text)}`);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^rad install-hooks: \.claude\/settings\.json: .+; nothing written\n$/);
      assert.equal(readFileSync(join(target, SETTINGS), 'utf8'), text);
    });
  }
});

test('install-hooks AC#3 — symlinked settings → exit 2, link target untouched', async () => {
  await withTarget(async (target) => {
    const real = join(target, 'real-settings.json');
    writeFileSync(real, '{}\n');
    mkdirSync(join(target, '.claude'));
    symlinkSync(real, join(target, SETTINGS));
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /not a regular file/);
    assert.equal(readFileSync(real, 'utf8'), '{}\n');
  });
});

test('install-hooks AC#3 — settings path is a directory → exit 2', async () => {
  await withTarget(async (target) => {
    mkdirSync(join(target, SETTINGS), { recursive: true });
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /not a regular file/);
  });
});

test('install-hooks AC#3 — missing hook script → exit 2, no settings.json created', async () => {
  await withTarget(async (target) => {
    const res = await runInstallHooks(['--target', target]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /scripts\/deliver-gate-hook\.mjs is missing/);
    assert.ok(!existsSync(join(target, SETTINGS)));
    assert.ok(!existsSync(join(target, '.claude')));
  }, { withScript: false });
});

test('install-hooks AC#3 — bad argv → exit 2 with usage, nothing written', async () => {
  await withTarget(async (target) => {
    for (const argv of [['--bogus', 'x'], ['--target'], ['--target', target, '--target', target], ['extra']]) {
      const res = await runInstallHooks(argv, target);
      assert.equal(res.code, 2, `argv ${JSON.stringify(argv)}`);
      assert.match(res.stderr, /^rad install-hooks: .+\nUsage: rad install-hooks \[--target <dir>\]\n$/);
    }
    assert.ok(!existsSync(join(target, SETTINGS)));
  });
});
