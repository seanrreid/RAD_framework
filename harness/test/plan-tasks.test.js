import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileLine, taskFilesFromPlanText, mergeTaskFiles } from '../plan-tasks.js';

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
