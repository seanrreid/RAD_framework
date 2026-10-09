// Tests for harness/playbook.js (playbook-mechanism wave 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlaybookRef, playbookFileName, parsePlaybook, validatePlaybook, checkPlaybookRef, PlaybookError,
} from '../playbook.js';

const KINDS = ['env-knob', 'hook-point'];

function playbook({ meta = { kind: 'env-knob', slug: 'timeout', version: 2, summary: 's' }, body } = {}) {
  const guide = body ?? '## Upgrade Guide\n\n### Version 1 — 2026-01-02\nfirst\n\n### Version 2 — 2026-03-04\nsecond\n';
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n# Title\n\n## Steps\nx\n\n${guide}`;
}
const validate = (text, fileName = 'env-knob--timeout.md') => validatePlaybook({ fileName, text, kinds: KINDS });
const has = (errors, needle) => assert.ok(errors.some((e) => e.includes(needle)), `${needle} in ${JSON.stringify(errors)}`);

test('parsePlaybookRef accepts kind/slug@version', () => {
  assert.deepEqual(parsePlaybookRef('env-knob/timeout-style@12'), { kind: 'env-knob', slug: 'timeout-style', version: 12 });
});

test('parsePlaybookRef rejects bad refs', () => {
  for (const bad of ['', 'kind/slug', 'a/b@0', 'a/b@-1', 'a/b@01', 'A/b@1', 'a/B@1', 'a/b@1.5', ' a/b@1', 'a/b@1 ', 'a b/c@1', '1a/b@1']) {
    assert.equal(parsePlaybookRef(bad), null, JSON.stringify(bad));
  }
});

test('non-string input throws TypeError', () => {
  assert.throws(() => parsePlaybookRef(undefined), TypeError);
  assert.throws(() => parsePlaybookRef(5), TypeError);
  assert.throws(() => parsePlaybook(null), TypeError);
  assert.throws(() => playbookFileName({ kind: 'a' }), TypeError);
  assert.throws(() => validatePlaybook({ fileName: 'a--b.md', text: 1, kinds: KINDS }), TypeError);
  assert.throws(() => validatePlaybook({ fileName: 'a--b.md', text: '', kinds: 'x' }), TypeError);
  assert.throws(() => checkPlaybookRef({ ref: null, kinds: KINDS, readPlaybook: () => null }), TypeError);
  assert.throws(() => checkPlaybookRef({ ref: 'a/b@1', kinds: KINDS }), TypeError);
});

test('playbookFileName joins kind and slug', () => {
  assert.equal(playbookFileName({ kind: 'env-knob', slug: 'timeout' }), 'env-knob--timeout.md');
});

test('parsePlaybook splits meta and body', () => {
  const { meta, body } = parsePlaybook('---\n{"version": 1}\n---\nbody\n');
  assert.deepEqual(meta, { version: 1 });
  assert.equal(body, 'body\n');
});

test('parsePlaybook throws PlaybookError on missing or malformed frontmatter', () => {
  for (const bad of ['', 'no frontmatter', '\n---\n{}\n---\n', '---\n{}\nbody', '---\n{not json}\n---\n', '---\n[1]\n---\n', '---\nnull\n---\n', '---\n"s"\n---\n']) {
    assert.throws(() => parsePlaybook(bad), PlaybookError, JSON.stringify(bad));
  }
});

test('validatePlaybook accepts a valid playbook', () => {
  assert.deepEqual(validate(playbook()), []);
});

test('validatePlaybook accepts primary_file and ignores its value', () => {
  assert.deepEqual(validate(playbook({ meta: { kind: 'env-knob', slug: 'timeout', version: 2, primary_file: 42 } })), []);
});

test('validatePlaybook rejects a bad file name and a disallowed kind', () => {
  has(validate(playbook(), 'timeout.md'), 'must match <kind>--<slug>.md');
  has(validate(playbook(), 'event-type--timeout.md'), 'not an allowed playbook kind');
});

test('validatePlaybook rejects unknown keys and mismatched kind/slug', () => {
  has(validate(playbook({ meta: { version: 2, extra: 1 } })), 'unknown frontmatter key "extra"');
  has(validate(playbook({ meta: { kind: 'hook-point', version: 2 } })), 'kind "hook-point" does not match');
  has(validate(playbook({ meta: { slug: 'other', version: 2 } })), 'slug "other" does not match');
});

test('validatePlaybook accepts kind/slug omitted from frontmatter', () => {
  assert.deepEqual(validate(playbook({ meta: { version: 2 } })), []);
});

test('validatePlaybook rejects a bad frontmatter version', () => {
  for (const version of [0, -1, 1.5, '2', null, undefined]) {
    has(validate(playbook({ meta: { version } })), 'version must be a positive integer');
  }
});

test('validatePlaybook reports missing frontmatter', () => {
  has(validate('# no frontmatter\n'), 'missing frontmatter');
});

test('validatePlaybook requires Upgrade Guide to exist and be the last section', () => {
  has(validate(playbook({ body: '## Other\nx\n' })), 'missing "## Upgrade Guide"');
  has(validate(playbook({ body: '## Upgrade Guide\n### Version 1 — 2026-01-02\n\n## After\nx\n', meta: { version: 1 } })), 'must be the last');
});

test('validatePlaybook ignores ## inside a code fence', () => {
  const body = '## Upgrade Guide\n```\n## not a section\n```\n### Version 1 — 2026-01-02\n';
  assert.deepEqual(validate(playbook({ body, meta: { version: 1 } })), []);
});

test('validatePlaybook rejects a skipped, repeated or non-ascending version', () => {
  const skip = '## Upgrade Guide\n### Version 1 — 2026-01-02\n### Version 3 — 2026-02-02\n';
  has(validate(playbook({ body: skip, meta: { version: 3 } })), 'consecutively from 1');
  const desc = '## Upgrade Guide\n### Version 2 — 2026-01-02\n### Version 1 — 2026-02-02\n';
  has(validate(playbook({ body: desc, meta: { version: 1 } })), 'consecutively from 1');
  const dup = '## Upgrade Guide\n### Version 1 — 2026-01-02\n### Version 1 — 2026-02-02\n';
  has(validate(playbook({ body: dup, meta: { version: 1 } })), 'consecutively from 1');
});

test('validatePlaybook requires the last entry to equal the frontmatter version', () => {
  has(validate(playbook({ meta: { version: 3 } })), 'does not equal frontmatter version 3');
});

test('validatePlaybook rejects an empty guide, a hyphen instead of an em dash, and impossible dates', () => {
  has(validate(playbook({ body: '## Upgrade Guide\nnothing\n' })), 'no "### Version N');
  has(validate(playbook({ body: '## Upgrade Guide\n### Version 1 - 2026-01-02\n', meta: { version: 1 } })), 'malformed version entry');
  has(validate(playbook({ body: '## Upgrade Guide\n### Version 1 — 2026-02-30\n', meta: { version: 1 } })), 'invalid date');
  has(validate(playbook({ body: '## Upgrade Guide\n### Version 1 — 2026-13-01\n', meta: { version: 1 } })), 'invalid date');
});

const reader = (files) => (name) => (name in files ? files[name] : null);

test('checkPlaybookRef is ok at the current version', () => {
  const r = checkPlaybookRef({ ref: 'env-knob/timeout@2', kinds: KINDS, readPlaybook: reader({ 'env-knob--timeout.md': playbook() }) });
  assert.deepEqual(r, { ok: true, current: 2, stale: false });
});

test('checkPlaybookRef is ok but stale for an older version', () => {
  const r = checkPlaybookRef({ ref: 'env-knob/timeout@1', kinds: KINDS, readPlaybook: reader({ 'env-knob--timeout.md': playbook() }) });
  assert.deepEqual(r, { ok: true, current: 2, stale: true });
});

test('checkPlaybookRef fails on a greater version, missing file, bad kind, bad ref and invalid file', () => {
  const read = reader({ 'env-knob--timeout.md': playbook(), 'env-knob--bad.md': 'junk' });
  const fail = (ref) => checkPlaybookRef({ ref, kinds: KINDS, readPlaybook: read });
  assert.match(fail('env-knob/timeout@3').reason, /ahead of/);
  assert.match(fail('env-knob/missing@1').reason, /not found/);
  assert.match(fail('event-type/timeout@1').reason, /not an allowed/);
  assert.match(fail('nonsense').reason, /not a valid playbook ref/);
  assert.match(fail('env-knob/bad@1').reason, /is invalid/);
  assert.equal(fail('').ok, false);
});
