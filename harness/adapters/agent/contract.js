/**
 * Provider-neutral wave contract.
 *
 * PURE module: it holds the plain-text WAVE_RESULT protocol (build the prompt,
 * extract + parse the result block, classify task statuses) plus the spine
 * reconciliation (resultToOutcome). It has NO dependency on any model SDK so it
 * can be shared by every provider adapter. The SDK-backed runner (runwave.js)
 * imports these helpers rather than owning them.
 *
 * Security: sanitizeErrorMessage strips anything that looks like a credential
 * before an error message is logged or surfaced.
 */

/**
 * Build the wave prompt string from plan state, following the exact template
 * defined in .claude/commands/team/rad-deliver.md Step 6.
 *
 * @param {Object} wave - wave descriptor from the plan
 * @param {Object} planCtx - orchestrator plan context
 * @returns {string}
 */
export function buildWavePrompt(wave, planCtx) {
  const {
    feature,
    branch,
    executionLog,
    executionNotes = {},
    acceptanceCriteria = [],
  } = planCtx;

  const { doNotTouch = [], keyFiles = [], reminders = [] } = executionNotes;
  const waveNumber = wave.n ?? wave.number ?? wave.id ?? '?';
  const waveType = wave.type ?? 'sequential';
  const tasks = wave.tasks ?? [];

  const doNotTouchBlock = doNotTouch.length
    ? doNotTouch.map((l) => `- ${l}`).join('\n')
    : '(none)';

  const keyFilesBlock = keyFiles.length
    ? keyFiles.map((l) => `- ${l}`).join('\n')
    : '(none)';

  const remindersBlock = reminders.length
    ? reminders.map((l) => `- ${l}`).join('\n')
    : '(none)';

  const acBlock = acceptanceCriteria.length
    ? acceptanceCriteria.map((ac, i) => `- AC#${i + 1}: ${ac}`).join('\n')
    : '(see plan file)';

  const taskBlocks = tasks
    .map((t, i) => {
      const num = `${waveNumber}.${i + 1}`;
      const fileList = Array.isArray(t.files) ? t.files.join(', ') : (t.file ?? '');
      return [
        `### Task ${num}: ${t.title ?? t.name ?? `Task ${num}`}`,
        fileList ? `File: ${fileList}` : '',
        t.what ? `What: ${t.what}` : '',
        t.validate ? `Validate: ${t.validate}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `You are executing Wave ${waveNumber} of a RAD delivery. Do not read files speculatively — only load what is listed below. Do not open PRs or push branches.

Branch: ${branch}
Feature: ${feature}
Execution log: ${executionLog}
Wave type: ${waveType}

## Execution Notes

### Do Not Touch
${doNotTouchBlock}

### Key Files (pre-load before starting)
${keyFilesBlock}

### Reminders
${remindersBlock}

## Guardrail Extensions

Before writing any code, complete this protocol:

1. List the file paths you expect to touch in this wave.
2. Match each path against the "Applies When" clause of each file in \`ai/extensions/\` (frontend.md, backend.md, database.md, security.md, testing.md).
3. Always load \`ai/guardrails.md\` as the baseline — no exceptions.
4. Load only the domain extensions whose "Applies When" clause matches your changed paths or the task domain. When in doubt, include the extension.
5. State the loaded extensions explicitly before writing any code.

## Acceptance Criteria
${acBlock}

## Tasks

${taskBlocks}

## For each task:
1. Load only the files listed — no additional reads
2. Implement exactly what the task describes — nothing more
3. Run the validation command
4. Self-classify the outcome before reporting:
   - AC passed → complete (or done_with_concerns if something adjacent worth noting)
   - AC failed, fixable code change → blocked_code
   - AC failed, task description ambiguous → blocked_spec
   - AC failed, plan appears wrong for codebase → blocked_intent
5. If validation passes:
   git add [changed files]
   git commit -m "deliver(${feature}): [task title]

   Wave ${waveNumber}, Task [${waveNumber}.N]
   Validated: [AC#N — validation method]"
6. Append to execution log:
   | [step#] | Wave ${waveNumber} | [task title] | ✓ complete | [commit hash] | [time] |
7. Do not continue to the next task if blocked_* — report immediately

## Return format
At the end, output exactly this block and nothing after it:

WAVE_RESULT
wave: ${waveNumber}
status: [complete | failed]
tasks:
  - title: [task title]
    status: [complete | done_with_concerns | blocked_code | blocked_spec | blocked_intent]
    commit: [hash or —]
    concern: [one-line concern if done_with_concerns, else —]
    error: [one-line summary if blocked_*, else —]
END_WAVE_RESULT`;
}

/**
 * Extract the WAVE_RESULT...END_WAVE_RESULT block from the response text.
 *
 * @param {string} text - full response text from the agent
 * @returns {string | null} the block content (without the delimiters), or null
 */
export function extractWaveResultBlock(text) {
  const start = text.indexOf('WAVE_RESULT');
  const end = text.indexOf('END_WAVE_RESULT');
  if (start === -1 || end === -1 || end <= start) return null;
  // Trim the delimiter lines themselves; return only the body
  return text.slice(start + 'WAVE_RESULT'.length, end).trim();
}

/** Valid task statuses — the five variants declared in the plan. */
export const VALID_TASK_STATUSES = new Set([
  'complete',
  'done_with_concerns',
  'blocked_code',
  'blocked_spec',
  'blocked_intent',
]);

/**
 * Parse the WAVE_RESULT body into a structured object.
 *
 * The format (from rad-deliver.md) is simple indented YAML-like text.
 * We parse it with lightweight line scanning rather than a full YAML parser
 * so there is no extra dependency and the structure stays unambiguous.
 *
 * @param {string} block - trimmed body between the delimiters
 * @returns {{ status: string, tasks: Array }}
 */
export function parseWaveResult(block) {
  const lines = block.split('\n');
  let waveStatus = 'failed';
  const tasks = [];
  let currentTask = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trimStart();

    // Top-level: "status: complete"
    if (/^status:\s/.test(trimmed) && !line.startsWith('  ') && !line.startsWith('\t')) {
      waveStatus = trimmed.replace(/^status:\s+/, '').trim();
      continue;
    }

    // Task list item: "  - title: ..."
    if (/^-\s+title:\s/.test(trimmed)) {
      if (currentTask) tasks.push(currentTask);
      currentTask = {
        title: trimmed.replace(/^-\s+title:\s+/, '').trim(),
        status: 'complete',
        commit: '—',
        concern: '—',
        error: '—',
      };
      continue;
    }

    if (currentTask) {
      if (/^\s+status:\s/.test(line)) {
        const val = trimmed.replace(/^status:\s+/, '').trim();
        currentTask.status = VALID_TASK_STATUSES.has(val) ? val : 'complete';
      } else if (/^\s+commit:\s/.test(line)) {
        currentTask.commit = trimmed.replace(/^commit:\s+/, '').trim();
      } else if (/^\s+concern:\s/.test(line)) {
        currentTask.concern = trimmed.replace(/^concern:\s+/, '').trim();
      } else if (/^\s+error:\s/.test(line)) {
        currentTask.error = trimmed.replace(/^error:\s+/, '').trim();
      }
    }
  }

  if (currentTask) tasks.push(currentTask);

  // Derive top-level status from tasks when not explicitly set
  if (waveStatus !== 'complete' && waveStatus !== 'failed') {
    waveStatus = 'failed';
  }

  return { status: waveStatus, tasks };
}

/**
 * Reconcile a parsed `{ status, tasks }` wave result into a matrix outcome
 * string the deliver spine consumes (it reads `result.outcome` and passes it to
 * resolveOutcome('implement', outcome)).
 *
 * The matrix vocabulary is fixed (see harness/matrix.yaml):
 *   success | fail-tests | fail-scope | fail-protocol | fail-timeout
 *   | no-changes | abort-user
 * This function maps only onto those existing outcomes — it never invents new
 * ones.
 *
 * Mapping:
 *   - unparseable / no tasks               → 'fail-protocol'
 *   - every task complete/done_with_concerns → 'success'
 *   - any blocked or failed task           → 'fail-tests' (generic code failure)
 *
 * @param {{ status?: string, tasks?: Array }} parsed
 * @returns {string} a matrix outcome string
 */
export function resultToOutcome(parsed) {
  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    return 'fail-protocol';
  }

  const passing = new Set(['complete', 'done_with_concerns']);
  const allPassed = parsed.tasks.every((t) => passing.has(t && t.status));

  return allPassed ? 'success' : 'fail-tests';
}

/**
 * Build a synthetic failure result when the model call itself fails.
 *
 * @param {string} waveId - wave identifier string/number for the title
 * @param {string} errorMessage - error message; must NOT contain the API key
 * @returns {{ status: string, tasks: Array }}
 */
export function syntheticFailure(waveId, errorMessage) {
  return {
    status: 'failed',
    tasks: [
      {
        title: String(waveId),
        status: 'blocked_code',
        commit: '—',
        concern: '—',
        error: errorMessage,
      },
    ],
  };
}

/**
 * Sanitize an error message so it can never leak the API key.
 *
 * We strip any 40+ character alphanumeric run (the minimum key length)
 * that looks like a credential. The replacement token is safe to log.
 *
 * @param {string} msg
 * @returns {string}
 */
export function sanitizeErrorMessage(msg) {
  // Replace anything that looks like an API key (sk-ant-… or long token)
  return msg.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
}
