// Tests for harness/generated-outputs.js: source -> generated output mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generatedOutputsFor } from '../generated-outputs.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated-outputs.js');
const PLAN = '.rad/skills/rad-plan/SKILL.md';
const AGENT = '.rad/agents/helper.md';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gen-outputs-'));
  mkdirSync(join(root, '.rad/skills/rad-plan'), { recursive: true });
  mkdirSync(join(root, '.rad/agents'), { recursive: true });
  writeFileSync(join(root, PLAN),
    '---\nname: rad-plan\ndescription: Plan things.\ntargets:\n  claude: command:team/rad-plan\n  codex: skill\n---\n\nPlan {{args}} carefully.\n');
  writeFileSync(join(root, AGENT),
    '---\nname: helper\ndescription: Helps with things.\nmodel: claude-sonnet-4-6\ntools: Read, Bash\npurpose: authority\nroles: [architect, developer]\ncodex:\n  sandbox_mode: read-only\n---\n\nYou are a helper.\n');
  return root;
}

test('skill with two targets yields both paths, sorted', async () => {
  const root = fixtureRoot();
  try {
    const got = await generatedOutputsFor(root, [PLAN]);
    assert.equal(got.ok, true);
    assert.deepEqual(got.outputs.map((o) => o.path), ['.agents/skills/rad-plan/SKILL.md', '.claude/commands/team/rad-plan.md']);
    assert.ok(got.outputs.every((o) => o.source === PLAN));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent source yields claude and codex outputs', async () => {
  const root = fixtureRoot();
  try {
    const got = await generatedOutputsFor(root, [AGENT]);
    assert.deepEqual(got.outputs.map((o) => o.path), ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown source and empty list yield no outputs', async () => {
  const root = fixtureRoot();
  try {
    assert.deepEqual((await generatedOutputsFor(root, ['.rad/skills/nope/SKILL.md'])).outputs, []);
    assert.deepEqual((await generatedOutputsFor(root, [])).outputs, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate sources do not duplicate outputs', async () => {
  const root = fixtureRoot();
  try {
    const got = await generatedOutputsFor(root, [PLAN, PLAN]);
    assert.equal(got.outputs.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('root without .rad/ is { ok: false } and the CLI exits 1 with the reason on stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gen-outputs-empty-'));
  try {
    const got = await generatedOutputsFor(root, [PLAN]);
    assert.equal(got.ok, false);
    const run = spawnSync('node', [SCRIPT, PLAN], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /\.rad\/: no source directory/);
    assert.equal(run.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI prints path<TAB>source lines', () => {
  const root = fixtureRoot();
  try {
    const run = spawnSync('node', [SCRIPT, PLAN], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, `.agents/skills/rad-plan/SKILL.md\t${PLAN}\n.claude/commands/team/rad-plan.md\t${PLAN}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
