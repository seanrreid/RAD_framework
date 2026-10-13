/**
 * Source provenance module (#243): classification, TSV parsing, header
 * stamping, fingerprint stability and the read-only `rad provenance` command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyAssociation, parseProvenanceTsv, provenanceHeaderLines, unknownHeaderLines, noneHeaderLines,
  stampProvenance, readProvenance, provenanceCommand,
} from '../provenance.js';
import { planFingerprint } from '../plan-fingerprint.js';

const BODY = '## Context\n\nSome body.\n\n## Waves\n\n- one\n';
const BASE_HEADER = '# Plan: Demo\nStatus: pending-review\nIssue: 42\nIssue-Title: A title\n';
const PLAN = `${BASE_HEADER}\n${BODY}`;
const STAMP = ['Source-Author: alice (OWNER)', 'Source-Comments: 2 total, 1 non-collaborator'];

test('classifyAssociation: trusted associations', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(classifyAssociation(a, 'User').trusted, true, a);
  }
});

test('classifyAssociation: every other value and a missing value is untrusted', () => {
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', 'weird', '', undefined, null]) {
    assert.equal(classifyAssociation(a, 'User').trusted, false, String(a));
  }
  assert.equal(classifyAssociation(undefined, 'User').label, 'NONE');
});

test('classifyAssociation: a bot is untrusted even with a trusted association', () => {
  const c = classifyAssociation('OWNER', 'Bot');
  assert.deepEqual({ trusted: c.trusted, bot: c.bot }, { trusted: false, bot: true });
});

test('parseProvenanceTsv: zero, one and many comments', () => {
  const issue = 'issue\talice\tUser\tOWNER';
  assert.equal(parseProvenanceTsv(`${issue}\n`).comments.length, 0);
  assert.equal(parseProvenanceTsv(`${issue}\ncomment\tbob\tUser\tNONE\n`).comments.length, 1);
  const many = parseProvenanceTsv(`${issue}\ncomment\tb\tUser\tNONE\ncomment\tc\tBot\tNONE\ncomment\td\tUser\tMEMBER\n`);
  assert.deepEqual(many.comments.map((c) => c.login), ['b', 'c', 'd']);
  assert.deepEqual(many.issue, { login: 'alice', type: 'User', association: 'OWNER' });
});

test('parseProvenanceTsv: malformed input throws', () => {
  assert.throws(() => parseProvenanceTsv(''), /empty/);
  assert.throws(() => parseProvenanceTsv('issue\talice\tUser'), /malformed/);
  assert.throws(() => parseProvenanceTsv('comment\talice\tUser\tOWNER'), /malformed/);
  assert.throws(() => parseProvenanceTsv('issue\talice\tUser\tOWNER\nbogus line'), /malformed/);
  assert.throws(() => parseProvenanceTsv('issue\t\tUser\tOWNER'), /malformed/);
});

test('provenanceHeaderLines: counts non-collaborator comments, bots included', () => {
  const parsed = parseProvenanceTsv('issue\talice\tUser\tOWNER\ncomment\tb\tUser\tMEMBER\ncomment\tc\tBot\tMEMBER\ncomment\td\tUser\tNONE');
  assert.deepEqual(provenanceHeaderLines(parsed), ['Source-Author: alice (OWNER)', 'Source-Comments: 3 total, 2 non-collaborator']);
  const bot = parseProvenanceTsv('issue\tdependabot\tBot\tNONE');
  assert.equal(provenanceHeaderLines(bot)[0], 'Source-Author: dependabot (NONE, bot)');
});

test('unknown and none header lines', () => {
  assert.equal(unknownHeaderLines('gh failed\nbadly')[0], 'Source-Author: unknown (gh failed badly)');
  assert.equal(noneHeaderLines()[0], 'Source-Author: none (no source issue)');
});

test('stampProvenance: no existing stamp inserts after Issue-Title', () => {
  const lines = stampProvenance(PLAN, STAMP).split('\n');
  const i = lines.indexOf('Issue-Title: A title');
  assert.deepEqual(lines.slice(i + 1, i + 3), STAMP);
});

test('stampProvenance: replaces a stale stamp', () => {
  const stale = PLAN.replace('Issue-Title: A title\n', 'Source-Author: old (NONE)\nIssue-Title: A title\nSource-Comments: 9 total, 9 non-collaborator\n');
  const out = stampProvenance(stale, STAMP);
  assert.equal(out.match(/^Source-Author:/gm).length, 1);
  assert.equal(out.match(/^Source-Comments:/gm).length, 1);
  assert.ok(!out.includes('old (NONE)'));
  assert.deepEqual(readProvenance(out), { author: 'alice (OWNER)', comments: '2 total, 1 non-collaborator' });
});

test('stampProvenance: only one of the two lines present', () => {
  const half = PLAN.replace('Issue-Title: A title\n', 'Issue-Title: A title\nSource-Comments: 1 total, 1 non-collaborator\n');
  const out = stampProvenance(half, STAMP);
  assert.equal(out.match(/^Source-Comments:/gm).length, 1);
  assert.deepEqual(readProvenance(out).author, 'alice (OWNER)');
});

test('stampProvenance: no Issue-Title falls back to the last Issue:/Adopted-From: line', () => {
  const plan = `# Plan: Demo\nAdopted-From: https://github.com/o/r/issues/42\nIssue: 42\nStatus: x\n\n${BODY}`;
  const lines = stampProvenance(plan, STAMP).split('\n');
  const i = lines.indexOf('Issue: 42');
  assert.deepEqual(lines.slice(i + 1, i + 3), STAMP);
});

test('stampProvenance: header with no blank line before ## keeps the heading adjacent', () => {
  const out = stampProvenance(`${BASE_HEADER}${BODY}`, STAMP);
  assert.ok(out.endsWith(`${STAMP[1]}\n${BODY}`));
});

test('stampProvenance: every body line is untouched', () => {
  const out = stampProvenance(PLAN, STAMP);
  assert.ok(out.endsWith(`\n${BODY}`));
  assert.equal(out.slice(out.indexOf('## Context')), BODY);
});

test('stampProvenance: a Source-Author-looking line in the body is not touched', () => {
  const plan = `${PLAN}\nSource-Author: bodytext\n`;
  const out = stampProvenance(plan, STAMP);
  assert.ok(out.endsWith('Source-Author: bodytext\n'));
  assert.equal(readProvenance(out).author, 'alice (OWNER)');
});

test('planFingerprint is identical before and after stamping (AC#6)', () => {
  const before = planFingerprint(PLAN).hash;
  assert.equal(planFingerprint(stampProvenance(PLAN, STAMP)).hash, before);
  assert.equal(planFingerprint(stampProvenance(PLAN, noneHeaderLines())).hash, before);
  assert.equal(planFingerprint(stampProvenance(PLAN, unknownHeaderLines('x'))).hash, before);
});

test('readProvenance: unstamped plan gives nulls', () => {
  assert.deepEqual(readProvenance(PLAN), { author: null, comments: null });
});

// ---- rad provenance ----

async function withPlan(planText, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rad-prov-'));
  try {
    mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
    if (planText !== null) writeFileSync(join(root, '.agents', 'plans', 'demo.md'), planText);
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function run(root, argv) {
  const out = []; const err = [];
  const so = process.stdout.write; const se = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    const code = await provenanceCommand(argv, { repoRoot: root });
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = so; process.stderr.write = se;
  }
}

const stamped = (lines) => stampProvenance(PLAN, lines);

test('rad provenance: trusted author', () => withPlan(stamped(['Source-Author: alice (OWNER)', 'Source-Comments: 0 total, 0 non-collaborator']), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'provenance: trusted - alice (OWNER)\n');
}));

test('rad provenance: untrusted author with non-collaborator comments adds a second line', () => withPlan(stamped(['Source-Author: eve (FIRST_TIMER)', 'Source-Comments: 4 total, 3 non-collaborator']), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], 'provenance: UNTRUSTED - eve (FIRST_TIMER)');
  assert.equal(lines[1], 'provenance: 3 of 4 issue comments are from non-collaborators');
}));

test('rad provenance: bot is untrusted and says bot', () => withPlan(stamped(['Source-Author: dependabot (NONE, bot)', 'Source-Comments: 0 total, 0 non-collaborator']), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.out, 'provenance: UNTRUSTED - dependabot (NONE, bot)\n');
}));

test('rad provenance: trusted author but untrusted comments still warns', () => withPlan(stamped(['Source-Author: alice (MEMBER)', 'Source-Comments: 2 total, 1 non-collaborator']), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.out.trim().split('\n').length, 2);
  assert.match(r.out, /^provenance: trusted - alice \(MEMBER\)\n/);
}));

test('rad provenance: unknown, with reason', () => withPlan(stamped(unknownHeaderLines('fetch failed')), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^provenance: unknown - .*fetch failed/);
}));

test('rad provenance: none', () => withPlan(stamped(noneHeaderLines()), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^provenance: none/);
}));

test('rad provenance: not recorded for an unstamped plan', () => withPlan(PLAN, async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^provenance: not recorded/);
}));

test('rad provenance: unreadable stamp value reports unknown', () => withPlan(stamped(['Source-Author: ???', 'Source-Comments: lots']), async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^provenance: unknown - unreadable/);
}));

test('rad provenance: bad feature name exits 2', () => withPlan(PLAN, async (root) => {
  for (const argv of [['../x'], [], ['a', 'b'], ['']]) {
    const r = await run(root, argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /Usage: rad provenance/);
  }
}));

test('rad provenance: missing plan exits 2', () => withPlan(null, async (root) => {
  const r = await run(root, ['demo']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no plan doc/);
}));

test('rad provenance: writes no file', () => withPlan(stamped(STAMP), async (root) => {
  const snapshot = () => readdirSync(root, { recursive: true }).sort().join('|');
  const before = snapshot();
  await run(root, ['demo']);
  assert.equal(snapshot(), before);
}));
