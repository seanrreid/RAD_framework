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
const TOOL_NEUTRAL_SKILLS = ['rad-plan', 'rad-adopt', 'rad-approve'];

// Claude-only syntax, Claude tool names, and raw state-changing commands that
// a tool-neutral body must route through the rad CLI instead.
const FORBIDDEN_PATTERNS = [
  '$ARGUMENTS', 'Explore', 'Files Claude',
  'git add', 'git commit', 'git push', 'git checkout',
  'rad-label.sh', 'scripts/checkout-plan.sh',
];

const PLAN_OPEN_CALL = 'node harness/cli.js plan-open';
const CLAUDE_ARGS_TOKEN = '$ARGUMENTS';
const IMPLICIT_INVOCATION_OFF = 'allow_implicit_invocation: false';

// The rad CLI calls each tool-neutral Codex body must make. Every
// TOOL_NEUTRAL_SKILLS entry needs one (guarded below).
const REQUIRED_COMMANDS = {
  'rad-plan': [PLAN_OPEN_CALL],
  'rad-adopt': [PLAN_OPEN_CALL],
  'rad-approve': [
    'node harness/cli.js approve',
    'node harness/cli.js plan-status',
    'node harness/cli.js checkout',
  ],
};

// Claude command role directory per skill; skills not listed are team commands.
const CLAUDE_COMMAND_ROLE = { 'rad-approve': 'architect' };
const DEFAULT_COMMAND_ROLE = 'team';

const codexBodyPath = (skill) => join('.agents', 'skills', skill, 'SKILL.md');
const codexOpenaiYamlPath = (skill) => join('.agents', 'skills', skill, 'agents', 'openai.yaml');
const claudeCommandPath = (skill) =>
  join('.claude', 'commands', CLAUDE_COMMAND_ROLE[skill] ?? DEFAULT_COMMAND_ROLE, `${skill}.md`);

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
  assert.deepEqual(forbiddenPatternsIn('bash scripts/checkout-plan.sh foo'), ['scripts/checkout-plan.sh']);
});

test('every tool-neutral skill declares its required rad CLI commands', () => {
  const missing = TOOL_NEUTRAL_SKILLS.filter(
    (skill) => !Array.isArray(REQUIRED_COMMANDS[skill]) || REQUIRED_COMMANDS[skill].length === 0,
  );
  assert.deepEqual(missing, [], 'TOOL_NEUTRAL_SKILLS entries without a REQUIRED_COMMANDS entry');
});

test('rad-approve: Codex openai.yaml disables implicit invocation', () => {
  const relPath = codexOpenaiYamlPath('rad-approve');
  const yaml = readGenerated(relPath);
  assert.ok(yaml.includes(IMPLICIT_INVOCATION_OFF), `${relPath} lacks \`${IMPLICIT_INVOCATION_OFF}\``);
});

for (const skill of TOOL_NEUTRAL_SKILLS) {
  test(`${skill}: Codex body is generated, calls its rad CLI commands, and is tool-neutral`, () => {
    const body = readGenerated(codexBodyPath(skill));
    assert.ok(body.includes(GENERATED_MARKER), `${codexBodyPath(skill)} lacks the generated marker`);
    for (const command of REQUIRED_COMMANDS[skill] ?? []) {
      assert.ok(body.includes(command), `${codexBodyPath(skill)} does not call \`${command}\``);
    }
    assert.deepEqual(forbiddenPatternsIn(body), [], `${codexBodyPath(skill)} contains forbidden patterns`);
  });

  test(`${skill}: Claude command is generated and keeps $ARGUMENTS`, () => {
    const command = readGenerated(claudeCommandPath(skill));
    assert.ok(command.includes(GENERATED_MARKER), `${claudeCommandPath(skill)} lacks the generated marker`);
    assert.ok(command.includes(CLAUDE_ARGS_TOKEN), `${claudeCommandPath(skill)} lacks ${CLAUDE_ARGS_TOKEN}`);
  });
}
