// Characterization of the long cli.js commands (parsePlanCtx, writePlanStatus via
// approveCommand, gateCommand, architectureApproveCommand, deliverCommand).
// Every scenario's observable behaviour (exit code, ordered stdout/stderr, files
// written) is compared with harness/test/fixtures/cli-commands-golden.json, which
// was generated from the UNREFACTORED cli.js (UPDATE_GOLDEN=1) and must not be
// regenerated once a refactor of these functions begins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parsePlanCtx, approveCommand, gateCommand, architectureApproveCommand, deliverCommand,
} from '../cli.js';
import { planFingerprint } from '../plan-fingerprint.js';
import { createFixture } from '../evals/lib/fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'fixtures', 'cli-commands-golden.json');
const CLI_URL = new URL('../cli.js', import.meta.url).href;
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';
const GOLDEN = UPDATE_GOLDEN ? {} : JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
const RECORDED = {};
const REGISTERED = [];

/** Every environment variable a scenario can depend on; cleared, set per scenario, restored after. */
const SCENARIO_ENV_KEYS = [
  'RAD_WORKTREE', 'RAD_WORKTREE_DIR', 'RAD_TOKEN_BUDGET', 'RAD_AGENT', 'RAD_AGENT_CMD', 'RAD_AGENT_PREFLIGHT',
  'RAD_MAX_FAILED_ATTEMPTS', 'RAD_HOOKS_DIR', 'RAD_VERIFY_TIMEOUT_SECONDS', 'RAD_SYNC', 'RAD_BRANCH_PREFIX',
  'ANTHROPIC_API_KEY',
];
const ISO_TS = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const LONG_HEX = /\b[0-9a-f]{40,64}\b/g;
const ARCHITECT = 'architect@example.com';
const DEVELOPER = 'dev@example.com';
const FEATURE = 'char-feature';

// ---------------------------------------------------------------------------
// Harness: scenario registry, environment, output capture, normalisation
// ---------------------------------------------------------------------------

after(() => {
  if (!UPDATE_GOLDEN) return;
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(RECORDED, null, 2)}\n`, 'utf8');
});

/** Register one named scenario; its JSON-normalised result must equal the golden entry. */
function scenario(name, fn) {
  assert.ok(!REGISTERED.includes(name), `duplicate scenario ${name}`);
  REGISTERED.push(name);
  test(name, async () => {
    const actual = JSON.parse(JSON.stringify(await fn()));
    if (UPDATE_GOLDEN) { RECORDED[name] = actual; return; }
    assert.ok(Object.hasOwn(GOLDEN, name), `no golden entry for ${name}`);
    assert.deepStrictEqual(actual, GOLDEN[name]);
  });
}

async function withEnv(env, fn) {
  const saved = Object.fromEntries(SCENARIO_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SCENARIO_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run fn with both stdout and stderr captured into ONE ordered list. */
async function captureOrdered(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const output = [];
  process.stdout.write = (c) => { output.push({ stream: 'stdout', text: String(c) }); return true; };
  process.stderr.write = (c) => { output.push({ stream: 'stderr', text: String(c) }); return true; };
  try {
    return { code: await fn(), output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** A temporary directory plus the substitutions that make its paths stable. */
function makeTemp(prefix = 'rad-char-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const real = realpathSync(dir);
  const labels = [[real, '<ROOT>'], [dir, '<ROOT>']];
  return { dir: real, labels, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeNormalizer(labels) {
  const ordered = [...labels].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let s = String(text);
    for (const [from, to] of ordered) s = s.split(from).join(to);
    return s.replace(ISO_TS, '<TS>').replace(LONG_HEX, '<SHA>');
  };
}

const normalizeOutput = (output, norm) => output.map((o) => ({ stream: o.stream, text: norm(o.text) }));
const readIfExists = (file, norm) => (existsSync(file) ? norm(readFileSync(file, 'utf8')) : null);

/** Sorted relative listing of every file under dir (excluding .git), with sizes. */
function listing(dir) {
  const rows = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else rows.push(`${relative(dir, full)}:${readFileSync(full, 'utf8').length}`);
    }
  };
  walk(dir);
  return rows;
}

function writeFileDeep(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

const okSh = () => ({ status: 0, stdout: '', stderr: '' });

/** A stub sh: the git identity, role check and blocker check are scripted; everything else succeeds. */
function makeStubSh({ email = ARCHITECT, roleOk = true } = {}) {
  return (file, args = []) => {
    const f = String(file);
    if (f === 'git' && args[0] === 'config' && args[1] === 'user.email') {
      return { status: email === '' ? 1 : 0, stdout: email === '' ? '' : `${email}\n`, stderr: '' };
    }
    if (f.endsWith('check-role.sh')) {
      return roleOk ? okSh() : { status: 1, stdout: '', stderr: 'stub: not an architect\n' };
    }
    return okSh();
  };
}

// ---------------------------------------------------------------------------
// Task 1.1a — parsePlanCtx matrix (AC#2)
// ---------------------------------------------------------------------------

const lines = (...l) => `${l.join('\n')}\n`;

const WAVE_PLAN = lines(
  '# feature', 'Branch: rad/feature', 'Capabilities: fs_read, shell', '',
  '## Acceptance Criteria', '', '1. first criterion', '2. second criterion', '- AC#3: bullet is ignored', 'plain prose', '',
  '## Execution Notes', '', '### Do Not Touch', '- harness/spine.js', 'not a bullet', '- harness/gates.js', '',
  '### Key Files', '- harness/cli.js', '', '### Reminders', '- run the linter', '- keep order', '',
  '## Waves', '',
  '### Wave 1 — sequential', 'Model: claude-haiku-5-5', 'Verify: node --test a.test.js', 'Capabilities: fs_read',
  '', '#### Task 1.1: First', 'File: src/a.js', 'What: do it', 'Validate: AC#1',
  '', '#### Task 1.2: Second', 'File: tests/a.test.js:1-9', 'What: test it', '',
  '### Wave 2', 'Verify: none (nothing to run)', 'Model:   ', '',
  '#### Task 2.1: Third', 'File: src/b.js', '',
  '### Wave 3', 'Verify: first', 'Verify: second', '',
  '## Tests to Write', '',
  '- [ ] a test — tests/a.test.js', '- [ ] orphan test — tests/orphan.test.js', '- not resolvable', '',
  '## Notes', 'Model: ignored outside a wave', 'Capabilities: ignored outside a wave',
);

const PLAN_CASES = {
  empty: '',
  'no-header-prose': '# Title\n\njust prose\n',
  'branch-only': 'Branch: rad/x\n',
  'branch-indented-and-repeated': '   Branch:   rad/first  \nBranch: rad/second\n',
  'ac-section-ends-at-next-heading': lines('## Acceptance Criteria', '1. a', '2. b', '## Other', '3. c'),
  'ac-section-absent': lines('# t', '1. not in a section'),
  'ac-lines-non-numbered': lines('## Acceptance Criteria', '- AC#1: x', 'AC#2: y', '10. ten', '  7. indented'),
  'notes-all-present': lines('### Do Not Touch', '- a', '### Key Files', '- b', '- c', '### Reminders', '- d'),
  'notes-empty-subsections': lines('### Do Not Touch', '### Key Files', '### Reminders'),
  'notes-absent': lines('## Waves', '### Wave 1'),
  'notes-stop-at-deeper-heading': lines('### Reminders', '- a', '#### Sub', '- b'),
  'wave-verify-model-capabilities': WAVE_PLAN,
  'verify-none-clears-earlier': lines('### Wave 1', 'Verify: cmd', 'Verify: None', '### Wave 2', 'Verify: none'),
  'verify-empty-and-subheading': lines('### Wave 1', 'Verify:', '#### Task 1.1: t', 'Verify: inside', '## End', 'Verify: outside'),
  'model-after-non-wave-heading': lines('### Wave 1', 'Model: m1', '### Other', 'Model: m2'),
  'capabilities-plan-level-only': lines('Capabilities: net, fs_write', '### Wave 1'),
  'capabilities-malformed-empty': lines('Capabilities:', '### Wave 1', 'Capabilities:   '),
  'capabilities-malformed-unknown': lines('Capabilities: bogus', '### Wave 1', 'Capabilities: fs_read, wat'),
  'capabilities-duplicate-declarations': lines('Capabilities: shell', 'Capabilities: net', '### Wave 1', 'Capabilities: mcp', 'Capabilities: shell'),
  'capabilities-case-and-order': lines('Capabilities: SHELL mcp,FS_READ', '### Wave 2', '### Wave 1', '### Wave 2'),
  'tests-promised-by-task-file': lines(
    '### Wave 1', '#### Task 1.1: x', 'File: tests/p.test.js', '## Tests to Write', '- [ ] p — tests/p.test.js',
  ),
  'tests-unpromised-only': lines('## Tests to Write', '- [ ] q — tests/q.test.js', '- [ ] q again — tests/q.test.js'),
  'tests-no-section': lines('### Wave 1', '#### Task 1.1: x', 'File: tests/p.test.js'),
  'tasks-without-waves': lines('#### Task 1.1: stray', 'File: a.js'),
};

/** [label, env] pairs for RAD_VERIFY_TIMEOUT_SECONDS: unset, valid, malformed. */
const TIMEOUT_ENVS = [['unset', {}], ['valid', { RAD_VERIFY_TIMEOUT_SECONDS: '1800' }], ['malformed', { RAD_VERIFY_TIMEOUT_SECONDS: '-5' }]];

for (const [name, text] of Object.entries(PLAN_CASES)) {
  scenario(`parsePlanCtx — ${name}`, () => withEnv({}, () => {
    const ctx = parsePlanCtx(text);
    return { keys: Object.keys(ctx), keysWithUndefined: Object.keys(ctx).filter((k) => ctx[k] === undefined), value: ctx };
  }));
}

for (const [label, env] of TIMEOUT_ENVS) {
  scenario(`parsePlanCtx — verify timeout ${label}`, () => withEnv(env, () => {
    const ctx = parsePlanCtx(WAVE_PLAN);
    return { keys: Object.keys(ctx), verifyTimeoutSeconds: ctx.verifyTimeoutSeconds };
  }));
}

// ---------------------------------------------------------------------------
// Task 1.1b — plan-header mirror through approveCommand (AC#3)
// ---------------------------------------------------------------------------

const PLAN_REL = join('.agents', 'plans', `${FEATURE}.md`);
const EVENTS_REL = join('.agents', 'state', FEATURE, 'events.jsonl');
const APPROVED_SEED = { feature: FEATURE, type: 'approved', actor: ARCHITECT, role: 'architect', ts: '2026-06-15T00:00:00.000Z' };
const PR_OPENED_SEED = { feature: FEATURE, type: 'pr-opened', actor: ARCHITECT, ts: '2026-06-16T00:00:00.000Z' };
const BODY = '\n## Waves\n\n### Wave 1\n\n#### Task 1.1: A\nValidate: ok\n';
const STALE = ['Approved-By: old@example.com', 'Approved-At: 2020-01-01T00:00:00.000Z', 'Recorded-By: older@example.com', 'Approval-Evidence: old evidence'];

const APPROVE_CASES = [
  ['direct-status-present', `# ${FEATURE}\nStatus: draft\nBranch: rad/${FEATURE}\n${BODY}`, []],
  ['direct-status-absent', `# ${FEATURE}\nBranch: rad/${FEATURE}\n${BODY}`, []],
  ['direct-no-header-block', `# ${FEATURE}\n${BODY}`, []],
  ['direct-empty-file', '', []],
  ['direct-no-trailing-newline', `# ${FEATURE}\nStatus: draft\n${BODY.trimEnd()}`, []],
  ['direct-all-headers-present', `# ${FEATURE}\nStatus: draft\n${STALE.join('\n')}\n${BODY}`, []],
  ['direct-only-approved-by-present', `# ${FEATURE}\nStatus: draft\nApproved-By: old@example.com\n${BODY}`, []],
  ['direct-only-recorded-by-present', `# ${FEATURE}\nStatus: draft\nRecorded-By: older@example.com\n${BODY}`, []],
  ['proxy-status-present', `# ${FEATURE}\nStatus: draft\nBranch: rad/${FEATURE}\n${BODY}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'slack thread']],
  ['proxy-status-absent', `# ${FEATURE}\nBranch: rad/${FEATURE}\n${BODY}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'slack thread']],
  ['proxy-all-headers-present', `# ${FEATURE}\nStatus: draft\n${STALE.join('\n')}\n${BODY}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'email']],
  ['proxy-no-header-block', `# ${FEATURE}\n${BODY}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'call']],
  ['proxy-no-trailing-newline', `# ${FEATURE}\nStatus: draft\n${BODY.trimEnd()}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'call']],
];

async function runApproveScenario(planText, args, { events = [], roleOk = true } = {}) {
  const tmp = makeTemp();
  try {
    writeFileDeep(join(tmp.dir, PLAN_REL), planText);
    if (events.length > 0) writeFileDeep(join(tmp.dir, EVENTS_REL), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const norm = makeNormalizer(tmp.labels);
    const sh = makeStubSh({ roleOk });
    const { code, output } = await withEnv({}, () => captureOrdered(() => approveCommand([FEATURE, '--no-commit', ...args], { repoRoot: tmp.dir, sh })));
    return {
      code,
      output: normalizeOutput(output, norm),
      planText: readIfExists(join(tmp.dir, PLAN_REL), norm),
      events: readIfExists(join(tmp.dir, EVENTS_REL), norm),
    };
  } finally {
    tmp.cleanup();
  }
}

for (const [name, planText, args] of APPROVE_CASES) {
  scenario(`approve header mirror — ${name}`, () => runApproveScenario(planText, args));
}

scenario('approve header mirror — delivered feature keeps its status (re-approval)', () => runApproveScenario(
  `# ${FEATURE}\nStatus: complete\nApproved-By: old@example.com\n${BODY}`, [], { events: [APPROVED_SEED, PR_OPENED_SEED] },
));
scenario('approve header mirror — delivered feature, proxy, status absent', () => runApproveScenario(
  `# ${FEATURE}\n${BODY}`, ['--on-behalf-of', 'boss@example.com', '--evidence', 'chat'], { events: [APPROVED_SEED, PR_OPENED_SEED] },
));
scenario('approve header mirror — non-delivered re-approval resets status', () => runApproveScenario(
  `# ${FEATURE}\nStatus: complete\n${BODY}`, [], { events: [APPROVED_SEED] },
));
scenario('approve header mirror — role check refused writes nothing', () => runApproveScenario(
  `# ${FEATURE}\nStatus: draft\n${BODY}`, [], { roleOk: false },
));

// ---------------------------------------------------------------------------
// Task 1.1c — gateCommand (AC#4)
// ---------------------------------------------------------------------------

const GATE_FEATURE = 'gate-feature';
const gateLog = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const GATE_APPROVED = { feature: GATE_FEATURE, type: 'approved', actor: ARCHITECT, role: 'architect', ts: '2026-06-15T00:00:00.000Z' };
const GATE_OTHER = { feature: GATE_FEATURE, type: 'plan-created', actor: DEVELOPER, ts: '2026-06-14T00:00:00.000Z' };
const GATE_WRONG_ROLE = { feature: GATE_FEATURE, type: 'approved', actor: DEVELOPER, role: 'developer', ts: '2026-06-15T01:00:00.000Z' };

/** In-process gateCommand over an optional on-disk log; asserts nothing is written. */
async function runGateScenario(argv, logText) {
  const tmp = makeTemp();
  try {
    if (logText !== undefined) writeFileDeep(join(tmp.dir, '.agents', 'state', GATE_FEATURE, 'events.jsonl'), logText);
    const before = listing(tmp.dir);
    const norm = makeNormalizer(tmp.labels);
    const sh = makeStubSh();
    const { code, output } = await withEnv({}, () => captureOrdered(() => gateCommand(argv, { repoRoot: tmp.dir, sh })));
    assert.deepStrictEqual(listing(tmp.dir), before, 'gate must not write any file');
    return { code, output: normalizeOutput(output, norm), filesUnchanged: true };
  } finally {
    tmp.cleanup();
  }
}

/** gateCommand --stdin in a child process (fd 0 cannot be replaced in-process). */
function runGateStdin(argv, input) {
  const tmp = makeTemp();
  try {
    const script = join(tmp.dir, 'run-gate.mjs');
    const work = join(tmp.dir, 'work');
    mkdirSync(work);
    writeFileSync(script, [
      `import { gateCommand } from ${JSON.stringify(CLI_URL)};`,
      'process.exitCode = await gateCommand(JSON.parse(process.argv[2]), { repoRoot: process.argv[3] });',
    ].join('\n'));
    const before = listing(work);
    const res = spawnSync(process.execPath, [script, JSON.stringify(argv), work], { input, encoding: 'utf8', cwd: work });
    const norm = makeNormalizer(tmp.labels);
    assert.deepStrictEqual(listing(work), before, 'gate --stdin must not write any file');
    return { code: res.status, stdout: norm(res.stdout), stderr: norm(res.stderr), filesUnchanged: true };
  } finally {
    tmp.cleanup();
  }
}

const GATE_ARGV_CASES = {
  'no arguments': [],
  'feature only': [GATE_FEATURE],
  'unknown option': [GATE_FEATURE, 'approved', '--bogus'],
  'extra argument': [GATE_FEATURE, 'approved', 'extra'],
  'unknown gate name': [GATE_FEATURE, 'no-such-gate'],
};
for (const [name, argv] of Object.entries(GATE_ARGV_CASES)) {
  scenario(`gate — ${name}`, () => runGateScenario(argv, gateLog([GATE_APPROVED])));
}
scenario('gate — missing log', () => runGateScenario([GATE_FEATURE, 'approved'], undefined));
scenario('gate — empty log', () => runGateScenario([GATE_FEATURE, 'approved'], ''));
scenario('gate — approved log', () => runGateScenario([GATE_FEATURE, 'approved'], gateLog([GATE_APPROVED])));
scenario('gate — log with several events', () => runGateScenario([GATE_FEATURE, 'approved'], gateLog([GATE_OTHER, GATE_WRONG_ROLE, GATE_APPROVED])));
scenario('gate — log with only a wrong-role approval', () => runGateScenario([GATE_FEATURE, 'approved'], gateLog([GATE_OTHER, GATE_WRONG_ROLE])));
scenario('gate — stdin valid approved log', () => runGateStdin([GATE_FEATURE, 'approved', '--stdin'], gateLog([GATE_OTHER, GATE_APPROVED])));
scenario('gate — stdin empty', () => runGateStdin([GATE_FEATURE, 'approved', '--stdin'], ''));
scenario('gate — stdin malformed lines are dropped', () => runGateStdin([GATE_FEATURE, 'approved', '--stdin'], `not json\n\n{broken\n${JSON.stringify(GATE_APPROVED)}\n`));
scenario('gate — stdin only malformed', () => runGateStdin([GATE_FEATURE, 'approved', '--stdin'], '{{{\n]]]\n'));
scenario('gate — stdin unknown gate', () => runGateStdin([GATE_FEATURE, 'no-such-gate', '--stdin'], gateLog([GATE_APPROVED])));

// ---------------------------------------------------------------------------
// Task 1.1d — architectureApproveCommand (AC#5)
// ---------------------------------------------------------------------------

const ARCH_EVENTS_REL = join('.agents', 'state', '_architecture', 'events.jsonl');

async function runArchScenario(argv, shOpts = {}) {
  const tmp = makeTemp();
  try {
    const norm = makeNormalizer(tmp.labels);
    const sh = makeStubSh(shOpts);
    const { code, output } = await withEnv({}, () => captureOrdered(() => architectureApproveCommand(argv, { repoRoot: tmp.dir, sh })));
    return { code, output: normalizeOutput(output, norm), events: readIfExists(join(tmp.dir, ARCH_EVENTS_REL), norm), files: listing(tmp.dir).map(norm) };
  } finally {
    tmp.cleanup();
  }
}

const ARCH_CASES = {
  'no arguments': [[], {}],
  'unknown option': [['slug', '--bogus'], {}],
  'extra positional': [['slug', 'other'], {}],
  'option missing its value': [['slug', '--on-behalf-of'], {}],
  'evidence without on-behalf-of': [['slug', '--evidence', 'text'], {}],
  'undetermined git identity': [['slug'], { email: '' }],
  'on-behalf-of without evidence': [['slug', '--on-behalf-of', 'boss@example.com'], {}],
  'direct mode': [['slug'], {}],
  'proxy mode': [['slug', '--on-behalf-of', 'boss@example.com', '--evidence', 'standup notes'], {}],
  'failed role check (direct)': [['slug'], { roleOk: false }],
  'failed role check (proxy)': [['slug', '--on-behalf-of', 'boss@example.com', '--evidence', 'x'], { roleOk: false }],
};
for (const [name, [argv, shOpts]] of Object.entries(ARCH_CASES)) {
  scenario(`architecture-approve — ${name}`, () => runArchScenario(argv, shOpts));
}

// ---------------------------------------------------------------------------
// Task 1.2 — deliverCommand (AC#6)
// ---------------------------------------------------------------------------

const DELIVER_FEATURE = 'stop-feature';
const DELIVER_PLAN_REL = join('.agents', 'plans', `${DELIVER_FEATURE}.md`);
const DELIVER_EVENTS_REL = join('.agents', 'state', DELIVER_FEATURE, 'events.jsonl');
const noopPrepare = async () => ({ ok: true, data: {} });
const noopFinish = { beforePr: async () => ({ ok: true, data: {} }), afterPr: async () => ({ ok: true, data: {} }) };
const successWave = async () => ({ outcome: 'success' });

const twoWavePlan = (extra = '') => lines(
  `# ${DELIVER_FEATURE}`, '', 'Status: approved', `Branch: rad/${DELIVER_FEATURE}`, '',
  '## Waves', '', '### Wave 1', '', '#### Task 1.1: Task A', 'Validate: task A passes', '- [ ] Task A', '',
  '### Wave 2', '', '#### Task 2.1: Task B', 'Validate: task B passes', '- [ ] Task B', extra,
);
const approvedFor = (text) => ({ ...APPROVED_SEED, feature: DELIVER_FEATURE, data: { fingerprint: planFingerprint(text).hash } });
const eventLines = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

/** Seed the plan (and optionally its approval and extra events) under a main checkout. */
function seedDeliver(dir, { plan = twoWavePlan(), approved = true, extraEvents = [], config } = {}) {
  writeFileDeep(join(dir, DELIVER_PLAN_REL), plan);
  const events = [...(approved ? [approvedFor(plan)] : []), ...extraEvents];
  if (events.length > 0) writeFileDeep(join(dir, DELIVER_EVENTS_REL), eventLines(events));
  if (config !== undefined) writeFileDeep(join(dir, '.rad', 'config.yml'), config);
}

/** Run deliverCommand once in a seeded temp checkout; returns the normalised observation. */
async function observeDeliver({ argv = [DELIVER_FEATURE], env = {}, ctx = {}, seed = {}, setup, after: afterRun }) {
  const tmp = makeTemp();
  try {
    seedDeliver(tmp.dir, seed);
    if (setup) setup(tmp.dir);
    const norm = makeNormalizer(tmp.labels);
    const before = listing(tmp.dir);
    const eventsBefore = readIfExists(join(tmp.dir, DELIVER_EVENTS_REL), norm);
    const full = { repoRoot: tmp.dir, sh: okSh, ...(typeof ctx === 'function' ? ctx(tmp.dir) : ctx) };
    const { code, output } = await withEnv({ RAD_WORKTREE: '0', ...env }, () => captureOrdered(() => deliverCommand(argv, full)));
    const result = {
      code, output: normalizeOutput(output, norm), events: readIfExists(join(tmp.dir, DELIVER_EVENTS_REL), norm),
      filesChanged: listing(tmp.dir).filter((f) => !before.includes(f)).map(norm),
      eventsBefore,
    };
    if (afterRun) result.extra = afterRun(tmp.dir, norm);
    return result;
  } finally {
    tmp.cleanup();
  }
}

/** A refusal that precedes setup: no event log and no worktree directory may exist afterwards. */
async function observeRefusal(opts) {
  const wtBase = makeTemp('rad-char-wt-');
  try {
    const result = await observeDeliver({ ...opts, env: { RAD_WORKTREE_DIR: wtBase.dir, ...opts.env } });
    assert.deepStrictEqual(readdirSync(wtBase.dir), [], 'no worktree may be created before setup');
    assert.equal(result.events, result.eventsBefore, 'no event may be appended before setup');
    assert.deepStrictEqual(result.filesChanged, [], 'no file may be created before setup');
    return { ...result, worktreeCreated: false };
  } finally {
    wtBase.cleanup();
  }
}

// Help, argument errors, missing feature -------------------------------------
scenario('deliver — --help', () => observeRefusal({ argv: ['--help'] }));
scenario('deliver — -h with a feature', () => observeRefusal({ argv: ['-h', DELIVER_FEATURE] }));
scenario('deliver — unknown option', () => observeRefusal({ argv: [DELIVER_FEATURE, '--bogus'] }));
scenario('deliver — --model without value', () => observeRefusal({ argv: [DELIVER_FEATURE, '--model'] }));
scenario('deliver — --context without value (exit 2)', () => observeRefusal({ argv: [DELIVER_FEATURE, '--context'] }));
scenario('deliver — unexpected second positional', () => observeRefusal({ argv: [DELIVER_FEATURE, 'other'] }));
scenario('deliver — no feature', () => observeRefusal({ argv: [] }));
scenario('deliver — blank feature', () => observeRefusal({ argv: ['  '] }));

// Agent-selection refusals (no injected runWave) ------------------------------
const noAgentCtx = { prepare: noopPrepare, finish: noopFinish };
scenario('deliver — no agent configured', () => observeRefusal({ ctx: noAgentCtx }));
scenario('deliver — unknown RAD_AGENT', () => observeRefusal({ ctx: noAgentCtx, env: { RAD_AGENT: 'bogus' } }));
scenario('deliver — RAD_AGENT=command without RAD_AGENT_CMD', () => observeRefusal({ ctx: noAgentCtx, env: { RAD_AGENT: 'command' } }));
scenario('deliver — invalid config and no environment agent', () => observeRefusal({ ctx: noAgentCtx, seed: { config: 'version: 99\nnot: [valid\n' } }));

// Failed-attempt cap, invalid config, hooks directory -------------------------
const withWave = { runWave: successWave, prepare: noopPrepare, finish: noopFinish };
for (const raw of ['abc', '0', '-3', '1.5']) {
  scenario(`deliver — invalid RAD_MAX_FAILED_ATTEMPTS ${raw}`, () => observeRefusal({ ctx: withWave, env: { RAD_MAX_FAILED_ATTEMPTS: raw } }));
}
scenario('deliver — invalid configuration with an injected wave runner', () => observeRefusal({ ctx: withWave, seed: { config: 'version: 99\nnot: [valid\n' } }));
scenario('deliver — invalid hooks directory (RAD_HOOKS_DIR)', () => observeRefusal({ ctx: withWave, env: { RAD_HOOKS_DIR: '-bad' } }));
scenario('deliver — invalid hooks directory (config settings)', () => observeRefusal({
  ctx: withWave,
  seed: { config: lines('version: 1', 'platform: manual', 'default_branch: main', 'roles:', '  architect: [a@example.com]', '  developers: []', '  designers: []', 'agent_scope_map: []', 'settings:', '  hooks_dir: "-dash"') },
}));

// Delivered rerun --------------------------------------------------------------
const DELIVERED = [PR_OPENED_SEED].map((e) => ({ ...e, feature: DELIVER_FEATURE }));
scenario('deliver — delivered rerun short-circuits', () => observeDeliver({ seed: { extraEvents: DELIVERED }, ctx: withWave }));
scenario('deliver — delivered rerun whose republish fails', () => observeDeliver({
  seed: { extraEvents: DELIVERED },
  ctx: { ...withWave, finish: { ...noopFinish, afterPr: async () => ({ ok: false, detail: 'push rejected' }) } },
}));

// --resume refusals -------------------------------------------------------------
const devSh = makeStubSh({ email: DEVELOPER });
const STOPPED_FAILED = { feature: DELIVER_FEATURE, type: 'deliver-stopped', actor: DEVELOPER, ts: '2026-06-17T00:00:00.000Z', data: { class: 'failed', reason: 'fail-scope', decision: 'wave 1: fail-scope — the work is wrong for the plan; fix the plan or the code and re-run' } };
const STOPPED_NEEDS = { ...STOPPED_FAILED, data: { class: 'needs-decision', reason: 'fail-timeout', decision: 'wave 1: fail-timeout — non-deterministic failure', wave: 1 } };
scenario('deliver — --resume without --context', () => observeRefusal({ argv: [DELIVER_FEATURE, '--resume'], ctx: withWave }));
scenario('deliver — --context without --resume', () => observeRefusal({ argv: [DELIVER_FEATURE, '--context', 'x'], ctx: withWave }));
scenario('deliver — --resume with an empty context', () => observeRefusal({ argv: [DELIVER_FEATURE, '--resume', '--context', '  '], ctx: withWave }));
scenario('deliver — --resume with an oversized context', () => observeRefusal({ argv: [DELIVER_FEATURE, '--resume', '--context', 'x'.repeat(8001)], ctx: withWave }));
scenario('deliver — --resume with nothing to resume', () => observeRefusal({ argv: [DELIVER_FEATURE, '--resume', '--context', 'go'], ctx: { ...withWave, sh: devSh }, }));
scenario('deliver — --resume after a failed stop', () => observeDeliver({
  argv: [DELIVER_FEATURE, '--resume', '--context', 'go'], ctx: { ...withWave, sh: devSh }, seed: { extraEvents: [STOPPED_FAILED] },
}));
scenario('deliver — --resume without a git identity', () => observeDeliver({
  argv: [DELIVER_FEATURE, '--resume', '--context', 'go'], ctx: withWave, seed: { extraEvents: [STOPPED_NEEDS] },
}));
scenario('deliver — --resume after a needs-decision stop', () => observeDeliver({
  argv: [DELIVER_FEATURE, '--resume', '--context', 'raised the limit'], ctx: { ...withWave, sh: devSh }, seed: { extraEvents: [STOPPED_NEEDS] },
}));

// Setup failures -----------------------------------------------------------------
scenario('deliver — setup failure: gate not passed', () => observeDeliver({ ctx: withWave, seed: { approved: false } }));
scenario('deliver — setup failure: no plan doc', () => observeDeliver({ ctx: withWave, seed: { approved: false }, setup: (d) => rmSync(join(d, DELIVER_PLAN_REL)) }));
scenario('deliver — setup failure: plan with a task-less wave', () => observeDeliver({
  ctx: withWave, seed: { plan: lines(`# ${DELIVER_FEATURE}`, 'Branch: rad/x', '### Wave 1', '### Wave 2', '#### Task 2.1: B', 'Validate: ok') },
}));
scenario('deliver — setup failure: malformed capabilities', () => observeDeliver({
  ctx: withWave, seed: { plan: lines(`# ${DELIVER_FEATURE}`, 'Branch: rad/x', 'Capabilities: bogus', '### Wave 1', '#### Task 1.1: A', 'Validate: ok') },
}));
scenario('deliver — setup failure in worktree mode (stub sh fails)', () => observeDeliver({
  env: { RAD_WORKTREE: '' },
  ctx: { ...withWave, sh: () => ({ status: 1, stdout: '', stderr: 'stub: boom\n' }) },
}));

// Token budget warning ------------------------------------------------------------
scenario('deliver — unarmed budget warns once', () => observeDeliver({ ctx: withWave }));
scenario('deliver — malformed budget warns once', () => observeDeliver({ ctx: withWave, env: { RAD_TOKEN_BUDGET: 'abc' } }));
scenario('deliver — armed budget does not warn', () => observeDeliver({ ctx: withWave, env: { RAD_TOKEN_BUDGET: '200000' } }));

// Prepare / finish port failures ----------------------------------------------------
const failingDefaultBranchSh = (file) => (String(file).endsWith('get-default-branch.sh')
  ? { status: 7, stdout: '', stderr: 'stub failure\n' }
  : okSh());
scenario('deliver — prepare port cannot resolve default branch', () => observeDeliver({
  ctx: { runWave: successWave, finish: noopFinish, sh: failingDefaultBranchSh },
}));
scenario('deliver — prepare port stops with merge-conflict', () => observeDeliver({
  ctx: { ...withWave, prepare: async () => ({ ok: false, stopped: 'merge-conflict', detail: 'a.js', base: 'main', branch: 'rad/x' }) },
}));
scenario('deliver — prepare port stops with prepare-failed', () => observeDeliver({
  ctx: { ...withWave, prepare: async () => ({ ok: false, stopped: 'prepare-failed', detail: 'cannot reach origin' }) },
}));
scenario('deliver — finish port beforePr fails', () => observeDeliver({
  ctx: { ...withWave, finish: { ...noopFinish, beforePr: async () => ({ ok: false, detail: 'commit refused' }) } },
}));
scenario('deliver — finish port afterPr fails after the PR', () => observeDeliver({
  ctx: { ...withWave, finish: { ...noopFinish, afterPr: async () => ({ ok: false, detail: 'label failed' }) } },
}));

// Spine throws -----------------------------------------------------------------------
scenario('deliver — spine throws (wave runner returns nothing)', () => observeDeliver({ ctx: { ...withWave, runWave: async () => undefined } }));
scenario('deliver — spine throws with a credential-looking message', () => observeDeliver({
  ctx: { ...withWave, runWave: async () => { throw new Error('boom sk-ant-api03-SECRETSECRETSECRET1234567890'); } },
}));

// Ok runs ----------------------------------------------------------------------------
scenario('deliver — ok run with evidence', () => observeDeliver({ ctx: withWave }));
scenario('deliver — ok run with --model and a per-wave plan', () => observeDeliver({
  argv: [DELIVER_FEATURE, '--model', 'claude-sonnet-5-5'], ctx: withWave,
  seed: { plan: twoWavePlan() },
}));
scenario('deliver — ok run the log does not evidence', () => observeDeliver({
  ctx: (dir) => ({
    ...withWave,
    finish: { ...noopFinish, afterPr: async () => { writeFileSync(join(dir, DELIVER_EVENTS_REL), ''); return { ok: true, data: {} }; } },
  }),
}));
scenario('deliver — ok run with a promised test file that exists', () => {
  const plan = twoWavePlan(lines('', '## Tests to Write', '', '- [ ] a test — tests/promised.test.js'));
  return observeDeliver({
    ctx: withWave, seed: { plan }, setup: (d) => writeFileDeep(join(d, 'tests', 'promised.test.js'), 'x\n'),
  });
});

// Stop classes ----------------------------------------------------------------------------
const usageWave = async () => ({ outcome: 'success', usage: { total: 100 } });
scenario('deliver — stop: matrix surface (needs-decision)', () => observeDeliver({ ctx: { ...withWave, runWave: async () => ({ outcome: 'fail-timeout' }) } }));
scenario('deliver — stop: matrix abort (failed)', () => observeDeliver({ ctx: { ...withWave, runWave: async () => ({ outcome: 'fail-scope' }) } }));
scenario('deliver — stop: repeated fail-tests', () => observeDeliver({ ctx: { ...withWave, runWave: async () => ({ outcome: 'fail-tests' }) } }));
scenario('deliver — stop: token budget', () => observeDeliver({ ctx: { ...withWave, runWave: usageWave }, env: { RAD_TOKEN_BUDGET: '50' } }));
scenario('deliver — stop: failed-attempt cap', () => observeDeliver({
  ctx: { ...withWave, runWave: async () => ({ outcome: 'fail-tests' }) }, env: { RAD_MAX_FAILED_ATTEMPTS: '1' },
}));
scenario('deliver — stop: approval changed during the run', () => observeDeliver({
  ctx: (dir) => ({
    ...withWave,
    runWave: async () => { writeFileSync(join(dir, DELIVER_PLAN_REL), twoWavePlan('\nedited after approval\n')); return { outcome: 'success' }; },
  }),
}));
scenario('deliver — stop: post-check fails', () => observeDeliver({
  ctx: { ...withWave, sh: (file) => (String(file).endsWith('open-pr.sh') ? { status: 1, stdout: '', stderr: 'stub open-pr failed\n' } : okSh()) },
}));
scenario('deliver — stop: tests still missing after the test wave', () => observeDeliver({
  ctx: withWave, seed: { plan: twoWavePlan(lines('', '## Tests to Write', '', '- [ ] missing — tests/never-written.test.js')) },
}));
scenario('deliver — stop: needs-decision then resumed to success', async () => {
  const tmp = makeTemp();
  try {
    seedDeliver(tmp.dir);
    const norm = makeNormalizer(tmp.labels);
    const run = (argv, runWave) => withEnv({ RAD_WORKTREE: '0' }, () => captureOrdered(() => deliverCommand(
      argv, { repoRoot: tmp.dir, sh: devSh, runWave, prepare: noopPrepare, finish: noopFinish },
    )));
    const first = await run([DELIVER_FEATURE], async () => ({ outcome: 'fail-timeout' }));
    const second = await run([DELIVER_FEATURE, '--resume', '--context', 'raised the limit'], successWave);
    return {
      first: { code: first.code, output: normalizeOutput(first.output, norm) },
      second: { code: second.code, output: normalizeOutput(second.output, norm) },
      events: readIfExists(join(tmp.dir, DELIVER_EVENTS_REL), norm),
    };
  } finally {
    tmp.cleanup();
  }
});
scenario('deliver — stop: failed stop cannot be resumed', async () => {
  const tmp = makeTemp();
  try {
    seedDeliver(tmp.dir);
    const norm = makeNormalizer(tmp.labels);
    const run = (argv) => withEnv({ RAD_WORKTREE: '0' }, () => captureOrdered(() => deliverCommand(
      argv, { repoRoot: tmp.dir, sh: devSh, runWave: async () => ({ outcome: 'fail-scope' }), prepare: noopPrepare, finish: noopFinish },
    )));
    const first = await run([DELIVER_FEATURE]);
    const second = await run([DELIVER_FEATURE, '--resume', '--context', 'try again']);
    return {
      first: { code: first.code, output: normalizeOutput(first.output, norm) },
      second: { code: second.code, output: normalizeOutput(second.output, norm) },
      events: readIfExists(join(tmp.dir, DELIVER_EVENTS_REL), norm),
    };
  } finally {
    tmp.cleanup();
  }
});

// Worktree mode on a real temporary repository with an origin --------------------------------
/** Run deliverCommand in worktree mode against a createFixture repository. */
async function observeWorktreeRun({ runWaveFor, sh, injectPrepare = true }) {
  const fx = createFixture({ feature: 'demo' });
  const wt = makeTemp('rad-char-wt-');
  try {
    const norm = makeNormalizer([...wt.labels.map(([p]) => [p, '<WT>']), [realpathSync(fx.base), '<ROOT>'], [fx.base, '<ROOT>'], [realpathSync(fx.root), '<REPO>'], [fx.root, '<REPO>']]);
    const wtDir = join(wt.dir, 'demo');
    const ctx = { repoRoot: fx.root, runWave: runWaveFor(wtDir), finish: noopFinish, ...(injectPrepare ? { prepare: noopPrepare } : {}), ...(sh ? { sh } : {}) };
    const { code, output } = await withEnv({ RAD_WORKTREE_DIR: wt.dir, RAD_AGENT_PREFLIGHT: 'off' }, () => captureOrdered(() => deliverCommand(['demo'], ctx)));
    const show = fx.git('show', 'rad/demo:.agents/state/demo/events.jsonl');
    return {
      code,
      output: normalizeOutput(output, norm),
      worktreeDirExists: existsSync(wtDir),
      worktreeEvents: readIfExists(join(wtDir, '.agents', 'state', 'demo', 'events.jsonl'), norm),
      branchEvents: show.status === 0 ? norm(show.stdout) : null,
      branchSubjects: norm(fx.git('log', '--format=%s', 'rad/demo').stdout),
    };
  } finally {
    wt.cleanup();
    fx.cleanup();
  }
}

const commitInWorktree = (wtDir) => async () => {
  mkdirSync(join(wtDir, 'src'), { recursive: true });
  writeFileSync(join(wtDir, 'src', 'feature.txt'), 'feature\n');
  spawnSync('git', ['add', 'src/feature.txt'], { cwd: wtDir });
  spawnSync('git', ['commit', '-q', '-m', 'feature'], { cwd: wtDir });
  return { outcome: 'success' };
};

scenario('deliver worktree — ok run tears the worktree down', () => observeWorktreeRun({ runWaveFor: commitInWorktree }));
scenario('deliver worktree — stop preserves the worktree', () => observeWorktreeRun({ runWaveFor: () => async () => ({ outcome: 'fail-scope' }) }));
scenario('deliver worktree — spine throw preserves the worktree', () => observeWorktreeRun({ runWaveFor: () => async () => undefined }));
scenario('deliver worktree — prepare port failure preserves the worktree', () => observeWorktreeRun({
  runWaveFor: commitInWorktree, injectPrepare: false,
  sh: (file, args, opts) => (String(file).endsWith('get-default-branch.sh') && String(opts?.cwd).includes('rad-char-wt-')
    ? { status: 9, stdout: '', stderr: 'stub failure\n' }
    : spawnSync(file, args, { ...opts, encoding: 'utf8' })),
}));

// ---------------------------------------------------------------------------
// Golden bookkeeping
// ---------------------------------------------------------------------------

test('golden file has exactly the registered scenarios', { skip: UPDATE_GOLDEN }, () => {
  assert.deepStrictEqual(Object.keys(GOLDEN).sort(), [...REGISTERED].sort());
});
