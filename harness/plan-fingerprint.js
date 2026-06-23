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
 * Built-in crypto only — no external deps. Reuses the createHash('sha256')
 * normalize→stringify→digest pattern from harness/fingerprint.js.
 */

import { createHash } from 'node:crypto';

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
  const start = lines.findIndex((line) => line.startsWith('## '));
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
 * editing any body section yields a DIFFERENT hash.
 *
 * @param {string} planText - full plan document text
 * @returns {{ hash: string }} 64-char SHA-256 hex digest of the normalized body
 */
export function planFingerprint(planText) {
  const body = normalizeBody(planText);
  const hash = createHash('sha256').update(body).digest('hex');
  return { hash };
}
