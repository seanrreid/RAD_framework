import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdentity } from '../cli.js';
import { selectAgent } from '../agent-select.js';
import { deliverSpine } from '../spine.js';
import { loadMatrix } from '../matrix.js';

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

// ── Spine: wave-attempt tagging (Task 1.2) ──────────────────────────────────

const WAVES = Object.freeze([{ n: 1, heading: 'Wave 1 — A' }, { n: 2, heading: 'Wave 2 — B' }]);

/** In-memory fake StateStore (copied from spine-wave-tasks.test.js). */
function makeFakeState({ plan }) {
  const appended = [];
  return {
    appended,
    async gate() {
      return { passed: true, reason: 'ok', satisfiedBy: { actor: 'architect' } };
    },
    append(event) {
      appended.push(event);
    },
    plan() {
      return plan;
    },
    history() {
      return appended;
    },
  };
}

function fixedClock() {
  let i = 0;
  return () => `t${i++}`;
}

/** Run the spine; `agent === undefined` omits the option entirely. */
async function runSpine({ agent, waveModels } = {}) {
  const state = makeFakeState({ plan: { waves: WAVES } });
  await deliverSpine({
    feature: 'demo',
    state,
    docs: {},
    matrix: loadMatrix(),
    gates: {},
    runWave: async () => ({ outcome: 'success', usage: { total: 10 } }),
    sh: () => ({ status: 0 }),
    now: fixedClock(),
    maxAttempts: 1,
    ...(waveModels === undefined ? {} : { waveModels }),
    ...(agent === undefined ? {} : { agent }),
  });
  return state.appended;
}

const attempts = (events) => events.filter((e) => e.type === 'wave-attempt').map((e) => e.data);

test('spine: a per-wave Model: override is recorded over the run default', async () => {
  const agent = { adapter: 'sdk', modelApplies: true, model: 'claude-opus-4-8' };
  const data = attempts(await runSpine({ agent, waveModels: { 2: 'claude-haiku-4-5' } }));
  assert.deepEqual(data.map((d) => d.agent), [
    { adapter: 'sdk', model: 'claude-opus-4-8' },
    { adapter: 'sdk', model: 'claude-haiku-4-5' },
  ]);
});

test('spine: a command cmd without {model} records the adapter and no model key', async () => {
  const agent = { adapter: 'command', modelApplies: false, model: 'claude-opus-4-8' };
  const data = attempts(await runSpine({ agent, waveModels: { 1: 'claude-haiku-4-5' } }));
  for (const d of data) {
    assert.deepEqual(d.agent, { adapter: 'command' });
    assert.equal(Object.hasOwn(d.agent, 'model'), false);
  }
});

test('spine: acp records the adapter and no model key', async () => {
  const data = attempts(await runSpine({ agent: { adapter: 'acp', modelApplies: false } }));
  assert.deepEqual(data.map((d) => d.agent), [{ adapter: 'acp' }, { adapter: 'acp' }]);
});

test('spine: a model-applying adapter with no model set omits the model key (never null/empty)', async () => {
  const data = attempts(await runSpine({ agent: { adapter: 'sdk', modelApplies: true, model: '' } }));
  assert.deepEqual(data.map((d) => d.agent), [{ adapter: 'sdk' }, { adapter: 'sdk' }]);
});

test('spine: no agent arg → events deep-equal and serialize byte-identical to the untagged baseline', async () => {
  const baseline = await runSpine();
  const nullAgent = await runSpine({ agent: null });
  assert.equal(attempts(baseline).some((d) => Object.hasOwn(d, 'agent')), false);
  assert.deepEqual(nullAgent, baseline);
  assert.equal(JSON.stringify(nullAgent), JSON.stringify(baseline));
});

test('spine: tagging adds only the agent key to wave-attempt events', async () => {
  const baseline = await runSpine();
  const tagged = await runSpine({ agent: { adapter: 'acp', modelApplies: false } });
  const strip = (events) => events.map((e) => {
    if (e.type !== 'wave-attempt') return e;
    const { agent: _agent, ...data } = e.data;
    return { ...e, data };
  });
  assert.equal(JSON.stringify(strip(tagged)), JSON.stringify(baseline));
});
