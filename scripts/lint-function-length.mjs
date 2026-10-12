#!/usr/bin/env node
// lint-function-length.mjs
// CI ratchet for the ~40-line function rule in AGENTS.md. READ-ONLY except
// for `--write-baseline`.
//
// Scan scope: *.js / *.mjs under <root>/harness (excluding node_modules,
// vendor, test, evals, fixtures) plus the top-level <root>/scripts/*.mjs.
// A function is a declaration, function expression or arrow function; its
// length is `end line - start line + 1`; nested functions are measured on
// their own.
//
// Baseline: one `<key><TAB><length>` per line, '#' comments allowed. A key is
// `<file>::<enclosing-name-chain>><own name>`, with a `#N` ordinal when
// siblings share a name; anonymous functions are keyed `<anon>` under the
// nearest named enclosing function. Keys carry no line numbers, so unrelated
// edits above a function do not change them.
//
// Ratchet rules (the baseline can only shrink):
//   - over the limit and not baselined          -> fail (new offender)
//   - baselined function longer than recorded   -> fail (grew)
//   - baselined, shorter but still over limit   -> fail (tighten the baseline)
//   - baselined, now within limit or not found  -> fail (remove the entry)
// A missing baseline file is an empty baseline.
//
// Usage: scripts/lint-function-length.mjs [--root <dir>] [--baseline <file>]
//                                         [--write-baseline]
//   defaults: repo root of this script, <root>/scripts/lint-function-length-baseline.txt
//
// Exit codes: 0 clean | 1 violations | 2 usage/parse/baseline/scan error.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './vendor/acorn.mjs';

const MAX_FUNCTION_LINES = 40;
const EXIT_CLEAN = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_ERROR = 2;
const EXCLUDED_DIRS = new Set(['node_modules', 'vendor', 'test', 'evals', 'fixtures']);
const SCAN_EXTENSIONS = ['.js', '.mjs'];
const HARNESS_DIR = 'harness';
const SCRIPTS_DIR = 'scripts';
const SCRIPTS_EXTENSION = '.mjs';
const DEFAULT_BASELINE = 'scripts/lint-function-length-baseline.txt';
const ANON_NAME = '<anon>';
const KEY_SEPARATOR = '::';
const CHAIN_SEPARATOR = '>';
const BASELINE_LINE_RE = /^(\S+)\t(\d+)$/;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const CLASS_TYPES = new Set(['ClassDeclaration', 'ClassExpression']);
const BASELINE_HEADER = [
  '# lint-function-length baseline — a ratchet, not an allowlist.',
  `# Each line: <file>::<function key><TAB><length>. Functions over ${MAX_FUNCTION_LINES} lines.`,
  '# Rules: a new offender fails; a baselined function may not grow; when one',
  '# shrinks (still over the limit) tighten its number; when it reaches the',
  '# limit or disappears, remove its line. The baseline can only shrink.',
  '# Regenerate with: scripts/lint-function-length.mjs --write-baseline',
];

class LintError extends Error {}

function parseArgs(argv) {
  const opts = { root: null, baseline: null, writeBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write-baseline') opts.writeBaseline = true;
    else if (arg === '--root' || arg === '--baseline') {
      if (i + 1 >= argv.length) throw new LintError(`${arg} needs a value`);
      opts[arg === '--root' ? 'root' : 'baseline'] = argv[++i];
    } else throw new LintError(`unknown argument: ${arg}`);
  }
  return opts;
}

function hasScanExtension(name) {
  return SCAN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walkDir(root, rel, out) {
  const entries = readdirSync(join(root, rel), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walkDir(root, child, out);
    } else if (entry.isFile() && hasScanExtension(entry.name)) out.push(child);
  }
}

function listScriptFiles(root) {
  const names = readdirSync(join(root, SCRIPTS_DIR), { withFileTypes: true });
  return names
    .filter((e) => e.isFile() && e.name.endsWith(SCRIPTS_EXTENSION))
    .map((e) => `${SCRIPTS_DIR}/${e.name}`)
    .sort();
}

function ignoreMissing(fn) {
  try {
    fn();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function listFiles(root) {
  const files = [];
  ignoreMissing(() => walkDir(root, HARNESS_DIR, files));
  ignoreMissing(() => files.push(...listScriptFiles(root)));
  if (files.length === 0) throw new LintError(`no files to scan under ${root}`);
  return files;
}

function parseSource(source, file) {
  const options = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    return parse(source, { ...options, sourceType: 'module' });
  } catch (moduleErr) {
    try {
      return parse(source, { ...options, sourceType: 'script' });
    } catch {
      throw new LintError(`${file}: does not parse: ${moduleErr.message}`);
    }
  }
}

function propertyKeyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

function assignmentTargetName(left) {
  if (left.type === 'Identifier') return left.name;
  if (left.type === 'MemberExpression' && !left.computed) return propertyKeyName(left.property);
  return null;
}

function inferName(node, parent) {
  if (node.id) return node.id.name;
  if (!parent) return null;
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : null;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return parent.computed ? null : propertyKeyName(parent.key);
    case 'AssignmentExpression':
      return assignmentTargetName(parent.left);
    case 'AssignmentPattern':
      return parent.left.type === 'Identifier' ? parent.left.name : null;
    default:
      return null;
  }
}

function childNodes(node) {
  const children = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter((v) => v && typeof v.type === 'string'));
    else if (value && typeof value.type === 'string') children.push(value);
  }
  return children;
}

// Records every function under `node`; `chain` is the named enclosing scopes.
function collectFunctions(node, parent, chain, found) {
  let childChain = chain;
  if (FUNCTION_TYPES.has(node.type)) {
    const name = inferName(node, parent);
    const lines = node.loc.end.line - node.loc.start.line + 1;
    found.push({ chain, name: name ?? ANON_NAME, lines });
    if (name) childChain = [...chain, name];
  } else if (CLASS_TYPES.has(node.type) && node.id) {
    childChain = [...chain, node.id.name];
  }
  for (const child of childNodes(node)) collectFunctions(child, node, childChain, found);
}

function assignKeys(file, found) {
  const groups = new Map();
  for (const fn of found) {
    const base = `${file}${KEY_SEPARATOR}${[...fn.chain, fn.name].join(CHAIN_SEPARATOR)}`;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(fn);
  }
  const keyed = [];
  for (const [base, fns] of groups) {
    fns.forEach((fn, i) => keyed.push({ key: fns.length > 1 ? `${base}#${i + 1}` : base, lines: fn.lines }));
  }
  return keyed;
}

function measureFile(root, file) {
  if (/\s/.test(file)) throw new LintError(`${file}: whitespace in a path is unsupported`);
  const found = [];
  collectFunctions(parseSource(readFileSync(join(root, file), 'utf8'), file), null, [], found);
  return assignKeys(file, found);
}

function measureAll(root) {
  const measured = new Map();
  for (const file of listFiles(root)) {
    for (const { key, lines } of measureFile(root, file)) measured.set(key, lines);
  }
  return measured;
}

function parseBaselineLine(line, path, lineNo) {
  const match = BASELINE_LINE_RE.exec(line);
  if (!match) throw new LintError(`${path}:${lineNo}: malformed baseline line: ${line}`);
  return [match[1], Number(match[2])];
}

function readBaseline(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw new LintError(`cannot read baseline ${path}: ${err.message}`);
  }
  const baseline = new Map();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const [key, lines] = parseBaselineLine(line, path, i + 1);
    if (baseline.has(key)) throw new LintError(`${path}:${i + 1}: duplicate baseline key: ${key}`);
    baseline.set(key, lines);
  });
  return baseline;
}

function checkMeasured(key, lines, baseline) {
  if (lines <= MAX_FUNCTION_LINES) return null;
  if (!baseline.has(key)) return `✗ ${key}: ${lines} lines (limit ${MAX_FUNCTION_LINES}) — new offender; split it`;
  const recorded = baseline.get(key);
  if (lines > recorded) return `✗ ${key}: grew from ${recorded} to ${lines} lines (limit ${MAX_FUNCTION_LINES})`;
  if (lines < recorded) return `✗ ${key}: shrank to ${lines} lines — tighten the baseline to ${lines}`;
  return null;
}

function checkBaselined(key, measured) {
  const lines = measured.get(key);
  if (lines === undefined) return `✗ ${key}: no longer found — remove the baseline entry`;
  if (lines <= MAX_FUNCTION_LINES) return `✗ ${key}: now ${lines} lines (within ${MAX_FUNCTION_LINES}) — remove the baseline entry`;
  return null;
}

function compare(measured, baseline) {
  const problems = [];
  for (const [key, lines] of measured) problems.push(checkMeasured(key, lines, baseline));
  for (const key of baseline.keys()) problems.push(checkBaselined(key, measured));
  return problems.filter(Boolean);
}

function writeBaseline(path, measured) {
  const rows = [...measured].filter(([, lines]) => lines > MAX_FUNCTION_LINES);
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = rows.map(([key, lines]) => `${key}\t${lines}`);
  writeFileSync(path, `${[...BASELINE_HEADER, ...body].join('\n')}\n`);
  return rows.length;
}

function run(argv) {
  const opts = parseArgs(argv);
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = resolve(opts.root ?? defaultRoot);
  const baselinePath = resolve(opts.baseline ?? join(root, DEFAULT_BASELINE));
  const measured = measureAll(root);
  if (opts.writeBaseline) {
    console.log(`wrote ${writeBaseline(baselinePath, measured)} baseline entries to ${baselinePath}`);
    return EXIT_CLEAN;
  }
  const problems = compare(measured, readBaseline(baselinePath));
  if (problems.length === 0) {
    console.log(`PASS: no function over ${MAX_FUNCTION_LINES} lines outside the baseline`);
    return EXIT_CLEAN;
  }
  console.log(problems.join('\n'));
  return EXIT_VIOLATIONS;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = EXIT_ERROR;
}
