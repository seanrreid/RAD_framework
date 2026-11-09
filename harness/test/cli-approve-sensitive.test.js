/**
 * Sensitive-content provenance at `rad approve` (AC#7): applied
 * `sensitive-content:<id>` waivers are frozen into `approved.data.waivers`; the
 * non-default pattern is recorded as `approved.data.sensitiveContentPattern`
 * only when the `sensitive-content-patterns` tag line is present. The blocker
 * script is stubbed with synthetic stdout through the injected `sh`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { approveCommand } from '../cli.js';
import { evaluateGate } from '../gates.js';
import { planFingerprint } from '../plan-fingerprint.js';
import { validateTransition } from '../transitions.js';

const FEATURE = 'sensitive-feature';
const BLOCKER_SCRIPT_RE = /check-approval-blockers\.sh$/;
const TAG = 'sensitive-content-patterns';
const CUSTOM_PATTERN = '(^|[^a-z])(rm -rf|sudo)([^a-z]|$)';
const WAIVER_LINE = 'sensitive-content:network-egress\tcalls the vendor API on purpose\n';
const PLAN_TEXT = [`# ${FEATURE}`, '', 'Status: pending-review', `Branch: rad/${FEATURE}`, '',
  '## Files in Scope', '', '- docs/guide.md', ''].join('\n');

/** Run `rad approve` with the blocker script returning `stdout` (exit 0). */
async function approveWith(stdout) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-approve-sensitive-'));
  const savedSync = process.env.RAD_SYNC;
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  let stderr = '';
  delete process.env.RAD_SYNC;
  try {
    mkdirSync(join(repoRoot, '.agents', 'plans'), { recursive: true });
    writeFileSync(join(repoRoot, '.agents', 'plans', `${FEATURE}.md`), PLAN_TEXT, 'utf8');
    const sh = (file, args) => {
      if (BLOCKER_SCRIPT_RE.test(file)) return { status: 0, stdout, stderr: '' };
      if (file === 'git' && args[0] === 'config') return { status: 0, stdout: 'arch@example.com\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    process.stdout.write = () => true;
    const code = await approveCommand([FEATURE, '--no-commit'], { repoRoot, sh });
    const eventsFile = join(repoRoot, '.agents', 'state', FEATURE, 'events.jsonl');
    const events = existsSync(eventsFile)
      ? readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : null;
    return { code, stderr, events };
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    if (savedSync !== undefined) process.env.RAD_SYNC = savedSync;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function assertRefusedNoWrite(r, re) {
  assert.equal(r.code, 1, `expected exit 1; got ${r.code}`);
  assert.match(r.stderr, re);
  assert.equal(r.events, null, 'no events.jsonl may be written on refusal');
}

test('AC#7: a sensitive-content waiver is frozen into data.waivers', async () => {
  const r = await approveWith(WAIVER_LINE);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(r.events[0].data.waivers, [
    { id: 'sensitive-content:network-egress', justification: 'calls the vendor API on purpose' },
  ]);
  assert.equal('sensitiveContentPattern' in r.events[0].data, false);
});

test('AC#7: the non-default pattern is recorded verbatim as data.sensitiveContentPattern', async () => {
  const r = await approveWith(`${TAG}\t${CUSTOM_PATTERN}\n${WAIVER_LINE}`);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.events[0].data.sensitiveContentPattern, CUSTOM_PATTERN);
  assert.equal(r.events[0].data.waivers.length, 1);
});

test('AC#7: both provenance tags coexist without clobbering each other', async () => {
  const r = await approveWith(`high-risk-pattern\tinfra/\n${TAG}\t${CUSTOM_PATTERN}\n`);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.events[0].data.highRiskPattern, 'infra/');
  assert.equal(r.events[0].data.sensitiveContentPattern, CUSTOM_PATTERN);
});

test('AC#7: the field is absent for the default pattern (empty stdout)', async () => {
  const r = await approveWith('');
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(Object.keys(r.events[0].data), ['fingerprint']);
});

test('AC#7: an empty tag value is refused and nothing is written', async () => {
  assertRefusedNoWrite(await approveWith(`${TAG}\t\n`), /approval blocker check failed \(empty sensitive-content-patterns value\)/);
});

test('AC#7: a duplicate tag line is refused and nothing is written', async () => {
  const r = await approveWith(`${TAG}\ta\n${TAG}\tb\n`);
  assertRefusedNoWrite(r, /approval blocker check failed \(duplicate sensitive-content-patterns line\)/);
});

test('AC#7: a tag line without a TAB is refused and nothing is written', async () => {
  assertRefusedNoWrite(await approveWith(`${TAG}\n`), /malformed waiver line/);
});

test('AC#7: a first field that merely starts with the tag is an ordinary waiver id', async () => {
  const r = await approveWith(`${TAG}X\tjust\n`);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(r.events[0].data.waivers, [{ id: `${TAG}X`, justification: 'just' }]);
  assert.equal('sensitiveContentPattern' in r.events[0].data, false);
});

test('AC#7: the event passes the existing validators and the fingerprint is unchanged', async () => {
  const withTag = await approveWith(`${TAG}\t${CUSTOM_PATTERN}\n${WAIVER_LINE}`);
  const without = await approveWith('');
  const expected = planFingerprint(PLAN_TEXT).hash;
  assert.equal(withTag.events[0].data.fingerprint, expected);
  assert.equal(without.events[0].data.fingerprint, expected);
  assert.doesNotThrow(() => validateTransition([], withTag.events[0]));
  assert.equal(evaluateGate('approved', withTag.events).passed, true);
});
