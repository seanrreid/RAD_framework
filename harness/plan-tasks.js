/**
 * Plan-task parser — maps each `#### Task N.M: <title>` in a plan doc to the
 * file paths its `File:` line declares.
 *
 * Pure and filesystem-free: callers read plan text and union results across
 * plan files with `mergeTaskFiles`. Semantics are fixed by the /rad-insights
 * Step 4e parser this module replaces — change them only with that consumer.
 */

// A task header sets the current title; the title is trimmed.
export const TASK_HEADER = /^#### Task [0-9]+\.[0-9]+:\s*(.+?)\s*$/;
// A trailing `:lines` / `:+N` locator, e.g. `a.js:10-20` or `b.md:+5`.
export const LINE_SUFFIX = /:[+0-9,-]+$/;
// Path separators on a File: line: `,`, `;`, or a space-padded ` + `.
const PATH_SEPARATOR = /[,;]|\s\+\s/;
// A token is kept only if it looks like a path (has a `.` or `/`).
const PATH_LIKE = /[./]/;
// A wave heading opens a wave scope, e.g. `### Wave 2 — Wiring`.
export const WAVE_HEADER = /^### Wave\s+(\d+)/;

/** "File: a.js:10-20; b.md (throughout)" -> ["a.js", "b.md"]; drops prose. */
export function parseFileLine(line) {
  return line.replace(/^File:\s*/, '')
    .split(PATH_SEPARATOR)
    .map((part) => part.trim().replace(/`/g, '').split(/\s+/)[0] || '')
    .map((p) => p.replace(LINE_SUFFIX, ''))
    .filter((p) => PATH_LIKE.test(p));
}

/** Union `source`'s title -> paths into `target` (deduped, order kept); returns target. */
export function mergeTaskFiles(target, source) {
  for (const [title, paths] of Object.entries(source)) {
    target[title] = [...new Set([...(target[title] || []), ...paths])];
  }
  return target;
}

/**
 * Only the FIRST `File:` line after a header counts (the title clears after
 * it); any other `#` line resets the title. Non-string input yields {}.
 */
export function taskFilesFromPlanText(text) {
  const taskFiles = {};
  if (typeof text !== 'string') return taskFiles;
  let title = null;
  for (const line of text.split('\n')) {
    const header = line.match(TASK_HEADER);
    if (header) { title = header[1]; continue; }
    if (line.startsWith('#')) { title = null; continue; }
    if (title && line.startsWith('File:')) {
      mergeTaskFiles(taskFiles, { [title]: parseFileLine(line) });
      title = null;
    }
  }
  return taskFiles;
}

/**
 * Wave number -> deduped File: paths of the tasks under each `### Wave N`
 * heading. Same per-task rule as taskFilesFromPlanText (first File: line only;
 * any other `#` line ends the task). Tasks before the first wave heading are
 * ignored; a wave whose tasks declare no File: line maps to []. Fails closed:
 * non-string input throws TypeError rather than yielding an empty (vacuous) map.
 */
export function taskFilesByWave(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`taskFilesByWave: expected plan text string, got ${text === null ? 'null' : typeof text}`);
  }
  const byWave = new Map();
  let wave = null;
  let inTask = false;
  for (const line of text.split('\n')) {
    const waveHeader = line.match(WAVE_HEADER);
    if (waveHeader) { wave = Number(waveHeader[1]); inTask = false; continue; }
    if (TASK_HEADER.test(line)) {
      inTask = wave !== null;
      if (inTask && !byWave.has(wave)) byWave.set(wave, []);
      continue;
    }
    if (line.startsWith('#')) { inTask = false; continue; }
    if (inTask && line.startsWith('File:')) {
      byWave.set(wave, [...new Set([...byWave.get(wave), ...parseFileLine(line)])]);
      inTask = false;
    }
  }
  return byWave;
}

// A wave with no `parallel`/`sequential` word in its heading runs sequentially.
export const DEFAULT_WAVE_TYPE = 'sequential';
// The wave type word, matched case-insensitively anywhere after the wave number.
const WAVE_TYPE_WORD = /\b(parallel|sequential)\b/i;
// Field labels that open a task's prose fields and its file list.
const FILE_LABEL = 'File:';
const PROSE_LABELS = { 'What:': 'what', 'Validate:': 'validate' };
// Headings that end the current task (and any open What:/Validate: field).
const TASK_END_PREFIXES = ['#### ', '### ', '## '];

/** `### Wave 2 — Parallel` -> 'parallel'; no type word -> DEFAULT_WAVE_TYPE. */
function waveTypeFrom(line, matched) {
  const word = line.slice(matched.length).match(WAVE_TYPE_WORD);
  return word ? word[1].toLowerCase() : DEFAULT_WAVE_TYPE;
}

/** The prose field key a line opens ('what' | 'validate'), or null. */
function proseLabelOf(line) {
  const label = Object.keys(PROSE_LABELS).find((l) => line.startsWith(l));
  return label ? { key: PROSE_LABELS[label], rest: line.slice(label.length) } : null;
}

/** Fold one in-task body line into `cursor` ({ task, field, filesSeen }). */
function applyTaskLine(cursor, line) {
  if (line.startsWith(FILE_LABEL)) {
    if (!cursor.filesSeen) cursor.task.files = parseFileLine(line);
    cursor.filesSeen = true;
    cursor.field = null;
    return;
  }
  const prose = proseLabelOf(line);
  if (prose) {
    cursor.field = prose.key;
    cursor.task[prose.key] = [prose.rest];
    return;
  }
  if (cursor.field) cursor.task[cursor.field].push(line);
}

/** Join a field's collected lines (or '' when the field never appeared), trimmed. */
function finishTask(task) {
  return { ...task, what: task.what.join('\n').trim(), validate: task.validate.join('\n').trim() };
}

/**
 * Wave number -> { type, tasks } where each task is { title, files, what,
 * validate } for a `#### Task N.M:` block under that `### Wave N` heading.
 * files = the task's first File: line (else []); What:/Validate: run to the next
 * field label or `## `/`### `/`#### ` heading, trimmed with line breaks kept;
 * a missing field is ''. Tasks before any wave heading are ignored; a wave with
 * no tasks maps to { type, tasks: [] }. Fails closed: non-string input throws.
 */
export function taskBlocksByWave(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`taskBlocksByWave: expected plan text string, got ${text === null ? 'null' : typeof text}`);
  }
  const byWave = new Map();
  let wave = null;
  let cursor = null;
  for (const line of text.split('\n')) {
    const waveHeader = line.match(WAVE_HEADER);
    if (waveHeader) {
      wave = { type: waveTypeFrom(line, waveHeader[0]), tasks: [] };
      byWave.set(Number(waveHeader[1]), wave);
      cursor = null;
      continue;
    }
    const taskHeader = line.match(TASK_HEADER);
    if (taskHeader) {
      const task = { title: taskHeader[1], files: [], what: [], validate: [] };
      if (wave) wave.tasks.push(task);
      cursor = wave ? { task, field: null, filesSeen: false } : null;
      continue;
    }
    if (TASK_END_PREFIXES.some((p) => line.startsWith(p))) { cursor = null; continue; }
    if (cursor) applyTaskLine(cursor, line);
  }
  for (const w of byWave.values()) w.tasks = w.tasks.map(finishTask);
  return byWave;
}
