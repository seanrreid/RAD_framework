#!/usr/bin/env node
// deliver-gate-hook.mjs — PreToolUse gate for /rad-deliver.
//
// CONTRACT (Claude Code PreToolUse hook):
//   stdin: JSON with top-level `tool_name` and `tool_input`. For a Skill call,
//     `tool_input.skill_name` is the skill id (e.g. "team:rad-deliver" or
//     "rad-deliver") and `tool_input.skill_args` is the raw argument string the
//     user passed (e.g. ".agents/plans/foo.md" or a bare "<slug>").
//   BLOCK: print a clear reason to stderr and `exit 2`. (Do NOT also emit JSON —
//     exit 2 wins; never both.)
//   ALLOW: `exit 0` with no output.
//
// FAIL-OPEN CAVEAT: the harness treats a crash, invalid output, or ANY exit code
// other than 0 or 2 as NON-BLOCKING (the tool proceeds). Therefore this script
// converts EVERY error/uncertainty path to `exit 2` (default-deny). The only
// exit-0 paths are explicit pass-throughs (non-Skill, non-rad-deliver, empty
// args) and an approved gate. We never rely on a bare non-zero exit.
//
// Dependency-free: Node builtins only (process, child_process, path).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Block helper: write a reason to stderr and deny (exit 2).
function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

try {
  // Resolve repo root from this script's location (scripts/ -> repo root).
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');

  // --- Read + parse stdin (fail closed on any problem) ---
  let raw;
  try {
    const { readFileSync } = await import('node:fs');
    raw = readFileSync(0, 'utf8');
  } catch {
    block('deliver gate: could not read stdin — denying.');
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    block('deliver gate: malformed hook payload (invalid JSON) — denying.');
  }

  if (payload === null || typeof payload !== 'object') {
    block('deliver gate: malformed hook payload (not an object) — denying.');
  }

  // --- Not a Skill call → not our concern, allow ---
  if (payload.tool_name !== 'Skill') {
    process.exit(0);
  }

  const toolInput =
    payload.tool_input && typeof payload.tool_input === 'object'
      ? payload.tool_input
      : null;
  if (toolInput === null) {
    // A Skill call with no/invalid tool_input is malformed → fail closed.
    block('deliver gate: Skill call missing tool_input — denying.');
  }

  // --- Is this the rad-deliver skill? Match trailing segment === "rad-deliver" ---
  const skillName =
    typeof toolInput.skill_name === 'string' ? toolInput.skill_name : '';
  const trailingSegment = skillName.split(':').pop();
  if (trailingSegment !== 'rad-deliver') {
    // Some other skill — allow.
    process.exit(0);
  }

  // --- Extract the feature slug from skill_args ---
  const skillArgs =
    typeof toolInput.skill_args === 'string' ? toolInput.skill_args : '';
  const trimmed = skillArgs.trim();

  // Argument-less listing case → allow (nothing to gate).
  if (trimmed === '') {
    process.exit(0);
  }

  // Accept either a `.agents/plans/<slug>.md` path or a bare `<slug>` token.
  let slug = null;
  const firstArg = trimmed.split(/\s+/)[0];
  const planMatch = firstArg.match(/\.agents\/plans\/([^/]+)\.md$/);
  if (planMatch) {
    slug = planMatch[1];
  } else {
    slug = firstArg;
  }

  // Validate the slug before using it in a branch name / shell call.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    block(
      `deliver gate: could not resolve a valid feature slug from "${skillArgs}" — denying.`
    );
  }

  // --- Run the approval gate (fail closed on non-zero / spawn error) ---
  const gateScript = path.join(repoRoot, 'scripts', 'check-plan-approved.sh');
  try {
    execFileSync(gateScript, [`rad/${slug}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    // Non-zero exit (not approved) OR spawn failure (script missing) → block.
    block(
      `deliver blocked: no approved event for ${slug} — run /rad-approve first`
    );
  }

  // Approved → allow.
  process.exit(0);
} catch {
  // Any unexpected error anywhere → fail closed.
  block('deliver gate: unexpected internal error — denying.');
}
