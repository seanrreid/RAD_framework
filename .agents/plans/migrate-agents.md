# Plan: Repo-Internal Agent Sources, and Migrate This Repo's 27 Agents (#186 part 3f-ii)
Created: 2026-10-08
Author: architect
Status: pending-review
Branch: rad/migrate-agents
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
3f-i (PR #223) made `rad-design` write `.rad/agents/<name>.md` sources and run `rad generate`, which writes `.claude/agents/<name>.md` (marked) and Codex `.codex/agents/<name>.toml`. This repo's own 27 orchestrator and mapper agents are still hand-written in `.claude/agents/` with no marker:
- 16 Task-only orchestrators;
- 11 Read/Grep/Glob context-tool mappers.

They never reach Codex, and `generate --check` doesn't guard them.

These 27 are **RAD-internal**: they were built for this repo's own features. The install manifest (`harness/install-manifest.js:63-65`) ships all of `SOURCE_TREES = ['.rad/skills', '.rad/agents']` plus every marked file under `MARKED_ROOTS = ['.claude/agents', '.agents/skills', '.codex/agents']`. Moved into `.rad/agents`, they would leak into every installed project, and `scripts/test-install-harness.sh:551` correctly asserts they don't ship.

The user decided on 2026-10-08:
- **3f Q1:** migrate all 27 to sources.
- **Leak Q:** keep them in a **separate `.rad/agents-internal/`** source directory. `rad generate` reads it; the manifest never ships it, nor any marked output whose `source:` points into it.

## Scope
| In scope | Out of scope |
|---|---|
| `rad generate` reads `.rad/agents/` and `.rad/agents-internal/` | Changing any agent's content |
| The manifest ships a marked output only when its marker's source is in a shipped tree | Codex settings on the 16 orchestrators |
| `git mv` of the 27 to `.rad/agents-internal/`, `codex.sandbox_mode: read-only` on the 11 mappers, regenerate | The lint, config schema and scope map |
| Docs that say where agents live | |

## Acceptance Criteria
1. **Generate reads both agent dirs.**
   - harness/generate.js reads agent sources from `.rad/agents/` and then `.rad/agents-internal/` (named constants). `readAgent` takes the source dir, and the marker records the real source path, for example `(source: .rad/agents-internal/spine-mapper.md)`.
   - The same agent name in both dirs is an error naming both paths.
   - With no `agents-internal` dir, every output is byte-identical to today.
   - Orphan detection treats outputs from either dir as named.
2. **A marker source reader.** harness/generated-marker.js exports `generatedSource(content)`, which returns the `source:` path from a marker line, or `null`. It parses both the `<!-- … -->` and `# …` forms, and imports nothing local, as today.
3. **The manifest filters by source.** In harness/install-manifest.js, `walkMarked` adds a marked file only when `generatedSource` returns a path that starts with a `SOURCE_TREES` entry plus `/`.
   - A marked file whose source is in `.rad/agents-internal/`, or whose source is missing or unparseable, isn't shipped (fail closed).
   - `SOURCE_TREES` is unchanged, so `.rad/agents-internal` is never shipped.
   - Today's shipped set is unchanged: the two reviewers, every generated skill, and their Codex outputs.
4. **The migration.** Each of the 27 unmarked `.claude/agents/<name>.md` files is moved with `git mv` to `.rad/agents-internal/<name>.md`.
   - Frontmatter and body stay as they were, except `codex: { sandbox_mode: read-only }` is added to the 11 whose `tools` are exactly `Read, Grep, Glob`.
   - `node harness/cli.js generate` then writes 27 marked `.claude/agents/<name>.md` and 27 `.codex/agents/<name>.toml`.
   - In each regenerated `.claude/agents` file, `name`, `description`, `model`, `tools`, `roles`, `purpose` and the body match the original. Only the marker line and renderer key order or description folding may differ, and the commit message lists which appeared.
   - These pass: `generate --check`, `bash scripts/lint-agent-files.sh` (including the one-to-one `agent_scope_map` match), and `node harness/cli.js config validate`.
5. **Not shipped.** `bash scripts/test-install-harness.sh` passes, including its existing assertion that a fresh install ships no internal orchestrator agent (`event-fold-orchestrator`), now with the 27 generated and marked in this repo.
6. **Tests.**
   - harness/test/generate.test.js: an agent in `agents-internal` is generated with its internal source in the marker; the same name in both dirs is an error; no `agents-internal` dir means unchanged output.
   - harness/test/install-manifest.test.js:
     - a marked output from `.rad/agents-internal` is excluded;
     - one from `.rad/agents` is included;
     - a marked file with no `source:` is excluded;
     - `.rad/agents-internal` sources are excluded.
   - A `generatedSource` unit test covers both marker forms and a non-marker.
7. **Docs.**
   - In each place below, change "agents are written or edited in `.claude/agents`" to "sources in `.rad/agents` (shipped) or `.rad/agents-internal` (repo-internal, never shipped); `rad generate` writes `.claude/agents` and `.codex/agents`":
     - docs/how-it-works.md (~75, ~140)
     - docs/daily-workflow.md (~74, ~86)
     - docs/onboarding.md (~17)
     - docs/apply-to-existing.md (~134)
     - docs/agent-hierarchy-audit.md (~3)
     - README.md (~38)
     - AGENTS.md (~119)
     - docs/epic-decomposition.md (~13)
   - docs/rad-tool-portability.md: the 27-agent row (~76) reads `generated (#186 part 3f-ii), internal: .rad/agents-internal, not shipped`, the agent-source spec mentions the internal dir, and the output mapping (~148) is updated.
   - `bash scripts/lint-claude-md.sh` passes.

## Agent Scope
Research came from listing the 27 unmarked agents and their tools, reading generate.js agent collection (`AGENTS_DIR`, `readAgent`, `collect`, `readSources`, `markerLine`), generated-marker.js, install-manifest.js `SOURCE_TREES`/`MARKED_ROOTS`/`walkMarked`/`listCoreFiles`, test-install-harness.sh:551, and the docs that mention `.claude/agents`. There are no out-of-scope dependencies.

## Files in Scope
<!-- Each agent move declares BOTH paths (git mv), plus its generated Codex output. -->
| File | Lines | Change |
|------|-------|--------|
| harness/generate.js | 25-60 | Agent dir constants |
| harness/generate.js | 200-262 | `readAgent` takes a dir; `readSources` collects both dirs; duplicate-name error |
| harness/generated-marker.js | 1-25 | `generatedSource(content)` |
| harness/install-manifest.js | 55-130 | `walkMarked` filters by marker source |
| harness/test/generate.test.js | 1-120 | Helpers; append cases (AC#6) |
| harness/test/install-manifest.test.js | 1-150 | Helpers; append cases (AC#6) |
| scripts/test-install-harness.sh | 530-560 | Read: the not-shipped assertion (must pass) |
| scripts/lint-agent-files.sh | 40-130 | Read only |
| .rad/agents/quality-reviewer.md | 1-20 | Read only: source format |
| .claude/agents/approval-authority-parent-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/approval-authority-parent-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/approval-authority-parent-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/approval-command-integration-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/approval-command-integration-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/approval-command-integration-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/approval-command-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/approval-command-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/approval-command-mapper.toml | 1-1 | New (generated) |
| .claude/agents/approval-event-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/approval-event-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/approval-event-mapper.toml | 1-1 | New (generated) |
| .claude/agents/approval-event-model-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/approval-event-model-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/approval-event-model-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/ci-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/ci-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/ci-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/ci-wiring-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/ci-wiring-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/ci-wiring-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/convention-lints-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/convention-lints-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/convention-lints-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/event-fold-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/event-fold-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/event-fold-mapper.toml | 1-1 | New (generated) |
| .claude/agents/event-fold-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/event-fold-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/event-fold-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/event-metrics-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/event-metrics-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/event-metrics-mapper.toml | 1-1 | New (generated) |
| .claude/agents/event-metrics-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/event-metrics-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/event-metrics-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/findings-loop-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/findings-loop-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/findings-loop-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/findings-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/findings-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/findings-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/harness-ci-parent-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/harness-ci-parent-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/harness-ci-parent-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/hook-runtime-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/hook-runtime-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/hook-runtime-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/hook-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/hook-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/hook-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/hooks-parent-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/hooks-parent-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/hooks-parent-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/insights-feedback-parent-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/insights-feedback-parent-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/insights-feedback-parent-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/integrity-checks-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/integrity-checks-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/integrity-checks-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/integrity-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/integrity-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/integrity-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/lint-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/lint-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/lint-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/portable-memory-parent-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/portable-memory-parent-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/portable-memory-parent-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/spine-integration-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/spine-integration-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/spine-integration-orchestrator.toml | 1-1 | New (generated) |
| .claude/agents/spine-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/spine-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/spine-mapper.toml | 1-1 | New (generated) |
| .claude/agents/sync-surface-mapper.md | 1-12 | Moved to the source (git mv); regenerated with the marker (context tool (read-only)) |
| .rad/agents-internal/sync-surface-mapper.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/sync-surface-mapper.toml | 1-1 | New (generated) |
| .claude/agents/sync-transport-orchestrator.md | 1-12 | Moved to the source (git mv); regenerated with the marker (orchestrator) |
| .rad/agents-internal/sync-transport-orchestrator.md | 1-1 | New internal source (renamed from .claude/agents) |
| .codex/agents/sync-transport-orchestrator.toml | 1-1 | New (generated) |
| docs/how-it-works.md | 70-80 | Where agents live |
| docs/how-it-works.md | 135-145 | Where agents live |
| docs/daily-workflow.md | 70-90 | Where agents live |
| docs/onboarding.md | 12-22 | Where agents live |
| docs/apply-to-existing.md | 128-140 | Where agents live |
| docs/agent-hierarchy-audit.md | 1-8 | Where agents live |
| README.md | 33-43 | Where agents live |
| AGENTS.md | 115-125 | Where agents live |
| docs/epic-decomposition.md | 8-18 | Where agents live |
| docs/rad-tool-portability.md | 70-80 | Agent rows |
| docs/rad-tool-portability.md | 125-152 | Source spec and output mapping |

## Execution Notes

### Do Not Touch
- The two reviewer sources and their outputs
- scripts/lint-agent-files.sh, harness/config.js, .rad/config.yml
- `SOURCE_TREES` and `MARKED_ROOTS` values (only `walkMarked`'s filter changes)
- Any agent's description, model, tools, roles, purpose or body

### Key Files
- harness/generate.js: `SOURCE_DIR`/`AGENTS_DIR` (37-39), `readAgent` (206), `listSourceDir` (226), `collect` (234), `readSources` (250-262), `markerLine` (268)
- harness/generated-marker.js: `GENERATED_MARKER`, `hasGeneratedMarker` (must stay import-free)
- harness/install-manifest.js: `SOURCE_TREES` (63), `MARKED_ROOTS` (65), `walkMarked` (104-110), `listCoreFiles` (119-125)
- scripts/test-install-harness.sh:551: the not-shipped assertion

### Reminders
- **Waves run under the 10-minute agent limit.** Validate with the targeted commands only; the reviewer runs the full suites.
- **No `agents-internal` dir means byte-identical generate output and manifest file set.**
- **Fail closed in the manifest:** a marked file is shipped only on a proven shipped source.
- **The migration is a move:** one shell loop of `git mv`, a small script for the 11 `codex` keys, then one `generate`. If `generate` rejects a source, report `blocked_spec` rather than changing content.

## Program Design
```js
// harness/generated-marker.js
export function generatedSource(content)          // → 'path' | null (both marker forms)
// harness/generate.js
const AGENT_DIRS = ['.rad/agents', '.rad/agents-internal'];
readAgent(root, dirRel, file)                     // marker source = `${dirRel}/${file}`
// harness/install-manifest.js
walkMarked(root, rel, out)                        // add only if generatedSource(text) starts with a SOURCE_TREES entry + '/'
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Generate reads agents-internal
File: harness/generate.js:25-60, 200-262, harness/generated-marker.js:1-25, harness/test/generate.test.js:1-120
What: Write AC#1 and AC#2, with the generate.test.js cases and the `generatedSource` unit test.
Validate: AC#1, AC#2, AC#6 — `node --test harness/test/generate.test.js` passes; `node harness/cli.js generate --check` exits 0

### Wave 2 — sequential

#### Task 2.1: The manifest filters marked outputs by source
File: harness/install-manifest.js:55-130, harness/test/install-manifest.test.js:1-150
What: Write AC#3 and its install-manifest.test.js cases.
Validate: AC#3, AC#6 — `node --test harness/test/install-manifest.test.js` passes; `bash scripts/test-install-harness.sh` passes

### Wave 3 — sequential

#### Task 3.1: Move and regenerate the 27 agents
File: .rad/agents/quality-reviewer.md:1-20, scripts/lint-agent-files.sh:40-130, scripts/test-install-harness.sh:530-560
What: Write AC#4 and AC#5. Find the unmarked `.claude/agents/*.md` files, `git mv` each to `.rad/agents-internal/`, add the `codex` key to the 11 Read/Grep/Glob mappers, run `node harness/cli.js generate`, and stage the moves plus the generated `.claude/agents` and `.codex/agents` files. Compare each regenerated file's fields and body with the original (`git show HEAD:<path>`), and record renderer-only differences in the commit message.
Validate: AC#4, AC#5 — `node harness/cli.js generate --check` exits 0; `bash scripts/lint-agent-files.sh` passes; `node harness/cli.js config validate` passes; `bash scripts/test-install-harness.sh` passes

### Wave 4 — sequential

#### Task 4.1: Docs: where agents live
File: docs/how-it-works.md:70-80, 135-145, docs/daily-workflow.md:70-90, docs/onboarding.md:12-22, docs/apply-to-existing.md:128-140, docs/agent-hierarchy-audit.md:1-8, README.md:33-43, AGENTS.md:115-125, docs/epic-decomposition.md:8-18, docs/rad-tool-portability.md:70-80, 125-152
What: Write AC#7.
Validate: AC#7 — `bash scripts/lint-claude-md.sh` passes; docs only

## Tests to Write
- [ ] agents-internal generation, duplicate names, unchanged output without the dir; generatedSource — harness/test/generate.test.js
- [ ] marked outputs filtered by source; internal sources excluded — harness/test/install-manifest.test.js

## Non-Goals
- Changing what any agent says or does.
- Codex settings for the orchestrators.
- Changing `SOURCE_TREES`/`MARKED_ROOTS` or the agent lint.

## Out-of-Scope Dependencies
None

## Risks
- **The marker-source filter changes what core installs ship.** Mitigation: AC#3 requires today's shipped set unchanged, and existing marked files all carry `source:`. The install-harness test is the end-to-end check.
- **The renderer may reorder keys or fold descriptions** in the regenerated files. AC#4 allows only that, and requires listing it.
- **Self-protected paths** (`harness/`, `scripts/`, `.rad/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — only the 11 Read/Grep/Glob mappers get `sandbox_mode: read-only`.** The orchestrators only delegate.
- **Assumption — a marked file without a parseable source isn't shipped.** All current generated files carry one, so nothing that ships today is lost.
- **Assumption — `.rad/agents-internal` is read before nothing else changes.** A duplicate name across dirs is an error, never a silent override.
