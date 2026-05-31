/**
 * Failure fingerprinting — the doom-loop breaker.
 *
 * Hash a wave/check result over its failed-check categories + error summary,
 * normalized so that equivalent failures hash equally and materially different
 * failures differ. The caller compares the fingerprint of two consecutive
 * cycles: an identical fingerprint means the work is provably stuck, so abort
 * instead of burning the remaining revision budget.
 *
 * Built-in crypto only — no external deps. See docs/harness-state-store.md,
 * "Failure fingerprinting (doom-loop breaker)".
 */

import { createHash } from 'node:crypto';

/** Normalize a free-text summary: trim, collapse internal whitespace, lowercase. */
function normalizeSummary(summary) {
  if (summary === undefined || summary === null) return '';
  return String(summary).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Normalize the failed-check categories: stringify, trim, dedupe, sort. */
function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  const cleaned = categories
    .map((c) => String(c).trim().toLowerCase())
    .filter((c) => c.length > 0);
  return [...new Set(cleaned)].sort();
}

/**
 * Compute a stable SHA-256 hex fingerprint of a failure result.
 *
 * Reads `result.failedCategories` (or `result.categories`) and
 * `result.errorSummary` (or `result.summary`). Equivalent failures — same
 * categories in any order, same summary modulo whitespace/case — hash equally.
 *
 * @param {{ failedCategories?: string[], categories?: string[], errorSummary?: string, summary?: string }} result
 * @returns {string} 64-char SHA-256 hex digest
 */
export function fingerprint(result) {
  const source = result ?? {};
  const categories = normalizeCategories(
    source.failedCategories ?? source.categories,
  );
  const summary = normalizeSummary(source.errorSummary ?? source.summary);

  // JSON of normalized, order-stable fields → one canonical preimage.
  const preimage = JSON.stringify({ categories, summary });
  return createHash('sha256').update(preimage).digest('hex');
}
