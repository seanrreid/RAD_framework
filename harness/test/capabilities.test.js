// Tests for harness/capabilities.js (#85 part 1): vocabulary, parsing, per-wave resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_CLASSES, DEFAULT_CAPABILITIES, DEFAULT_SDK_TOOLS,
  parseCapabilityLine, resolveWaveCapabilities, sdkAllowedTools, commandRefusal,
} from '../capabilities.js';

const sorted = (list) => [...list].sort();

// --- vocabulary --------------------------------------------------------------

test('vocabulary: five classes; default is fs_read, fs_write, shell', () => {
  assert.deepEqual(CAPABILITY_CLASSES, ['fs_read', 'fs_write', 'shell', 'net', 'mcp']);
  assert.deepEqual(DEFAULT_CAPABILITIES, ['fs_read', 'fs_write', 'shell']);
  assert.deepEqual(DEFAULT_SDK_TOOLS, ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
});

// --- parseCapabilityLine -----------------------------------------------------

test('parse: commas, whitespace and mixed case are accepted; result in vocabulary order', () => {
  assert.deepEqual(parseCapabilityLine('shell, fs_read'), { ok: true, classes: ['fs_read', 'shell'] });
  assert.deepEqual(parseCapabilityLine('  NET   Fs_Read\tmcp '), { ok: true, classes: ['fs_read', 'net', 'mcp'] });
  assert.deepEqual(parseCapabilityLine('fs_write,,shell ,net'), { ok: true, classes: ['fs_write', 'shell', 'net'] });
});

test('parse: duplicates are removed', () => {
  assert.deepEqual(parseCapabilityLine('shell, SHELL, shell fs_read'), { ok: true, classes: ['fs_read', 'shell'] });
});

test('parse: unknown class is an error naming the token', () => {
  const r = parseCapabilityLine('fs_read, network');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown class 'network'/);
});

test('parse: empty, whitespace-only, separators-only and non-string values are errors', () => {
  for (const value of ['', '   ', ' , ,', undefined, null, 42]) {
    const r = parseCapabilityLine(value);
    assert.equal(r.ok, false, String(value));
    assert.match(r.error, /empty/);
  }
});

// --- resolveWaveCapabilities -------------------------------------------------

test('resolve: no declarations → implicit default, unconstrained', () => {
  const r = resolveWaveCapabilities({ waves: [1, 2], planCapabilities: undefined, waveCapabilities: {}, deny: [] });
  assert.equal(r.ok, true);
  for (const n of [1, 2]) {
    assert.deepEqual(r.byWave[n], {
      requested: DEFAULT_CAPABILITIES, effective: DEFAULT_CAPABILITIES, implicit: true,
      constrained: false, source: 'default', denied: [],
    });
  }
});

test('resolve: plan-level line applies to every wave and is explicit', () => {
  const r = resolveWaveCapabilities({ waves: [1, 2], planCapabilities: ['fs_read'], waveCapabilities: {}, deny: [] });
  assert.equal(r.ok, true);
  for (const n of [1, 2]) {
    assert.equal(r.byWave[n].source, 'plan');
    assert.equal(r.byWave[n].implicit, false);
    assert.equal(r.byWave[n].constrained, true);
    assert.deepEqual(r.byWave[n].effective, ['fs_read']);
  }
});

test('resolve: wave-level line replaces the plan line for that wave only', () => {
  const r = resolveWaveCapabilities({
    waves: [1, 2], planCapabilities: ['fs_read'], waveCapabilities: { 2: ['shell', 'net'] }, deny: [],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.byWave[1].effective, ['fs_read']);
  assert.equal(r.byWave[2].source, 'wave');
  assert.deepEqual(r.byWave[2].requested, ['shell', 'net']);
  assert.deepEqual(r.byWave[2].effective, ['shell', 'net']);
});

test('resolve: deny narrows an implicit default → constrained, not an error', () => {
  const r = resolveWaveCapabilities({ waves: [1], planCapabilities: undefined, waveCapabilities: {}, deny: ['shell', 'net'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.byWave[1], {
    requested: DEFAULT_CAPABILITIES, effective: ['fs_read', 'fs_write'], implicit: true,
    constrained: true, source: 'default', denied: ['shell'],
  });
});

test('resolve: deny of a class the default never had leaves the wave unconstrained', () => {
  const r = resolveWaveCapabilities({ waves: [1], waveCapabilities: {}, deny: ['net', 'mcp'] });
  assert.equal(r.ok, true);
  assert.equal(r.byWave[1].constrained, false);
  assert.deepEqual(r.byWave[1].effective, DEFAULT_CAPABILITIES);
});

test('resolve: explicitly requested denied class → refusal naming wave, class and config', () => {
  const r = resolveWaveCapabilities({
    waves: [3, 1, 2], planCapabilities: ['fs_read'], waveCapabilities: { 2: ['net'], 3: ['net'] }, deny: ['net'],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Wave 2 /);
  assert.match(r.error, /'net'/);
  assert.match(r.error, /\.rad\/config\.yml/);
});

test('resolve: a plan-level request for a denied class is refused at the first wave', () => {
  const r = resolveWaveCapabilities({ waves: [2, 1], planCapabilities: ['fs_read', 'mcp'], waveCapabilities: {}, deny: ['mcp'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Wave 1 .*'mcp'.*plan-level/);
});

test('resolve: deny of every default class → effective [] and constrained, not an error', () => {
  const r = resolveWaveCapabilities({ waves: [1], waveCapabilities: {}, deny: [...CAPABILITY_CLASSES] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.byWave[1].effective, []);
  assert.equal(r.byWave[1].constrained, true);
  assert.deepEqual(r.byWave[1].denied, DEFAULT_CAPABILITIES);
});

test('resolve: malformed inputs fail closed', () => {
  const base = { waves: [1], planCapabilities: undefined, waveCapabilities: {}, deny: [] };
  for (const bad of [
    { waves: undefined }, { deny: 'net' }, { deny: ['bogus'] }, { planCapabilities: 'shell' },
    { waveCapabilities: null }, { waveCapabilities: { 1: 'shell' } }, { waveCapabilities: { 1: ['bogus'] } },
  ]) {
    const r = resolveWaveCapabilities({ ...base, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, 'string');
  }
});

// --- sdkAllowedTools ---------------------------------------------------------

test('sdkAllowedTools: default set equals today\'s literal list (order-insensitive)', () => {
  const r = sdkAllowedTools(DEFAULT_CAPABILITIES);
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.tools), sorted(DEFAULT_SDK_TOOLS));
});

test('sdkAllowedTools: fs-only and net mappings', () => {
  assert.deepEqual(sdkAllowedTools(['fs_read']), { ok: true, tools: ['Read', 'Glob', 'Grep'] });
  assert.deepEqual(sdkAllowedTools(['fs_write', 'fs_read']), { ok: true, tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] });
  assert.deepEqual(sdkAllowedTools(['net']), { ok: true, tools: ['WebFetch', 'WebSearch'] });
  assert.deepEqual(sdkAllowedTools([]), { ok: true, tools: [] });
});

test('sdkAllowedTools: mcp is refused; unknown and non-array fail closed', () => {
  const mcp = sdkAllowedTools(['fs_read', 'mcp']);
  assert.equal(mcp.ok, false);
  assert.match(mcp.error, /the sdk adapter configures no MCP servers/);
  assert.equal(sdkAllowedTools(['bogus']).ok, false);
  assert.equal(sdkAllowedTools(undefined).ok, false);
});

// --- commandRefusal ----------------------------------------------------------

const resolved = (input) => resolveWaveCapabilities({ waveCapabilities: {}, deny: [], ...input }).byWave;

test('commandRefusal: no constrained waves → null', () => {
  assert.equal(commandRefusal(resolved({ waves: [1, 2] })), null);
  assert.equal(commandRefusal({}), null);
});

test('commandRefusal: an explicit full set → null', () => {
  assert.equal(commandRefusal(resolved({ waves: [1], planCapabilities: [...CAPABILITY_CLASSES] })), null);
});

test('commandRefusal: a narrowed wave → message naming the wave, effective set and remedy', () => {
  const msg = commandRefusal(resolved({ waves: [1, 2], waveCapabilities: { 2: ['fs_read'] } }));
  assert.match(msg, /Wave 2 /);
  assert.match(msg, /\[fs_read\]/);
  assert.match(msg, /RAD_AGENT=sdk/);
  assert.match(msg, /remove the Capabilities declaration/);
});

test('commandRefusal: an implicit default narrowed by deny is refused too', () => {
  const msg = commandRefusal(resolved({ waves: [1], deny: ['shell'] }));
  assert.match(msg, /Wave 1 .*\[fs_read, fs_write\]/);
});
