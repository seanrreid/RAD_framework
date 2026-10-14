| step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
| 1 | Wave 1 | Touches table and core-set description | ✓ complete | f5d43ff | 2026-10-14 |
| 2 | Wave 1 | Commit commands, agent section and command names | ✓ complete | 7be3fb8 | 2026-10-14 |

Task 1.3 scratch-repo results (fresh `install.sh --yes`, then `--upgrade`):
- (a) manifest has .claude/commands, .claude/skills, ai, scripts/*.sh, scripts/*.mjs, scripts/lib, scripts/hooks, harness, .rad/skills, .rad/agents, plus marker files in .claude/agents, .agents/skills, .codex/agents.
- (b) unedited accessibility-reviewer.md: identical after --upgrade.
- (c) edited quality-reviewer.md: kept; new version staged at .rad/upgrade-pending/.claude/agents/quality-reviewer.md; installer reported keep.
- (d) hand-written .claude/agents/my-agent.md (no marker): untouched, not in manifest.
- No contradiction with AC#1/AC#2; no wording change needed.
- Note: `git add .rad/` (AC#3) would also stage .rad/upgrade-pending/ if a kept edit exists.
- AC#5 grep prints nothing; all relative links resolve; diff stat main...HEAD lists UPGRADE.md, the plan, and events.jsonl (approval/deliver state events).
