// Reviewer evals: run each reviewer agent (.claude/agents/<reviewer>.md) against
// every fixture under reviewers/fixtures/<reviewer>/<id>/ and require a strict
// majority of N trials to meet the fixture's expect.json. Makes REAL model calls
// via RAD_REVIEW_EVAL_CMD; unset → every case is SKIPPED (never passed).
//
// Trust boundary: the command is spawned with the FULL inherited env (this is an
// eval job, not a delivery), cwd = a temp review repo, prompt on stdin. The
// command is split on whitespace, so the executable path must not contain spaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReviewPrompt, buildReviewRepo, judgeMajority, judgeTrial, parseFindings, readExpect,
} from './reviewers/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURES = join(HERE, 'reviewers', 'fixtures');
const SKIP_REASON = 'skipped: no credentials (RAD_REVIEW_EVAL_CMD unset)';
const DEFAULT_TRIALS = 3;
const DEFAULT_TIMEOUT_SECONDS = 300;
const POSITIVE_INT = /^[1-9][0-9]*$/;

/** Parse an optional positive-integer env var; malformed → named error, never a silent default. */
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!POSITIVE_INT.test(raw.trim())) {
    const err = new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    err.name = 'ReviewEvalConfigError';
    throw err;
  }
  return Number(raw.trim());
}

const subdirs = (dir) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();

/** One reviewer run: spawn → parse → judge; spawn failures become 'invalid' with the reason. */
function runTrial(cmd, prompt, expect, fixtureDir, timeoutMs) {
  const { root, cleanup } = buildReviewRepo(fixtureDir);
  try {
    const res = spawnSync(cmd[0], cmd.slice(1), {
      cwd: root, input: prompt, env: process.env, encoding: 'utf8', timeout: timeoutMs,
    });
    const parsed = res.error ? null : parseFindings(res.stdout);
    const categories = parsed?.findings.map((f) => `${f?.priority}:${f?.category}`) ?? [];
    if (res.error) {
      const why = res.error.code === 'ETIMEDOUT' ? `timeout after ${timeoutMs}ms` : res.error.message;
      return { verdict: 'invalid', categories, note: `spawn failed: ${why}` };
    }
    if (parsed === null) {
      const note = res.status === 0 ? 'no rad-findings block' : `exit ${res.status}, no rad-findings block`;
      return { verdict: 'invalid', categories, note };
    }
    return { verdict: judgeTrial(expect, parsed), categories, note: `exit ${res.status}` };
  } finally {
    cleanup();
  }
}

function runFixture(reviewer, fixtureDir) {
  const trials = positiveIntEnv('RAD_REVIEW_EVAL_TRIALS', DEFAULT_TRIALS);
  const timeoutMs = positiveIntEnv('RAD_REVIEW_EVAL_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS) * 1000;
  const cmd = process.env.RAD_REVIEW_EVAL_CMD.trim().split(/\s+/);
  const agentMd = readFileSync(join(REPO_ROOT, '.claude', 'agents', `${reviewer}.md`), 'utf8');
  const prompt = buildReviewPrompt(agentMd);
  const expect = readExpect(fixtureDir);
  const results = [];
  for (let i = 1; i <= trials; i += 1) results.push(runTrial(cmd, prompt, expect, fixtureDir, timeoutMs));
  const summary = results.map((r, i) =>
    `  trial ${i + 1}: ${r.verdict} [${r.categories.join(', ') || 'no findings'}] (${r.note})`).join('\n');
  const majority = judgeMajority(results.map((r) => r.verdict), trials);
  assert.equal(majority, 'pass', `${reviewer}/${fixtureDir.split('/').pop()} expected ${JSON.stringify(expect)}:\n${summary}`);
}

for (const reviewer of subdirs(FIXTURES)) {
  for (const id of subdirs(join(FIXTURES, reviewer))) {
    const dir = join(FIXTURES, reviewer, id);
    const skip = process.env.RAD_REVIEW_EVAL_CMD?.trim() ? false : SKIP_REASON;
    test(`${reviewer}/${id}`, { skip }, () => runFixture(reviewer, dir));
  }
}
