/**
 * Git StateStore adapter (design Decisions 2, 6).
 *
 * Implements the StateStore port against git-as-transport: the event log is a
 * git-TRACKED, per-feature `events.jsonl` (Decision 6) under
 * `.agents/state/<feature>/events.jsonl`. This is NEW state storage — it does
 * not replace `.agents/findings.jsonl` (cross-cycle findings); it is its sibling
 * (per-feature lifecycle state). One file per feature avoids merge contention on
 * concurrent appends across branches.
 *
 * State is a pure fold over that log: `phase()`/`gate()`/`history()` are views,
 * `append()` is the only mutation, and `append()` validates the transition
 * BEFORE writing — an illegal move throws (TransitionError) and nothing is
 * written. The `approved` gate additionally wraps the existing
 * `scripts/check-plan-approved.sh` / `scripts/check-role.sh` guardrails (the
 * authority on branch-tip status + role) by shelling out — those scripts are
 * called, never modified.
 *
 * See docs/harness-state-store.md for the authoritative spec.
 */

import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

import { reduce, phaseOf } from '../events.js';
import { validateTransition } from '../transitions.js';
// gates.js is imported lazily inside gate() — it pulls in js-yaml (the only
// runtime dep). This keeps THIS MODULE importable and its non-gate methods
// (append/history/phase/plan/list/recordApproval) usable and unit-testable
// without js-yaml installed, and lets tests inject `evaluateGate` to exercise
// gate() hermetically. Note: the full harness still needs js-yaml — spine.js
// imports matrix.js eagerly — so js-yaml is optional only for StateStore-only
// consumers, not for the harness as a whole.

/**
 * Default shell-out helper: run a script/command synchronously and capture its
 * result. Returns `{ status, stdout, stderr }` (does NOT throw on non-zero exit,
 * so the caller can branch on the exit code — guardrail scripts use exit codes
 * as pass/fail). Injectable for testing.
 *
 * @param {string} file - executable/script path
 * @param {string[]} [args]
 * @param {{ cwd?: string }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function defaultSh(file, args = [], opts = {}) {
  try {
    const stdout = execFileSync(file, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? ''),
    };
  }
}

/**
 * A safe feature slug: lowercase alphanumeric + hyphens, no path separators, no
 * '..'. Feature names arrive from untrusted event payloads and plan names and are
 * interpolated into filesystem paths and a shell argument (the branch passed to
 * check-plan-approved.sh), so they MUST be validated before use to prevent path
 * traversal. Mirrors the `rad/<feature>` branch grammar the scripts enforce.
 */
function isSafeFeature(feature) {
  return typeof feature === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(feature);
}

/** Throw on any feature that is not a safe slug. */
function assertSafeFeature(feature) {
  if (!isSafeFeature(feature)) {
    throw new Error(
      `invalid feature slug ${JSON.stringify(feature)} ` +
        `(expected /^[a-z0-9][a-z0-9-]*$/ — no path separators or '..')`,
    );
  }
}

/** Path to a feature's event log, relative to repoRoot. */
function eventsPath(repoRoot, feature) {
  return join(repoRoot, '.agents', 'state', feature, 'events.jsonl');
}

/** Path to a feature's plan doc, relative to repoRoot. */
function planPath(repoRoot, feature) {
  return join(repoRoot, '.agents', 'plans', `${feature}.md`);
}

/**
 * Parse a per-feature events.jsonl into an array of events. Crash-tolerant:
 * blank lines and any unparseable (e.g. half-written trailing) line are skipped,
 * never fatal (Decision 6).
 *
 * @param {string} file
 * @returns {import('../events.js').Event[]}
 */
function readEvents(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip an unparseable line (crash tolerance) — do not abort the read.
      continue;
    }
  }
  return events;
}

/**
 * Extract the body lines of a `## <name>` markdown section (until the next `## `
 * heading). Mirrors the awk pattern the repo's scripts use.
 *
 * @param {string} text - full plan-doc text
 * @param {string} name - section heading (without the leading '## ')
 * @returns {string[]}
 */
function sectionLines(text, name) {
  const lines = text.split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^## /.test(line)) {
      inSection = line.replace(/^##\s+/, '').trim() === name;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

/**
 * Parse a plan doc's structured sections (waves / acceptance criteria / files),
 * reusing the same grep/awk patterns the repo's scripts rely on. Returns null
 * when no plan doc exists for the feature.
 *
 * @param {string} text
 * @returns {{ acceptanceCriteria: string[], waves: Array<{ n: number, heading: string }>, files: string[] }}
 */
function parsePlan(text) {
  // Acceptance Criteria: numbered list lines `^[0-9]+.` in the AC section.
  const acceptanceCriteria = sectionLines(text, 'Acceptance Criteria')
    .filter((l) => /^[0-9]+\./.test(l.trim()))
    .map((l) => l.trim());

  // Waves: `### Wave N` headings anywhere in the doc (scripts grep `^### Wave`).
  const waves = [];
  for (const line of text.split('\n')) {
    const m = /^### Wave\s+(\d+)/.exec(line);
    if (m) waves.push({ n: Number(m[1]), heading: line.trim() });
  }

  // Files in Scope: table rows, column 2 (File) — skip the header + separator.
  const files = sectionLines(text, 'Files in Scope')
    .filter((l) => /^\|/.test(l.trim()))
    .filter((l) => !/^\|\s*File/.test(l.trim()))
    .filter((l) => !/^\|[-|\s]*$/.test(l.trim()))
    .map((l) => l.split('|')[1])
    .map((c) => (c ? c.trim() : ''))
    .filter((c) => c.length > 0);

  return { acceptanceCriteria, waves, files };
}

/**
 * Create a Git StateStore.
 *
 * @param {{ repoRoot: string, sh?: typeof defaultSh, claudeMd?: string }} opts
 *   - repoRoot: absolute path to the repo working tree
 *   - sh:       injectable shell-out helper (defaults to execFileSync-based)
 *   - claudeMd: path to CLAUDE.md for check-role.sh (defaults to <repoRoot>/CLAUDE.md)
 * @returns {import('../events.js').StateStore & {
 *   recordApproval: (a: { feature: string, actor: string, recordedBy?: string, ts?: string, evidence?: Object }) => void
 * }}
 */
export function createGitStateStore({
  repoRoot,
  sh = defaultSh,
  claudeMd,
  evaluateGate,
} = {}) {
  if (!repoRoot) throw new Error('createGitStateStore: repoRoot is required');
  const claudeMdPath = claudeMd ?? join(repoRoot, 'CLAUDE.md');

  // Resolve the gate evaluator lazily so the store loads without js-yaml: the
  // dynamic import of gates.js (which pulls in js-yaml, the one runtime dep)
  // only happens the first time gate() is actually called. Injectable (the
  // `evaluateGate` option) for tests that exercise gate() without the dep.
  let cachedEvaluateGate = evaluateGate;
  async function resolveEvaluateGate() {
    if (!cachedEvaluateGate) {
      ({ evaluateGate: cachedEvaluateGate } = await import('../gates.js'));
    }
    return cachedEvaluateGate;
  }

  /** Read + parse a feature's event log (crash-tolerant). */
  function history(feature) {
    assertSafeFeature(feature);
    return readEvents(eventsPath(repoRoot, feature));
  }

  /**
   * Append one event. Validates the transition against the current state
   * (derived by reduce over existing history) BEFORE writing — an illegal move
   * throws TransitionError and nothing is written. Stamps `ts` if absent, but
   * accepts a caller-injected `ts` (the store never overrides one the caller
   * passed).
   */
  function append(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('append(event): event must be an object');
    }
    const { feature } = event;
    if (!feature) throw new Error('append(event): event.feature is required');
    assertSafeFeature(feature);
    if (!event.type) throw new Error('append(event): event.type is required');
    if (!event.actor) throw new Error('append(event): event.actor is required');

    const existing = history(feature);
    // reduce derives the current state; transition validation reads its history.
    reduce(existing); // pure fold (also asserts the history shape)
    // The hook lifecycle events (hook-observed / hook-veto / hook-failed) are
    // in-progress observations recorded alongside wave events. They carry a
    // provenance payload on `event.data` ({ point, hook, outcome, source:'hook' })
    // and are permitted exactly like wave-attempt/wave-failed — validateTransition
    // gates illegal MOVES (post-terminal, duplicate approval, …), not a type
    // allowlist, so these three pass while no other event is loosened.
    validateTransition(event, { history: existing });

    // Only reached on a legal transition — now safe to persist.
    const stamped = { ...event, ts: event.ts ?? new Date().toISOString() };

    const file = eventsPath(repoRoot, feature);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(stamped) + '\n', 'utf8');
  }

  /** Derived current phase (pure fold over the log). */
  function phase(feature) {
    return phaseOf(history(feature));
  }

  /** Parse the feature's plan doc structured sections, or null if none. */
  function plan(feature) {
    assertSafeFeature(feature);
    const file = planPath(repoRoot, feature);
    if (!existsSync(file)) return null;
    return parsePlan(readFileSync(file, 'utf8'));
  }

  /**
   * Evaluate a named gate. Delegates the predicate to evaluateGate() over the
   * event history — a pure fold over the frozen event log. No shell-outs are
   * performed here; all authority (role verification) is established at
   * WRITE-TIME by recordApproval (which calls check-role.sh and freezes the
   * verified role into the event). Gate evaluation reads only what is already
   * frozen in the log.
   *
   * TRANSITIONAL NOTE — doc-Status authority (check-plan-approved.sh):
   *   The branch-tip doc-Status check (scripts/check-plan-approved.sh) is a
   *   complementary guardrail that was previously performed here at read-time.
   *   It is now the responsibility of the PROSE /rad-deliver Step 2
   *   (Decision 2 endpoint) — see docs/daily-workflow.md. It must NOT be
   *   re-introduced into this function; doing so would couple the pure gate
   *   fold to external filesystem/git state.
   *
   * Async: the gate-rule evaluator is loaded lazily (it pulls in the YAML
   * policy parser), so callers `await state.gate(...)`.
   */
  async function gate(feature, name) {
    const evaluate = await resolveEvaluateGate();
    return evaluate(name, history(feature));
  }

  /**
   * Enumerate features that have an event log and/or a plan doc — no per-branch
   * fan-out. Returns one descriptor per feature with its derived phase and
   * whether each backing file is present. Optional filter narrows by phase.
   *
   * @param {{ phase?: string }} [filter]
   */
  function list(filter = {}) {
    const features = new Set();

    const stateDir = join(repoRoot, '.agents', 'state');
    if (existsSync(stateDir)) {
      for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          isSafeFeature(entry.name) &&
          existsSync(eventsPath(repoRoot, entry.name))
        ) {
          features.add(entry.name);
        }
      }
    }

    const plansDir = join(repoRoot, '.agents', 'plans');
    if (existsSync(plansDir)) {
      for (const entry of readdirSync(plansDir)) {
        if (entry.endsWith('.md') && entry !== 'README.md') {
          const name = entry.replace(/\.md$/, '');
          if (isSafeFeature(name)) features.add(name);
        }
      }
    }

    const out = [];
    for (const feature of features) {
      const featurePhase = phase(feature);
      out.push({
        feature,
        phase: featurePhase,
        hasLog: existsSync(eventsPath(repoRoot, feature)),
        hasPlan: existsSync(planPath(repoRoot, feature)),
      });
    }

    return filter.phase
      ? out.filter((f) => f.phase === filter.phase)
      : out;
  }

  /**
   * Proxy-aware approval. Constructs and appends an `approved` event carrying
   * both `actor` (the architect whose judgment it is) and `recordedBy` (whoever
   * physically ran it). The gate is satisfied by `actor`; `recordedBy` preserves
   * the audit trail (design "Approval without a bottleneck").
   *
   * Write-time authority: check-role.sh is invoked ONCE against the `actor`
   * identity (in proxy mode this is the --on-behalf-of architect, not the
   * physical runner). On a non-zero exit the call throws and nothing is written.
   * The verified role is frozen into the event's `role` field so gate() reads
   * authority from the immutable log — no repeat shell-outs required at read time.
   *
   * @param {{ feature: string, actor: string, requiredRole?: string, recordedBy?: string, ts?: string, evidence?: Object }} a
   */
  function recordApproval({ feature, actor, requiredRole = 'architect', recordedBy, ts, evidence } = {}) {
    if (!feature) throw new Error('recordApproval: feature is required');
    if (!actor) throw new Error('recordApproval: actor is required');

    // Verify role at write-time. The `actor` is the identity whose authority we
    // are freezing — in proxy mode the runner (recordedBy) is not the one being
    // checked. Refuse before writing anything on a failed check.
    const roleScript = join(repoRoot, 'scripts', 'check-role.sh');
    const roleCheck = sh(roleScript, [requiredRole, claudeMdPath, actor], { cwd: repoRoot });
    if (roleCheck.status !== 0) {
      throw new Error(
        `recordApproval: role check failed — actor '${actor}' does not hold role '${requiredRole}': ` +
        `${(roleCheck.stdout || roleCheck.stderr || '').trim()}`,
      );
    }

    /** @type {import('../events.js').Event} */
    const event = {
      feature,
      type: 'approved',
      actor,
      role: requiredRole,
      ts: ts ?? new Date().toISOString(),
    };
    if (recordedBy !== undefined) event.recordedBy = recordedBy;
    if (evidence !== undefined) event.data = { evidence };

    append(event);
  }

  return {
    append,
    history,
    phase,
    plan,
    gate,
    list,
    recordApproval,
  };
}

export { defaultSh };
