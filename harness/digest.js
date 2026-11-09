/**
 * Review digest — a read-only ranked "look here" summary of one feature's
 * deliver branch, assembled from checks RAD already runs. Recall over
 * precision: nothing is suppressed; a source that cannot be read is reported
 * as `{ unavailable: reason }`, never dropped and never fatal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliverCompleted, fileDeficitSignals, forecastForPaths, currentStop,
  outcomeCounts, retryCounts, totalUsage,
} from './events.js';
import { evaluateGate } from './gates.js';
import { findingsByFile } from './findings.js';
import { planFingerprint } from './plan-fingerprint.js';
import { mergeTaskFiles, taskFilesFromPlanText } from './plan-tasks.js';

export const DIGEST_RANK = Object.freeze(['scope', 'approval', 'high-risk', 'high-risk-waived', 'sensitive-content', 'sensitive-content-waived', 'self-protected', 'deficit', 'findings', 'run']);

const PLANS_DIR = join('.agents', 'plans');
const STATE_DIR = join('.agents', 'state');
const EVENTS_FILE = 'events.jsonl';
const FINDINGS_FILE = join('.agents', 'findings.jsonl');
const HIGH_RISK_PREFIX = 'high-risk:';
const SENSITIVE_PREFIX = 'sensitive-content:';
const SAFE_FEATURE = /^[a-z0-9][a-z0-9-]*$/;
const WAVE_HEADER = /^### Wave [0-9]+\b/gm;
const SCOPE_VIOLATION_LINE = /^\s*✗ (\S+)(?: — (.+))?$/;
const SCOPE_EXIT = Object.freeze({ PASSED: 0, VIOLATION: 1 });
const PLAN_PATHS = '. scripts/lib/plan-paths.sh && ';
const SCRIPTS = Object.freeze({
  scopePaths: `${PLAN_PATHS}plan_scope_paths "$1"`,
  highRisk: `${PLAN_PATHS}plan_high_risk_findings "$1"`,
  waivers: `${PLAN_PATHS}plan_waivers "$1"`,
  selfProtected: `${PLAN_PATHS}for p in "$@"; do if path_is_self_protected "$p"; then printf '%s\\n' "$p"; fi; done`,
});
const INPUT_KEYS = Object.freeze(['scope', 'paths', 'approval', 'highRisk', 'waivers', 'sensitiveDiff', 'selfProtected', 'deficits', 'findings', 'history', 'waveCount']);
const NOTHING_FLAGGED = 'nothing flagged — every check below stayed inside the lines';

const isUnavailable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.unavailable === 'string';
const reasonOf = (err) => (err && err.message) || String(err);
const lines = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** Parse JSONL; a malformed line throws naming its 1-based line number. */
function parseJsonl(raw, label) {
  return raw.split('\n').flatMap((line, i) => {
    if (line.trim() === '') return [];
    let parsed;
    try { parsed = JSON.parse(line); } catch (err) { throw new Error(`${label}: line ${i + 1} is not valid JSON (${err.message})`); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}: line ${i + 1} is not a JSON object`);
    return [parsed];
  });
}

/** Run a source; a throw becomes `{ unavailable: reason }` for that input only. */
function attempt(fn) {
  try { return fn(); } catch (err) { return { unavailable: reasonOf(err) }; }
}

function runSh(sh, script, args, cwd) {
  const res = sh('bash', ['-c', script, '_', ...args], { cwd });
  if (res.status !== 0) throw new Error((res.stderr || '').trim() || `exit ${res.status}`);
  return lines(res.stdout);
}

/** check-scope.sh for `planRel` (exit 0 → passed, 1 → violations parsed; any other exit throws). */
export function readScope(sh, repoRoot, planRel, branch, base) {
  const res = sh('bash', ['scripts/check-scope.sh', planRel, branch, ...(base ? [base] : [])], { cwd: repoRoot });
  if (res.status !== SCOPE_EXIT.PASSED && res.status !== SCOPE_EXIT.VIOLATION) {
    throw new Error(`check-scope.sh exit ${res.status}: ${(res.stderr || res.stdout || '').trim()}`);
  }
  const violations = lines(res.stdout).map((l) => l.match(SCOPE_VIOLATION_LINE)).filter(Boolean)
    .map((m) => ({ path: m[1], detail: m[2] || 'changed outside declared scope' }));
  return { passed: res.status === SCOPE_EXIT.PASSED, violations };
}

/** Every feature's log concatenated (feature stamped from dir), for deficit signals. */
function readAllHistories(repoRoot) {
  const dir = join(repoRoot, STATE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    .flatMap((name) => {
      const log = join(dir, name, EVENTS_FILE);
      if (!existsSync(log)) return [];
      return parseJsonl(readFileSync(log, 'utf8'), `event log for ${name}`).map((e) => (e.feature ? e : { ...e, feature: name }));
    });
}

function readDeficits(repoRoot, paths) {
  if (isUnavailable(paths)) throw new Error(`needs scope paths (${paths.unavailable})`);
  const taskFiles = {};
  const dir = join(repoRoot, PLANS_DIR);
  for (const name of (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.md')).sort()) {
    mergeTaskFiles(taskFiles, taskFilesFromPlanText(readFileSync(join(dir, name), 'utf8')));
  }
  return forecastForPaths(fileDeficitSignals(readAllHistories(repoRoot), taskFiles), paths);
}

function readFindings(repoRoot) {
  const file = join(repoRoot, FINDINGS_FILE);
  return existsSync(file) ? parseJsonl(readFileSync(file, 'utf8'), 'findings.jsonl') : [];
}

function readApproval(planText, history) {
  if (isUnavailable(planText)) throw new Error(`plan unreadable (${planText.unavailable})`);
  if (isUnavailable(history)) throw new Error(`event log unavailable (${history.unavailable})`);
  const gate = evaluateGate('approved', history);
  const approvals = history.filter((e) => e && e.type === 'approved');
  const latest = approvals.length > 0 ? approvals[approvals.length - 1] : null;
  const stored = latest?.data?.fingerprint;
  return {
    gatePassed: gate.passed, gateReason: gate.reason,
    storedFingerprint: typeof stored === 'string' && stored !== '' ? stored : null,
    currentFingerprint: planFingerprint(planText).hash,
    frozenWaivers: Array.isArray(latest?.data?.waivers) ? latest.data.waivers : null,
  };
}

function readWaivers(sh, repoRoot, planRel, approval) {
  if (!isUnavailable(approval) && approval.frozenWaivers) return approval.frozenWaivers;
  return runSh(sh, SCRIPTS.waivers, [planRel], repoRoot).map((l) => {
    const tab = l.indexOf('\t');
    return { id: l.slice(0, tab), justification: l.slice(tab + 1) };
  });
}

/** check-sensitive-content.sh diff → [{id, count, locations}]; a missing ref or non-zero exit throws. */
export function readSensitiveDiff(sh, repoRoot, branch, base) {
  if (typeof base !== 'string' || base === '') throw new Error('no base ref to scan against');
  if (typeof branch !== 'string' || branch === '') throw new Error('no branch ref to scan');
  const res = sh('bash', ['scripts/check-sensitive-content.sh', 'diff', base, branch], { cwd: repoRoot });
  if (res.status !== 0) throw new Error(`check-sensitive-content.sh exit ${res.status}: ${(res.stderr || res.stdout || '').trim()}`);
  return lines(res.stdout).map((l) => {
    const [tag, count, locations = ''] = l.split('\t');
    if (!tag.startsWith(SENSITIVE_PREFIX) || !/^[0-9]+$/.test(count ?? '')) throw new Error(`unparseable scan line: ${l}`);
    return { id: tag.slice(SENSITIVE_PREFIX.length), count: Number(count), locations };
  });
}

/** Gather every digest input read-only. A failing source → `{ unavailable }` for that input. */
export async function gatherDigestInputs({ repoRoot, sh, feature, branch, base }) {
  if (typeof feature !== 'string' || !SAFE_FEATURE.test(feature)) {
    const bad = { unavailable: `invalid feature name: ${JSON.stringify(feature)}` };
    return { feature: String(feature), ...Object.fromEntries(INPUT_KEYS.map((k) => [k, bad])) };
  }
  const planRel = join(PLANS_DIR, `${feature}.md`);
  const planText = attempt(() => readFileSync(join(repoRoot, planRel), 'utf8'));
  const history = attempt(() => parseJsonl(readFileSync(join(repoRoot, STATE_DIR, feature, EVENTS_FILE), 'utf8'), 'event log'));
  const paths = attempt(() => runSh(sh, SCRIPTS.scopePaths, [planRel], repoRoot));
  const approval = attempt(() => readApproval(planText, history));
  const withPaths = (fn) => attempt(() => (isUnavailable(paths) ? { unavailable: `needs scope paths (${paths.unavailable})` } : fn()));
  return {
    feature,
    scope: attempt(() => readScope(sh, repoRoot, planRel, branch, base)),
    paths,
    approval,
    highRisk: attempt(() => runSh(sh, SCRIPTS.highRisk, [planRel], repoRoot).map((l) => l.slice(HIGH_RISK_PREFIX.length))),
    waivers: attempt(() => readWaivers(sh, repoRoot, planRel, approval)),
    sensitiveDiff: attempt(() => readSensitiveDiff(sh, repoRoot, branch, base)),
    selfProtected: withPaths(() => (paths.length === 0 ? [] : runSh(sh, SCRIPTS.selfProtected, paths, repoRoot))),
    deficits: attempt(() => readDeficits(repoRoot, paths)),
    findings: attempt(() => readFindings(repoRoot)),
    history,
    waveCount: isUnavailable(planText) ? planText : (planText.match(WAVE_HEADER) || []).length,
  };
}

const avail = (v) => v !== undefined && !isUnavailable(v);
const item = (kind, path, detail) => (path === null ? { kind, detail } : { kind, path, detail });

function approvalProblems(a) {
  const out = [];
  if (!a.gatePassed) out.push(`approved gate not passing: ${a.gateReason}`);
  if (a.storedFingerprint && a.storedFingerprint !== a.currentFingerprint) {
    out.push('plan body changed since approval (fingerprint mismatch)');
  }
  return out;
}

function highRiskItems(highRisk, waivers) {
  const waived = new Map(avail(waivers) ? waivers.map((w) => [w.id, w.justification]) : []);
  return highRisk.map((path) => (waived.has(HIGH_RISK_PREFIX + path)
    ? item('high-risk-waived', path, `waived: ${waived.get(HIGH_RISK_PREFIX + path)}`)
    : item('high-risk', path, 'high-risk path with no waiver')));
}

/** Frozen approved-event waivers win; the plan's waivers apply only when the approval froze none. */
function sensitiveItems(hits, approval, waivers) {
  const frozen = avail(approval) && Array.isArray(approval.frozenWaivers) ? approval.frozenWaivers : null;
  const source = frozen ?? (avail(waivers) && Array.isArray(waivers) ? waivers : []);
  const waived = new Map(source.map((w) => [w.id, w.justification]));
  return hits.map((h) => {
    const where = `${h.count} added line(s): ${h.locations}`;
    return waived.has(SENSITIVE_PREFIX + h.id)
      ? item('sensitive-content-waived', h.id, `waived: ${waived.get(SENSITIVE_PREFIX + h.id)} (${where})`)
      : item('sensitive-content', h.id, `HIGH: sensitive pattern in the diff with no waiver (${where})`);
  });
}

function deficitDetail(deficits) {
  return Object.keys(deficits).sort().map((name) => {
    const features = Array.isArray(deficits[name]?.features) ? deficits[name].features : [];
    return `${name} in ${features.length} feature(s) (${features.join(', ')})`;
  }).join('; ');
}

function findingItems(findings, paths) {
  return Object.entries(findingsByFile(findings, paths)).map(([path, t]) => item('findings', path,
    `${t.total} past finding(s) (${t.high} high, ${t.medium} medium, ${t.low} low): ${t.categories.join(', ') || 'uncategorized'}`));
}

function runItems(history, waveCount) {
  const out = [];
  for (const [wave, n] of Object.entries(retryCounts(history).perWave)) {
    if (n > 1) out.push(item('run', null, `wave ${wave} took ${n} attempts`));
  }
  for (const [outcome, n] of Object.entries(outcomeCounts(history))) {
    if (!['success', 'total'].includes(outcome) && n > 0) out.push(item('run', null, `${n} wave(s) ended ${outcome}`));
  }
  const stop = currentStop(history);
  if (stop) out.push(item('run', null, `stopped: ${stop.class ?? '?'}/${stop.reason ?? '?'}${stop.detail ? ` — ${stop.detail}` : ''}`));
  if (Number.isInteger(waveCount) && !deliverCompleted(history, waveCount)) {
    out.push(item('run', null, `completion not evidenced for ${waveCount} wave(s)`));
  }
  return out;
}

function collectItems(i) {
  const items = [];
  if (avail(i.scope)) items.push(...i.scope.violations.map((v) => item('scope', v.path, v.detail)));
  if (avail(i.approval)) items.push(...approvalProblems(i.approval).map((d) => item('approval', null, d)));
  if (avail(i.highRisk)) items.push(...highRiskItems(i.highRisk, i.waivers));
  if (avail(i.sensitiveDiff)) items.push(...sensitiveItems(i.sensitiveDiff, i.approval, i.waivers));
  if (avail(i.selfProtected)) items.push(...i.selfProtected.map((p) => item('self-protected', p, 'RAD machinery — architect review')));
  if (avail(i.deficits)) items.push(...i.deficits.map((r) => item('deficit', r.path, deficitDetail(r.deficits))));
  if (avail(i.findings) && avail(i.paths)) items.push(...findingItems(i.findings, i.paths));
  if (avail(i.history)) items.push(...runItems(i.history, avail(i.waveCount) ? i.waveCount : null));
  return items;
}

const compareItems = (a, b) => (DIGEST_RANK.indexOf(a.kind) - DIGEST_RANK.indexOf(b.kind))
  || (a.path ?? '').localeCompare(b.path ?? '') || a.detail.localeCompare(b.detail);

const UNAVAILABLE_CHECK = (check) => ({ check, ok: false, detail: 'input unavailable' });

function collectEvidence(i, items) {
  const count = (kind) => items.filter((it) => it.kind === kind).length;
  const ev = [];
  ev.push(avail(i.scope) ? { check: 'scope passed', ok: i.scope.passed, detail: `${i.scope.violations.length} out-of-scope file(s)` } : UNAVAILABLE_CHECK('scope passed'));
  ev.push(avail(i.approval) ? { check: 'approval intact', ok: count('approval') === 0, detail: i.approval.storedFingerprint ? 'fingerprint compared' : 'approval carries no fingerprint — an edit cannot be proven' } : UNAVAILABLE_CHECK('approval intact'));
  ev.push(avail(i.history) && avail(i.waveCount)
    ? { check: 'completion evidenced', ok: deliverCompleted(i.history, i.waveCount), detail: `${i.waveCount} wave(s) declared` }
    : UNAVAILABLE_CHECK('completion evidenced'));
  ev.push(avail(i.highRisk) ? { check: 'high-risk waived', ok: count('high-risk') === 0, detail: `${count('high-risk')} unwaived, ${count('high-risk-waived')} waived` } : UNAVAILABLE_CHECK('high-risk waived'));
  ev.push(avail(i.sensitiveDiff) ? { check: 'sensitive content waived', ok: count('sensitive-content') === 0, detail: `${count('sensitive-content')} unwaived, ${count('sensitive-content-waived')} waived` } : UNAVAILABLE_CHECK('sensitive content waived'));
  if (avail(i.history)) ev.push({ check: 'token usage', ok: true, detail: `${totalUsage(i.history).total} token(s)` });
  return ev;
}

/** Pure: rank every flagged item; nothing is suppressed. Never throws on odd input. */
export function buildDigest(inputs) {
  const i = inputs && typeof inputs === 'object' ? inputs : {};
  const unavailable = INPUT_KEYS.filter((k) => isUnavailable(i[k])).map((k) => ({ input: k, reason: i[k].unavailable }));
  const feature = String(i.feature ?? '');
  try {
    const items = collectItems(i).sort(compareItems);
    return { feature, items, evidence: collectEvidence(i, items), unavailable };
  } catch (err) {
    unavailable.push({ input: 'digest', reason: `malformed inputs: ${reasonOf(err)}` });
    return { feature, items: [], evidence: [], unavailable };
  }
}

/** Pure: the digest as markdown. */
export function renderDigest(digest) {
  const out = [`## Review digest — ${digest.feature}`, '', '### Look here', ''];
  if (digest.items.length === 0) {
    out.push(digest.unavailable.length === 0 ? NOTHING_FLAGGED
      : `nothing flagged by the checks that ran — ${digest.unavailable.length} input(s) unavailable (see below)`);
  }
  for (const it of digest.items) out.push(`- **${it.kind}**${it.path ? ` \`${it.path}\`` : ''} — ${it.detail}`);
  out.push('', '### Evidence', '');
  for (const e of digest.evidence) out.push(`- ${e.ok ? '✓' : '✗'} ${e.check} — ${e.detail}`);
  for (const u of digest.unavailable) out.push(`- unavailable: ${u.input} — ${u.reason}`);
  return `${out.join('\n')}\n`;
}
