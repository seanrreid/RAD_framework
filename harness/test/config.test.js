// Tests for harness/config.js and the `rad config` verbs (#87 part 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_PATH, PLATFORMS, loadConfig, validateConfig, getConfigValue, migrateFromClaudeMd, serializeConfig,
  settingsErrors, seedSettings, writeConfigAtomic, agentErrors, buildInitConfig, AGENT_ADAPTERS, AGENT_PRESETS,
  DEFAULT_PLAYBOOK_KINDS, resolvePlaybookKinds,
} from '../config.js';
import { configCommand } from '../cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const VALID = Object.freeze({
  version: 1,
  platform: 'github',
  default_branch: 'main',
  roles: { architect: ['arch@example.com'], developers: [], designers: [] },
  agent_scope_map: [{ agent: 'a', type: 'reviewer', reads: 'x, y', roles: ['architect', 'developer'] }],
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const tempRoot = () => mkdtempSync(join(tmpdir(), 'rad-config-'));

function writeConfig(root, text) {
  mkdirSync(join(root, '.rad'), { recursive: true });
  writeFileSync(join(root, CONFIG_PATH), text);
}

/** Run configCommand capturing stdout/stderr. */
async function runConfig(argv, repoRoot) {
  const orig = { out: process.stdout.write, err: process.stderr.write };
  let stdout = '';
  let stderr = '';
  process.stdout.write = (c) => { stdout += c; return true; };
  process.stderr.write = (c) => { stderr += c; return true; };
  try {
    const code = await configCommand(argv, { repoRoot });
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
}

const CLAUDE_MD = `# X

### Git Platform

\`\`\`
platform: gitlab        # github | gitlab
default_branch: trunk
\`\`\`

### Role Assignments

\`\`\`
architect:  a@x.com, b@x.com
developers: []
designers:  d@x.com
\`\`\`

### Agent Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| m | context-tool | a.js, b.js | architect, developer |
| bad | row |

## Workflow
`;

// --- validateConfig -------------------------------------------------------

test('validateConfig: a valid doc has no errors', () => {
  assert.deepEqual(validateConfig(clone(VALID)), []);
  assert.ok(PLATFORMS.includes('manual'));
});

test('validateConfig: unknown top-level key is an error (fail-closed)', () => {
  const errors = validateConfig({ ...clone(VALID), extra: 1 });
  assert.ok(errors.some((e) => e.includes("unknown top-level key 'extra'")), errors.join());
});

test('validateConfig: bad platform, missing version, non-mapping doc', () => {
  assert.ok(validateConfig({ ...clone(VALID), platform: 'svn' }).some((e) => e.startsWith('platform must be one of')));
  const noVersion = clone(VALID);
  delete noVersion.version;
  assert.ok(validateConfig(noVersion).includes('version is required'));
  assert.deepEqual(validateConfig(null), ['config must be a YAML mapping']);
  assert.deepEqual(validateConfig([]), ['config must be a YAML mapping']);
});

test('validateConfig: placeholder identity and empty architect are errors', () => {
  const doc = clone(VALID);
  doc.roles.architect = ['[your GitHub username]'];
  assert.ok(validateConfig(doc).some((e) => e.includes('template placeholder')));
  doc.roles.architect = [];
  assert.ok(validateConfig(doc).some((e) => e.includes('at least one identity')));
});

test('validateConfig: a lone-string role normalizes; a number role does not', () => {
  const doc = clone(VALID);
  doc.roles.architect = 'arch@example.com';
  doc.roles.developers = 'dev@example.com';
  assert.deepEqual(validateConfig(doc), []);
  doc.roles.designers = 7;
  assert.ok(validateConfig(doc).includes('roles.designers must be a list'));
});

test('validateConfig: bad scope-map row shapes', () => {
  const doc = clone(VALID);
  doc.agent_scope_map = [{ agent: '', type: 't', reads: 1, roles: [], extra: true }, 'x'];
  const errors = validateConfig(doc);
  for (const frag of ['agent_scope_map[0].agent', 'agent_scope_map[0].reads', 'agent_scope_map[0].extra',
    'agent_scope_map[0].roles', 'agent_scope_map[1] must be a mapping']) {
    assert.ok(errors.some((e) => e.includes(frag)), `${frag} in ${errors.join(' | ')}`);
  }
});

// --- getConfigValue --------------------------------------------------------

test('getConfigValue: scalar, list, nested, absent, bad key', () => {
  assert.deepEqual(getConfigValue(VALID, 'platform'), { found: true, value: 'github' });
  assert.deepEqual(getConfigValue(VALID, 'roles.architect'), { found: true, value: ['arch@example.com'] });
  assert.equal(getConfigValue(VALID, 'agent_scope_map').value.length, 1);
  assert.deepEqual(getConfigValue(VALID, 'roles.nobody'), { found: false });
  assert.deepEqual(getConfigValue(VALID, 'platform.deeper'), { found: false });
  assert.deepEqual(getConfigValue(VALID, ''), { found: false });
  assert.deepEqual(getConfigValue(null, 'platform'), { found: false });
});

// --- loadConfig / serializeConfig -----------------------------------------

test('loadConfig: missing file → { ok: false, missing: true }', async () => {
  assert.deepEqual(await loadConfig(tempRoot()), { ok: false, missing: true });
});

test('loadConfig: parse error and validation error are named', async () => {
  const root = tempRoot();
  writeConfig(root, 'platform: [unclosed\n');
  const parsed = await loadConfig(root);
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors[0], /cannot parse \.rad\/config\.yml/);
  writeConfig(root, 'version: 1\nplatform: svn\n');
  const invalid = await loadConfig(root);
  assert.ok(invalid.errors.some((e) => e.startsWith('platform must be one of')));
  assert.ok(invalid.errors.includes('roles is required'));
});

test('serializeConfig round-trips through loadConfig (lone string normalized)', async () => {
  const root = tempRoot();
  const doc = clone(VALID);
  doc.roles.architect = 'arch@example.com';
  doc.agent_scope_map.push({ agent: 'yes', type: 'true', reads: '#hash: "q"', roles: 'designer' });
  writeConfig(root, serializeConfig(doc));
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.roles.architect, ['arch@example.com']);
  assert.deepEqual(loaded.doc.agent_scope_map[1], { agent: 'yes', type: 'true', reads: '#hash: "q"', roles: ['designer'] });
  assert.equal(serializeConfig(loaded.doc), serializeConfig(doc), 'deterministic');
});

// --- migrateFromClaudeMd ---------------------------------------------------

test('migrateFromClaudeMd: parses fences, role lists, table; warns on a bad row', () => {
  const { doc, warnings, missing, blocks } = migrateFromClaudeMd(CLAUDE_MD);
  assert.deepEqual(missing, []);
  assert.equal(doc.platform, 'gitlab');
  assert.equal(doc.default_branch, 'trunk');
  assert.deepEqual(doc.roles, { architect: ['a@x.com', 'b@x.com'], developers: [], designers: ['d@x.com'] });
  assert.deepEqual(doc.agent_scope_map, [{ agent: 'm', type: 'context-tool', reads: 'a.js, b.js', roles: ['architect', 'developer'] }]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(blocks.map((b) => b.name), ['Git Platform', 'Role Assignments', 'Agent Scope Map']);
  assert.deepEqual(blocks[0], { name: 'Git Platform', start: 5, end: 8 });
});

test('migrateFromClaudeMd: missing required keys are named; empty input never throws', () => {
  const noArch = CLAUDE_MD.replace('architect:  a@x.com, b@x.com', 'architect:  []').replace('default_branch: trunk\n', '');
  assert.deepEqual(migrateFromClaudeMd(noArch).missing, ['default_branch', 'roles.architect']);
  assert.deepEqual(migrateFromClaudeMd('').missing, ['platform', 'default_branch', 'roles.architect']);
  assert.deepEqual(migrateFromClaudeMd(undefined).missing, ['platform', 'default_branch', 'roles.architect']);
});

// Guard: config lives only in .rad/config.yml. Fails if a config block
// (### Git Platform / ### Role Assignments / ### Agent Scope Map) returns to
// CLAUDE.md or to AGENTS.md (the conventions file CLAUDE.md imports).
const CONVENTIONS_FILES = ['CLAUDE.md', 'AGENTS.md'];

test("this repo's CLAUDE.md and AGENTS.md carry no config; .rad/config.yml is the source", async () => {
  const committed = await loadConfig(REPO_ROOT);
  assert.equal(committed.ok, true, JSON.stringify(committed.errors));
  assert.equal(committed.doc.roles.architect[0], 'sean@torchcodelab.com');
  for (const file of CONVENTIONS_FILES) {
    const { missing, blocks } = migrateFromClaudeMd(readFileSync(join(REPO_ROOT, file), 'utf8'));
    assert.deepEqual(missing, ['platform', 'default_branch', 'roles.architect'], file);
    assert.deepEqual(blocks, [], file);
  }
});

// --- rad config verbs ------------------------------------------------------

test('rad config get: scalar, list, scope rows, absent key, usage', async () => {
  const root = tempRoot();
  writeConfig(root, serializeConfig(VALID));
  assert.deepEqual(await runConfig(['get', 'default_branch'], root), { code: 0, stdout: 'main\n', stderr: '' });
  assert.equal((await runConfig(['get', 'roles.architect'], root)).stdout, 'arch@example.com\n');
  const rows = await runConfig(['get', 'agent_scope_map'], root);
  assert.deepEqual(JSON.parse(rows.stdout.trim()), VALID.agent_scope_map[0]);
  const absent = await runConfig(['get', 'roles.nobody'], root);
  assert.equal(absent.code, 3);
  assert.equal(absent.stdout, '');
  assert.equal((await runConfig(['get'], root)).code, 2);
  assert.equal((await runConfig(['bogus'], root)).code, 2);
  assert.equal((await runConfig([], root)).code, 2);
});

test('rad config get/validate: missing file → exit 1 with the init/migrate hint', async () => {
  const root = tempRoot();
  for (const argv of [['get', 'platform'], ['validate']]) {
    const r = await runConfig(argv, root);
    assert.equal(r.code, 1);
    assert.match(r.stderr,
      /rad: no \.rad\/config\.yml — run 'rad config init' \(new install\) or 'rad config migrate' \(from a pre-#87 CLAUDE\.md\)/);
  }
});

test('rad config validate: valid → 0, invalid → 1 listing errors, extra arg → 2', async () => {
  const root = tempRoot();
  writeConfig(root, serializeConfig(VALID));
  const ok = await runConfig(['validate'], root);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /✓ \.rad\/config\.yml valid/);
  writeConfig(root, `${serializeConfig(VALID)}surprise: 1\n`);
  const bad = await runConfig(['validate'], root);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown top-level key 'surprise'/);
  assert.equal((await runConfig(['get', 'platform'], root)).code, 1);
  assert.equal((await runConfig(['validate', 'x'], root)).code, 2);
});

test('rad config migrate: writes, refuses overwrite without --force, never edits CLAUDE.md', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'CLAUDE.md'), CLAUDE_MD);
  const first = await runConfig(['migrate'], root);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Git Platform: lines 5-8/);
  assert.equal((await loadConfig(root)).doc.platform, 'gitlab');
  const again = await runConfig(['migrate'], root);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists — pass --force/);
  assert.equal((await runConfig(['migrate', '--force'], root)).code, 0);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), CLAUDE_MD);
});

test('rad config migrate: --from, missing required key, placeholder, bad argv', async () => {
  const root = tempRoot();
  const from = join(root, 'other.md');
  writeFileSync(from, CLAUDE_MD.replace('platform: gitlab', 'platform: '));
  const missing = await runConfig(['migrate', '--from', from], root);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /missing required key\(s\): platform/);
  writeFileSync(from, CLAUDE_MD.replace('a@x.com, b@x.com', '[your GitHub username]'));
  const placeholder = await runConfig(['migrate', '--from', from], root);
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.stderr, /template placeholder/);
  assert.equal(existsSync(join(root, CONFIG_PATH)), false, 'nothing written on failure');
  assert.equal((await runConfig(['migrate', '--from', join(root, 'nope.md')], root)).code, 1);
  assert.equal((await runConfig(['migrate', '--from'], root)).code, 2);
  assert.equal((await runConfig(['migrate', '--what'], root)).code, 2);
});

// --- rad config init (#87 part 2) -----------------------------------------

/** A temp git repo whose repo-local user.email is `email` (never the developer's real one). */
function gitRepoWithEmail(email) {
  const root = tempRoot();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', email], { cwd: root });
  return root;
}

/** Run with no global/system git identity: empty HOME, no global or system config. */
async function withNoGitIdentity(fn) {
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'XDG_CONFIG_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: tempRoot(), XDG_CONFIG_HOME: tempRoot(),
  });
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('rad config init: flags write a valid config and print the summary line', async () => {
  const root = tempRoot();
  const r = await runConfig(['init', '--architect', 'lead@x.com', '--platform', 'gitlab', '--default-branch', 'trunk'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'rad config init: wrote .rad/config.yml (architect=lead@x.com, platform=gitlab, default_branch=trunk)\n');
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc, {
    version: 1, platform: 'gitlab', default_branch: 'trunk',
    roles: { architect: ['lead@x.com'], developers: [], designers: [] }, agent_scope_map: [],
  });
  assert.equal((await runConfig(['validate'], root)).code, 0);
});

test('rad config init: architect defaults to the repo git user.email; platform/branch default manual/main', async () => {
  const root = gitRepoWithEmail('git-arch@example.com');
  const r = await runConfig(['init'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /architect=git-arch@example\.com, platform=manual, default_branch=main/);
  assert.equal((await runConfig(['validate'], root)).code, 0);
  assert.deepEqual((await runConfig(['get', 'roles.architect'], root)).stdout, 'git-arch@example.com\n');
});

test('rad config init: --architect overrides the git email', async () => {
  const root = gitRepoWithEmail('git-arch@example.com');
  const r = await runConfig(['init', '--architect', 'override@x.com'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await loadConfig(root)).doc.roles.architect[0], 'override@x.com');
});

test('rad config init: no identity → exit 1 naming --architect, nothing written', async () => {
  const root = tempRoot();
  const r = await withNoGitIdentity(() => runConfig(['init'], root));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no architect identity .*pass --architect <id>/);
  assert.equal(existsSync(join(root, CONFIG_PATH)), false);
});

test('rad config init: invalid platform, placeholder and empty architect → exit 1, nothing written', async () => {
  const cases = [
    { argv: ['--architect', 'a@x.com', '--platform', 'bogus'], err: /platform/ },
    { argv: ['--architect', '[your GitHub username]'], err: /template placeholder/ },
    { argv: ['--architect', ''], err: /roles\.architect\[0\] must be a non-empty string/ },
  ];
  for (const { argv, err } of cases) {
    const root = tempRoot();
    const r = await runConfig(['init', ...argv], root);
    assert.equal(r.code, 1, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /refusing to write an invalid config/);
    assert.match(r.stderr, err);
    assert.equal(existsSync(join(root, CONFIG_PATH)), false, `nothing written for ${argv.join(' ')}`);
  }
});

test('rad config init: refuses to overwrite without --force; --force overwrites', async () => {
  const root = tempRoot();
  writeConfig(root, serializeConfig(VALID));
  const before = readFileSync(join(root, CONFIG_PATH), 'utf8');
  const refused = await runConfig(['init', '--architect', 'new@x.com'], root);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already exists — pass --force/);
  assert.equal(readFileSync(join(root, CONFIG_PATH), 'utf8'), before);
  const forced = await runConfig(['init', '--architect', 'new@x.com', '--force'], root);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal((await loadConfig(root)).doc.roles.architect[0], 'new@x.com');
  assert.equal((await runConfig(['validate'], root)).code, 0);
});

test('rad config init: unknown flag or a flag missing its value → exit 2 usage', async () => {
  const root = tempRoot();
  for (const argv of [['--what'], ['--architect'], ['--platform'], ['--default-branch'], ['--architect', '--force']]) {
    const r = await runConfig(['init', ...argv], root);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /Usage: .*rad config init/);
  }
  assert.equal(existsSync(join(root, CONFIG_PATH)), false);
});

// --- rad config init agent flags (#186 part 3a, AC#5) -----------------------

const INIT_BASE = ['init', '--architect', 'lead@x.com'];
const INIT_SUMMARY = 'rad config init: wrote .rad/config.yml (architect=lead@x.com, platform=manual, default_branch=main';

/** Run init with `flags`, assert success, the summary suffix and the written agent: block. */
async function assertInitAgent(flags, agent, suffix) {
  const root = tempRoot();
  const r = await runConfig([...INIT_BASE, ...flags], root);
  assert.equal(r.code, 0, `${flags.join(' ')}: ${r.stderr}`);
  assert.equal(r.stdout, `${INIT_SUMMARY}${suffix})\n`);
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.agent, agent);
  assert.equal((await runConfig(['validate'], root)).code, 0);
  return root;
}

test('rad config init --agent: each preset writes its AGENT_PRESETS block and names it in the summary', async () => {
  for (const [name, preset] of Object.entries(AGENT_PRESETS)) {
    const root = await assertInitAgent(['--agent', name], preset, `, agent=command:${preset.command}`);
    assert.equal((await runConfig(['get', 'agent.command'], root)).stdout, `${preset.command}\n`);
  }
});

test('rad config init --agent-cmd: a custom command (default command adapter) and acp', async () => {
  const root = await assertInitAgent(['--agent-cmd', 'my-agent --run'], { adapter: 'command', command: 'my-agent --run' },
    ', agent=command:my-agent --run');
  assert.equal((await runConfig(['get', 'agent.command'], root)).stdout, 'my-agent --run\n');
  await assertInitAgent(['--agent-cmd', 'agent --acp', '--agent-adapter', 'acp'], { adapter: 'acp', command: 'agent --acp' },
    ', agent=acp:agent --acp');
  await assertInitAgent(['--agent-adapter', 'command', '--agent-cmd', 'x'], { adapter: 'command', command: 'x' },
    ', agent=command:x');
});

test('rad config init --agent-adapter sdk: writes { adapter: sdk } with no command', async () => {
  await assertInitAgent(['--agent-adapter', 'sdk'], { adapter: 'sdk' }, ', agent=sdk');
});

test('rad config init: without agent flags the summary is unchanged and no agent: key is written', async () => {
  const root = tempRoot();
  const r = await runConfig(INIT_BASE, root);
  assert.equal(r.stdout, `${INIT_SUMMARY})\n`);
  assert.equal('agent' in (await loadConfig(root)).doc, false);
  assert.doesNotMatch(readFileSync(join(root, CONFIG_PATH), 'utf8'), /^agent:/m);
});

test('rad config init: contradictory or incomplete agent flags → exit 2 usage, nothing written', async () => {
  const cases = [
    { argv: ['--agent', 'gemini'], err: /unknown --agent 'gemini' \(expected claude \| codex\)/ },
    { argv: ['--agent', 'claude', '--agent-cmd', 'x'], err: /--agent cannot be combined/ },
    { argv: ['--agent', 'claude', '--agent-adapter', 'sdk'], err: /--agent cannot be combined/ },
    { argv: ['--agent-adapter', 'sdk', '--agent-cmd', 'x'], err: /sdk takes no --agent-cmd/ },
    { argv: ['--agent-adapter', 'command'], err: /--agent-adapter command requires --agent-cmd/ },
    { argv: ['--agent-adapter', 'acp'], err: /--agent-adapter acp requires --agent-cmd/ },
    { argv: ['--agent-adapter', 'grpc', '--agent-cmd', 'x'], err: /unknown --agent-adapter 'grpc' \(expected command \| sdk \| acp\)/ },
    { argv: ['--agent'], err: /--agent requires a value/ },
    { argv: ['--agent-cmd'], err: /--agent-cmd requires a value/ },
    { argv: ['--agent-adapter'], err: /--agent-adapter requires a value/ },
  ];
  for (const { argv, err } of cases) {
    const root = tempRoot();
    const r = await runConfig([...INIT_BASE, ...argv], root);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, err);
    assert.match(r.stderr, /Usage: .*rad config init .*--agent <claude\|codex>/);
    assert.equal(existsSync(join(root, CONFIG_PATH)), false, `nothing written for ${argv.join(' ')}`);
  }
});

test('rad config init: an empty --agent-cmd is a value, rejected by validation (exit 1, nothing written)', async () => {
  const root = tempRoot();
  const r = await runConfig([...INIT_BASE, '--agent-cmd', ''], root);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /agent\.command must be a non-empty string/);
  assert.equal(existsSync(join(root, CONFIG_PATH)), false);
});

// --- capabilities.deny (#85) -------------------------------------------------

const withCaps = (capabilities) => ({ ...clone(VALID), capabilities });

test('capabilities.deny: empty list and known classes are valid', () => {
  assert.deepEqual(validateConfig(withCaps({ deny: [] })), []);
  assert.deepEqual(validateConfig(withCaps({ deny: ['net', 'mcp'] })), []);
  assert.deepEqual(validateConfig(withCaps({})), [], 'deny is optional under capabilities');
});

test('capabilities.deny: unknown class is an error naming it', () => {
  const errors = validateConfig(withCaps({ deny: ['net', 'network'] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /capabilities\.deny\[1\] is not a capability class \(got "network"\)/);
});

test('capabilities.deny: a lone string normalizes to a list (same rule as roles); other non-lists are errors', () => {
  assert.deepEqual(validateConfig(withCaps({ deny: 'net' })), []);
  assert.match(validateConfig(withCaps({ deny: 'bogus' })).join('\n'), /capabilities\.deny\[0\]/);
  for (const deny of [{ net: true }, 7, null]) {
    assert.deepEqual(validateConfig(withCaps({ deny })), ['capabilities.deny must be a list'], JSON.stringify(deny));
  }
});

test('capabilities: unknown key under capabilities is an error', () => {
  assert.deepEqual(validateConfig(withCaps({ deny: [], allow: ['net'] })), ['unknown key capabilities.allow']);
});

test('capabilities: non-mapping is an error', () => {
  for (const caps of [['net'], 'net', null, 3]) {
    assert.deepEqual(validateConfig(withCaps(caps)), ['capabilities must be a mapping'], JSON.stringify(caps));
  }
});

test('capabilities: serialize → loadConfig round-trips the deny list', async () => {
  const doc = withCaps({ deny: ['net', 'mcp'] });
  const text = serializeConfig(doc);
  assert.match(text, /\ncapabilities:\n {2}deny: \[net, mcp\]\n$/);
  const root = tempRoot();
  writeConfig(root, text);
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.capabilities, { deny: ['net', 'mcp'] });
  assert.equal(serializeConfig(loaded.doc), text);
});

test('capabilities: a lone-string deny loads as a list', async () => {
  const root = tempRoot();
  writeConfig(root, `${serializeConfig(VALID)}capabilities:\n  deny: net\n`);
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.capabilities.deny, ['net']);
});

test('capabilities: a config without the key serializes with no capabilities block', async () => {
  const text = serializeConfig(VALID);
  assert.doesNotMatch(text, /capabilities/);
  assert.equal(serializeConfig({ ...clone(VALID), capabilities: undefined }), text);
  const root = tempRoot();
  writeConfig(root, text);
  const loaded = await loadConfig(root);
  assert.equal(Object.hasOwn(loaded.doc, 'capabilities'), false);
});

test('capabilities: the committed .rad/config.yml still validates', async () => {
  const loaded = await loadConfig(REPO_ROOT);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
});

// ---------------------------------------------------------------------------
// settings: block (#71 part 2a)
// ---------------------------------------------------------------------------

const withSettings = (settings) => ({ ...clone(VALID), settings });
/** The real RAD_HIGH_RISK_DEFAULT_PATTERN value: full of regex metacharacters. */
const DEFAULT_PATTERN = '(^|[/_.-])(o?auth(n|z|entication|enticate|orization|orize)?|payments?|billing|migrations?|secrets?|credentials?|tokens?)([/_.-]|[A-Z0-9]|$)';

/** serialize → write → loadConfig; returns { text, loaded }. */
async function roundTrip(doc) {
  const text = serializeConfig(doc);
  const root = tempRoot();
  writeConfig(root, text);
  return { text, loaded: await loadConfig(root) };
}

test('settings: both keys, either key alone, and an empty mapping are valid', () => {
  assert.deepEqual(validateConfig(withSettings({ high_risk_patterns: DEFAULT_PATTERN, hooks_dir: 'scripts/hooks' })), []);
  assert.deepEqual(validateConfig(withSettings({ hooks_dir: 'my hooks' })), []);
  assert.deepEqual(validateConfig(withSettings({ high_risk_patterns: 'auth' })), []);
  assert.deepEqual(validateConfig(withSettings({})), []);
});

test('settings: non-mapping is an error', () => {
  for (const settings of [['a'], 'a', null, 3]) {
    assert.deepEqual(validateConfig(withSettings(settings)), ['settings must be a mapping'], JSON.stringify(settings));
  }
});

test('settings: unknown key is an error naming it', () => {
  assert.deepEqual(validateConfig(withSettings({ hooks_dir: 'h', hook_dir: 'h' })), ['unknown key settings.hook_dir']);
});

test('settings: a non-string or empty value is an error naming the key', () => {
  for (const value of ['', '   ', 7, true, null, ['a'], { a: 1 }]) {
    for (const key of ['high_risk_patterns', 'hooks_dir']) {
      assert.deepEqual(validateConfig(withSettings({ [key]: value })), [`settings.${key} must be a non-empty string`],
        `${key}=${JSON.stringify(value)}`);
    }
  }
});

test('settings.hooks_dir: a leading dash or a line break is malformed', () => {
  for (const hooks of ['-x', '--hooks', 'a\nb', 'a\rb']) {
    const errors = validateConfig(withSettings({ hooks_dir: hooks }));
    assert.equal(errors.length, 1, JSON.stringify(hooks));
    assert.match(errors[0], /^settings\.hooks_dir must not start with '-' or contain a line break$/);
  }
  assert.deepEqual(validateConfig(withSettings({ hooks_dir: 'a-b/-c' })), [], 'a dash not in first position is fine');
});

test('settings.high_risk_patterns: a line break is an error', () => {
  for (const pattern of ['auth\nbilling', 'auth\r']) {
    assert.deepEqual(validateConfig(withSettings({ high_risk_patterns: pattern })),
      ['settings.high_risk_patterns must not contain a line break'], JSON.stringify(pattern));
  }
});

test('settings: absent → no settings block, byte-identical to before', async () => {
  const text = serializeConfig(VALID);
  assert.doesNotMatch(text, /settings/);
  assert.equal(serializeConfig({ ...clone(VALID), settings: undefined }), text);
  const { loaded } = await roundTrip(VALID);
  assert.equal(Object.hasOwn(loaded.doc, 'settings'), false);
});

test('settings: the real default pattern round-trips losslessly through serialize → loadConfig', async () => {
  const settings = { hooks_dir: '.rad/hooks', high_risk_patterns: DEFAULT_PATTERN };
  const { text, loaded } = await roundTrip(withSettings(settings));
  assert.match(text, /\nsettings:\n {2}high_risk_patterns: "[^\n]+"\n {2}hooks_dir: "\.rad\/hooks"\n$/, 'fixed key order, last block');
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.settings, { high_risk_patterns: DEFAULT_PATTERN, hooks_dir: '.rad/hooks' });
  assert.equal(serializeConfig(loaded.doc), text);
});

test('settings: patterns with quotes, backslashes and YAML indicators round-trip', async () => {
  for (const pattern of [`it's "quoted"`, 'a\\.b\\d+', '#comment-like', ': colon', '- dash', '* star', 'true', '~']) {
    const { loaded } = await roundTrip(withSettings({ high_risk_patterns: pattern }));
    assert.equal(loaded.ok, true, `${pattern}: ${JSON.stringify(loaded.errors)}`);
    assert.equal(loaded.doc.settings.high_risk_patterns, pattern);
  }
});

test('settings: only set keys are written; capabilities precedes settings', async () => {
  const doc = { ...withSettings({ hooks_dir: 'h' }), capabilities: { deny: ['net'] } };
  const { text, loaded } = await roundTrip(doc);
  assert.match(text, /\ncapabilities:\n {2}deny: \[net\]\nsettings:\n {2}hooks_dir: h\n$/);
  assert.deepEqual(loaded.doc.settings, { hooks_dir: 'h' });
});

test('settings: an empty mapping serializes as `settings: {}` and loads back as {}', async () => {
  const { text, loaded } = await roundTrip(withSettings({}));
  assert.match(text, /\nsettings: \{\}\n$/);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.settings, {});
});

test('settings: rad config validate rejects a bad settings block, naming the key', async () => {
  const root = tempRoot();
  writeConfig(root, `${serializeConfig(VALID)}settings:\n  hooks_dir: "-x"\n  nope: y\n`);
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join('\n'), /settings\.hooks_dir/);
  assert.match(loaded.errors.join('\n'), /unknown key settings\.nope/);
});

// ---------------------------------------------------------------------------
// seedSettings / writeConfigAtomic (preset install, #71 part 2b)
// ---------------------------------------------------------------------------

/** The real default high-risk pattern: YAML metacharacters (|, [, ], :, ?, $) included. */
const DEFAULT_HIGH_RISK = '(^|[/_.-])(o?auth(n|z|entication|enticate|orization|orize)?|payments?|billing|migrations?|secrets?|credentials?|tokens?)([/_.-]|[A-Z0-9]|$)';
const BASE_TEXT = `# operator comment, kept byte-for-byte\n${serializeConfig(VALID)}# trailing note\n`;

/** Seed, write and load back; asserts the original text is an exact prefix. */
async function seedAndLoad(text, settings) {
  const got = await seedSettings(text, settings);
  assert.equal(got.ok, true, got.error);
  assert.ok(got.text.startsWith(text), 'original text is an exact prefix');
  const root = tempRoot();
  writeConfigAtomic(root, got.text);
  return { got, loaded: await loadConfig(root) };
}

test('settingsErrors — exported; undefined is valid, unknown keys and bad values are named', () => {
  assert.deepEqual(settingsErrors(undefined), []);
  assert.deepEqual(settingsErrors({ hooks_dir: 'h' }), []);
  assert.deepEqual(settingsErrors({ nope: 1 }), ['unknown key settings.nope']);
  assert.deepEqual(settingsErrors('x'), ['settings must be a mapping']);
});

test('seedSettings — no settings block: every key appended as a block; comments kept; loads back', async () => {
  const settings = { hooks_dir: 'scripts/hooks', high_risk_patterns: 'auth' };
  const { got, loaded } = await seedAndLoad(BASE_TEXT, settings);
  assert.deepEqual([got.seeded, got.kept, got.unseeded], [['high_risk_patterns', 'hooks_dir'], [], []]);
  assert.equal(got.text, `${BASE_TEXT}settings:\n  high_risk_patterns: auth\n  hooks_dir: scripts/hooks\n`);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.doc.settings, settings);
});

test('seedSettings — config text without a trailing newline gets one before and after the block', async () => {
  const text = serializeConfig(VALID).replace(/\n$/, '');
  const { got, loaded } = await seedAndLoad(text, { hooks_dir: 'h' });
  assert.equal(got.text, `${text}\nsettings:\n  hooks_dir: h\n`);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
});

test('seedSettings — the real default high-risk pattern round-trips through YAML', async () => {
  const { got, loaded } = await seedAndLoad(BASE_TEXT, { high_risk_patterns: DEFAULT_HIGH_RISK });
  assert.deepEqual(got.seeded, ['high_risk_patterns']);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  assert.equal(loaded.doc.settings.high_risk_patterns, DEFAULT_HIGH_RISK);
});

test('seedSettings — settings block present with the same key: kept, text unchanged', async () => {
  const text = `${BASE_TEXT}settings:\n  hooks_dir: mine  # operator choice\n`;
  const got = await seedSettings(text, { hooks_dir: 'theirs' });
  assert.deepEqual(got, { ok: true, text, seeded: [], kept: ['hooks_dir'], unseeded: [] });
});

test('seedSettings — settings block present but missing the key: unseeded, text unchanged', async () => {
  const text = `${BASE_TEXT}settings:\n  hooks_dir: mine\n`;
  const got = await seedSettings(text, { hooks_dir: 'x', high_risk_patterns: 'auth' });
  assert.deepEqual(got, { ok: true, text, seeded: [], kept: ['hooks_dir'], unseeded: ['high_risk_patterns'] });
  const empty = `${BASE_TEXT}settings: {}\n`;
  assert.deepEqual(await seedSettings(empty, { hooks_dir: 'x' }),
    { ok: true, text: empty, seeded: [], kept: [], unseeded: ['hooks_dir'] });
});

test('seedSettings — nothing to seed (undefined or empty settings): text unchanged', async () => {
  for (const settings of [undefined, {}]) {
    assert.deepEqual(await seedSettings(BASE_TEXT, settings), { ok: true, text: BASE_TEXT, seeded: [], kept: [], unseeded: [] });
  }
});

test('seedSettings — errors: invalid preset settings, unparseable or non-mapping config, invalid result', async () => {
  assert.match((await seedSettings(BASE_TEXT, { nope: 'x' })).error, /preset settings are invalid: unknown key settings\.nope/);
  assert.match((await seedSettings('version: [\n', { hooks_dir: 'h' })).error, /cannot parse \.rad\/config\.yml/);
  assert.match((await seedSettings('- a\n', { hooks_dir: 'h' })).error, /not a YAML mapping/);
  assert.match((await seedSettings('version: 1\n', { hooks_dir: 'h' })).error, /seeded config is invalid: .*platform is required/);
  assert.match((await seedSettings(`${BASE_TEXT}settings: nope\n`, { hooks_dir: 'h' })).error, /settings must be a mapping/);
  assert.match((await seedSettings(42, { hooks_dir: 'h' })).error, /config text must be a string/);
});

test('writeConfigAtomic — writes the exact text and leaves no temp file', () => {
  const root = tempRoot();
  writeConfigAtomic(root, 'a: 1\n');
  writeConfigAtomic(root, BASE_TEXT);
  assert.equal(readFileSync(join(root, CONFIG_PATH), 'utf8'), BASE_TEXT);
  assert.equal(existsSync(join(root, `${CONFIG_PATH}.tmp`)), false);
});

// --- agent: block (#186 part 3a) -------------------------------------------

const withAgent = (agent) => ({ ...clone(VALID), agent });

test('AGENT_PRESETS and AGENT_ADAPTERS: the named presets and adapters', () => {
  assert.deepEqual(AGENT_ADAPTERS, ['command', 'sdk', 'acp']);
  assert.deepEqual(AGENT_PRESETS, {
    claude: { adapter: 'command', command: 'claude -p' },
    codex: { adapter: 'command', command: 'codex exec' },
  });
  for (const preset of Object.values(AGENT_PRESETS)) assert.deepEqual(agentErrors(preset), []);
});

test('validateConfig: agent accepts command, acp and sdk adapters; absent agent is fine', () => {
  assert.deepEqual(validateConfig(withAgent({ adapter: 'command', command: 'claude -p' })), []);
  assert.deepEqual(validateConfig(withAgent({ adapter: 'acp', command: 'gemini --acp' })), []);
  assert.deepEqual(validateConfig(withAgent({ adapter: 'sdk' })), []);
  assert.deepEqual(validateConfig(clone(VALID)), []);
});

test('validateConfig: agent fails closed on bad shapes', () => {
  const cases = [
    [{ adapter: 'command', command: 'x', model: 'y' }, /unknown key agent\.model/],
    [{ adapter: 'bogus', command: 'x' }, /agent\.adapter must be one of command \| sdk \| acp \(got "bogus"\)/],
    [{ command: 'x' }, /agent\.adapter is required/],
    [{ adapter: 'command' }, /agent\.command is required when agent\.adapter is command/],
    [{ adapter: 'acp' }, /agent\.command is required when agent\.adapter is acp/],
    [{ adapter: 'command', command: '   ' }, /agent\.command must be a non-empty string/],
    [{ adapter: 'command', command: 42 }, /agent\.command must be a non-empty string/],
    [{ adapter: 'sdk', command: 'claude -p' }, /agent\.command must be absent when agent\.adapter is sdk/],
    [{ adapter: 'command', command: 'claude -p\nrm -rf /' }, /agent\.command must not contain a line break/],
    ['claude', /agent must be a mapping/],
    [['command'], /agent must be a mapping/],
    [null, /agent must be a mapping/],
  ];
  for (const [agent, err] of cases) {
    const errors = validateConfig(withAgent(agent));
    assert.ok(errors.some((e) => err.test(e)), `${JSON.stringify(agent)} → ${JSON.stringify(errors)}`);
  }
});

test('serializeConfig: agent block round-trips through loadConfig (serialize → parse → validate → equal)', async () => {
  for (const agent of [AGENT_PRESETS.claude, { adapter: 'acp', command: 'gemini "--acp"' }, { adapter: 'sdk' }]) {
    const doc = withAgent({ ...agent });
    const text = serializeConfig(doc);
    assert.match(text, /\ndefault_branch: main\nagent:\n  adapter: /, 'agent block follows default_branch');
    if (agent.adapter === 'sdk') assert.doesNotMatch(text, /command:/, 'sdk writes no command line');
    const root = tempRoot();
    writeConfig(root, text);
    const loaded = await loadConfig(root);
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.doc.agent, agent);
  }
  assert.match(serializeConfig(withAgent(AGENT_PRESETS.claude)), /\n  command: "claude -p"\n/);
  assert.doesNotMatch(serializeConfig(clone(VALID)), /^agent:/m, 'block omitted when unset');
});

test('getConfigValue: agent.command and agent.adapter', () => {
  const doc = withAgent({ ...AGENT_PRESETS.codex });
  assert.deepEqual(getConfigValue(doc, 'agent.command'), { found: true, value: 'codex exec' });
  assert.deepEqual(getConfigValue(doc, 'agent.adapter'), { found: true, value: 'command' });
  assert.deepEqual(getConfigValue(clone(VALID), 'agent.command'), { found: false });
});

test('buildInitConfig: includes agent only when given, as a copy', () => {
  const without = buildInitConfig({ architect: 'a@x.com' });
  assert.equal(Object.hasOwn(without, 'agent'), false);
  assert.deepEqual(validateConfig(without), []);
  const withIt = buildInitConfig({ architect: 'a@x.com', agent: AGENT_PRESETS.claude });
  assert.deepEqual(withIt.agent, { adapter: 'command', command: 'claude -p' });
  assert.notEqual(withIt.agent, AGENT_PRESETS.claude);
  assert.deepEqual(validateConfig(withIt), []);
});

const withKinds = (kinds) => ({ ...clone(VALID), playbook_kinds: kinds });

test('playbook_kinds: absent is valid and resolves to the default', () => {
  assert.deepEqual(validateConfig(clone(VALID)), []);
  assert.deepEqual(resolvePlaybookKinds(clone(VALID)), DEFAULT_PLAYBOOK_KINDS);
  assert.deepEqual(DEFAULT_PLAYBOOK_KINDS, ['env-knob', 'hook-point', 'event-type', 'severity-pattern']);
});

test('playbook_kinds: a valid list is accepted and resolves to itself', () => {
  const doc = withKinds(['env-knob', 'a1']);
  assert.deepEqual(validateConfig(doc), []);
  assert.deepEqual(resolvePlaybookKinds(doc), ['env-knob', 'a1']);
});

test('playbook_kinds: an empty list, a non-array, a duplicate, an empty or non-kebab string are each an error', () => {
  const bad = [[], 'env-knob', {}, ['a', 'a'], [''], ['Env'], ['1a'], ['a_b'], ['-a'], [7], [null]];
  for (const kinds of bad) {
    assert.ok(validateConfig(withKinds(kinds)).some((e) => e.startsWith('playbook_kinds')),
      `expected a playbook_kinds error for ${JSON.stringify(kinds)}`);
  }
});

test('playbook_kinds: serialized only when set, and round trips', async () => {
  assert.doesNotMatch(serializeConfig(clone(VALID)), /playbook_kinds/);
  const text = serializeConfig(withKinds(['env-knob', 'hook-point']));
  assert.match(text, /\nplaybook_kinds: \[env-knob, hook-point\]\n$/);
  const root = mkdtempSync(join(tmpdir(), 'rad-kinds-'));
  mkdirSync(join(root, '.rad'));
  writeFileSync(join(root, CONFIG_PATH), text);
  const loaded = await loadConfig(root);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.doc.playbook_kinds, ['env-knob', 'hook-point']);
});
