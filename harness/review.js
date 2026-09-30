// Shared reviewer-prompt + findings-parse module. Used by product code (the
// review lane) and re-exported by the reviewer eval library. Pure functions:
// none of them throw on malformed input. Product code: never import from the eval tree.

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FINDINGS_BLOCK = /````rad-findings[^\n]*\n([\s\S]*?)````/g;
const DEFAULT_BASE = 'main';
/** A base ref safe to interpolate into the instruction: ref chars only, no leading '-'. */
const SAFE_BASE = /^[A-Za-z0-9._/-]+$/;

function isSafeBase(base) {
  return typeof base === 'string' && SAFE_BASE.test(base) && !base.startsWith('-');
}

export function stripFrontmatter(md) {
  if (typeof md !== 'string') return '';
  return md.replace(FRONTMATTER, '');
}

/**
 * The review task appended to a reviewer agent's body, diffing `<base>...HEAD`.
 * An invalid base (non-string, disallowed chars, leading '-') falls back to
 * 'main' rather than throwing — this function is pure; callers validate the
 * base and reject bad input before reaching here.
 */
export function reviewInstruction(base = DEFAULT_BASE) {
  const ref = isSafeBase(base) ? base : DEFAULT_BASE;
  return [
    '---',
    '',
    '## Task',
    '',
    `Review the changes on the current branch versus ${ref} (\`git diff ${ref}...HEAD\`).`,
    'Follow your process above. End your response with the ````rad-findings block',
    'exactly as specified, containing every finding you report.',
  ].join('\n');
}

export function buildReviewPrompt(agentMd, { base = DEFAULT_BASE } = {}) {
  return `${stripFrontmatter(agentMd).trim()}\n\n${reviewInstruction(base)}\n`;
}

/** Parsed JSON of the LAST rad-findings block, or null if missing/malformed. */
export function parseFindings(stdout) {
  if (typeof stdout !== 'string') return null;
  const blocks = [...stdout.matchAll(FINDINGS_BLOCK)];
  if (blocks.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return null; // unparseable output is a judged outcome ('invalid'), not an error
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return isObject && Array.isArray(parsed.findings) ? parsed : null;
}
