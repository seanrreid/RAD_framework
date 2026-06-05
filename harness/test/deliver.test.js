import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { deliverCommand } from '../cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.js');

// ---------------------------------------------------------------------------
// Fixture helpers — copied verbatim from cli.test.js
// ---------------------------------------------------------------------------

async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-deliver-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** Write a minimal plan doc with the given Status header. */
function writePlanDoc(repoRoot, feature, status = 'pending-review') {
  const plansDir = join(repoRoot, '.agents', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${feature}.md`);
  writeFileSync(
    planFile,
    [
      `# ${feature}`,
      '',
      `Status: ${status}`,
      `Branch: rad/${feature}`,
      '',
      '## Acceptance Criteria',
      '',
      '1. Example criterion.',
      '',
      '## Waves',
      '',
      '### Wave 1',
      '',
      '- [ ] Task A',
    ].join('\n'),
    'utf8',
  );
  return planFile;
}

/** A minimal mock sh that returns success for any call. */
function mockSh(_file, _args, _opts) {
  return { status: 0, stdout: '', stderr: '' };
}

// ---------------------------------------------------------------------------
// (a) Dispatch smoke — AC#1
//
// `main(['deliver', '--help'], { repoRoot })` exits 0 and stdout includes
// 'deliver'. Shells out to `node harness/cli.js` so it exercises the real
// process dispatch path.
// ---------------------------------------------------------------------------

test('AC#1 — deliver --help exits 0 and stdout includes "deliver"', () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CLI, 'deliver', '--help'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`expected exit 0, got ${err.status}: ${err.stderr}`);
  }
  assert.ok(stdout.includes('deliver'), `stdout should include "deliver"; got:\n${stdout}`);
});

// ---------------------------------------------------------------------------
// (b) Auth guard — AC#3
//
// When ANTHROPIC_API_KEY is unset/empty, deliverCommand must return exit code
// 1 and write to stderr containing 'ANTHROPIC_API_KEY'. The ctx.runWave spy
// must receive zero calls.
// ---------------------------------------------------------------------------

test('AC#3 — missing ANTHROPIC_API_KEY exits 1 and stderr contains ANTHROPIC_API_KEY', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'test-feature';
    writePlanDoc(repoRoot, feature, 'pending-review');

    // Save and unset the API key so the guard fires.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    let runWaveCalls = 0;
    const spyRunWave = () => { runWaveCalls += 1; };

    let stderrOutput = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrOutput += chunk;
      return origWrite(chunk, ...rest);
    };

    let code;
    try {
      code = await deliverCommand([feature], { repoRoot, sh: mockSh, runWave: spyRunWave });
    } finally {
      process.stderr.write = origWrite;
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      }
    }

    assert.equal(code, 1, `deliverCommand should return 1 when API key is absent; got ${code}`);
    assert.ok(
      stderrOutput.includes('ANTHROPIC_API_KEY'),
      `stderr should contain 'ANTHROPIC_API_KEY'; got:\n${stderrOutput}`,
    );
    assert.equal(runWaveCalls, 0, 'runWave spy must not be called when API key is absent');
  });
});

// ---------------------------------------------------------------------------
// (c) Gate refusal — AC#4
//
// A plan with Status: pending-review (no approved event in events.jsonl) must
// cause deliverCommand to return a non-zero exit code without ever calling
// runWave.
// ---------------------------------------------------------------------------

test('AC#4 — pending-review plan fails gate and runWave is never called', async () => {
  await withTempRepo(async (repoRoot) => {
    const feature = 'test-feature';
    writePlanDoc(repoRoot, feature, 'pending-review');
    // No events.jsonl written — gate fold returns not-passed.

    // Ensure API key is set so the auth guard does not fire first.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

    let runWaveCalls = 0;
    const spyRunWave = () => { runWaveCalls += 1; };

    let code;
    try {
      code = await deliverCommand([feature], { repoRoot, sh: mockSh, runWave: spyRunWave });
    } finally {
      if (saved !== undefined) {
        process.env.ANTHROPIC_API_KEY = saved;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }

    assert.ok(code !== 0, `deliverCommand should return non-zero for an unapproved plan; got ${code}`);
    assert.equal(runWaveCalls, 0, 'runWave spy must not be called when the gate has not passed');
  });
});
