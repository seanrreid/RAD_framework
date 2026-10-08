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
