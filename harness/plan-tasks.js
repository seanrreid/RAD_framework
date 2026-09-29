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
