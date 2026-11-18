import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Shared fixture helpers for delivery-history.test.js and insights-rework-load.test.js.
// Not named *.test.js so `node --test harness/test/*.test.js` does not run it.

export const planFor = (title, paths) => `# Plan: ${title}

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
${paths.map((p) => `| ${p} | 1-10 | edit |`).join('\n')}
`;

export const squashBody = (slug) => `* plan: x\n\n* approve: ${slug}\n\nPlan: .agents/plans/${slug}.md\n\n* deliver(${slug}): begin execution`;

export function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
