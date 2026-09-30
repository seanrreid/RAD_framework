// Reviewer eval library: builds a hermetic review repo from a fixture dir,
// builds the reviewer prompt, and judges the reviewer's rad-findings output.
// Pure functions (stripFrontmatter, buildReviewPrompt, parseFindings, judgeTrial,
// judgeMajority) never throw on malformed input. readExpect and buildReviewRepo
// do I/O and throw named errors on failure.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PRIORITY_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 });
/** Priorities that make a negative (clean) fixture fail. */
const BLOCKING_PRIORITIES = new Set(['HIGH', 'MEDIUM']);
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FINDINGS_BLOCK = /````rad-findings[^\n]*\n([\s\S]*?)````/g;
/** Env prefixes stripped so a developer's RAD_* or GIT_* never leaks into the fixture repo. */
const STRIPPED_ENV = /^(RAD_|GIT_)/;
const REVIEW_BRANCH = 'review';
const FIXTURE_EMAIL = 'reviewer-eval@evals.invalid';
const FIXTURE_NAME = 'Reviewer Eval';

export const REVIEW_INSTRUCTION = [
  '---',
  '',
  '## Task',
  '',
  'Review the changes on the current branch versus main (`git diff main...HEAD`).',
  'Follow your process above. End your response with the ````rad-findings block',
  'exactly as specified, containing every finding you report.',
].join('\n');

const REVIEW_CLAUDE_MD = [
  '# Project Context', '',
  '## Stack', '', '| Layer | Technology |', '|-------|-----------|',
  '| Backend | Node.js / plain JS + HTML fixtures |', '',
  '## Coding Conventions', '', '- None special.', '',
].join('\n');

export function stripFrontmatter(md) {
  if (typeof md !== 'string') return '';
  return md.replace(FRONTMATTER, '');
}

export function buildReviewPrompt(agentMd) {
  return `${stripFrontmatter(agentMd).trim()}\n\n${REVIEW_INSTRUCTION}\n`;
}

/** Parsed JSON of the LAST rad-findings block, or null if missing/malformed. */
export function parseFindings(stdout) {
  if (typeof stdout !== 'string') return null;
  const blocks = [...stdout.matchAll(FINDINGS_BLOCK)];
  if (blocks.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return null; // unparseable output is a judged outcome ('invalid'), not an error
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return isObject && Array.isArray(parsed.findings) ? parsed : null;
}

function isValidExpect(expect) {
  if (!expect || typeof expect !== 'object') return false;
  if (expect.kind === 'negative') return true;
  if (expect.kind !== 'positive' || !(expect.minPriority in PRIORITY_RANK)) return false;
  const cats = Array.isArray(expect.category) ? expect.category : [expect.category];
  return cats.length > 0 && cats.every((c) => typeof c === 'string' && c !== '');
}

function meetsPositive(expect, finding) {
  if (!finding || typeof finding !== 'object') return false;
  const cats = Array.isArray(expect.category) ? expect.category : [expect.category];
  const rank = PRIORITY_RANK[finding.priority] ?? 0;
  return cats.includes(finding.category) && rank >= PRIORITY_RANK[expect.minPriority];
}

/** 'pass' | 'fail' | 'invalid' for one reviewer run against one fixture expectation. */
export function judgeTrial(expect, parsed) {
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) return 'invalid';
  if (!isValidExpect(expect)) return 'invalid';
  if (expect.kind === 'positive') {
    return parsed.findings.some((f) => meetsPositive(expect, f)) ? 'pass' : 'fail';
  }
  const blocking = parsed.findings.some((f) => f && BLOCKING_PRIORITIES.has(f.priority));
  return blocking ? 'fail' : 'pass';
}

/** 'pass' iff a strict majority of n trials passed; invalid and fail both count against. */
export function judgeMajority(results, n) {
  if (!Array.isArray(results) || !Number.isFinite(n) || n <= 0) return 'fail';
  const passes = results.filter((r) => r === 'pass').length;
  return passes > n / 2 ? 'pass' : 'fail';
}

/**
 * Read <fixtureDir>/expect.json. THROWS (unlike the pure helpers): a missing or
 * unparseable expect.json is a broken fixture, which a suite must surface loudly.
 */
export function readExpect(fixtureDir) {
  const path = join(fixtureDir, 'expect.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const e = new Error(`readExpect: cannot read ${path}: ${err.message}`, { cause: err });
    e.name = 'FixtureExpectError';
    throw e;
  }
}

function hermeticEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.test(k)));
}

function mustGit(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, env: hermeticEnv(), encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`buildReviewRepo: git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function commitAll(root, message) {
  mustGit(root, 'add', '-A');
  mustGit(root, 'commit', '-q', '--allow-empty', '-m', message);
}

/** Temp git repo: main = CLAUDE.md + base/, branch `review` = main + change/. */
export function buildReviewRepo(fixtureDir) {
  const base = mkdtempSync(join(tmpdir(), 'rad-reviewer-eval-'));
  const root = join(base, 'repo');
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    mustGit(base, 'init', '-q', '-b', 'main', root);
    const config = { 'user.email': FIXTURE_EMAIL, 'user.name': FIXTURE_NAME,
      'commit.gpgsign': 'false', 'core.hooksPath': join(base, 'no-hooks') };
    for (const [k, v] of Object.entries(config)) mustGit(root, 'config', k, v);
    writeFileSync(join(root, 'CLAUDE.md'), REVIEW_CLAUDE_MD);
    const baseTree = join(fixtureDir, 'base');
    if (existsSync(baseTree)) cpSync(baseTree, root, { recursive: true });
    commitAll(root, 'base');
    mustGit(root, 'checkout', '-q', '-b', REVIEW_BRANCH);
    cpSync(join(fixtureDir, 'change'), root, { recursive: true });
    commitAll(root, 'change');
  } catch (err) {
    cleanup();
    throw err;
  }
  return { root, cleanup };
}
