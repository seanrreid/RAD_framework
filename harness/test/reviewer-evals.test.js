import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIORITY_RANK,
  REVIEW_INSTRUCTION,
  stripFrontmatter,
  buildReviewPrompt,
  parseFindings,
  judgeTrial,
  judgeMajority,
  readExpect,
  buildReviewRepo,
} from '../evals/reviewers/lib.js';

const AGENT_MD = '---\nname: quality-reviewer\ntools: Read, Bash\n---\n\n# quality-reviewer\n\nBody text.\n';
const FENCE = '````';
const block = (json) => `${FENCE}rad-findings\n${json}\n${FENCE}`;
const parsedWith = (...findings) => ({ reviewer: 'r', findings, summary: {} });
const finding = (priority, category = 'security') => ({ priority, category, file: 'a.js', line: 1, issue: 'x' });
const positive = (minPriority, category = 'security') => ({ kind: 'positive', category, minPriority });
const NEGATIVE = { kind: 'negative' };

test('PRIORITY_RANK orders HIGH > MEDIUM > LOW', () => {
  assert.deepEqual(PRIORITY_RANK, { HIGH: 3, MEDIUM: 2, LOW: 1 });
});

test('stripFrontmatter removes the leading block and tolerates non-strings', () => {
  assert.equal(stripFrontmatter(AGENT_MD), '\n# quality-reviewer\n\nBody text.\n');
  assert.equal(stripFrontmatter('# no frontmatter\n'), '# no frontmatter\n');
  assert.equal(stripFrontmatter(''), '');
  assert.equal(stripFrontmatter(undefined), '');
  assert.equal(stripFrontmatter(42), '');
});

test('buildReviewPrompt carries the agent body without frontmatter plus the instruction', () => {
  const prompt = buildReviewPrompt(AGENT_MD);
  assert.ok(prompt.includes('# quality-reviewer\n\nBody text.'));
  assert.ok(!prompt.includes('tools: Read, Bash'));
  assert.ok(prompt.includes(REVIEW_INSTRUCTION));
  assert.ok(prompt.includes('git diff main...HEAD'));
  assert.equal(buildReviewPrompt(AGENT_MD), prompt, 'deterministic');
});

test('parseFindings: last block wins over an earlier one', () => {
  const out = `${block('{"reviewer":"a","findings":[]}')}\ntext\n${block('{"reviewer":"b","findings":[{"priority":"LOW"}]}')}\n`;
  const parsed = parseFindings(out);
  assert.equal(parsed.reviewer, 'b');
  assert.equal(parsed.findings.length, 1);
});

test('parseFindings: missing, garbled, non-object, non-array findings → null', () => {
  assert.equal(parseFindings('no block here'), null);
  assert.equal(parseFindings(''), null);
  assert.equal(parseFindings(null), null);
  assert.equal(parseFindings(block('{"reviewer": oops')), null);
  assert.equal(parseFindings(block('[1,2]')), null);
  assert.equal(parseFindings(block('"str"')), null);
  assert.equal(parseFindings(block('{"findings":"none"}')), null);
  assert.equal(parseFindings(`${block('{"findings":[]}')}\n${block('garbled')}`), null, 'last block garbled → null');
});

test('judgeTrial positive: threshold checks', () => {
  assert.equal(judgeTrial(positive('HIGH'), parsedWith(finding('MEDIUM'))), 'fail');
  assert.equal(judgeTrial(positive('MEDIUM'), parsedWith(finding('HIGH'))), 'pass');
  assert.equal(judgeTrial(positive('MEDIUM'), parsedWith(finding('MEDIUM'))), 'pass');
  assert.equal(judgeTrial(positive('MEDIUM'), parsedWith(finding('LOW'))), 'fail');
  assert.equal(judgeTrial(positive('LOW'), parsedWith(finding('LOW'))), 'pass');
  assert.equal(judgeTrial(positive('LOW'), parsedWith(finding('bogus'))), 'fail');
  assert.equal(judgeTrial(positive('HIGH'), parsedWith()), 'fail');
});

test('judgeTrial positive: category string/array match, wrong category fails', () => {
  const arr = positive('MEDIUM', ['error-handling', 'security']);
  assert.equal(judgeTrial(arr, parsedWith(finding('HIGH', 'security'))), 'pass');
  assert.equal(judgeTrial(arr, parsedWith(finding('HIGH', 'naming'))), 'fail');
  assert.equal(judgeTrial(positive('LOW'), parsedWith(finding('HIGH', 'naming'))), 'fail');
  assert.equal(judgeTrial(positive('LOW'), parsedWith(null, finding('LOW'))), 'pass', 'null finding skipped');
});

test('judgeTrial: null parsed or malformed expect → invalid', () => {
  assert.equal(judgeTrial(positive('HIGH'), null), 'invalid');
  assert.equal(judgeTrial(NEGATIVE, null), 'invalid');
  assert.equal(judgeTrial(null, parsedWith()), 'invalid');
  assert.equal(judgeTrial({ kind: 'positive', category: 'security' }, parsedWith()), 'invalid');
  assert.equal(judgeTrial({ kind: 'positive', category: [], minPriority: 'LOW' }, parsedWith()), 'invalid');
  assert.equal(judgeTrial({ kind: 'maybe' }, parsedWith()), 'invalid');
});

test('judgeTrial negative: only LOW passes, any MEDIUM/HIGH fails', () => {
  assert.equal(judgeTrial(NEGATIVE, parsedWith()), 'pass');
  assert.equal(judgeTrial(NEGATIVE, parsedWith(finding('LOW'), finding('LOW'))), 'pass');
  assert.equal(judgeTrial(NEGATIVE, parsedWith(finding('LOW'), finding('MEDIUM'))), 'fail');
  assert.equal(judgeTrial(NEGATIVE, parsedWith(finding('HIGH'))), 'fail');
});

test('judgeMajority: strict majority of passes', () => {
  assert.equal(judgeMajority(['pass', 'pass', 'fail'], 3), 'pass');
  assert.equal(judgeMajority(['pass', 'fail', 'fail'], 3), 'fail');
  assert.equal(judgeMajority(['pass', 'pass', 'invalid'], 3), 'pass');
  assert.equal(judgeMajority(['pass', 'invalid', 'invalid'], 3), 'fail');
  assert.equal(judgeMajority([], 0), 'fail');
  assert.equal(judgeMajority(null, 3), 'fail');
});

test('readExpect parses expect.json and throws a named error when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rad-reviewer-expect-'));
  try {
    assert.throws(() => readExpect(dir), { name: 'FixtureExpectError' });
    writeFileSync(join(dir, 'expect.json'), '{ nope');
    assert.throws(() => readExpect(dir), { name: 'FixtureExpectError' });
    writeFileSync(join(dir, 'expect.json'), JSON.stringify(NEGATIVE));
    assert.deepEqual(readExpect(dir), NEGATIVE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildReviewRepo: review branch diff lists only the change tree; cleanup removes it', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'rad-reviewer-fixture-'));
  try {
    mkdirSync(join(fixture, 'base'));
    mkdirSync(join(fixture, 'change'));
    writeFileSync(join(fixture, 'base', 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(fixture, 'change', 'b.js'), 'export const b = 2;\n');
    const { root, cleanup } = buildReviewRepo(fixture);
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
    assert.equal(git('diff', 'main...review', '--name-only'), 'b.js');
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'review');
    assert.ok(existsSync(join(root, 'CLAUDE.md')));
    assert.ok(existsSync(join(root, 'a.js')));
    cleanup();
    assert.ok(!existsSync(root));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
