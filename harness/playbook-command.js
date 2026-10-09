/**
 * playbook-command.js — `rad playbook lint | check-ref`.
 *
 * A thin I/O shell over the pure harness/playbook.js: it reads playbook files
 * under `<root>/.agents/playbooks/` and the allowed kinds from the root's
 * `.rad/config.yml`, then reports. A config that exists but is invalid is a
 * refusal, never a silent fall back to the default kinds.
 *
 * Exit codes: 0 = ok; 1 = lint problems or a failed ref check; 2 = refused
 * (usage error or unreadable config).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import { loadConfig, resolvePlaybookKinds } from './config.js';
import { checkPlaybookRef, validatePlaybook } from './playbook.js';

const VERB = 'rad playbook';
export const PLAYBOOK_USAGE = 'rad playbook lint [--root <dir>] [<file>...] | rad playbook check-ref [--root <dir>] <ref>';
const OK_EXIT = 0;
const FAILED_EXIT = 1;
const REFUSED_EXIT = 2;
const PLAYBOOKS_DIR = '.agents/playbooks';
const PLAYBOOK_EXT = '.md';
const README_NAME = 'README.md';
const HELP_FLAGS = new Set(['--help', '-h']);
const ROOT_FLAG = '--root';

/** A deliberate refusal carrying its message; anything else is a bug and propagates. */
class PlaybookRefusal extends Error {}
const refuse = (message) => new PlaybookRefusal(`${message}\nusage: ${PLAYBOOK_USAGE}`);

/**
 * Split argv into `--root` and positionals. An unknown flag or a `--root`
 * with no value is a refusal.
 *
 * @param {string[]} args
 * @param {string} defaultRoot
 * @returns {{ root: string, positionals: string[] }}
 */
export function parsePlaybookOptions(args, defaultRoot) {
  let root = defaultRoot;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === ROOT_FLAG) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw refuse(`${ROOT_FLAG} needs a directory`);
      root = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw refuse(`unknown flag '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  return { root: resolve(root), positionals };
}

/** The root's allowed kinds: configured, or the default when there is no config file. */
async function kindsFor(root) {
  const loaded = await loadConfig(root);
  if (loaded.ok) return resolvePlaybookKinds(loaded.doc);
  if (loaded.missing) return resolvePlaybookKinds(undefined);
  throw refuse(`unreadable config: ${loaded.errors.join('; ')}`);
}

/** Files to lint: the explicit ones, else every `*.md` but README.md in the playbooks dir. */
function lintTargets(root, files) {
  if (files.length > 0) return files.map((f) => resolve(f));
  const dir = join(root, PLAYBOOKS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(PLAYBOOK_EXT) && name !== README_NAME)
    .sort()
    .map((name) => join(dir, name));
}

async function lintVerb(args, defaultRoot) {
  const { root, positionals } = parsePlaybookOptions(args, defaultRoot);
  const kinds = await kindsFor(root);
  const targets = lintTargets(root, positionals);
  let problems = 0;
  for (const path of targets) {
    const errors = validatePlaybook({ fileName: basename(path), text: readFileSync(path, 'utf8'), kinds });
    for (const error of errors) process.stdout.write(`${path}: ${error}\n`);
    problems += errors.length;
  }
  if (problems > 0) return FAILED_EXIT;
  process.stdout.write(`playbooks ok (${targets.length})\n`);
  return OK_EXIT;
}

async function checkRefVerb(args, defaultRoot) {
  const { root, positionals } = parsePlaybookOptions(args, defaultRoot);
  if (positionals.length !== 1) throw refuse(`check-ref expects one <ref>, got ${positionals.length}`);
  const kinds = await kindsFor(root);
  const dir = join(root, PLAYBOOKS_DIR);
  const readPlaybook = (fileName) => {
    const path = join(dir, fileName);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  const result = checkPlaybookRef({ ref: positionals[0], kinds, readPlaybook });
  if (!result.ok) {
    process.stderr.write(`${VERB}: ${result.reason}\n`);
    return FAILED_EXIT;
  }
  process.stdout.write(`${result.stale ? 'stale' : 'ok'} current=${result.current}\n`);
  return OK_EXIT;
}

const VERBS = { lint: lintVerb, 'check-ref': checkRefVerb };

/**
 * `rad playbook <lint|check-ref> ...`
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string }} ctx
 * @returns {Promise<number>} exit code
 */
export async function playbookCommand(argv, ctx) {
  if (argv.some((a) => HELP_FLAGS.has(a))) {
    process.stdout.write(`usage: ${PLAYBOOK_USAGE}\n`);
    return OK_EXIT;
  }
  try {
    const [verb, ...rest] = argv;
    if (!Object.hasOwn(VERBS, verb ?? '')) throw refuse(`expected a subcommand (${Object.keys(VERBS).join(' | ')})`);
    return await VERBS[verb](rest, ctx.repoRoot);
  } catch (err) {
    if (!(err instanceof PlaybookRefusal)) throw err;
    process.stderr.write(`${VERB}: ${err.message}\n`);
    return REFUSED_EXIT;
  }
}
