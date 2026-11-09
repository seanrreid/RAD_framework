/**
 * Branch-commit reader — lists the commits on a feature's `rad/<feature>`
 * branch that landed after the deliver PR opened. Shells out to git only
 * through an injectable runner with argument arrays (never a shell). Read-only:
 * it writes nothing, and nothing here may be read to block, warn or gate a
 * command.
 *
 * Commits are compared at second precision (committer time, whole seconds):
 * a commit in the same second as `since` is excluded. Harness-authored
 * commits (subject starting `deliver(`, `approve:` or `review:`) are dropped.
 * A missing ref or a missing `since` is reported as `unavailable` with a
 * reason, never thrown.
 */
import { defaultSh } from './adapters/git-state-store.js';

// Same base grammar as isSafeFeature in adapters/git-state-store.js, without its
// reserved `_architecture` literal: that project log is not a feature branch.
const SAFE_FEATURE = /^[a-z0-9][a-z0-9-]*$/;
const HARNESS_SUBJECT_PREFIXES = Object.freeze(['deliver(', 'approve:', 'review:']);
const MS_PER_SECOND = 1000;
// FIELD is the git format token for the separator character SEPARATOR; keep them paired.
const FIELD = '%x1f';
const SEPARATOR = '\x1f';
const LOG_FORMAT = `--format=%H${FIELD}%ct${FIELD}%cI${FIELD}%s`;

const refsFor = (feature) => [`refs/heads/rad/${feature}`, `refs/remotes/origin/rad/${feature}`];

function refExists(sh, root, ref) {
  return sh('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root }).status === 0;
}

function sinceSeconds(since) {
  if (typeof since !== 'string' && typeof since !== 'number') return null;
  const ms = Date.parse(since);
  return Number.isFinite(ms) ? Math.floor(ms / MS_PER_SECOND) : null;
}

const isHarnessSubject = (subject) => HARNESS_SUBJECT_PREFIXES.some((p) => subject.startsWith(p));

function parseCommits(out) {
  return out.split('\n').filter((l) => l !== '').map((line) => {
    const [sha, seconds, date, ...subject] = line.split(SEPARATOR);
    return { sha, seconds: Number(seconds), date, subject: subject.join(SEPARATOR) };
  });
}

/**
 * @param {{ root: string, feature: string, since: (string|number|undefined), sh?: Function }} opts
 *   `since` is the `pr-opened` event timestamp
 * @returns {{ available: true, ref: string,
 *     commits: {sha: string, seconds: number, date: string, subject: string}[] }
 *   | { available: false, reason: string }}
 * @throws {Error} on an unsafe feature name or a git failure on an existing ref
 */
export function readBranchCommits({ root, feature, since, sh = defaultSh }) {
  if (typeof feature !== 'string' || !SAFE_FEATURE.test(feature)) {
    throw new Error(`branch-commits: unsafe feature name ${JSON.stringify(feature)}`);
  }
  const floor = sinceSeconds(since);
  if (floor === null) return { available: false, reason: 'no pr-opened event' };
  const ref = refsFor(feature).find((r) => refExists(sh, root, r));
  if (!ref) return { available: false, reason: `no rad/${feature} branch ref (local or origin)` };
  const res = sh('git', ['log', '--first-parent', LOG_FORMAT, ref, '--'], { cwd: root });
  if (res.status !== 0) {
    throw new Error(`branch-commits: git log ${ref} failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
  }
  const commits = parseCommits(res.stdout)
    .filter((c) => c.seconds > floor && !isHarnessSubject(c.subject))
    .map(({ sha, seconds, date, subject }) => ({ sha, seconds, date, subject }));
  return { available: true, ref, commits };
}
