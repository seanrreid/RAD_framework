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
const TOOL_NEUTRAL_SKILLS = [
  'rad-plan', 'rad-adopt', 'rad-approve', 'rad-deliver', 'rad-research', 'rad-epic-decompose',
  'rad-design', 'wrap', 'kickoff', 'rad-insights',
];

// Claude-only syntax, Claude tool names, and raw state-changing commands that
// a tool-neutral body must route through the rad CLI instead.
const FORBIDDEN_PATTERNS = [
  '$ARGUMENTS', 'Explore', 'Files Claude',
  'git add', 'git commit', 'git push', 'git checkout',
  'rad-label.sh', 'scripts/checkout-plan.sh',
];

const PLAN_OPEN_CALL = 'node harness/cli.js plan-open';
const DELIVER_CALL = 'node harness/cli.js deliver';
const CLAUDE_ARGS_TOKEN = '$ARGUMENTS';
const SOURCE_ARGS_TOKEN = '{{args}}';
const CLAUDE_SKILL_TARGET = /^\s*claude:\s*skill\s*$/m;
const IMPLICIT_INVOCATION_OFF = 'allow_implicit_invocation: false';

// The rad CLI calls (or artifact path) each tool-neutral Codex body must make. Every
// TOOL_NEUTRAL_SKILLS entry needs one (guarded below).
const REQUIRED_COMMANDS = {
  'rad-plan': [PLAN_OPEN_CALL],
  'rad-adopt': [PLAN_OPEN_CALL],
  'rad-approve': [
    'node harness/cli.js approve',
    'node harness/cli.js plan-status',
    'node harness/cli.js checkout',
  ],
  'rad-deliver': [DELIVER_CALL],
  'rad-research': ['.agents/research/'],
  'rad-epic-decompose': ['scripts/fetch-epic.sh', 'node harness/cli.js label'],
  'rad-design': ['node harness/cli.js architecture-approve', 'node harness/cli.js generate', '.rad/agents/'],
  wrap: ['node harness/cli.js wrap'],
  kickoff: ['node harness/cli.js checkout'],
  'rad-insights': ['.agents/findings.jsonl', 'scripts/draft-insights-plan.sh'],
};

// Skills whose Codex openai.yaml must keep implicit invocation off.
const EXPLICIT_ONLY_SKILLS = ['rad-approve', 'rad-deliver', 'rad-epic-decompose', 'rad-design', 'wrap', 'rad-insights'];

// The exit-3 resume contract the rad-deliver body must spell out.
const RESUME_FLAGS = '--resume --context';
const STOP_AND_ASK = /STOP and ask the user/;

// Claude command role directory per skill; skills not listed are team commands.
const CLAUDE_COMMAND_ROLE = {
  'rad-approve': 'architect', 'rad-epic-decompose': 'architect', 'rad-design': 'architect',
  'rad-insights': 'shared',
};
const DEFAULT_COMMAND_ROLE = 'team';

const codexBodyPath = (skill) => join('.agents', 'skills', skill, 'SKILL.md');
const codexOpenaiYamlPath = (skill) => join('.agents', 'skills', skill, 'agents', 'openai.yaml');
const sourcePath = (skill) => join('.rad', 'skills', skill, 'SKILL.md');
const readSource = (skill) => readFileSync(join(REPO_ROOT, sourcePath(skill)), 'utf8');
// A `claude: skill` source generates .claude/skills/<name>/SKILL.md; the rest generate role commands.
const claudeCommandPath = (skill) =>
  CLAUDE_SKILL_TARGET.test(readSource(skill))
    ? join('.claude', 'skills', skill, 'SKILL.md')
    : join('.claude', 'commands', CLAUDE_COMMAND_ROLE[skill] ?? DEFAULT_COMMAND_ROLE, `${skill}.md`);

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

for (const skill of EXPLICIT_ONLY_SKILLS) {
  test(`${skill}: Codex openai.yaml disables implicit invocation`, () => {
    const relPath = codexOpenaiYamlPath(skill);
    const yaml = readGenerated(relPath);
    assert.ok(yaml.includes(IMPLICIT_INVOCATION_OFF), `${relPath} lacks \`${IMPLICIT_INVOCATION_OFF}\``);
  });
}

test('rad-deliver: both bodies give the resume command and say to stop and ask on exit 3', () => {
  for (const relPath of [codexBodyPath('rad-deliver'), claudeCommandPath('rad-deliver')]) {
    const body = readGenerated(relPath);
    assert.ok(body.includes(RESUME_FLAGS), `${relPath} lacks \`${RESUME_FLAGS}\``);
    assert.match(body, STOP_AND_ASK, `${relPath} lacks an explicit stop-and-ask instruction`);
  }
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

  test(`${skill}: Claude output is generated and keeps $ARGUMENTS when its source uses {{args}}`, () => {
    const command = readGenerated(claudeCommandPath(skill));
    assert.ok(command.includes(GENERATED_MARKER), `${claudeCommandPath(skill)} lacks the generated marker`);
    if (readSource(skill).includes(SOURCE_ARGS_TOKEN)) {
      assert.ok(command.includes(CLAUDE_ARGS_TOKEN), `${claudeCommandPath(skill)} lacks ${CLAUDE_ARGS_TOKEN}`);
    }
  });
}

// The --playbook flag and its load step must reach every generated body of both planning skills.
const PLAYBOOK_SKILLS = ['rad-plan', 'rad-adopt'];
const PLAYBOOK_REQUIRED_TEXT = ['--playbook <kind>/<slug>[@<version>]', 'playbook check-ref', '## Playbook Deviations'];

for (const skill of PLAYBOOK_SKILLS) {
  test(`${skill}: both generated bodies document --playbook, check-ref and Playbook Deviations`, () => {
    for (const relPath of [codexBodyPath(skill), claudeCommandPath(skill)]) {
      const body = readGenerated(relPath);
      for (const text of PLAYBOOK_REQUIRED_TEXT) {
        assert.ok(body.includes(text), `${relPath} lacks \`${text}\``);
      }
    }
  });
}

// The last-wave full-suite Verify guidance must reach every generated body of both planning skills.
const VERIFY_ALL_REQUIRED_TEXT = ['Verify: exec bash scripts/verify-all.sh', 'RAD_VERIFY_TIMEOUT_SECONDS=1800'];

for (const skill of PLAYBOOK_SKILLS) {
  test(`${skill}: both generated bodies document the last-wave verify-all guidance`, () => {
    for (const relPath of [codexBodyPath(skill), claudeCommandPath(skill)]) {
      const body = readGenerated(relPath);
      for (const text of VERIFY_ALL_REQUIRED_TEXT) {
        assert.ok(body.includes(text), `${relPath} lacks \`${text}\``);
      }
    }
  });
}

// The optional ## Exercise plan section must reach every generated body of both planning skills.
for (const skill of PLAYBOOK_SKILLS) {
  test(`${skill}: both generated bodies mention the optional ## Exercise section`, () => {
    for (const relPath of [codexBodyPath(skill), claudeCommandPath(skill)]) {
      const body = readGenerated(relPath);
      assert.ok(body.includes('## Exercise'), `${relPath} lacks \`## Exercise\``);
      assert.ok(body.includes('docs/rad-cli.md'), `${relPath} lacks the docs/rad-cli.md pointer`);
    }
  });
}

// ---- rad-insights pins -----------------------------------------------------
// Strings copied byte-for-byte from the skill before the Plan F trim. The trim
// may reorganise prose but must keep every command and every rendered string.
const INSIGHTS_SKILL = 'rad-insights';

// The 12 Step 4b-4j module invocations, including prefixed forms.
const INSIGHTS_PINNED_COMMANDS = [
  'node harness/insights-usage-cost.js',
  'node harness/insights-reliability.js',
  'node harness/insights-blocked-reasons.js',
  'node harness/insights-blocked-files.js',
  'node harness/insights-wave-tiering.js',
  'node harness/insights-cache-hit.js',
  'node harness/insights-model-spend.js',
  'node harness/insights-provider-spend.js',
  'node harness/insights-prompt-surfaces.js',
  'node harness/insights-cycle-time.js',
  'DEFAULT_BRANCH="$DEFAULT_BRANCH" node harness/insights-rework-load.js',
  'SINCE="" node harness/insights-human-corrections.js',
];

// Step 5 strings rendered to the reader (multi-line strings keep source wrapping).
const INSIGHTS_PINNED_REPORT_STRINGS = [
  // Code Legibility degradation lines
  [
    'No enriched (per-task) wave events exist yet — code-legibility signals need',
    'per-task data to attribute blocked tasks to files.',
  ].join('\n'),
  [
    'No plan-doc task mappings found (no "#### Task" header + "File:" line under the',
    'plans directory) — blocked tasks cannot be attributed to files.',
  ].join('\n'),
  [
    'Insufficient history for code-legibility signals — no file has accumulated',
    'blocked tasks across at least [minFeatures] distinct features yet',
    '([belowFloor] file(s) below the floor).',
  ].join('\n'),
  // Code Legibility framing sentence
  [
    'These counts are a code-legibility signal about the named region of the codebase —',
    'repeated trouble there across unrelated features suggests the code is hard to',
    'understand or change safely — not a verdict on agent or developer performance.',
  ].join('\n'),
  // Deficit-proxy disclaimer
  [
    'These deficit labels are proxies inferred from wave',
    ' outcomes and task statuses, not a diagnosis of the code.',
  ].join('\n'),
  // Model Tiering degradation lines
  [
    'No wave data yet — per-wave-position reliability will populate after the first',
    '/rad-deliver run records wave-attempt events.',
  ].join('\n'),
  [
    'Insufficient history for a model-tiering advisory — [features] feature(s) have',
    'wave history; at least [minFeatures] are needed before per-position rates mean',
    'anything beyond individual plans.',
  ].join('\n'),
  // Model Tiering spend note
  [
    'The per-position rates above are outcome-only — they carry no spend. Spend-derived',
    'tiering advice lives in the Spend by model subsection below (Step 4f3), grouped by',
    'the recorded wave model. Recorded `input_tokens` is the uncached remainder, so',
    'token totals vary with cache-hit rate and scheduling — see the Cache-Hit Readout',
    'below (`cacheRead` / `cacheWrite` / `cost`, #121).',
  ].join('\n'),
  // Cache-hit degradation line
  [
    'no cache data reported — no wave attempt carried `usage.cacheRead`',
    '([withoutCache] attempt(s) without cache fields).',
  ].join('\n'),
  // Calibration malformed-JSON surfacing rule
  [
    'Any `skipping malformed JSON at <file>:<line>` stderr line MUST be surfaced in',
    '  the report under the section — the skip is never silent.',
  ].join('\n'),
];

// Returns the pinned entries a body lacks, reported by string (not by section).
function missingPins(body, pins) {
  return pins.filter((pin) => !body.includes(pin));
}

const insightsBodies = () => [
  ['source', readSource(INSIGHTS_SKILL)],
  [codexBodyPath(INSIGHTS_SKILL), readGenerated(codexBodyPath(INSIGHTS_SKILL))],
  [claudeCommandPath(INSIGHTS_SKILL), readGenerated(claudeCommandPath(INSIGHTS_SKILL))],
];

test('rad-insights: source and both generated bodies keep every pinned command and report string', () => {
  assert.equal(INSIGHTS_PINNED_COMMANDS.length, 12);
  for (const [label, body] of insightsBodies()) {
    assert.deepEqual(missingPins(body, INSIGHTS_PINNED_COMMANDS), [], `${label} lost a pinned command`);
    assert.deepEqual(missingPins(body, INSIGHTS_PINNED_REPORT_STRINGS), [], `${label} lost a pinned report string`);
  }
});

test('missingPins is not vacuous: a body missing a pinned string fails and names it', () => {
  const all = [...INSIGHTS_PINNED_COMMANDS, ...INSIGHTS_PINNED_REPORT_STRINGS];
  const full = all.join('\n\n');
  assert.deepEqual(missingPins(full, all), []);
  for (const pin of all) {
    const body = full.replace(pin, '');
    assert.deepEqual(missingPins(body, all), [pin], 'removing one pin must report exactly that pin');
  }
  assert.deepEqual(missingPins('', all), all, 'an empty body misses every pin');
  // A string present only under a different heading still counts as present (reports by string).
  const elsewhere = `### Unrelated\n${all[0]}\n`;
  assert.ok(!missingPins(elsewhere, all).includes(all[0]));
});
