/**
 * Delivery-history reader — the only delivery-metrics module that shells out.
 * Reads the default branch's first-parent history and returns the raw records
 * the pure folds in delivery-metrics.js consume. Read-only: it writes nothing
 * to the repo, and nothing here may be read to block, warn or gate a command.
 *
 * A deliver merge is either
 *   - a squash commit whose subject starts `Deliver:` and whose body names the
 *     feature (`deliver(<slug>)` or `Plan: .agents/plans/<slug>.md`), or
 *   - a two-parent merge `Merge pull request #N from <owner>/rad/<slug>`,
 *     diffed against its first parent.
 * A deliver merge whose slug is missing or ambiguous is counted in
 * `unresolved` — never guessed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSh } from './adapters/git-state-store.js';

const PLAN_PATHS_LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'plan-paths.sh');
const SCOPE_PATHS_SCRIPT = '. "$1" && plan_scope_paths "$2"';
const plansPath = (slug) => `.agents/plans/${slug}.md`;

// Record markers that cannot appear in a commit message or a NUL-separated path list.
const RECORD = '\x01';
const FIELD = '\x02';
const HEADER_END = '\x03';
const LOG_FORMAT = `--format=${RECORD}%H${FIELD}%P${FIELD}%cI${FIELD}%s${FIELD}%b${HEADER_END}`;
const LOG_BASE = ['log', '--first-parent', '--diff-merges=first-parent', '-M', '-z', LOG_FORMAT];

const SLUG = '[a-z0-9][a-z0-9-]*';
const DELIVER_SUBJECT = /^Deliver:/;
const MERGE_SUBJECT = new RegExp(`^Merge pull request #(\\d+) from [^/\\s]+/rad/(${SLUG})\\s*$`);
const PR_GROUP = /\(#(\d+)\)/g;
const BODY_SLUGS = [new RegExp(`deliver\\((${SLUG})\\)`, 'g'), new RegExp(`^Plan: \\.agents/plans/(${SLUG})\\.md\\s*$`, 'gm')];
const RENAME_OR_COPY = /^[RC]/;

function git(sh, root, args) {
  const res = sh('git', args, { cwd: root });
  if (res.status !== 0) {
    throw new Error(`delivery-history: git ${args.slice(0, 2).join(' ')} failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
  }
  return res.stdout;
}

/** False for an empty repo (no commits anywhere); throws when commits exist but the branch does not. */
function branchExists(sh, root, branch) {
  if (sh('git', ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { cwd: root }).status === 0) return true;
  if (git(sh, root, ['rev-list', '-n', '1', '--all']).trim() === '') return false;
  throw new Error(`delivery-history: default branch '${branch}' not found in ${root}`);
}

/** Split `git log -z` output into `{ sha, parents, date, subject, body, tokens }`, newest first. */
function parseLog(out) {
  return out.split(RECORD).filter((r) => r !== '').map((record) => {
    const end = record.indexOf(HEADER_END);
    const [sha, parents, date, subject, body] = record.slice(0, end).split(FIELD);
    // -z puts a NUL and a newline between the header and the first diff entry.
    const tokens = record.slice(end + 1).replace(/^[\0\n]+/, '').split('\0').filter((t) => t !== '');
    return { sha, parents: parents.split(' ').filter(Boolean), date, subject, body, tokens };
  });
}

/** `--name-status -z` tokens → touches; renames and copies carry `oldPath`. */
function parseNameStatus(tokens) {
  const touches = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i];
    if (RENAME_OR_COPY.test(status)) {
      touches.push({ path: tokens[i + 2], oldPath: tokens[i + 1], status });
      i += 3;
    } else {
      touches.push({ path: tokens[i + 1], status });
      i += 2;
    }
  }
  return touches;
}

const lineCount = (n) => (n === '-' ? null : Number.parseInt(n, 10));

/** `--numstat -z` tokens → files; a rename's path is its new path, binary counts are null. */
function parseNumstat(tokens) {
  const files = [];
  for (let i = 0; i < tokens.length;) {
    const [added, deleted, path] = tokens[i].split('\t');
    if (path === '') {
      files.push({ path: tokens[i + 2], added: lineCount(added), deleted: lineCount(deleted) });
      i += 3;
    } else {
      files.push({ path, added: lineCount(added), deleted: lineCount(deleted) });
      i += 1;
    }
  }
  return files;
}

/** The PR number is the LAST `(#N)` — subjects may also carry an issue number. */
const lastPr = (subject) => {
  const groups = [...subject.matchAll(PR_GROUP)];
  return groups.length === 0 ? null : Number(groups.at(-1)[1]);
};

/** `{ isDeliver, feature?, pr }`; `feature` is absent when the slug is missing or ambiguous. */
function classify(entry) {
  const merge = entry.parents.length > 1 ? entry.subject.match(MERGE_SUBJECT) : null;
  if (merge) return { isDeliver: true, feature: merge[2], pr: Number(merge[1]) };
  if (!DELIVER_SUBJECT.test(entry.subject)) return { isDeliver: false };
  const slugs = new Set(BODY_SLUGS.flatMap((re) => [...entry.body.matchAll(re)].map((m) => m[1])));
  const pr = lastPr(entry.subject);
  return slugs.size === 1 ? { isDeliver: true, feature: [...slugs][0], pr } : { isDeliver: true, pr };
}

/** Plan scope at `sha` via plan-paths.sh; `[]` when the plan file is absent at that commit. */
function scopedFilesAt(sh, root, sha, slug) {
  const spec = `${sha}:${plansPath(slug)}`;
  if (sh('git', ['cat-file', '-e', spec], { cwd: root }).status !== 0) return [];
  const dir = mkdtempSync(join(tmpdir(), 'rad-delivery-plan-'));
  try {
    const planFile = join(dir, 'plan.md');
    writeFileSync(planFile, git(sh, root, ['show', spec]));
    const res = sh('bash', ['-c', SCOPE_PATHS_SCRIPT, '_', PLAN_PATHS_LIB, planFile], { cwd: root });
    if (res.status !== 0) throw new Error(`delivery-history: plan_scope_paths failed for ${spec}: ${(res.stderr || '').trim()}`);
    return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {{ root: string, sh?: typeof defaultSh, defaultBranch: string }} opts
 * @returns {{ merges: Object[], commits: Object[], unresolved: number }} merges and
 *   commits oldest first; an empty repo yields empty arrays
 */
export function readDeliveryHistory({ root, sh = defaultSh, defaultBranch }) {
  if (!branchExists(sh, root, defaultBranch)) return { merges: [], commits: [], unresolved: 0 };
  const statusLog = parseLog(git(sh, root, [...LOG_BASE, '--name-status', defaultBranch])).reverse();
  const numstatBySha = new Map(parseLog(git(sh, root, [...LOG_BASE, '--numstat', defaultBranch]))
    .map((e) => [e.sha, parseNumstat(e.tokens)]));
  const merges = [];
  const commits = [];
  let unresolved = 0;
  for (const entry of statusLog) {
    const kind = classify(entry);
    commits.push({ sha: entry.sha, committedAt: entry.date, isDeliver: kind.isDeliver,
      ...(kind.feature ? { feature: kind.feature } : {}), touches: parseNameStatus(entry.tokens) });
    if (!kind.isDeliver) continue;
    if (!kind.feature) { unresolved += 1; continue; }
    merges.push({ feature: kind.feature, sha: entry.sha, pr: kind.pr, mergedAt: entry.date,
      files: numstatBySha.get(entry.sha) ?? [], scopedFiles: scopedFilesAt(sh, root, entry.sha, kind.feature) });
  }
  return { merges, commits, unresolved };
}
