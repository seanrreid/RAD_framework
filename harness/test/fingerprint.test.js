import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fingerprint } from '../fingerprint.js';
import { planFingerprint } from '../plan-fingerprint.js';

test('fingerprint is a 64-char SHA-256 hex digest', () => {
  const fp = fingerprint({ failedCategories: ['tests'], errorSummary: 'boom' });
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test('equivalent failures hash equal — category order, case, whitespace insensitive', () => {
  const a = fingerprint({
    failedCategories: ['tests', 'scope'],
    errorSummary: 'Two   checks   FAILED',
  });
  const b = fingerprint({
    failedCategories: ['scope', 'tests'], // reordered
    errorSummary: 'two checks failed', // normalized whitespace + case
  });
  assert.equal(a, b);
});

test('fingerprint accepts the alias field names (categories / summary)', () => {
  const a = fingerprint({ failedCategories: ['tests'], errorSummary: 'x' });
  const b = fingerprint({ categories: ['tests'], summary: 'x' });
  assert.equal(a, b);
});

test('duplicate categories are deduped (equivalent)', () => {
  const a = fingerprint({ categories: ['tests', 'tests'], summary: 'x' });
  const b = fingerprint({ categories: ['tests'], summary: 'x' });
  assert.equal(a, b);
});

test('materially different failures differ', () => {
  const base = fingerprint({ categories: ['tests'], summary: 'assertion failed' });
  const diffCategory = fingerprint({ categories: ['scope'], summary: 'assertion failed' });
  const diffSummary = fingerprint({ categories: ['tests'], summary: 'timeout exceeded' });
  assert.notEqual(base, diffCategory);
  assert.notEqual(base, diffSummary);
});

test('empty/undefined result hashes stably to the canonical empty preimage', () => {
  assert.equal(fingerprint(undefined), fingerprint({}));
  assert.equal(fingerprint({}), fingerprint({ categories: [], summary: '' }));
});

// Plan fingerprint: the plan-header `Capabilities:` line is locked by approval.
// Hash of PLAN_BODY_ONLY computed from the body-only scheme before the header
// fold existed; it must never move, or every existing approval is invalidated.
const PRE_FOLD_HASH = 'a21c81e9810f071f3037381ae6509ea4065952fd01635fefee72deee4857fc1d';
const PLAN_BODY = '## Context\n\nSome body.\n\n## Wave 1\n\nCapabilities: fs_read\n';
const PLAN_BODY_ONLY = `# Plan: fixture\n\nStatus: approved\n\n${PLAN_BODY}`;
const withHeaderCaps = (caps) => `# Plan: fixture\n\nStatus: approved\nCapabilities: ${caps}\n\n${PLAN_BODY}`;
const planHash = (text) => planFingerprint(text).hash;

test('plan without a header Capabilities line hashes exactly as before the fold', () => {
  assert.equal(planHash(PLAN_BODY_ONLY), PRE_FOLD_HASH);
});

test('adding a header Capabilities line changes the plan hash', () => {
  assert.notEqual(planHash(withHeaderCaps('fs_read, fs_write')), planHash(PLAN_BODY_ONLY));
});

test('widening the header Capabilities line changes the plan hash', () => {
  assert.notEqual(planHash(withHeaderCaps('fs_read, fs_write, shell, net')),
    planHash(withHeaderCaps('fs_read, fs_write')));
});

test('removing the header Capabilities line restores the body-only hash', () => {
  const removed = withHeaderCaps('fs_read').replace('Capabilities: fs_read\n', '');
  assert.notEqual(planHash(removed), planHash(withHeaderCaps('fs_read')));
  assert.equal(planHash(removed), PRE_FOLD_HASH);
});

test('editing only Status: does not change a plan hash that has header capabilities', () => {
  const draft = withHeaderCaps('fs_read, fs_write').replace('Status: approved', 'Status: draft');
  assert.equal(planHash(draft), planHash(withHeaderCaps('fs_read, fs_write')));
});

test('trailing whitespace on the header Capabilities line does not change the hash', () => {
  const padded = withHeaderCaps('fs_read, fs_write').replace('fs_write\n', 'fs_write  \t\n');
  assert.equal(planHash(padded), planHash(withHeaderCaps('fs_read, fs_write')));
});

test('a wave Capabilities line in the body still changes the hash', () => {
  const widened = PLAN_BODY_ONLY.replace('Capabilities: fs_read', 'Capabilities: fs_read, net');
  assert.notEqual(planHash(widened), PRE_FOLD_HASH);
});

test('a plan with no body heading still folds its header Capabilities line', () => {
  const headerOnly = '# Plan: fixture\nStatus: draft\n';
  assert.notEqual(planHash(`${headerOnly}Capabilities: fs_read\n`), planHash(headerOnly));
});

// Header `Playbook:` line (#50): folded after Capabilities; absent line must not move any hash.
const withHeaderPlaybook = (line, caps) =>
  `# Plan: fixture\n\nStatus: approved\n${caps ? `Capabilities: ${caps}\n` : ''}${line}\n\n${PLAN_BODY}`;

test('plan without a Playbook line still hashes to the fixed pre-change hash', () => {
  assert.equal(planHash(PLAN_BODY_ONLY), PRE_FOLD_HASH);
  assert.equal(planHash(withHeaderPlaybook('Notes: none')), PRE_FOLD_HASH);
});

test('a header Playbook line changes the hash; changing it changes it again', () => {
  const a = planHash(withHeaderPlaybook('Playbook: docs/playbooks/a.md@1'));
  assert.notEqual(a, PRE_FOLD_HASH);
  assert.notEqual(planHash(withHeaderPlaybook('Playbook: docs/playbooks/a.md@2')), a);
});

test('trailing whitespace on the Playbook line does not change the hash', () => {
  assert.equal(planHash(withHeaderPlaybook('Playbook: a@1  \t')), planHash(withHeaderPlaybook('Playbook: a@1')));
});

test('a Playbook line in the body, outside the header, is ignored', () => {
  const bodyLine = 'Playbook: docs/playbooks/a.md@1';
  const plan = `${PLAN_BODY_ONLY}\n${bodyLine}\n`;
  // Hash equals the plain body digest: no marker was folded in.
  const bodyOnly = `${PLAN_BODY}\n${bodyLine}\n`;
  assert.equal(planHash(plan), createHash('sha256').update(bodyOnly).digest('hex'));
});

test('Capabilities plus Playbook: both fold, and each change moves the hash', () => {
  const both = planHash(withHeaderPlaybook('Playbook: a@1', 'fs_read'));
  assert.notEqual(both, planHash(withHeaderCaps('fs_read')));
  assert.notEqual(both, planHash(withHeaderPlaybook('Playbook: a@1')));
  assert.notEqual(both, planHash(withHeaderPlaybook('Playbook: a@2', 'fs_read')));
  assert.notEqual(both, planHash(withHeaderPlaybook('Playbook: a@1', 'fs_read, net')));
});

test('Capabilities-only plans keep their hash after the Playbook fold exists', () => {
  assert.equal(planHash(withHeaderCaps('fs_read')), planHash(withHeaderPlaybook('Notes: none', 'fs_read')));
});
