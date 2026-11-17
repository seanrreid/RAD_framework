import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewerCalibration, formatReviewerCalibration } from '../insights-reviewer-calibration.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'insights-reviewer-calibration.js');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'insights-parity', 'golden.txt'), 'utf8');
const SCENARIOS = ['absent', 'empty', 'blank', 'populated', 'cycle', 'non-object', 'malformed'];
const MIN_LABELED = 5;

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-reviewer-calibration-'));
const withTmp = (fn) => { const dir = makeTmp(); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

function goldenSection(name) {
  const m = GOLDEN.split(`=== 3c:${name} ===\n`)[1];
  return m.split(/^=== .* ===\n/m)[0];
}

// Builder shared with the golden capture: scenario name -> file text (null = absent file).
const f = (reviewer, extra) => JSON.stringify({ type: 'finding', reviewer, file: 'a.js', issue: 'x', ...extra });
const many = (reviewer, n, extra) => Array.from({ length: n }, () => f(reviewer, extra));

/** Scenario name -> findings-file text; null means the file is absent. */
function scenarioTexts() {
  return {
    absent: null,
    empty: '',
    blank: '\n  \n\t\n',
    populated: [
      ...many('quality-reviewer', 3, { verdict: 'confirmed' }),
      ...many('quality-reviewer', 2, { issue: 'verified false alarm here' }),
      ...many('ui-reviewer', 2, { issue: 'verified real bug' }),
      f('ui-reviewer', { category: 'false-alarm' }),
      f('ui-reviewer', { issue: 'fixed lowercase is unlabeled' }),
      f('ui-reviewer', { issue: 'FIXED in follow-up' }),
      f(undefined, {}),
    ].join('\n') + '\n',
    cycle: [
      JSON.stringify({ type: 'cycle', feature: 'x', ts: '2026-01-01' }),
      JSON.stringify({ type: 'cycle', feature: 'y', ts: '2026-01-02' }),
    ].join('\n') + '\n',
    'non-object': ['null', '42', '"str"', '[1,2]', 'true'].join('\n') + '\n',
    malformed: [f('quality-reviewer', { verdict: 'confirmed' }), '{not json', f('quality-reviewer', { verdict: 'confirmed' })].join('\n') + '\n',
  };
}

/** Writes the scenario into `dir`; returns the findings-file path the module must be given. */
function scenarioFile(dir, name) {
  const file = join(dir, `${name}.jsonl`);
  const text = scenarioTexts()[name];
  if (text !== null) writeFileSync(file, text);
  return file;
}

function runModule(file) {
  return spawnSync(process.execPath, [MODULE], { env: { ...process.env, RAD_FINDINGS_FILE: file }, encoding: 'utf8' });
}

for (const name of SCENARIOS) {
  test(`parity: ${name} stdout matches the golden from the old inline snippet, exit 0`, () => {
    withTmp((dir) => {
      const r = runModule(scenarioFile(dir, name));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, goldenSection(name));
    });
  });
}

test('parity: only the malformed scenario writes stderr, naming file, line and message', () => {
  withTmp((dir) => {
    for (const name of SCENARIOS.filter((n) => n !== 'malformed')) {
      assert.equal(runModule(scenarioFile(dir, name)).stderr, '', name);
    }
    const file = scenarioFile(dir, 'malformed');
    const expected = (() => { try { JSON.parse('{not json'); } catch (e) { return e.message; } })();
    assert.equal(runModule(file).stderr, `skipping malformed JSON at ${file}:2: ${expected}\n`);
  });
});

test('edge: missing file -> { findingsLog: false }', () => {
  withTmp((dir) => {
    assert.deepStrictEqual(buildReviewerCalibration({ findingsFile: join(dir, 'nope'), onSkip: assert.fail }), { findingsLog: false });
  });
});

test('edge: empty file and blank-only lines -> no reviewers, nothing skipped', () => {
  withTmp((dir) => {
    for (const name of ['empty', 'blank']) {
      const out = buildReviewerCalibration({ findingsFile: scenarioFile(dir, name), onSkip: assert.fail });
      assert.deepStrictEqual(out, { findingsLog: true, reviewers: {}, minLabeled: MIN_LABELED });
    }
  });
});

test('edge: non-object lines and cycle records are tolerated; zero labeled findings stays empty', () => {
  withTmp((dir) => {
    for (const name of ['cycle', 'non-object']) {
      const out = buildReviewerCalibration({ findingsFile: scenarioFile(dir, name), onSkip: assert.fail });
      assert.deepStrictEqual(out.reviewers, {}, name);
    }
  });
});

test('edge: a finding missing its reviewer counts under (unknown), not thrown on', () => {
  withTmp((dir) => {
    const out = buildReviewerCalibration({ findingsFile: scenarioFile(dir, 'populated'), onSkip: assert.fail });
    assert.equal(out.reviewers['(unknown)'].unlabeled, 1);
  });
});

test('populated: precision is null below minLabeled and a number at it, never 0', () => {
  withTmp((dir) => {
    const { reviewers } = buildReviewerCalibration({ findingsFile: scenarioFile(dir, 'populated'), onSkip: assert.fail });
    assert.equal(reviewers['ui-reviewer'].labeled, MIN_LABELED - 1);
    assert.equal(reviewers['ui-reviewer'].precision, null);
    assert.equal(reviewers['quality-reviewer'].labeled, MIN_LABELED);
    assert.equal(reviewers['quality-reviewer'].precision, 0.6);
  });
});

test('edge: malformed line is reported through onSkip with file, line and message, then skipped', () => {
  withTmp((dir) => {
    const file = scenarioFile(dir, 'malformed');
    const skips = [];
    const out = buildReviewerCalibration({ findingsFile: file, onSkip: (...a) => skips.push(a) });
    assert.equal(skips.length, 1);
    assert.deepStrictEqual(skips[0].slice(0, 2), [file, 2]);
    assert.match(skips[0][2], /JSON/);
    assert.equal(out.reviewers['quality-reviewer'].confirmed, 2);
  });
});

test('format: 2-space JSON, key order findingsLog, reviewers, minLabeled', () => {
  const text = formatReviewerCalibration({ findingsLog: true, reviewers: {}, minLabeled: MIN_LABELED });
  assert.equal(text, JSON.stringify({ findingsLog: true, reviewers: {}, minLabeled: MIN_LABELED }, null, 2));
});
