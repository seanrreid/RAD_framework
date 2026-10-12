import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  spawnOptions, signalGroup, trackGroup, untrackGroup,
} from '../adapters/agent/process-group.js';

const HANDLED_EVENTS = ['SIGINT', 'SIGTERM', 'exit'];
const POLL_MS = 50;
const DEADLINE_MS = 3_000;

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitUntilDead(pid) {
  const deadline = Date.now() + DEADLINE_MS;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
  return !isAlive(pid);
}

/** Run `fn` with process.platform pretended to be `platform`. */
async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

const counts = () => HANDLED_EVENTS.map((e) => process.listenerCount(e));

test('spawnOptions: detached on POSIX, empty on win32', async () => {
  assert.deepEqual(await withPlatform('linux', spawnOptions), { detached: true });
  assert.deepEqual(await withPlatform('win32', spawnOptions), {});
});

test('signalGroup: win32 signals the child pid, not the negative group pid', async () => {
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  try {
    await withPlatform('win32', () => signalGroup({ pid: 4242, exitCode: null, signalCode: null }, 'SIGTERM'));
    await withPlatform('linux', () => signalGroup({ pid: 4242, exitCode: null, signalCode: null }, 'SIGTERM'));
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(calls, [[4242, 'SIGTERM'], [-4242, 'SIGTERM']]);
});

test('signalGroup: skips exited/unspawned children; ESRCH is silent; other errors are logged', () => {
  const realKill = process.kill;
  const realWrite = process.stderr.write;
  const logged = [];
  let code = 'ESRCH';
  let kills = 0;
  process.kill = () => { kills++; throw Object.assign(new Error('boom'), { code }); };
  process.stderr.write = (s) => { logged.push(String(s)); return true; };
  try {
    signalGroup({ pid: undefined, exitCode: null, signalCode: null }, 'SIGTERM');
    signalGroup({ pid: 9, exitCode: 0, signalCode: null }, 'SIGTERM');
    assert.equal(kills, 0);
    signalGroup({ pid: 9, exitCode: null, signalCode: null }, 'SIGTERM');
    assert.deepEqual(logged, [], 'ESRCH is not an error');
    code = 'EPERM';
    signalGroup({ pid: 9, exitCode: null, signalCode: null }, 'SIGKILL');
  } finally {
    process.kill = realKill;
    process.stderr.write = realWrite;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SIGKILL.*pid 9|pid 9.*SIGKILL/);
});

test('trackGroup installs handlers once while live and untrackGroup removes them', () => {
  const before = counts();
  const a = { pid: 1 };
  const b = { pid: 2 };
  trackGroup(a);
  const during = counts();
  trackGroup(b);
  trackGroup(b);
  assert.deepEqual(counts(), during, 'a second live group adds no handlers');
  during.forEach((n, i) => assert.equal(n, before[i] + 1));
  untrackGroup(a);
  assert.deepEqual(counts(), during, 'handlers stay while a group is live');
  untrackGroup(b);
  assert.deepEqual(counts(), before, 'handlers removed when none is live');
});

test('a fatal signal kills the tracked group and the harness exits by that signal', async () => {
  const modulePath = new URL('../adapters/agent/process-group.js', import.meta.url).href;
  const script = `
    import { spawn } from 'node:child_process';
    import { spawnOptions, trackGroup } from ${JSON.stringify(modulePath)};
    const child = spawn('sleep', ['300'], { stdio: 'ignore', ...spawnOptions() });
    trackGroup(child);
    console.log(child.pid);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
    setInterval(() => {}, 1000);
  `;
  const host = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  host.stdout.on('data', (d) => { out += d; });
  const [, signal] = await new Promise((r) => host.on('close', (code, sig) => r([code, sig])));
  const pid = Number(out.trim());
  try {
    assert.equal(signal, 'SIGTERM', 'harness terminated with the original signal');
    assert.equal(await waitUntilDead(pid), true, 'tracked agent group was killed');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
});
