import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAgent, NO_AGENT_CONFIGURED } from '../agent-select.js';

const CMD_CONFIG = { agent: { adapter: 'command', command: 'claude -p' } };
const ACP_CONFIG = { agent: { adapter: 'acp', command: 'codex-acp' } };
const SDK_CONFIG = { agent: { adapter: 'sdk' } };

test('env: RAD_AGENT and RAD_AGENT_CMD both set → env selection, trimmed', () => {
  const env = { RAD_AGENT: ' acp ', RAD_AGENT_CMD: '  my-agent --x  ' };
  assert.deepEqual(selectAgent(env, null), { kind: 'acp', cmd: 'my-agent --x', source: 'env' });
});

test('env: RAD_AGENT_CMD only → kind defaults to command', () => {
  assert.deepEqual(selectAgent({ RAD_AGENT_CMD: 'run-it' }, undefined), {
    kind: 'command',
    cmd: 'run-it',
    source: 'env',
  });
});

test('env: RAD_AGENT only → cmd undefined, kind not validated', () => {
  assert.deepEqual(selectAgent({ RAD_AGENT: 'sdk' }, null), { kind: 'sdk', cmd: undefined, source: 'env' });
  assert.deepEqual(selectAgent({ RAD_AGENT: 'bogus' }, null), { kind: 'bogus', cmd: undefined, source: 'env' });
});

test('env beats config entirely (all-or-nothing, no field mixing)', () => {
  assert.deepEqual(selectAgent({ RAD_AGENT: 'sdk' }, CMD_CONFIG), { kind: 'sdk', cmd: undefined, source: 'env' });
  assert.deepEqual(selectAgent({ RAD_AGENT_CMD: 'x' }, ACP_CONFIG), { kind: 'command', cmd: 'x', source: 'env' });
});

test('config only: command adapter', () => {
  assert.deepEqual(selectAgent({}, CMD_CONFIG), { kind: 'command', cmd: 'claude -p', source: 'config' });
});

test('config only: acp adapter', () => {
  assert.deepEqual(selectAgent({}, ACP_CONFIG), { kind: 'acp', cmd: 'codex-acp', source: 'config' });
});

test('config only: sdk adapter → cmd undefined', () => {
  assert.deepEqual(selectAgent({}, SDK_CONFIG), { kind: 'sdk', cmd: undefined, source: 'config' });
});

test('neither env nor config → error with the named constant', () => {
  assert.deepEqual(selectAgent({}, {}), { error: NO_AGENT_CONFIGURED });
  assert.match(NO_AGENT_CONFIGURED, /rad config init --agent claude\|codex/);
});

test('blank and whitespace env values are treated as unset', () => {
  assert.deepEqual(selectAgent({ RAD_AGENT: '', RAD_AGENT_CMD: '' }, CMD_CONFIG), {
    kind: 'command',
    cmd: 'claude -p',
    source: 'config',
  });
  assert.deepEqual(selectAgent({ RAD_AGENT: '  \t', RAD_AGENT_CMD: '\n ' }, {}), { error: NO_AGENT_CONFIGURED });
  assert.deepEqual(selectAgent({ RAD_AGENT: ' ', RAD_AGENT_CMD: 'x' }, null), {
    kind: 'command',
    cmd: 'x',
    source: 'env',
  });
});

test('null or undefined config → error when env is empty', () => {
  assert.deepEqual(selectAgent({}, null), { error: NO_AGENT_CONFIGURED });
  assert.deepEqual(selectAgent({}, undefined), { error: NO_AGENT_CONFIGURED });
});

test('config without an agent mapping → error', () => {
  assert.deepEqual(selectAgent({}, { platform: 'github' }), { error: NO_AGENT_CONFIGURED });
  assert.deepEqual(selectAgent({}, { agent: null }), { error: NO_AGENT_CONFIGURED });
  assert.deepEqual(selectAgent({}, { agent: 'command' }), { error: NO_AGENT_CONFIGURED });
});

test('missing or non-object env throws TypeError', () => {
  assert.throws(() => selectAgent(undefined, CMD_CONFIG), TypeError);
  assert.throws(() => selectAgent(null, CMD_CONFIG), TypeError);
  assert.throws(() => selectAgent('RAD_AGENT=sdk', CMD_CONFIG), TypeError);
  assert.throws(() => selectAgent([], CMD_CONFIG), TypeError);
});
