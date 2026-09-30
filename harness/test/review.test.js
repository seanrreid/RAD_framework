import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, reviewInstruction } from '../review.js';
import { REVIEW_INSTRUCTION } from '../evals/reviewers/lib.js';

const LEGACY_INSTRUCTION = [
  '---', '', '## Task', '',
  'Review the changes on the current branch versus main (`git diff main...HEAD`).',
  'Follow your process above. End your response with the ````rad-findings block',
  'exactly as specified, containing every finding you report.',
].join('\n');

test('reviewInstruction default and eval REVIEW_INSTRUCTION are byte-identical to the legacy text', () => {
  assert.equal(reviewInstruction(), LEGACY_INSTRUCTION);
  assert.equal(REVIEW_INSTRUCTION, LEGACY_INSTRUCTION);
});

test('reviewInstruction interpolates a valid base ref', () => {
  const text = reviewInstruction('origin/release-1.2_x');
  assert.match(text, /versus origin\/release-1\.2_x \(`git diff origin\/release-1\.2_x\.\.\.HEAD`\)/);
});

test('reviewInstruction falls back to main for invalid bases (never throws)', () => {
  for (const bad of ['', '-rf', '--output=x', 'main; rm -rf /', 'a b', '$(x)', null, 42, {}]) {
    assert.equal(reviewInstruction(bad), LEGACY_INSTRUCTION, `base=${String(bad)}`);
  }
});

test('buildReviewPrompt threads base and defaults to main', () => {
  const md = '---\nname: x\n---\nBody\n';
  assert.equal(buildReviewPrompt(md), `Body\n\n${LEGACY_INSTRUCTION}\n`);
  assert.match(buildReviewPrompt(md, { base: 'develop' }), /git diff develop\.\.\.HEAD/);
  assert.equal(buildReviewPrompt(md, undefined), buildReviewPrompt(md));
});
