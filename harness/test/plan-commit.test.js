import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  planIssueNumber,
  countWavesTasks,
  planCommitMessage,
  validateTrailer,
  planWorkBranch,
  conventionWorkBranch,
  approveCommitMessage,
  reviewCommitMessage,
  setPlanStatus,
} from '../plan-commit.js';

const GITHUB_URL = 'https://github.com/org/repo/issues/42';
const GITLAB_URL = 'https://gitlab.com/org/repo/-/issues/77';

/** A minimal plan doc; `header` lines go after the title, `out` is the Out-of-Scope body. */
function plan({ header = [], out = null, waves = 1, tasksPerWave = 1 } = {}) {
  const lines = ['# Plan: Do the Thing', 'Status: pending-review', ...header, '', '## Context', 'x', ''];
  if (out !== null) lines.push('## Out-of-Scope Dependencies', out, '');
  lines.push('## Wave Plan');
  for (let w = 1; w <= waves; w += 1) {
    lines.push(`### Wave ${w} — sequential`);
    for (let t = 1; t <= tasksPerWave; t += 1) lines.push(`#### Task ${w}.${t}: step`);
  }
  return lines.join('\n');
}

// ── planIssueNumber ──────────────────────────────────────────────────────────

test('planIssueNumber: Issue: header wins over Adopted-From', () => {
  assert.equal(planIssueNumber(plan({ header: ['Issue: 186', `Adopted-From: ${GITHUB_URL}`] })), 186);
});

test('planIssueNumber: GitHub and GitLab Adopted-From URLs', () => {
  assert.equal(planIssueNumber(plan({ header: [`Adopted-From: ${GITHUB_URL}`] })), 42);
  assert.equal(planIssueNumber(plan({ header: [`Adopted-From: ${GITLAB_URL}`] })), 77);
});

test('planIssueNumber: free-text Adopted-From → null', () => {
  assert.equal(planIssueNumber(plan({ header: ['Adopted-From: a slack thread'] })), null);
});

test('planIssueNumber: neither header → null', () => {
  assert.equal(planIssueNumber(plan()), null);
});

test('planIssueNumber: Issue: below the header block is ignored', () => {
  const text = `${plan()}\n\n## Notes\nIssue: 99\n`;
  assert.equal(planIssueNumber(text), null);
});

test('planIssueNumber: malformed Issue: → null (no Adopted-From fallback)', () => {
  assert.equal(planIssueNumber(plan({ header: ['Issue: abc'] })), null);
  assert.equal(planIssueNumber(plan({ header: ['Issue: 0', `Adopted-From: ${GITHUB_URL}`] })), null);
});

// ── countWavesTasks ──────────────────────────────────────────────────────────

test('countWavesTasks counts wave and task headings', () => {
  assert.deepEqual(countWavesTasks(plan({ waves: 2, tasksPerWave: 3 })), { waves: 2, tasks: 6 });
});

test('countWavesTasks: zero waves', () => {
  assert.deepEqual(countWavesTasks('# Plan: x\n\n## Context\nnothing\n'), { waves: 0, tasks: 0 });
});

test('countWavesTasks ignores headings inside fenced code', () => {
  const text = `${plan()}\n\`\`\`md\n### Wave 9\n#### Task 9.1: x\n\`\`\`\n`;
  assert.deepEqual(countWavesTasks(text), { waves: 1, tasks: 1 });
});

// ── planCommitMessage ────────────────────────────────────────────────────────

test('planCommitMessage: plan subject and body order without Issue', () => {
  const msg = planCommitMessage(plan({ header: ['Author: dev'], waves: 2, tasksPerWave: 2 }));
  assert.equal(msg, [
    'plan: Do the Thing',
    '',
    'Author: dev',
    'Waves: 2',
    'Tasks: 4',
    'Out-of-scope deps: no',
  ].join('\n'));
});

test('planCommitMessage: adopt subject, Adopted-From then Issue first in body', () => {
  const msg = planCommitMessage(plan({ header: ['Author: dev', `Adopted-From: ${GITHUB_URL}`] }));
  assert.equal(msg, [
    'adopt: Do the Thing',
    '',
    `Adopted-From: ${GITHUB_URL}`,
    'Issue: 42',
    'Author: dev',
    'Waves: 1',
    'Tasks: 1',
    'Out-of-scope deps: no',
  ].join('\n'));
});

test('planCommitMessage: Issue header on a plain plan; missing Author → unknown', () => {
  const msg = planCommitMessage(plan({ header: ['Issue: 186'] }));
  assert.match(msg, /^plan: Do the Thing\n\nIssue: 186\nAuthor: unknown\n/);
});

test('planCommitMessage: Out-of-scope deps None → no, content → yes', () => {
  for (const out of ['None', 'none.', '- None', '  *NONE*  ', '']) {
    assert.match(planCommitMessage(plan({ out })), /Out-of-scope deps: no$/, `body ${JSON.stringify(out)}`);
  }
  assert.match(planCommitMessage(plan({ out: '- needs #200 merged' })), /Out-of-scope deps: yes$/);
  assert.match(planCommitMessage(plan({ out: 'None yet, but #200' })), /Out-of-scope deps: yes$/);
});

test('planCommitMessage: trailers appended after the derived lines', () => {
  const trailers = ['Co-Authored-By: X <y@z>', 'Refs: #186'];
  const msg = planCommitMessage(plan({ header: ['Author: dev'] }), trailers);
  assert.ok(msg.endsWith('Out-of-scope deps: no\n\nCo-Authored-By: X <y@z>\nRefs: #186'), msg);
});

test('planCommitMessage: invalid trailer throws', () => {
  assert.throws(() => planCommitMessage(plan(), ['no colon here']), /Key: Value/);
});

test('planCommitMessage: plan without a "# Plan:" title throws', () => {
  assert.throws(() => planCommitMessage('Status: x\n\n## Context\n'), /# Plan:/);
});

// ── validateTrailer ──────────────────────────────────────────────────────────

test('validateTrailer accepts Key: Value', () => {
  assert.equal(validateTrailer('Co-Authored-By: X <y@z>'), null);
});

test('validateTrailer rejects malformed trailers', () => {
  assert.match(validateTrailer('NoColon'), /Key: Value/);
  assert.match(validateTrailer('Key:   '), /value is empty/);
  assert.match(validateTrailer('Key: a\nInjected: b'), /single line/);
  assert.match(validateTrailer('Bad Key: v'), /trailer key/);
  assert.match(validateTrailer(': v'), /trailer key/);
});

// ── planWorkBranch ───────────────────────────────────────────────────────────

test('planWorkBranch: the Branch: header wins', () => {
  assert.equal(planWorkBranch('rad/custom', 'feat', { RAD_BRANCH_PREFIX: 'team/' }), 'rad/custom');
});

test('planWorkBranch: no header honors RAD_BRANCH_PREFIX', () => {
  assert.equal(planWorkBranch('', 'feat', { RAD_BRANCH_PREFIX: 'team/' }), 'team/feat');
  assert.equal(planWorkBranch(undefined, 'feat', { RAD_BRANCH_PREFIX: 'team/' }), 'team/feat');
});

test('planWorkBranch: no header and no prefix → default rad/', () => {
  assert.equal(planWorkBranch('  ', 'feat', {}), 'rad/feat');
  assert.equal(conventionWorkBranch('feat', { RAD_BRANCH_PREFIX: '' }), 'rad/feat');
});

// resolveWorkBranch / approveCommand in cli.js call planWorkBranch with no env,
// so the fallback must read RAD_BRANCH_PREFIX from process.env (never `rad/`).
test('planWorkBranch: missing Branch: header + process.env RAD_BRANCH_PREFIX=team/ → team/<feature>', (t) => {
  const saved = process.env.RAD_BRANCH_PREFIX;
  t.after(() => {
    if (saved === undefined) delete process.env.RAD_BRANCH_PREFIX;
    else process.env.RAD_BRANCH_PREFIX = saved;
  });
  process.env.RAD_BRANCH_PREFIX = 'team/';
  assert.equal(planWorkBranch('', 'rad-plan-open'), 'team/rad-plan-open');
});

// ── approveCommitMessage ─────────────────────────────────────────────────────

const DIRECT = { feature: 'do-thing', approvedBy: 'arch' };
const PROXY = { ...DIRECT, proxy: true, recordedBy: 'dev', evidence: 'slack 2026-10-07' };

test('approveCommitMessage: no issue → Issue line omitted', () => {
  assert.equal(approveCommitMessage(plan(), DIRECT), [
    'approve: do-thing',
    '',
    'Plan: .agents/plans/do-thing.md',
    'Approved-By: arch',
  ].join('\n'));
});

test('approveCommitMessage: proxy adds Recorded-By and Approval-Evidence after Approved-By', () => {
  assert.equal(approveCommitMessage(plan({ header: ['Issue: 186'] }), PROXY), [
    'approve: do-thing',
    '',
    'Plan: .agents/plans/do-thing.md',
    'Issue: 186',
    'Approved-By: arch',
    'Recorded-By: dev',
    'Approval-Evidence: slack 2026-10-07',
  ].join('\n'));
});

test('approveCommitMessage: direct mode never emits proxy lines', () => {
  const msg = approveCommitMessage(plan(), { ...DIRECT, recordedBy: 'dev', evidence: 'x' });
  assert.doesNotMatch(msg, /Recorded-By|Approval-Evidence/);
});

test('approveCommitMessage: re-approval subject', () => {
  assert.match(approveCommitMessage(plan(), { ...DIRECT, reapproval: true }), /^approve: do-thing \(re-approval\)\n\n/);
});

test('approveCommitMessage: trailers follow a blank line in the given order', () => {
  const trailers = ['Refs: #186', 'Co-Authored-By: X <y@z>'];
  const msg = approveCommitMessage(plan(), DIRECT, trailers);
  assert.ok(msg.endsWith('Approved-By: arch\n\nRefs: #186\nCo-Authored-By: X <y@z>'), msg);
});

test('approveCommitMessage: invalid trailer throws', () => {
  assert.throws(() => approveCommitMessage(plan(), DIRECT, ['no colon here']), /Key: Value/);
});

test('approveCommitMessage: empty feature throws', () => {
  assert.throws(() => approveCommitMessage(plan(), { ...DIRECT, feature: '' }), /feature/);
  assert.throws(() => approveCommitMessage(plan(), { ...DIRECT, feature: undefined }), /feature/);
});

// ── reviewCommitMessage ──────────────────────────────────────────────────────

test('reviewCommitMessage: shape with issue and trailers', () => {
  const msg = reviewCommitMessage(plan({ header: ['Issue: 7'] }),
    { feature: 'do-thing', status: 'changes-requested', reviewedBy: 'arch' }, ['Refs: #7']);
  assert.equal(msg, [
    'review: do-thing changes-requested',
    '',
    'Plan: .agents/plans/do-thing.md',
    'Issue: 7',
    'Reviewed-By: arch',
    '',
    'Refs: #7',
  ].join('\n'));
});

test('reviewCommitMessage: no issue omits the line; invalid trailer and empty feature throw', () => {
  const opts = { feature: 'do-thing', status: 'rejected', reviewedBy: 'arch' };
  assert.doesNotMatch(reviewCommitMessage(plan(), opts), /Issue:/);
  assert.throws(() => reviewCommitMessage(plan(), opts, ['Bad Key: v']), /trailer key/);
  assert.throws(() => reviewCommitMessage(plan(), { ...opts, feature: '  ' }), /feature/);
});

// ── setPlanStatus ────────────────────────────────────────────────────────────

test('setPlanStatus: replaces the header Status: line', () => {
  const out = setPlanStatus(plan(), 'approved');
  assert.match(out, /^# Plan: Do the Thing\nStatus: approved\n/);
  assert.doesNotMatch(out, /pending-review/);
});

test('setPlanStatus: missing Status: is inserted after Author:', () => {
  const text = '# Plan: X\nAuthor: dev\nIssue: 1\n\n## Context\nx\n';
  assert.equal(setPlanStatus(text, 'approved'), '# Plan: X\nAuthor: dev\nStatus: approved\nIssue: 1\n\n## Context\nx\n');
});

test('setPlanStatus: no Status: and no Author: → inserted after the title', () => {
  const text = '# Plan: X\nIssue: 1\n\n## Context\n';
  assert.equal(setPlanStatus(text, 'rejected'), '# Plan: X\nStatus: rejected\nIssue: 1\n\n## Context\n');
});

test('setPlanStatus: Status: inside a fenced block below the header is untouched', () => {
  const body = '\n## Example\n```md\nStatus: pending-review\n```\nStatus: draft\n';
  const text = `# Plan: X\nAuthor: dev\n${body}`;
  assert.equal(setPlanStatus(text, 'approved'), `# Plan: X\nAuthor: dev\nStatus: approved\n${body}`);
});

test('setPlanStatus: empty or multi-line status throws', () => {
  assert.throws(() => setPlanStatus(plan(), ''), /non-empty/);
  assert.throws(() => setPlanStatus(plan(), '   '), /non-empty/);
  assert.throws(() => setPlanStatus(plan(), 'a\nb'), /single line/);
});

test('setPlanStatus: no anchor line throws', () => {
  assert.throws(() => setPlanStatus('Issue: 1\n\n## Context\n', 'approved'), /anchor/);
});
