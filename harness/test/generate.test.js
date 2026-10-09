// Tests for harness/generate.js: source parsing, rendering, errors, determinism,
// and the plan/apply layer (drift, orphans, conflicts) (#171 part 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  GENERATED_MARKER, OUTPUT_ROOTS, readSources, renderOutputs, planGenerate, applyGenerate, hasGeneratedMarker,
} from '../generate.js';
import { generatedSource } from '../generated-marker.js';

const SKILL_BOTH = `---
name: review-x
description: Review things.
targets:
  claude: command:team/review-x
  codex: skill
---

Review {{args}} carefully.
`;

const AGENT = `---
name: helper
description: Helps with things.
model: claude-sonnet-4-6
tools: Read, Bash
purpose: authority
roles: [architect, developer]
codex:
  sandbox_mode: read-only
---

You are a helper.
`;

/** A temp root holding `files` (rel -> text); `fn` gets the root. Cleaned up after. */
async function withRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rad-generate-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Read + render the sources under `root`; asserts both succeed and returns the outputs by path. */
async function generated(root) {
  const read = await readSources(root);
  assert.equal(read.ok, true, JSON.stringify(read.errors));
  const rendered = renderOutputs(read.sources);
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  return Object.fromEntries(rendered.outputs.map((o) => [o.path, o.content]));
}

/** Assert the sources in `files` fail (read or render) with an error matching `re`. */
async function assertSourceError(files, re) {
  await withRoot(files, async (root) => {
    const read = await readSources(root);
    const errors = read.ok ? renderOutputs(read.sources).errors : read.errors;
    assert.ok(errors, `expected an error matching ${re}`);
    assert.match(errors.join('\n'), re);
  });
}

const skillSource = (name, targets, body = 'Body.\n') =>
  `---\nname: ${name}\ndescription: A skill.\ntargets:\n${targets.map((t) => `  ${t}`).join('\n')}\n---\n\n${body}`;
const agentSource = (fm, body = 'Body.\n') => `---\n${fm}\n---\n\n${body}`;

test('skill: emits a Claude command and a Codex skill with {{args}} substituted per target', async () => {
  await withRoot({ '.rad/skills/review-x/SKILL.md': SKILL_BOTH }, async (root) => {
    const out = await generated(root);
    assert.deepEqual(Object.keys(out), ['.agents/skills/review-x/SKILL.md', '.claude/commands/team/review-x.md']);
    const src = '.rad/skills/review-x/SKILL.md';
    assert.equal(out['.claude/commands/team/review-x.md'],
      `---\ndescription: "Review things."\n---\n<!-- ${GENERATED_MARKER} (source: ${src}) -->\n\nReview $ARGUMENTS carefully.\n`);
    assert.equal(out['.agents/skills/review-x/SKILL.md'],
      `---\nname: review-x\ndescription: "Review things."\n---\n<!-- ${GENERATED_MARKER} (source: ${src}) -->\n\n`
      + 'Review the text the user wrote after the skill name carefully.\n');
  });
});

test('skill: codex: none emits only the Claude output; claude: skill emits .claude/skills', async () => {
  await withRoot({ '.rad/skills/solo/SKILL.md': skillSource('solo', ['claude: skill', 'codex: none']) }, async (root) => {
    const out = await generated(root);
    assert.deepEqual(Object.keys(out), ['.claude/skills/solo/SKILL.md']);
    assert.match(out['.claude/skills/solo/SKILL.md'], /^---\nname: solo\ndescription: "A skill."\n---\n<!-- /);
  });
});

test('skill: claude.md and codex.md override the body for their target only', async () => {
  const files = {
    '.rad/skills/ov/SKILL.md': skillSource('ov', ['claude: skill', 'codex: skill'], 'Shared {{args}}.\n'),
    '.rad/skills/ov/codex.md': 'Codex only {{args}}.\n',
  };
  await withRoot(files, async (root) => {
    const out = await generated(root);
    assert.match(out['.claude/skills/ov/SKILL.md'], /\n\nShared \$ARGUMENTS\.\n$/);
    assert.match(out['.agents/skills/ov/SKILL.md'], /\n\nCodex only the text the user wrote after the skill name\.\n$/);
  });
  await withRoot({ ...files, '.rad/skills/ov/claude.md': 'Claude only.\n' }, async (root) => {
    assert.match((await generated(root))['.claude/skills/ov/SKILL.md'], /\n\nClaude only\.\n$/);
  });
});

test('skill: codex_implicit: false emits agents/openai.yaml with the policy', async () => {
  const src = '.rad/skills/gate/SKILL.md';
  await withRoot({ [src]: skillSource('gate', ['claude: skill', 'codex: skill', 'codex_implicit: false']) }, async (root) => {
    const out = await generated(root);
    assert.equal(out['.agents/skills/gate/agents/openai.yaml'],
      `# ${GENERATED_MARKER} (source: ${src})\npolicy:\n  allow_implicit_invocation: false\n`);
  });
});

test('agent: Claude file keeps frontmatter order minus codex: (purpose after roles), TOML has sandbox_mode and never model or purpose', async () => {
  await withRoot({ '.rad/agents/helper.md': AGENT }, async (root) => {
    const out = await generated(root);
    const src = '.rad/agents/helper.md';
    assert.equal(out['.claude/agents/helper.md'],
      '---\nname: helper\ndescription: "Helps with things."\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n'
      + `roles: [architect, developer]\npurpose: authority\n---\n<!-- ${GENERATED_MARKER} (source: ${src}) -->\n\nYou are a helper.\n`);
    const toml = out['.codex/agents/helper.toml'];
    assert.equal(toml, `# ${GENERATED_MARKER} (source: ${src})\nname = "helper"\ndescription = "Helps with things."\n`
      + "sandbox_mode = \"read-only\"\ndeveloper_instructions = '''\nYou are a helper.\n'''\n");
    assert.doesNotMatch(toml, /model/);
    assert.doesNotMatch(toml, /purpose/);
    assert.deepEqual(parseMiniToml(toml), {
      name: 'helper', description: 'Helps with things.', sandbox_mode: 'read-only', developer_instructions: 'You are a helper.\n',
    });
  });
});

test('agent: without codex.sandbox_mode the TOML omits it; quotes in description are escaped', async () => {
  const fm = 'name: plain\ndescription: Say "hi" \\ there\nmodel: claude-haiku-4-5\ntools: [Read, Grep]';
  await withRoot({ '.rad/agents/plain.md': agentSource(fm, "It's fine, '' too.\n") }, async (root) => {
    const out = await generated(root);
    assert.match(out['.claude/agents/plain.md'], /\ntools: Read, Grep\n---\n/);
    const toml = parseMiniToml(out['.codex/agents/plain.toml']);
    assert.deepEqual(toml, { name: 'plain', description: 'Say "hi" \\ there', developer_instructions: "It's fine, '' too.\n" });
  });
});

test('agent: without roles, purpose follows tools; without purpose the output is unchanged', async () => {
  const fm = 'name: lone\ndescription: d\nmodel: m\ntools: Read';
  await withRoot({ '.rad/agents/lone.md': agentSource(`${fm}\npurpose: "  context  "`) }, async (root) => {
    const out = await generated(root);
    assert.match(out['.claude/agents/lone.md'], /\ntools: Read\npurpose: context\n---\n/);
    assert.doesNotMatch(out['.codex/agents/lone.toml'], /purpose/);
  });
  await withRoot({ '.rad/agents/lone.md': agentSource(fm) }, async (root) => {
    const out = await generated(root);
    assert.match(out['.claude/agents/lone.md'], /\ntools: Read\n---\n/);
    assert.doesNotMatch(out['.claude/agents/lone.md'], /purpose/);
  });
});

test('agent: a YAML-reserved or numeric model is quoted so it reads back as a string', async () => {
  await withRoot({ '.rad/agents/odd.md': agentSource('name: odd\ndescription: d\nmodel: "true"\ntools: Read') }, async (root) => {
    assert.match((await generated(root))['.claude/agents/odd.md'], /\nmodel: "true"\n/);
  });
});

/** A minimal reader for the TOML subset generate.js writes: basic strings and one ''' literal. */
function parseMiniToml(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z_]+) = (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== "'''") { out[m[1]] = JSON.parse(m[2]); continue; }
    const end = lines.indexOf("'''", i + 1);
    out[m[1]] = `${lines.slice(i + 1, end).join('\n')}\n`;
    i = end;
  }
  return out;
}

test('errors: missing name, mismatched name, missing description', async () => {
  await assertSourceError({ '.rad/skills/a/SKILL.md': '---\ndescription: d\ntargets: {claude: skill, codex: none}\n---\nB\n' },
    /^\.rad\/skills\/a\/SKILL\.md: missing name/m);
  await assertSourceError({ '.rad/skills/a/SKILL.md': skillSource('b', ['claude: skill', 'codex: none']) },
    /\.rad\/skills\/a\/SKILL\.md: name 'b' does not match 'a'/);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: y\ndescription: d\nmodel: m\ntools: Read') },
    /\.rad\/agents\/x\.md: name 'y' does not match 'x'/);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: x\nmodel: m\ntools: Read') }, /\.rad\/agents\/x\.md: missing description/);
});

test('errors: unknown targets and unknown keys', async () => {
  const cases = [
    [['claude: plugin', 'codex: none'], /unknown target claude: "plugin"/],
    [['claude: command:no-subdir', 'codex: none'], /unknown target claude: "command:no-subdir"/],
    [['claude: command:../x', 'codex: none'], /unknown target claude/],
    [['claude: skill', 'codex: prompt'], /unknown target codex: "prompt"/],
    [['claude: skill', 'codex: none', 'gemini: skill'], /unknown target 'gemini'/],
    [['claude: skill', 'codex: none', 'codex_implicit: false'], /codex_implicit requires codex: skill/],
  ];
  for (const [targets, re] of cases) await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', targets) }, re);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: x\ndescription: d\nmodel: m\ntools: Read\ncodex: {sandbox_mode: full}') },
    /unknown codex\.sandbox_mode "full"/);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: x\ndescription: d\nmodel: m\ntools: Read\ncodex: {model: o3}') },
    /unknown target codex\.model/);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: x\ndescription: d\ntools: Read') }, /x\.md: missing model/);
  for (const purpose of ['', '""', '"  "', 'null', '[a]', '3']) {
    await assertSourceError({ '.rad/agents/x.md': agentSource(`name: x\ndescription: d\nmodel: m\ntools: Read\npurpose: ${purpose}`) },
      /^\.rad\/agents\/x\.md: purpose must be a non-empty string$/m);
  }
});

test('errors: an unknown {{token}} names the file it came from', async () => {
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: skill', 'codex: none'], 'Hi {{user}}.\n') },
    /\.rad\/skills\/s\/SKILL\.md: unknown token \{\{user\}\}/);
  await assertSourceError({
    '.rad/skills/s/SKILL.md': skillSource('s', ['claude: skill', 'codex: skill']),
    '.rad/skills/s/codex.md': '{{ args }}\n',
  }, /\.rad\/skills\/s\/codex\.md: unknown token \{\{ args \}\}/);
  await assertSourceError({ '.rad/agents/x.md': agentSource('name: x\ndescription: d\nmodel: m\ntools: Read', '{{args}}\n') },
    /\.rad\/agents\/x\.md: unknown token \{\{args\}\}/);
});

test("errors: an agent body a TOML literal string cannot hold (''' or a control char); ]]] is fine", async () => {
  const fm = 'name: x\ndescription: d\nmodel: m\ntools: Read';
  await assertSourceError({ '.rad/agents/x.md': agentSource(fm, "Use ''' here.\n") }, /\.rad\/agents\/x\.md: body contains '''/);
  await assertSourceError({ '.rad/agents/x.md': agentSource(fm, 'Bell \u0007 here.\n') }, /x\.md: body contains a control character/);
  await withRoot({ '.rad/agents/x.md': agentSource(fm, 'a[[b]]] ok\n') }, async (root) => {
    assert.equal(parseMiniToml((await generated(root))['.codex/agents/x.toml']).developer_instructions, 'a[[b]]] ok\n');
  });
});

test('errors: two sources emitting the same path', async () => {
  await assertSourceError({
    '.rad/skills/a/SKILL.md': skillSource('a', ['claude: command:team/same', 'codex: none']),
    '.rad/skills/b/SKILL.md': skillSource('b', ['claude: command:team/same', 'codex: none']),
  }, /\.rad\/skills\/b\/SKILL\.md: output \.claude\/commands\/team\/same\.md is also emitted by \.rad\/skills\/a\/SKILL\.md/);
});

test('errors: symlinked sources are refused, never followed', async () => {
  const real = skillSource('s', ['claude: skill', 'codex: none']);
  await withRoot({ 'elsewhere/SKILL.md': real, 'elsewhere/s.md': AGENT }, async (root) => {
    mkdirSync(join(root, '.rad/skills/s'), { recursive: true });
    symlinkSync(join(root, 'elsewhere/SKILL.md'), join(root, '.rad/skills/s/SKILL.md'));
    mkdirSync(join(root, '.rad/agents'));
    symlinkSync(join(root, 'elsewhere/s.md'), join(root, '.rad/agents/helper.md'));
    symlinkSync(join(root, 'elsewhere'), join(root, '.rad/skills/linked'));
    const got = await readSources(root);
    assert.equal(got.ok, false);
    const text = got.errors.join('\n');
    assert.match(text, /\.rad\/skills\/s\/SKILL\.md: not a regular file/);
    assert.match(text, /\.rad\/agents\/helper\.md: not a regular file/);
    assert.match(text, /\.rad\/skills\/linked: not a directory/);
  });
  await withRoot({ 'real/skills/s/SKILL.md': real }, async (root) => {
    symlinkSync(join(root, 'real'), join(root, '.rad'));
    assert.match((await readSources(root)).errors.join('\n'), /^\.rad\/: not a directory/);
  });
});

test('errors: missing .rad/, unexpected skill files, a non-.md agent, an override for codex: none', async () => {
  await withRoot({}, async (root) => assert.match((await readSources(root)).errors[0], /^\.rad\/: no source directory/));
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: skill', 'codex: none']), '.rad/skills/s/notes.txt': 'x' },
    /\.rad\/skills\/s\/notes\.txt: unexpected file/);
  await assertSourceError({ '.rad/agents/x.txt': 'x' }, /\.rad\/agents\/x\.txt: agent sources must be \.md files/);
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: skill', 'codex: none']), '.rad/skills/s/codex.md': 'x' },
    /codex\.md: override for codex, but codex: none/);
  await assertSourceError({ '.rad/skills/s/SKILL.md': 'no frontmatter\n' }, /SKILL\.md: missing --- frontmatter block/);
});

test('readSources: an empty .rad/ yields no sources and no outputs', async () => {
  await withRoot({ '.rad/config.yml': 'version: 1\n' }, async (root) => {
    assert.deepEqual(await readSources(root), { ok: true, sources: { skills: [], agents: [] } });
    assert.deepEqual(renderOutputs({ skills: [], agents: [] }), { ok: true, outputs: [] });
  });
});

test('determinism: two runs give identical outputs, sorted by path', async () => {
  const files = { '.rad/skills/review-x/SKILL.md': SKILL_BOTH, '.rad/agents/helper.md': AGENT };
  await withRoot(files, async (root) => {
    const a = renderOutputs((await readSources(root)).sources);
    const b = renderOutputs((await readSources(root)).sources);
    assert.deepEqual(a, b);
    const paths = a.outputs.map((o) => o.path);
    assert.deepEqual(paths, [...paths].sort());
    for (const o of a.outputs) assert.ok(o.content.endsWith('\n') && !o.content.endsWith('\n\n'), o.path);
  });
});

test('hasGeneratedMarker: only in its defined position', () => {
  assert.equal(hasGeneratedMarker(`# ${GENERATED_MARKER} (source: s)\nx = 1\n`), true);
  assert.equal(hasGeneratedMarker(`---\nname: a\n---\n<!-- ${GENERATED_MARKER} (source: s) -->\n\nB\n`), true);
  assert.equal(hasGeneratedMarker(`---\nname: a\n---\n\n<!-- ${GENERATED_MARKER} -->\n`), false);
  assert.equal(hasGeneratedMarker(`Body mentions ${GENERATED_MARKER}\n`), false);
  assert.equal(hasGeneratedMarker(''), false);
});

test('generatedSource: reads the source path from either marker form; null otherwise', () => {
  assert.equal(generatedSource(`# ${GENERATED_MARKER} (source: .rad/agents/a.md)\nx = 1\n`), '.rad/agents/a.md');
  assert.equal(generatedSource(`---\nname: a\n---\n<!-- ${GENERATED_MARKER} (source: .rad/agents-internal/a.md) -->\n\nB\n`),
    '.rad/agents-internal/a.md');
  assert.equal(generatedSource(`---\nname: a\n---\n<!-- ${GENERATED_MARKER} -->\n\nB\n`), null, 'marker without a source');
  assert.equal(generatedSource(`---\nname: a\n---\n\nBody (source: .rad/agents/a.md)\n`), null, 'not a marker');
  assert.equal(generatedSource(''), null);
});

test('agent: a source in .rad/agents-internal is generated with its internal source in the marker', async () => {
  await withRoot({ '.rad/agents-internal/helper.md': AGENT }, async (root) => {
    const out = await generated(root);
    assert.deepEqual(Object.keys(out), ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
    for (const content of Object.values(out)) assert.equal(generatedSource(content), '.rad/agents-internal/helper.md');
  });
});

test('agent: the same name in .rad/agents and .rad/agents-internal is an error naming both paths', async () => {
  await assertSourceError({ '.rad/agents/helper.md': AGENT, '.rad/agents-internal/helper.md': AGENT },
    /\.rad\/agents-internal\/helper\.md: agent helper is also defined in \.rad\/agents\/helper\.md/);
});

test('agent: with no .rad/agents-internal dir the output is unchanged; an empty one adds nothing', async () => {
  const files = { '.rad/skills/review-x/SKILL.md': SKILL_BOTH, '.rad/agents/helper.md': AGENT };
  const base = await withRoot(files, generated);
  const withEmpty = await withRoot(files, async (root) => {
    mkdirSync(join(root, '.rad/agents-internal'));
    return generated(root);
  });
  assert.deepEqual(withEmpty, base);
  assert.equal(generatedSource(base['.claude/agents/helper.md']), '.rad/agents/helper.md');
});

test('plan: outputs of an internal agent are named, not orphans', async () => {
  await withRoot({ '.rad/agents-internal/helper.md': AGENT }, async (root) => {
    applyGenerate(root, (await planFor(root)).plan);
    const { plan } = await planFor(root);
    assert.deepEqual(plan.orphans, []);
    assert.deepEqual(plan.unchanged, ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
  });
});

/** Render the sources under `root` and plan against it. */
async function planFor(root) {
  const rendered = renderOutputs((await readSources(root)).sources);
  return { outputs: rendered.outputs, plan: planGenerate(root, rendered.outputs) };
}

test('plan/apply: first run writes everything; second run is all unchanged with no drift', async () => {
  await withRoot({ '.rad/skills/review-x/SKILL.md': SKILL_BOTH, '.rad/agents/helper.md': AGENT }, async (root) => {
    const first = await planFor(root);
    assert.equal(first.plan.drift.length, 4);
    assert.deepEqual(applyGenerate(root, first.plan).wrote, first.outputs.map((o) => o.path));
    const second = await planFor(root);
    assert.deepEqual(second.plan, { writes: [], unchanged: first.outputs.map((o) => o.path), drift: [], orphans: [], conflicts: [] });
  });
});

test('plan: a hand-edited or deleted marked output is drift', async () => {
  await withRoot({ '.rad/agents/helper.md': AGENT }, async (root) => {
    applyGenerate(root, (await planFor(root)).plan);
    const path = join(root, '.claude/agents/helper.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}extra\n`);
    rmSync(join(root, '.codex/agents/helper.toml'));
    const { plan } = await planFor(root);
    assert.deepEqual(plan.drift, ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
    assert.deepEqual(plan.conflicts, []);
  });
});

test('plan: a marked file with no source is an orphan; unmarked files under output roots are ignored', async () => {
  await withRoot({ '.rad/agents/helper.md': AGENT }, async (root) => {
    applyGenerate(root, (await planFor(root)).plan);
    rmSync(join(root, '.rad/agents/helper.md'));
    writeFileSync(join(root, '.claude/agents/hand.md'), '---\nname: hand\n---\nHand-written.\n');
    const { plan } = await planFor(root);
    assert.deepEqual(plan.orphans, ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
    assert.deepEqual(plan.writes, []);
  });
  assert.deepEqual([...OUTPUT_ROOTS], ['.claude/commands', '.claude/skills', '.claude/agents', '.agents/skills', '.codex/agents']);
});

test('plan/apply: an unmarked file at an output path is a conflict and is never overwritten', async () => {
  const hand = '---\ndescription: hand-written\n---\nMine.\n';
  await withRoot({ '.rad/skills/review-x/SKILL.md': SKILL_BOTH, '.claude/commands/team/review-x.md': hand }, async (root) => {
    const { plan } = await planFor(root);
    assert.deepEqual(plan.conflicts.map((c) => c.path), ['.claude/commands/team/review-x.md']);
    assert.match(plan.conflicts[0].reason, /no generated marker/);
    assert.throws(() => applyGenerate(root, plan), /refusing to write: 1 conflict/);
    assert.equal(readFileSync(join(root, '.claude/commands/team/review-x.md'), 'utf8'), hand);
    assert.equal(existsSync(join(root, '.agents/skills/review-x/SKILL.md')), false);
  });
});

test('plan: a symlinked output file or output ancestor is a conflict, never followed', async () => {
  await withRoot({ '.rad/agents/helper.md': AGENT, 'outside/helper.md': 'x\n' }, async (root) => {
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    symlinkSync(join(root, 'outside/helper.md'), join(root, '.claude/agents/helper.md'));
    symlinkSync(join(root, 'outside'), join(root, '.codex'));
    const { plan } = await planFor(root);
    assert.deepEqual(plan.conflicts.map((c) => c.path), ['.claude/agents/helper.md', '.codex/agents/helper.toml']);
    assert.match(plan.conflicts[1].reason, /^\.codex is not a directory/);
    assert.equal(readFileSync(join(root, 'outside/helper.md'), 'utf8'), 'x\n');
  });
});

test('skill: claude: none + codex: skill emits only the Codex skill', async () => {
  await withRoot({ '.rad/skills/codex-only/SKILL.md': skillSource('codex-only', ['claude: none', 'codex: skill'], 'Run {{args}}.\n') },
    async (root) => {
      const out = await generated(root);
      assert.deepEqual(Object.keys(out), ['.agents/skills/codex-only/SKILL.md']);
      assert.match(out['.agents/skills/codex-only/SKILL.md'], /^---\nname: codex-only\n[\s\S]*Run the text the user wrote after the skill name\.\n$/);
    });
});

test('skill: claude: none + codex: skill with codex_implicit: false also emits agents/openai.yaml only', async () => {
  const targets = ['claude: none', 'codex: skill', 'codex_implicit: false'];
  await withRoot({ '.rad/skills/quiet/SKILL.md': skillSource('quiet', targets) }, async (root) => {
    const out = await generated(root);
    assert.deepEqual(Object.keys(out), ['.agents/skills/quiet/SKILL.md', '.agents/skills/quiet/agents/openai.yaml']);
  });
});

test('errors: claude: none with codex: none, and a claude.md override with claude: none', async () => {
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: none', 'codex: none']) },
    /claude: none and codex: none emit nothing/);
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: none', 'codex: skill']), '.rad/skills/s/claude.md': 'x' },
    /claude\.md: override for claude, but claude: none/);
});

test('errors: an unknown claude target names none as an allowed value', async () => {
  await assertSourceError({ '.rad/skills/s/SKILL.md': skillSource('s', ['claude: nothing', 'codex: skill']) },
    /unknown target claude: "nothing" \(expected 'skill', 'none' or 'command:<subdir>\/<file>'\)/);
});
