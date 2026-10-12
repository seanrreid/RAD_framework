import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCommandPrompt } from '../adapters/agent/command.js';

const FAST_GRACE_MS = 200;
const AGENT_TIMEOUT_MS = 1_500;
const DEATH_POLL_MS = 50;
const DEATH_DEADLINE_MS = 3_000;
const FLOOD_BYTES = 11 * 1024 * 1024; // just over the 10 MB output cap

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitUntilDead(pid) {
  const deadline = Date.now() + DEATH_DEADLINE_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DEATH_POLL_MS));
  }
  return !isAlive(pid);
}

/**
 * Run a fixture agent that backgrounds a long `sleep` (a grandchild in the
 * agent's group), records its pid, then runs `tail`. Always kills the recorded
 * pid afterwards so a failing test cannot leak a `sleep`.
 */
async function runWithGrandchild(tail) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-pgkill-'));
  const pidFile = join(dir, 'grandchild.pid');
  const script = join(dir, 'agent.js');
  writeFileSync(script, [
    "const { spawn } = require('child_process');",
    "const g = spawn('sleep', ['300'], { stdio: 'ignore' });",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    tail,
  ].join('\n'));
  let pid;
  try {
    const result = await runCommandPrompt({
      cmd: `${process.execPath} ${script}`, prompt: 'x', repoRoot: dir,
      timeoutMs: AGENT_TIMEOUT_MS, killGraceMs: FAST_GRACE_MS,
    });
    pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
    assert.ok(pid, 'the fixture recorded its grandchild pid');
    return { result, dead: await waitUntilDead(pid) };
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('timeout kills the whole process group, including a backgrounded grandchild', async () => {
  const { result, dead } = await runWithGrandchild('setTimeout(() => {}, 300000);');
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|timeout/i);
  assert.equal(dead, true, 'grandchild is gone after the timeout kill');
});

test('output-cap overflow kills the whole process group', async () => {
  const flood = `process.stdout.write('x'.repeat(${FLOOD_BYTES})); setTimeout(() => {}, 300000);`;
  const { result, dead } = await runWithGrandchild(flood);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded/);
  assert.equal(dead, true, 'grandchild is gone after the overflow kill');
});
