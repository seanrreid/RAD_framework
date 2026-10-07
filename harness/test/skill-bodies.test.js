// Tool-neutrality checks on the generated skill bodies: the Codex body must be
// free of Claude-only syntax and raw git/label commands (it calls the rad CLI
// instead), while the generated Claude command keeps its $ARGUMENTS wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATED_MARKER } from '../generate.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Skills whose generated Codex bodies must be tool-neutral. Later parts extend this list.
const TOOL_NEUTRAL_SKILLS = ['rad-plan', 'rad-adopt'];

// Claude-only syntax, Claude tool names, and raw state-changing commands that
// a tool-neutral body must route through the rad CLI instead.
const FORBIDDEN_PATTERNS = [
  '$ARGUMENTS', 'Explore', 'Files Claude',
  'git add', 'git commit', 'git push', 'git checkout',
  'rad-label.sh',
];

const PLAN_OPEN_CALL = 'node harness/cli.js plan-open';
const CLAUDE_ARGS_TOKEN = '$ARGUMENTS';

const codexBodyPath = (skill) => join('.agents', 'skills', skill, 'SKILL.md');
const claudeCommandPath = (skill) => join('.claude', 'commands', 'team', `${skill}.md`);

// Pure predicate: the forbidden patterns present in text (empty when neutral).
function forbiddenPatternsIn(text) {
  return FORBIDDEN_PATTERNS.filter((pattern) => text.includes(pattern));
}

function readGenerated(relPath) {
  const abs = join(REPO_ROOT, relPath);
  assert.ok(existsSync(abs), `generated file missing: ${relPath} — run \`node harness/cli.js generate\``);
  return readFileSync(abs, 'utf8');
}

test('forbiddenPatternsIn is not vacuous: fixtures with forbidden text fail it', () => {
  assert.deepEqual(forbiddenPatternsIn('then run git commit -m "x"'), ['git commit']);
  assert.deepEqual(forbiddenPatternsIn('Use $ARGUMENTS as the feature'), ['$ARGUMENTS']);
  assert.deepEqual(forbiddenPatternsIn(''), []);
  assert.deepEqual(forbiddenPatternsIn(`run ${PLAN_OPEN_CALL} <feature>`), []);
});

for (const skill of TOOL_NEUTRAL_SKILLS) {
  test(`${skill}: Codex body is generated, calls plan-open, and is tool-neutral`, () => {
    const body = readGenerated(codexBodyPath(skill));
    assert.ok(body.includes(GENERATED_MARKER), `${codexBodyPath(skill)} lacks the generated marker`);
    assert.ok(body.includes(PLAN_OPEN_CALL), `${codexBodyPath(skill)} does not call \`${PLAN_OPEN_CALL}\``);
    assert.deepEqual(forbiddenPatternsIn(body), [], `${codexBodyPath(skill)} contains forbidden patterns`);
  });

  test(`${skill}: Claude command is generated and keeps $ARGUMENTS`, () => {
    const command = readGenerated(claudeCommandPath(skill));
    assert.ok(command.includes(GENERATED_MARKER), `${claudeCommandPath(skill)} lacks the generated marker`);
    assert.ok(command.includes(CLAUDE_ARGS_TOKEN), `${claudeCommandPath(skill)} lacks ${CLAUDE_ARGS_TOKEN}`);
  });
}
