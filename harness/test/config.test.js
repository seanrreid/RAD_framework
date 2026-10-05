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
// (### Git Platform / ### Role Assignments / ### Agent Scope Map) returns to CLAUDE.md.
test("this repo's CLAUDE.md carries no config; .rad/config.yml is the source", async () => {
  const committed = await loadConfig(REPO_ROOT);
  assert.equal(committed.ok, true, JSON.stringify(committed.errors));
  assert.equal(committed.doc.roles.architect[0], 'sean@torchcodelab.com');
  const { missing, blocks } = migrateFromClaudeMd(readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8'));
  assert.deepEqual(missing, ['platform', 'default_branch', 'roles.architect']);
  assert.deepEqual(blocks, []);
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
