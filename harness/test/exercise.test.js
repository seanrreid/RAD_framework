import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExerciseBlock } from '../exercise.js';

const CRITERIA = '## Acceptance Criteria\n1. **One.** first\n2. **Two.** second\n\n';

function plan(exercise) {
  return `# Plan\n\n${CRITERIA}## Exercise\n${exercise}\n## Agent Scope\nnot part of the block\nLaunch: \`nope\`\n`;
}

test('parses a full block', () => {
  const b = parseExerciseBlock(plan(
    'Launch: `npm start`\nDrive: open the page\nObserve (AC#1): a heading shows\nObserve (AC#2): a button works\nTeardown: `rm -f x`\n',
  ));
  assert.equal(b.present, true);
  assert.equal(b.launch, 'npm start');
  assert.equal(b.teardown, 'rm -f x');
  assert.equal(b.drive, 'open the page');
  assert.deepEqual(b.observes, [
    { ac: 1, text: 'a heading shows' },
    { ac: 2, text: 'a button works' },
  ]);
  assert.deepEqual(b.warnings, []);
});

test('empty and non-string input yield an absent block without throwing', () => {
  for (const input of ['', undefined, null, 42, {}, []]) {
    const b = parseExerciseBlock(input);
    assert.equal(b.present, false);
    assert.deepEqual(b.warnings, []);
    assert.deepEqual(b.observes, []);
  }
});

test('a plan with no Exercise section has no warnings', () => {
  const b = parseExerciseBlock(`# Plan\n\n${CRITERIA}## Scope\nx\n`);
  assert.equal(b.present, false);
  assert.deepEqual(b.warnings, []);
});

test('a block with only Drive is absent and warns it will be skipped', () => {
  const b = parseExerciseBlock(plan('Drive: just click around\n'));
  assert.equal(b.present, false);
  assert.equal(b.drive, 'just click around');
  assert.equal(b.warnings.length, 1);
  assert.match(b.warnings[0], /will be skipped/);
});

test('an Observe with no AC records ac null and warns', () => {
  const b = parseExerciseBlock(plan('Observe: something happens\n'));
  assert.equal(b.present, true);
  assert.deepEqual(b.observes, [{ ac: null, text: 'something happens' }]);
  assert.match(b.warnings.join('\n'), /no \(AC#N\)/);
});

test('an AC number absent from the plan warns', () => {
  const b = parseExerciseBlock(plan('Observe (AC#9): ghost\n'));
  assert.equal(b.present, true);
  assert.match(b.warnings.join('\n'), /AC#9/);
});

test('an unknown key warns', () => {
  const b = parseExerciseBlock(plan('Wait: 5s\nObserve (AC#1): ok\n'));
  assert.equal(b.present, true);
  assert.equal(b.warnings.length, 1);
  assert.match(b.warnings[0], /unknown key "Wait:"/);
});

test('the block ends at the next ## heading', () => {
  const b = parseExerciseBlock(plan('Observe (AC#1): ok\n'));
  assert.equal(b.launch, null);
  assert.equal(b.observes.length, 1);
});

test('a #### sub-heading stays inside the block', () => {
  const b = parseExerciseBlock(plan('Launch: `a`\n#### Notes\nObserve (AC#1): after the subheading\n'));
  assert.equal(b.launch, 'a');
  assert.equal(b.observes.length, 1);
});

test('CRLF line endings parse the same', () => {
  const text = plan('Launch: `npm start`\nObserve (AC#1): ok\n').replace(/\n/g, '\r\n');
  const b = parseExerciseBlock(text);
  assert.equal(b.launch, 'npm start');
  assert.deepEqual(b.observes, [{ ac: 1, text: 'ok' }]);
  assert.deepEqual(b.warnings, []);
});

test('an empty Launch or Teardown warns and stays null', () => {
  const b = parseExerciseBlock(plan('Launch:\nTeardown: ``\nObserve (AC#1): ok\n'));
  assert.equal(b.launch, null);
  assert.equal(b.teardown, null);
  assert.equal(b.warnings.length, 2);
});

test('prose lines with colons that are not Key: lines are ignored', () => {
  const b = parseExerciseBlock(plan('see http://x.y for more: info\nObserve (AC#1): ok\n'));
  assert.deepEqual(b.warnings, []);
});
