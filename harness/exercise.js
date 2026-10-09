// `rad exercise` — runs a plan's optional `## Exercise` block against the built
// branch. This file holds the pure block parser; it does no I/O and never throws.
// It must not import harness/cli.js (agent resolution and config are injected).

const EXERCISE_HEADING = /^##\s+Exercise\s*$/i;
const CRITERIA_HEADING = /^##\s+Acceptance Criteria\s*$/i;
const LEVEL2_HEADING = /^##\s/;
const NUMBERED_CRITERION = /^(?:[-*]\s+)?(?:AC#)?(\d+)[.:)]\s/;
// `Key:` or `Key (qualifier):` at the start of a line, optionally bulleted.
const KEY_LINE = /^(?:[-*]\s+)?([A-Z][A-Za-z]*)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/;
const AC_REF = /^AC#(\d+)$/i;
const COMMAND_KEYS = { launch: 'launch', teardown: 'teardown' };

function emptyBlock() {
  return { present: false, launch: null, teardown: null, drive: null, observes: [], warnings: [] };
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Numbers of the plan's numbered Acceptance Criteria (`1. ...` or `- AC#1: ...`). */
function criterionNumbers(lines) {
  const numbers = new Set();
  let inCriteria = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (LEVEL2_HEADING.test(trimmed)) {
      inCriteria = CRITERIA_HEADING.test(trimmed);
      continue;
    }
    const m = inCriteria ? NUMBERED_CRITERION.exec(trimmed) : null;
    if (m) numbers.add(Number(m[1]));
  }
  return numbers;
}

/** Lines of the `## Exercise` section, or null when the plan has none. */
function exerciseLines(lines) {
  const start = lines.findIndex((l) => EXERCISE_HEADING.test(l.trim()));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (LEVEL2_HEADING.test(line.trim())) break;
    body.push(line);
  }
  return body;
}

function stripBackticks(value) {
  const m = /^`([^`]*)`$/.exec(value.trim());
  return (m ? m[1] : value).trim();
}

function recordObserve(block, qualifier, text, criteria) {
  const ref = qualifier === undefined ? null : AC_REF.exec(qualifier.trim());
  const ac = ref ? Number(ref[1]) : null;
  if (ac === null) {
    block.warnings.push(`Observe line has no (AC#N): "${text}"`);
  } else if (!criteria.has(ac)) {
    block.warnings.push(`Observe references AC#${ac}, which is not among the plan's numbered Acceptance Criteria`);
  }
  block.observes.push({ ac, text });
}

function recordKey(block, key, qualifier, value, criteria) {
  const name = key.toLowerCase();
  if (name === 'observe') return recordObserve(block, qualifier, value.trim(), criteria);
  if (name === 'drive') {
    block.drive = value.trim() || null;
  } else if (COMMAND_KEYS[name]) {
    const command = stripBackticks(value);
    if (command === '') block.warnings.push(`${key}: is empty`);
    block[COMMAND_KEYS[name]] = command || null;
  } else {
    block.warnings.push(`unknown key "${key}:" in the Exercise block`);
  }
}

/**
 * Parses the optional `## Exercise` section of a plan doc.
 * `present` is true only when at least one Observe line exists; a block without
 * one is treated as absent (and warned about). Warnings are advisory, never errors.
 *
 * @param {string} planText
 * @returns {{present: boolean, launch: string|null, teardown: string|null,
 *            drive: string|null, observes: {ac: number|null, text: string}[], warnings: string[]}}
 */
export function parseExerciseBlock(planText) {
  const block = emptyBlock();
  if (typeof planText !== 'string') return block;
  const lines = splitLines(planText);
  const body = exerciseLines(lines);
  if (body === null) return block;

  const criteria = criterionNumbers(lines);
  for (const line of body) {
    const m = KEY_LINE.exec(line.trim());
    if (m) recordKey(block, m[1], m[2], m[3], criteria);
  }
  block.present = block.observes.length > 0;
  if (!block.present) block.warnings.push('Exercise block has no Observe lines; it will be skipped');
  return block;
}
