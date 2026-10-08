import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileLine, taskFilesFromPlanText, mergeTaskFiles, taskFilesByWave } from '../plan-tasks.js';

test('parseFileLine splits on , ; and " + "', () => {
  assert.deepEqual(parseFileLine('File: a.js, b.js; c/d.md + e.ts'), ['a.js', 'b.js', 'c/d.md', 'e.ts']);
});

test('parseFileLine strips :lines and :+N suffixes', () => {
  assert.deepEqual(parseFileLine('File: a.js:10-20, b.md:+5, c.js:1,2'), ['a.js', 'b.md', 'c.js']);
});

test('parseFileLine strips backticks', () => {
  assert.deepEqual(parseFileLine('File: `harness/x.js:1-60`, `y.md`'), ['harness/x.js', 'y.md']);
});

test('parseFileLine drops parenthetical prose fragments', () => {
  assert.deepEqual(parseFileLine('File: a.js:10-20; b.md (throughout); (see notes)'), ['a.js', 'b.md']);
});

test('parseFileLine on a line with no path-like tokens → []', () => {
  assert.deepEqual(parseFileLine('File: none'), []);
});

test('taskFilesFromPlanText maps a header to its File: paths', () => {
  const text = '#### Task 1.1: Do thing\nWhat: stuff\nFile: a.js, b.md\n';
  assert.deepEqual(taskFilesFromPlanText(text), { 'Do thing': ['a.js', 'b.md'] });
});

test('header with no File: line is ignored', () => {
  assert.deepEqual(taskFilesFromPlanText('#### Task 1.1: Orphan\nWhat: nothing\n'), {});
});

test('a # line resets the title before File:', () => {
  const text = '#### Task 1.1: Reset me\n### Wave 2\nFile: a.js\n';
  assert.deepEqual(taskFilesFromPlanText(text), {});
});

test('only the first File: line after a header counts', () => {
  const text = '#### Task 1.1: T\nFile: a.js\nFile: b.js\n';
  assert.deepEqual(taskFilesFromPlanText(text), { T: ['a.js'] });
});

test('repeated title in one text merges deduped', () => {
  const text = '#### Task 1.1: T\nFile: a.js, a.js:1-2\n#### Task 2.1: T\nFile: a.js, b.js\n';
  assert.deepEqual(taskFilesFromPlanText(text), { T: ['a.js', 'b.js'] });
});

test('empty text → {}', () => {
  assert.deepEqual(taskFilesFromPlanText(''), {});
});

test('non-string input → {}', () => {
  for (const bad of [undefined, null, 42, {}, ['File: a.js']]) {
    assert.deepEqual(taskFilesFromPlanText(bad), {});
  }
});

test('mergeTaskFiles unions across plan texts, deduped', () => {
  const merged = mergeTaskFiles(
    taskFilesFromPlanText('#### Task 1.1: T\nFile: a.js\n'),
    taskFilesFromPlanText('#### Task 3.2: T\nFile: a.js; c.js\n#### Task 3.3: U\nFile: d.js\n'),
  );
  assert.deepEqual(merged, { T: ['a.js', 'c.js'], U: ['d.js'] });
});

test('taskFilesByWave groups File: paths under two waves', () => {
  const text = [
    '### Wave 1 — Parse', '#### Task 1.1: A', 'File: a.js:1-10', '#### Task 1.2: B', 'File: b.js',
    '### Wave 2', '#### Task 2.1: C', 'File: `c.js`',
  ].join('\n');
  assert.deepEqual(taskFilesByWave(text), new Map([[1, ['a.js', 'b.js']], [2, ['c.js']]]));
});

test('taskFilesByWave keeps every path of a multi-file task, deduped', () => {
  const text = '### Wave 1\n#### Task 1.1: A\nFile: a.js:1-5, test/a.test.js (append); a.js\n';
  assert.deepEqual(taskFilesByWave(text), new Map([[1, ['a.js', 'test/a.test.js']]]));
});

test('taskFilesByWave ignores tasks before any wave heading', () => {
  const text = '#### Task 0.1: Stray\nFile: stray.js\n### Wave 1\n#### Task 1.1: A\nFile: a.js\n';
  assert.deepEqual(taskFilesByWave(text), new Map([[1, ['a.js']]]));
});

test('taskFilesByWave counts only the first File: line per task', () => {
  const text = '### Wave 1\n#### Task 1.1: A\nFile: a.js\nFile: b.js\n';
  assert.deepEqual(taskFilesByWave(text), new Map([[1, ['a.js']]]));
});

test('taskFilesByWave maps a wave whose tasks have no File: line to []', () => {
  const text = '### Wave 1\n#### Task 1.1: A\nWhat: x\n### Wave 2\n#### Task 2.1: B\nFile: b.js\n';
  assert.deepEqual(taskFilesByWave(text), new Map([[1, []], [2, ['b.js']]]));
});

test('taskFilesByWave: a # line ends the task before File:', () => {
  const text = '### Wave 1\n#### Task 1.1: A\n##### Notes\nFile: a.js\n';
  assert.deepEqual(taskFilesByWave(text), new Map([[1, []]]));
});

test('taskFilesByWave on empty text → empty Map', () => {
  assert.deepEqual(taskFilesByWave(''), new Map());
});

test('taskFilesByWave non-string input → TypeError', () => {
  for (const bad of [undefined, null, 42, {}, ['### Wave 1']]) {
    assert.throws(() => taskFilesByWave(bad), TypeError);
  }
});
