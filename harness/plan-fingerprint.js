/**
 * Plan fingerprinting — a stable hash of a plan document's normative body.
 *
 * Approval and deliver REWRITE the plan's header lines (Status, Approved-By,
 * Approved-At, Completed-At, Recorded-By, Re-reviewed). If the fingerprint
 * covered those lines the hash would be circular: recording an approval would
 * change the very hash the approval attests to. So we exclude the entire mutable
 * header block by construction — we hash only from the first `## ` heading
 * onward (the document body). Same body → same hash regardless of header churn;
 * any change to a body section → a different hash.
 *
 * Exception: header `Capabilities:` lines set the plan's default capabilities,
 * so they are normative and are folded into the hashed text under
 * HEADER_CAPABILITIES_MARKER. Approval never rewrites them, so the hash stays
 * non-circular. A plan with no header `Capabilities:` line must hash
 * byte-identically to the body-only scheme, or every existing approval breaks.
 *
 * Built-in crypto only — no external deps. Reuses the createHash('sha256')
 * normalize→stringify→digest pattern from harness/fingerprint.js.
 */

import { createHash } from 'node:crypto';

const BODY_HEADING_PREFIX = '## ';
const HEADER_CAPABILITIES_PATTERN = /^Capabilities:/;
// Fold separator: changing it re-hashes every plan that has a header Capabilities line.
const HEADER_CAPABILITIES_MARKER = '\n<!-- rad:header-capabilities -->\n';

/** Index of the first body heading, or -1 when the plan has none. */
function bodyStart(lines) {
  return lines.findIndex((line) => line.startsWith(BODY_HEADING_PREFIX));
}

/**
 * The header block's `Capabilities:` lines (before the first `## `, or the whole
 * doc when there is none), trimmed, in document order.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function headerCapabilityLines(lines) {
  const start = bodyStart(lines);
  const header = start === -1 ? lines : lines.slice(0, start);
  return header.map((line) => line.trim()).filter((line) => HEADER_CAPABILITIES_PATTERN.test(line));
}

/**
 * Extract the stable normative body: everything from the first top-level `## `
 * heading to the end. Returns '' if no such heading exists. Within the body,
 * trailing whitespace is trimmed per line and runs of blank lines are collapsed
 * to a single blank line, so cosmetic whitespace churn does not shift the hash.
 *
 * @param {string} planText
 * @returns {string}
 */
function normalizeBody(planText) {
  const lines = String(planText ?? '').split('\n');
  const start = bodyStart(lines);
  if (start === -1) return '';

  const body = lines.slice(start).map((line) => line.replace(/[ \t]+$/, ''));

  // Collapse runs of blank lines to a single blank line.
  const collapsed = [];
  let lastBlank = false;
  for (const line of body) {
    const isBlank = line.length === 0;
    if (isBlank && lastBlank) continue;
    collapsed.push(line);
    lastBlank = isBlank;
  }
  return collapsed.join('\n');
}

/**
 * Compute a stable SHA-256 fingerprint of a plan document's body.
 *
 * The mutable header block is excluded by construction (see module header), so
 * editing only a header line (e.g. `Status:`) yields the SAME hash, while
 * editing any body section or a header `Capabilities:` line yields a DIFFERENT hash.
 *
 * @param {string} planText - full plan document text
 * @returns {{ hash: string }} 64-char SHA-256 hex digest of the normalized body
 */
export function planFingerprint(planText) {
  const text = String(planText ?? '');
  const capabilities = headerCapabilityLines(text.split('\n'));
  const body = normalizeBody(text);
  const hashed = capabilities.length === 0
    ? body
    : `${body}${HEADER_CAPABILITIES_MARKER}${capabilities.join('\n')}`;
  const hash = createHash('sha256').update(hashed).digest('hex');
  return { hash };
}
