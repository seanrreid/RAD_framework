import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdentity } from '../cli.js';
import { selectAgent } from '../agent-select.js';

const CONFIG = Object.freeze({ agent: { adapter: 'command', command: 'claude -p --model {model}' } });

test('agentIdentity: a command cmd with {model} applies a model', () => {
  assert.deepEqual(agentIdentity({ kind: 'command', cmd: 'claude -p --model {model}' }), {
    adapter: 'command', modelApplies: true,
  });
});

test('agentIdentity: a command cmd without {model} applies none', () => {
  assert.deepEqual(agentIdentity({ kind: 'command', cmd: 'codex exec' }), { adapter: 'command', modelApplies: false });
});

test('agentIdentity: a command selection with no cmd applies none', () => {
  assert.deepEqual(agentIdentity({ kind: 'command', cmd: undefined }), { adapter: 'command', modelApplies: false });
});

test('agentIdentity: sdk always applies a model; acp never does', () => {
  assert.deepEqual(agentIdentity({ kind: 'sdk', cmd: undefined }), { adapter: 'sdk', modelApplies: true });
  assert.deepEqual(agentIdentity({ kind: 'acp', cmd: 'gemini --acp' }), { adapter: 'acp', modelApplies: false });
});

test('agentIdentity: config selection supplies the identity when no env override is set', () => {
  assert.deepEqual(agentIdentity(selectAgent({}, CONFIG)), { adapter: 'command', modelApplies: true });
});

test('agentIdentity: RAD_AGENT / RAD_AGENT_CMD override the config selection', () => {
  const env = { RAD_AGENT: 'command', RAD_AGENT_CMD: 'codex exec' };
  assert.deepEqual(agentIdentity(selectAgent(env, CONFIG)), { adapter: 'command', modelApplies: false });
  assert.deepEqual(agentIdentity(selectAgent({ RAD_AGENT: 'sdk' }, CONFIG)), { adapter: 'sdk', modelApplies: true });
  assert.deepEqual(agentIdentity(selectAgent({ RAD_AGENT: 'acp', RAD_AGENT_CMD: 'x --acp' }, CONFIG)), {
    adapter: 'acp', modelApplies: false,
  });
});
