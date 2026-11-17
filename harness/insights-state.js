/**
 * Shared read-side state helpers for the /rad-insights fold modules: where the
 * per-feature event logs live and how to list and parse them. Read-only; the
 * writer and gate fold stay in `harness/events.js` / `harness/gates.js`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STATE_DIR = join('.agents', 'state');
export const EVENT_LOG = 'events.jsonl';
// Shared by the wave-attempt folds (4b usage cost, 4c reliability) so the event name
// and the unknown-wave bucket cannot drift between them.
export const WAVE_ATTEMPT = 'wave-attempt';
export const UNKNOWN_WAVE = '?';

/** Sorted names of the feature dirs under `stateDir` that hold an events.jsonl. */
export function listFeatures(stateDir) {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((f) => existsSync(join(stateDir, f, EVENT_LOG)))
    .sort();
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse one feature's events.jsonl. Fail-closed: a malformed line throws the
 * JSON error, and a valid-JSON line that is not an object (null, number,
 * array, string) throws an Error naming the file and 1-based line.
 */
export function readHistory(stateDir, feature) {
  const file = join(stateDir, feature, EVENT_LOG);
  const lines = readFileSync(file, 'utf8').split('\n');
  const events = [];
  lines.forEach((text, i) => {
    if (!text) return;
    const event = JSON.parse(text);
    if (!isPlainObject(event)) throw new Error(`${file}:${i + 1}: event is not a JSON object`);
    events.push(event);
  });
  return events;
}

/** Every feature's events concatenated in sorted-feature order (fail-closed per `readHistory`). */
export function readAllHistory(stateDir) {
  return listFeatures(stateDir).flatMap((feature) => readHistory(stateDir, feature));
}
