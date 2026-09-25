# Execution Log: Insights Read-Side Folds
Plan: .agents/plans/insights-read-side-folds.md
Started: 2026-09-25
Branch: rad/insights-read-side-folds
Executor role: architect

Note: a prior run on 2026-08-20 failed at Wave 1 before any code was written
(RAD_AGENT_CMD auth under ENV_ALLOW_LIST; fixed by #117). This is the re-run.

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
| 1 | Wave 1 | Commit the fixture corpus | ✓ complete | 3c18f70 | 09:58 |
| 2 | Wave 1 | Regression fence over the five existing folds | ✓ complete | 6ce8807 | 09:59 |
| 3 | Wave 2 | blockedReasonCounts fold | ✓ complete | e6bc3c5 | 10:00 |
| 4 | Wave 2 | Blocked-reason subsection in /rad-insights | ✓ complete | c2ed749 | 10:01 |
| 5 | Wave 3 | Per-file failure attribution fold | ✓ complete | 64c7c3e | 10:04 |
| 6 | Wave 3 | Code-legibility subsection in /rad-insights | ✓ complete | 61b11ee | 10:04 |
| 7 | Wave 4 | Outcome-derived reliability fold | ✓ complete | 74a1052 | 10:08 |
| 8 | Wave 4 | Model-tiering advisory subsection | ✓ complete | 40dafce | 10:08 |
