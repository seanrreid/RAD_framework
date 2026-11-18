/**
 * generated-outputs — which generated files each `.rad/` source produces.
 *
 * Usage: node harness/generated-outputs.js <source>...
 * Prints one `<generated path><TAB><source>` line per output of each named
 * source (sorted by path). A source that is not a generator input prints
 * nothing. Exits 1 with the generator's reasons on stderr when `.rad/` cannot
 * be read or rendered (fail-closed: callers surface the reason, never guess).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSources, renderOutputs } from './generate.js';

/**
 * @param {string} root - repo root holding `.rad/`
 * @param {string[]} sources - `.rad/...` source paths
 * @returns {Promise<{ ok: true, outputs: { path: string, source: string }[] } | { ok: false, errors: string[] }>}
 */
export async function generatedOutputsFor(root, sources) {
  const read = await readSources(root);
  if (!read.ok) return read;
  const rendered = renderOutputs(read.sources);
  if (!rendered.ok) return rendered;
  const wanted = new Set(sources);
  const outputs = rendered.outputs
    .filter((o) => wanted.has(o.source))
    .map(({ path, source }) => ({ path, source }));
  return { ok: true, outputs };
}

/** True when this module is the script node was invoked with (symlink-safe). */
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const got = await generatedOutputsFor(process.cwd(), process.argv.slice(2));
  if (!got.ok) {
    process.stderr.write(`generated-outputs: ${got.errors.join('; ')}\n`);
    process.exit(1);
  }
  for (const o of got.outputs) process.stdout.write(`${o.path}\t${o.source}\n`);
}
