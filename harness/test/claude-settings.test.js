import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVER_GATE_HOOK_COMMAND, DELIVER_GATE_HOOK_MATCHER, mergeDeliverGateHook,
} from '../claude-settings.js';

/** The exact entry the merge appends to hooks.PreToolUse. */
const REGISTRATION = {
  matcher: 'Skill',
  hooks: [{ type: 'command', command: 'node scripts/deliver-gate-hook.mjs' }],
};

const json = (value) => JSON.stringify(value, null, 2);

test('constants — match the registration this repo ships', () => {
  assert.equal(DELIVER_GATE_HOOK_COMMAND, 'node scripts/deliver-gate-hook.mjs');
  assert.equal(DELIVER_GATE_HOOK_MATCHER, 'Skill');
});

test('absent file (null) → created, containing only the registration', () => {
  const res = mergeDeliverGateHook(null);
  assert.equal(res.status, 'created');
  assert.deepEqual(JSON.parse(res.text), { hooks: { PreToolUse: [REGISTRATION] } });
  assert.ok(res.text.endsWith('}\n'));
});

test('{} → added, hooks and PreToolUse created', () => {
  const res = mergeDeliverGateHook('{}');
  assert.equal(res.status, 'added');
  assert.deepEqual(JSON.parse(res.text), { hooks: { PreToolUse: [REGISTRATION] } });
});

test('hooks present without PreToolUse → added alongside the other hook events', () => {
  const res = mergeDeliverGateHook(json({ hooks: { Stop: [{ hooks: [] }] } }));
  assert.equal(res.status, 'added');
  assert.deepEqual(JSON.parse(res.text), { hooks: { Stop: [{ hooks: [] }], PreToolUse: [REGISTRATION] } });
});

test('added — other top-level keys and other PreToolUse entries kept, in order', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] };
  const input = { autoMode: { allow: ['$defaults'] }, hooks: { PreToolUse: [other] }, model: 'opus' };
  const res = mergeDeliverGateHook(json(input));
  assert.equal(res.status, 'added');
  const out = JSON.parse(res.text);
  assert.deepEqual(Object.keys(out), ['autoMode', 'hooks', 'model']);
  assert.deepEqual(out.autoMode, input.autoMode);
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.hooks.PreToolUse, [other, REGISTRATION]);
});

test('added — output is 2-space JSON ending in a newline', () => {
  const res = mergeDeliverGateHook('{"a":1}');
  assert.equal(res.text, `${json({ a: 1, hooks: { PreToolUse: [REGISTRATION] } })}\n`);
});

test('registration present under a different matcher → present, text byte-identical', () => {
  const text = `{ "hooks": { "PreToolUse": [ { "matcher": "*",
    "hooks": [ { "type": "command", "command": "node ./scripts/deliver-gate-hook.mjs --x" } ] } ] } }`;
  assert.deepEqual(mergeDeliverGateHook(text), { status: 'present', text });
});

test('idempotent — merging its own added output → present, unchanged', () => {
  const first = mergeDeliverGateHook('{"a":1}');
  assert.equal(first.status, 'added');
  assert.deepEqual(mergeDeliverGateHook(first.text), { status: 'present', text: first.text });
  const created = mergeDeliverGateHook(null);
  assert.deepEqual(mergeDeliverGateHook(created.text), { status: 'present', text: created.text });
});

test('PreToolUse entries with non-array hooks or non-string commands are not "present"', () => {
  const input = { hooks: { PreToolUse: [{ matcher: 'Skill', hooks: 'x' }, { hooks: [{ command: 7 }, null] }, null] } };
  const res = mergeDeliverGateHook(json(input));
  assert.equal(res.status, 'added');
  assert.deepEqual(JSON.parse(res.text).hooks.PreToolUse.at(-1), REGISTRATION);
});

test('errors — each malformed input fails closed with a message naming the problem', () => {
  const cases = [
    ['', /empty/],
    ['   \n\t', /empty/],
    ['{not json', /not valid JSON/],
    ['[]', /top level is not a JSON object/],
    ['null', /top level is not a JSON object/],
    ['"text"', /top level is not a JSON object/],
    [json({ hooks: [] }), /'hooks' is not an object/],
    [json({ hooks: null }), /'hooks' is not an object/],
    [json({ hooks: { PreToolUse: {} } }), /'hooks\.PreToolUse' is not an array/],
  ];
  for (const [text, re] of cases) {
    const res = mergeDeliverGateHook(text);
    assert.equal(res.text, undefined, `${JSON.stringify(text)} must not produce text`);
    assert.match(res.error, re, JSON.stringify(text));
  }
});
