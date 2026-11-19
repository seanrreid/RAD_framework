import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_PER_ARM, buildEntry, buildReport, formatReport, median, readLedger } from '../review-minutes.js';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'review-minutes.js');
const DATE = '2026-11-18';

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-minutes-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const row = (arm, minutes, extra) => ({ arm, minutes, ...extra });
const rows = (arm, minutesList, extra) => minutesList.map((m) => row(arm, m, extra));
const cli = (file, ...args) => spawnSync(process.execPath, [MODULE, ...args], {
  encoding: 'utf8', env: { ...process.env, RAD_REVIEW_MINUTES_FILE: file },
});

test('buildEntry: valid input keeps optional fields only when given', () => {
  const entry = buildEntry({ ref: ' PR-12 ', arm: 'rad', minutes: '18.5', lines: '240', rounds: '2', note: ' ok ' }, DATE);
  assert.deepEqual(entry, { date: DATE, ref: 'PR-12', arm: 'rad', minutes: 18.5, lines: 240, rounds: 2, note: 'ok' });
  assert.deepEqual(buildEntry({ ref: 'x', arm: 'unmanaged', minutes: 5 }, DATE), { date: DATE, ref: 'x', arm: 'unmanaged', minutes: 5 });
});

test('buildEntry: rejects missing or blank ref, unknown arm, and non-positive or non-numeric minutes', () => {
  assert.throws(() => buildEntry({ arm: 'rad', minutes: 5 }, DATE), /--ref is required/);
  assert.throws(() => buildEntry({ ref: '  ', arm: 'rad', minutes: 5 }, DATE), /--ref is required/);
  assert.throws(() => buildEntry({ ref: 'x', arm: 'swarm', minutes: 5 }, DATE), /--arm must be one of/);
  assert.throws(() => buildEntry({ ref: 'x', arm: undefined, minutes: 5 }, DATE), /--arm must be one of/);
  for (const bad of [undefined, '', '0', 0, '-3', 'abc', 'NaN', 'Infinity']) {
    assert.throws(() => buildEntry({ ref: 'x', arm: 'rad', minutes: bad }, DATE), /--minutes must be a positive number/, String(bad));
  }
});

test('buildEntry: lines and rounds must be non-negative integers; zero is allowed', () => {
  assert.equal(buildEntry({ ref: 'x', arm: 'rad', minutes: 1, lines: '0' }, DATE).lines, 0);
  for (const bad of ['-1', '1.5', 'abc', '']) {
    assert.throws(() => buildEntry({ ref: 'x', arm: 'rad', minutes: 1, lines: bad }, DATE), /--lines/, bad);
    assert.throws(() => buildEntry({ ref: 'x', arm: 'rad', minutes: 1, rounds: bad }, DATE), /--rounds/, bad);
  }
});

test('median: empty, odd and even lengths', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('readLedger: absent file is empty; blank lines ignored; bad rows are reported by line, never silent', () => withTmp((dir) => {
  const missing = join(dir, 'none.jsonl');
  assert.deepEqual(readLedger(missing, () => assert.fail('no skip expected')), []);

  const file = join(dir, 'ledger.jsonl');
  const text = [
    JSON.stringify(row('rad', 10)), '', '   ', '{not json',
    'null', '[1,2]', '42', JSON.stringify(row('swarm', 10)), JSON.stringify(row('rad', 0)),
    JSON.stringify(row('rad', -4)), JSON.stringify(row('rad', '9')), JSON.stringify(row('unmanaged', 7)),
  ].join('\n');
  writeFileSync(file, text);
  const skips = [];
  const valid = readLedger(file, (f, line, reason) => skips.push({ f, line, reason }));
  assert.deepEqual(valid.map((r) => r.arm), ['rad', 'unmanaged']);
  assert.deepEqual(skips.map((s) => s.line), [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(skips.every((s) => s.f === file && s.reason));
}));

test('buildReport: empty ledger has n=0, no statistics and no comparison', () => {
  const report = buildReport([]);
  for (const arm of ['rad', 'unmanaged']) {
    assert.equal(report.arms[arm].n, 0);
    assert.equal(report.arms[arm].enough, false);
    assert.equal(report.arms[arm].medianMinutes, null);
  }
  assert.equal(report.medianRatio, null);
});

test('buildReport: below the per-arm floor statistics stay null, never 0', () => {
  const report = buildReport(rows('rad', Array(MIN_PER_ARM - 1).fill(10)));
  assert.equal(report.arms.rad.n, MIN_PER_ARM - 1);
  assert.equal(report.arms.rad.medianMinutes, null);
  assert.equal(report.arms.rad.meanMinutes, null);
  assert.equal(report.medianRatio, null);
});

test('buildReport: one arm enough but not the other gives no comparison', () => {
  const report = buildReport([...rows('rad', [10, 12, 14, 16, 18]), ...rows('unmanaged', [20, 30])]);
  assert.equal(report.arms.rad.medianMinutes, 14);
  assert.equal(report.medianRatio, null);
});

test('buildReport: medians, size-normalised rate (zero-line rows excluded), rounds and ratio', () => {
  const rad = [10, 20, 30, 40, 50].map((m, i) => row('rad', m, { lines: i === 0 ? 0 : 100, rounds: 1 }));
  const unmanaged = rows('unmanaged', [20, 40, 60, 80, 100], { lines: 200, rounds: 3 });
  const { arms, medianRatio } = buildReport([...rad, ...unmanaged]);
  assert.equal(arms.rad.medianMinutes, 30);
  assert.equal(arms.rad.meanMinutes, 30);
  assert.equal(arms.rad.sizedN, 4);
  assert.equal(arms.rad.medianMinutesPer100Lines, 35);
  assert.equal(arms.rad.medianRounds, 1);
  assert.equal(arms.unmanaged.medianMinutesPer100Lines, 30);
  assert.equal(arms.unmanaged.medianRounds, 3);
  assert.equal(medianRatio, 0.5);
});

test('formatReport: states insufficiency, the comparison direction and the caveat', () => {
  const thin = formatReport(buildReport(rows('rad', [5, 6])), 'f.jsonl');
  assert.match(thin, /rad\s+n=2\s+insufficient \(need 5\)/);
  assert.match(thin, /not enough tickets in both arms yet/);
  assert.match(thin, /a signal, not proof/);

  const full = formatReport(buildReport([...rows('rad', [10, 10, 10, 10, 10]), ...rows('unmanaged', [20, 20, 20, 20, 20])]), 'f.jsonl');
  assert.match(full, /RAD median review time is 50% lower than unmanaged/);
  const worse = formatReport(buildReport([...rows('rad', [30, 30, 30, 30, 30]), ...rows('unmanaged', [20, 20, 20, 20, 20])]), 'f.jsonl');
  assert.match(worse, /50% higher than unmanaged/);
});

test('cli: log then report round-trips through the ledger file', () => withTmp((dir) => {
  const file = join(dir, 'nested', 'ledger.jsonl');
  for (let i = 0; i < MIN_PER_ARM; i++) {
    assert.equal(cli(file, 'log', '--ref', `r${i}`, '--arm', 'rad', '--minutes', '10').status, 0);
    assert.equal(cli(file, 'log', '--ref', `u${i}`, '--arm', 'unmanaged', '--minutes', '20').status, 0);
  }
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, MIN_PER_ARM * 2);
  const out = cli(file, 'report');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /50% lower than unmanaged/);
}));

test('cli: invalid input exits non-zero with the reason and writes nothing', () => withTmp((dir) => {
  const file = join(dir, 'ledger.jsonl');
  const bad = cli(file, 'log', '--ref', 'x', '--arm', 'rad', '--minutes', '0');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--minutes must be a positive number/);
  assert.equal(existsSync(file), false);
  assert.equal(cli(file).status, 2);
  assert.match(cli(file, 'frobnicate').stderr, /usage:/);
}));

test('cli: report surfaces malformed rows on stderr with file:line and still succeeds', () => withTmp((dir) => {
  const file = join(dir, 'ledger.jsonl');
  writeFileSync(file, `${JSON.stringify(row('rad', 10))}\n{broken\n`);
  const out = cli(file, 'report');
  assert.equal(out.status, 0);
  assert.match(out.stderr, new RegExp(`skipping bad ledger row at .*ledger\\.jsonl:2`));
  assert.match(out.stdout, /rad\s+n=1/);
}));
