// The /rad-review exercise step: both review bodies call `rad exercise`, honor
// --no-exercise and RAD_EXERCISE_BLOCKING, never touch the approval gate, and
// only the Claude body persists findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const CLAUDE_BODY = read('.claude/commands/team/rad-review.md');
const CODEX_SOURCE = read('.rad/skills/rad-review/SKILL.md');
const CODEX_GENERATED = read('.agents/skills/rad-review/SKILL.md');
const BODIES = { claude: CLAUDE_BODY, codexSource: CODEX_SOURCE, codexGenerated: CODEX_GENERATED };

// Invocations only: the Claude body may mention `rad approve` in prose.
const APPROVAL_CALLS = [/cli\.js (gate|approve|record-approval)\b/, /^\s*rad (gate|approve)\b/m, /record-approval/];

for (const [name, body] of Object.entries(BODIES)) {
  test(`${name} body calls rad exercise with its flag and blocking switch`, () => {
    assert.match(body, /harness\/cli\.js exercise/);
    assert.ok(body.includes('--no-exercise'));
    assert.ok(body.includes('RAD_EXERCISE_BLOCKING'));
  });

  test(`${name} body makes no gate or approval call`, () => {
    for (const re of APPROVAL_CALLS) assert.doesNotMatch(body, re);
  });
}

test('Claude body persists exercise findings and the cycle exercise field', () => {
  assert.ok(CLAUDE_BODY.includes('reviewer: "exercise"'));
  assert.match(CLAUDE_BODY, /"exercise":\{"ran":/);
  assert.ok(CLAUDE_BODY.includes('ran: false'));
});

test('Codex source is read-only: no persistence, no cycle field, no rad review call', () => {
  assert.match(CODEX_SOURCE, /Never write `\.agents\/findings\.jsonl`/);
  assert.doesNotMatch(CODEX_SOURCE, /reviewer: "exercise"/);
  assert.doesNotMatch(CODEX_SOURCE, /"exercise":\{/);
  assert.doesNotMatch(CODEX_SOURCE, /cli\.js review/);
  assert.doesNotMatch(CODEX_SOURCE, /append to `?\.agents\/findings\.jsonl/i);
});

test('Codex source uses {{args}} and the generated body has no $ARGUMENTS', () => {
  assert.ok(CODEX_SOURCE.includes('{{args}}'));
  assert.ok(!CODEX_GENERATED.includes('$ARGUMENTS'));
});

test('Codex body reports a Behavioral Exercise section', () => {
  assert.ok(CODEX_SOURCE.includes('Behavioral Exercise'));
});
