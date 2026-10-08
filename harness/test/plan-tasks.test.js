import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFileLine, taskFilesFromPlanText, mergeTaskFiles, taskFilesByWave, taskBlocksByWave } from '../plan-tasks.js';

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

test('taskBlocksByWave reads wave type from the heading, defaulting to sequential', () => {
  const text = '### Wave 1 — Parallel\n#### Task 1.1: A\n### Wave 2 — Wiring\n#### Task 2.1: B\n';
  const byWave = taskBlocksByWave(text);
  assert.deepEqual([...byWave.keys()], [1, 2]);
  assert.equal(byWave.get(1).type, 'parallel');
  assert.equal(byWave.get(2).type, 'sequential');
});

test('taskBlocksByWave collects several tasks per wave with all fields', () => {
  const text = [
    '### Wave 1 — sequential',
    '#### Task 1.1: First', 'File: a.js:1-10, b.js', 'What: do a', 'Validate: test a',
    '#### Task 1.2: Second', 'File: `c.js`', 'What: do c', 'Validate: test c',
  ].join('\n');
  assert.deepEqual(taskBlocksByWave(text).get(1), {
    type: 'sequential',
    tasks: [
      { title: 'First', files: ['a.js', 'b.js'], what: 'do a', validate: 'test a' },
      { title: 'Second', files: ['c.js'], what: 'do c', validate: 'test c' },
    ],
  });
});

test('taskBlocksByWave keeps multi-line What and Validate, including bullet lines', () => {
  const text = [
    '### Wave 1', '#### Task 1.1: Multi', 'File: a.js',
    'What: Write the parser.', '- (a) handle waves', '- (b) handle tasks', '',
    'Validate: AC#1 —', '  `node --test x.js` passes', '', '## Tests to Write', 'not part of it',
  ].join('\n');
  const [task] = taskBlocksByWave(text).get(1).tasks;
  assert.equal(task.what, 'Write the parser.\n- (a) handle waves\n- (b) handle tasks');
  assert.equal(task.validate, 'AC#1 —\n  `node --test x.js` passes');
});

test('taskBlocksByWave: a task with no File: line gets files [] and missing fields are empty', () => {
  const text = '### Wave 1\n#### Task 1.1: Bare\nWhat: only what\n#### Task 1.2: Empty\n';
  assert.deepEqual(taskBlocksByWave(text).get(1).tasks, [
    { title: 'Bare', files: [], what: 'only what', validate: '' },
    { title: 'Empty', files: [], what: '', validate: '' },
  ]);
});

test('taskBlocksByWave counts only the first File: line per task', () => {
  const text = '### Wave 1\n#### Task 1.1: A\nFile: a.js\nWhat: x\nFile: b.js\n';
  assert.deepEqual(taskBlocksByWave(text).get(1).tasks[0].files, ['a.js']);
});

test('taskBlocksByWave ignores tasks before any wave heading', () => {
  const text = '#### Task 0.1: Stray\nFile: stray.js\nWhat: stray\n### Wave 1\n#### Task 1.1: A\nWhat: a\n';
  const byWave = taskBlocksByWave(text);
  assert.deepEqual([...byWave.keys()], [1]);
  assert.deepEqual(byWave.get(1).tasks.map((t) => t.title), ['A']);
});

test('taskBlocksByWave maps a wave heading with no tasks to tasks []', () => {
  const text = '### Wave 1 — parallel\nSome prose.\n### Wave 2\n#### Task 2.1: B\nWhat: b\n';
  const byWave = taskBlocksByWave(text);
  assert.deepEqual(byWave.get(1), { type: 'parallel', tasks: [] });
  assert.equal(byWave.get(2).tasks.length, 1);
});

test('taskBlocksByWave on empty text → empty Map', () => {
  assert.deepEqual(taskBlocksByWave(''), new Map());
});

test('taskBlocksByWave non-string input → TypeError', () => {
  for (const bad of [undefined, null, 42, {}, ['### Wave 1']]) {
    assert.throws(() => taskBlocksByWave(bad), TypeError);
  }
});

test('taskBlocksByWave parses the wave-task-prompts plan: 4 waves, 1 full task each', () => {
  const planUrl = new URL('../../.agents/plans/wave-task-prompts.md', import.meta.url);
  const byWave = taskBlocksByWave(readFileSync(planUrl, 'utf8'));
  assert.deepEqual([...byWave.keys()], [1, 2, 3, 4]);
  for (const [n, wave] of byWave) {
    assert.equal(wave.tasks.length, 1, `wave ${n} task count`);
    const [task] = wave.tasks;
    assert.ok(task.title && task.what && task.validate, `wave ${n} task has title/what/validate`);
    assert.ok(task.files.length > 0, `wave ${n} task has files`);
  }
});
