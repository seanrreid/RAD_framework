/**
 * Invariant registry — schema validation, anchor checks, and bypass inventory.
 *
 * A registry doc (parsed YAML) names each invariant, its authority, the code
 * anchors that enforce it, and the analyzed bypass surfaces. All exports are
 * pure and total: malformed input yields error strings (or []), never a throw.
 * I/O is injected — `checkAnchors` reads files only through its `readFile` port.
 */

export const REGISTRY_VERSION = 1;

/** Bypass `guarded` values. Only these exact STRINGS are accepted: js-yaml 4
 * parses a bare `yes`/`no` as a string, but YAML 1.1 parsers yield boolean
 * true/false — a boolean here means the doc was parsed under different rules. */
const GUARDED_VALUES = Object.freeze(['yes', 'no']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function validateAnchors(label, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return [`${label}: enforced_by must be a non-empty array`];
  }
  const errors = [];
  anchors.forEach((a, i) => {
    if (!isObject(a) || !isNonEmptyString(a.file) || !isNonEmptyString(a.symbol)) {
      errors.push(`${label}: enforced_by[${i}] requires non-empty file and symbol`);
    }
  });
  return errors;
}

function validateBypasses(label, entry) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'bypasses')) {
    return [`${label}: bypasses not analyzed (use [] for none)`];
  }
  if (!Array.isArray(entry.bypasses)) return [`${label}: bypasses must be an array`];
  const errors = [];
  entry.bypasses.forEach((b, i) => {
    if (!isObject(b) || !isNonEmptyString(b.id) || !isNonEmptyString(b.surface)) {
      errors.push(`${label}: bypasses[${i}] requires id, surface, and guarded`);
    } else if (!GUARDED_VALUES.includes(b.guarded)) {
      errors.push(`${label}: bypasses[${i}] guarded must be the string "yes" or "no"`);
    }
  });
  return errors;
}

function validateEntry(entry, index, seenIds) {
  if (!isObject(entry)) return [`invariants[${index}]: entry must be an object`];
  if (!isNonEmptyString(entry.id)) return [`invariants[${index}]: missing id`];
  const label = entry.id;
  const errors = [];
  if (seenIds.has(label)) errors.push(`${label}: duplicate id`);
  seenIds.add(label);
  if (!isNonEmptyString(entry.claim)) errors.push(`${label}: missing claim`);
  if (!isNonEmptyString(entry.authority)) errors.push(`${label}: missing authority`);
  errors.push(...validateAnchors(label, entry.enforced_by));
  errors.push(...validateBypasses(label, entry));
  return errors;
}

/** Validate a registry doc. Returns error strings; empty means valid. */
export function validateRegistry(doc) {
  if (!isObject(doc)) return ['registry: doc must be an object'];
  const errors = [];
  if (doc.version !== REGISTRY_VERSION) {
    errors.push(`registry: version must be ${REGISTRY_VERSION}`);
  }
  if (!Array.isArray(doc.invariants)) {
    errors.push('registry: invariants must be an array');
    return errors;
  }
  const seenIds = new Set();
  doc.invariants.forEach((entry, i) => errors.push(...validateEntry(entry, i, seenIds)));
  return errors;
}

/** Anchors to verify for one invariant: every enforced_by anchor, plus
 * display_only anchors only when they carry both file and symbol. */
function anchorsOf(entry) {
  const enforced = Array.isArray(entry.enforced_by) ? entry.enforced_by : [];
  const display = Array.isArray(entry.display_only) ? entry.display_only : [];
  const hasBoth = (a) => isObject(a) && isNonEmptyString(a.file) && isNonEmptyString(a.symbol);
  return [...enforced.filter(hasBoth), ...display.filter(hasBoth)];
}

/** Check each anchor's symbol is a literal substring of its file. Position is
 * irrelevant — a moved symbol still passes. Invalid shape → [] (never throws). */
export function checkAnchors(doc, readFile) {
  if (!isObject(doc) || !Array.isArray(doc.invariants)) return [];
  const errors = [];
  for (const entry of doc.invariants) {
    if (!isObject(entry)) continue;
    for (const { file, symbol } of anchorsOf(entry)) {
      const content = readFile(file);
      if (typeof content !== 'string') errors.push(`${entry.id}: ${file} not found`);
      else if (!content.includes(symbol)) {
        errors.push(`${entry.id}: symbol not found in ${file}: ${symbol}`);
      }
    }
  }
  return errors;
}

/** Flatten every bypass in registry order. Invalid shape → []. */
export function bypassInventory(doc) {
  if (!isObject(doc) || !Array.isArray(doc.invariants)) return [];
  const rows = [];
  for (const entry of doc.invariants) {
    if (!isObject(entry) || !Array.isArray(entry.bypasses)) continue;
    for (const b of entry.bypasses) {
      if (!isObject(b)) continue;
      rows.push({ invariant: entry.id, id: b.id, surface: b.surface, guarded: b.guarded, note: b.note });
    }
  }
  return rows;
}
