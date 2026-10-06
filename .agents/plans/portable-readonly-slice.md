# Plan: Migrate the Read-Only Slice and Ship It (#171 part 2)
Created: 2026-10-06
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T18:56:36.674Z
Recorded-By: sean@torchcodelab.com
Branch: rad/portable-readonly-slice
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/171
Issue-Title: Assistant-portable skill surface: one source, generated Claude + Codex wrappers (no symlinks)

## Context

Part 1 (#187) shipped the pieces the slice needs:
- **`harness/generate.js`:**
  - **Skill sources** (`.rad/skills/<name>/SKILL.md`) take `targets: { claude: command:<dir>/<file> | skill, codex: skill | none, codex_implicit? }`, with optional `claude.md`/`codex.md` override bodies and the `{{args}}` token.
  - **Agent sources** (`.rad/agents/<name>.md`) produce `.claude/agents/<name>.md` and `.codex/agents/<name>.toml`.
  - **Marker:** every output carries a generated marker.
  - **Exports:** `OUTPUT_ROOTS`, `hasGeneratedMarker`.
- **`rad generate [--check]`:** never overwrites an unmarked file; an unmarked file at an output path is a conflict (exit 2).
- **CI `generated-drift` job:** runs `generate --check`.
- **`docs/rad-tool-portability.md`:** the matrix marks the read-only slice `planned: part 2`.
- **#186:** filed for state-changing parity.

**What this plan moves into `.rad/`:**

| Item | Today | After this plan |
|---|---|---|
| `quality-reviewer`, `accessibility-reviewer` | Hand-written `.claude/agents/*.md`; never shipped (`.claude/agents/` is user data, `harness/install-manifest.js:53` `CORE_TREES`), yet `rad review` loads them (`harness/cli.js` ~2668-2775) | `.rad/agents/` sources; Claude and Codex outputs generated |
| `quality-review` (38 lines), `accessibility-review` (41), `rad-status` (32) | Hand-written `.claude/commands/` files | `.rad/skills/` sources; `.claude/commands/` and `.agents/skills/` outputs generated |
| `/rad-review` (335 lines, heavy prose) | Hand-written Claude command | Stays hand-written; a Codex-only version is added |

**Also corrected here:**
- `lint-agent-files.sh:15-17` cites `quality-reviewer` as an agent without `roles:`, but it has one.

**Decisions (2026-10-06, recorded on #171):**
- **Ship sources and outputs:** core installs `.rad/skills/` and `.rad/agents/` plus every generated output.
- **Codex runs the reviewers as sub-agents:** the Codex `quality-review` and `accessibility-review` skills spawn the generated `.codex/agents/<reviewer>` sub-agent (`sandbox_mode: read-only`).

## Scope

| In scope | Out of scope |
|---|---|
| `.rad/agents/{quality,accessibility}-reviewer.md` sources (moved bodies) + generated outputs | Any reviewer body change (part 3 adjusts CLAUDE.md wording) |
| `.rad/skills/{quality-review,accessibility-review,rad-status}` sources + generated outputs | `rad-review`'s Claude command (stays hand-written) |
| `claude: none` target in the generator; Codex-only `rad-review` source + output | State-changing commands and skills (#186) |
| Core ships `.rad/skills`, `.rad/agents` and every marked generated output | Shipping `deliver-gate-hook.mjs` / settings (#186) |
| `lint-agent-files.sh` comment fix; `generated-wrappers-match-source` invariant; matrix status update | AGENTS.md / CLAUDE.md (part 3) |

## Acceptance Criteria

1. **Reviewer agents come from sources.**
   - **Sources:** `.rad/agents/quality-reviewer.md` and `.rad/agents/accessibility-reviewer.md` take today's frontmatter (`name`, `description`, `model`, `tools`, `roles`) and bodies unchanged, plus `codex: { sandbox_mode: read-only }`.
   - **Generated in the same commit:**
     - the hand-written `.claude/agents/<reviewer>.md` files are deleted;
     - `rad generate` writes `.claude/agents/<reviewer>.md` (same frontmatter values, same body, plus the marker) and `.codex/agents/<reviewer>.toml`.
   - **Checks:**
     - `scripts/lint-agent-files.sh` passes on the generated files;
     - `rad review quality-reviewer` still resolves and parses the generated agent (covered by a test);
     - the diff of each `.claude/agents/<reviewer>.md` against main is only the marker line plus any frontmatter re-serialization. Report the exact diff in the WAVE_RESULT.
2. **Commands come from sources.**
   - **`quality-review` and `accessibility-review`:** sources in `.rad/skills/` with `targets: { claude: command:team/<name>, codex: skill }`.
     - **Claude:** the body produces today's command text, with `$ARGUMENTS` coming from `{{args}}`.
     - **Codex (`codex.md` override):** tells Codex to spawn the `<reviewer>` sub-agent defined in `.codex/agents/<reviewer>.toml` on the changed files (or the files the user named), then report its findings. It never edits files.
   - **`rad-status`:** source with `targets: { claude: command:shared/rad-status, codex: skill }` and one shared body (no Claude-only syntax).
   - **Generated in the same commit:** the hand-written `.claude/commands/` files are deleted and regenerated. Diff against main: the marker plus frontmatter re-serialization only. Report the exact diff.
3. **A Codex-only `rad-review`.**
   - **Generator:** `harness/generate.js` accepts `claude: none`. It emits no Claude output, and `claude: none` together with `codex: none` is an error. Covered by tests in `harness/test/generate.test.js`.
   - **Source:** `.rad/skills/rad-review/SKILL.md` with `targets: { claude: none, codex: skill }`. It writes `.agents/skills/rad-review/SKILL.md`, a read-only review of the current `rad/<feature>` branch:
     1. run `scripts/check-scope.sh`, `scripts/lint-plan.sh`, `scripts/check-approval-blockers.sh` and `scripts/check-tests-present.sh` for the branch's plan (resolved the way the Claude command does, via `scripts/get-default-branch.sh`);
     2. spawn the `quality-reviewer` sub-agent, and the `accessibility-reviewer` sub-agent when UI files changed;
     3. report a combined summary.
   - **Never written:** it doesn't append to `.agents/findings.jsonl`, commit or push.
   - **Untouched:** the Claude `.claude/commands/team/rad-review.md` stays hand-written and unmarked.
4. **Shipping through core.** `listCoreFiles` (`harness/install-manifest.js`) adds two things:
   - the `.rad/skills` and `.rad/agents` trees, when present;
   - every regular file under `.claude/agents`, `.agents/skills` and `.codex/agents` that carries the generated marker (via `hasGeneratedMarker` from `harness/generate.js`).

   `.claude/commands` and `.claude/skills` are already core trees. Unmarked files under the new roots are never shipped, so the 27 internal RAD agents stay unshipped.
   - **`install-manifest.test.js` covers:**
     - marked files ship;
     - unmarked files don't;
     - the `.rad/` source trees ship;
     - `.rad/config.yml` and `.rad/installed.json` are never shipped;
     - no symlink is followed.
   - **`scripts/test-install-harness.sh`:** a fresh install contains the generated reviewer agents (Claude and Codex), the four `.agents/skills/*` outputs and the `.rad/agents` sources, and no internal orchestrator agent. A target-side `node harness/cli.js generate --check` exits 0.
5. **Small fixes and docs.**
   - **`scripts/lint-agent-files.sh`:** the comment no longer cites `quality-reviewer` as an agent without `roles:`. It is a comment-only change; behaviour is unchanged.
   - **`docs/rad-tool-portability.md`:** matrix statuses for the slice become `generated`. The `rad-review` row records the Codex-only wrapper and the hand-written Claude command. The "Shipping gaps" table marks the reviewer gap fixed.
   - **`docs/invariants.yaml`:** gains `generated-wrappers-match-source`: "every file carrying the generated marker equals what `rad generate` renders from its `.rad/` source, and no marked file lacks a source".
     - Anchors: `harness/generate.js` (`planGenerate`, `GENERATED_MARKER`) and the CI job line in `.github/workflows/ci.yml`.
     - `not_evalable`: build-time check with no agent-reachable bypass; covered by `generated-drift` and `harness/test/generate.test.js`.
     - Bypass: a hand-edited unmarked file is not covered, by design.
6. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`, `scripts/lint-agent-files.sh`;
   - `node harness/cli.js generate --check`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No mapper agents were used. Part 1's research (Codex conventions, RAD's surface map) applies unchanged. Anchors were checked directly on main at `0ec2766`:
- the `generate.js` target parsing (110-135) and emit (312-314);
- `install-manifest.js` `CORE_TREES`/`listCoreFiles` (53-103);
- the reviewer frontmatter;
- the three command files;
- the `lint-agent-files.sh` comment (15-17);
- the portability matrix rows (52-73).

There are no out-of-scope dependencies.

## Files in Scope

Line ranges are the context an executor must load. Generated outputs are written by `rad generate`, not by hand, so their range is the marker and frontmatter region only. Moved bodies are unchanged, so their range is the frontmatter region.

| File | Lines | Change |
|------|-------|--------|
| harness/generate.js | 105-140 | `claude: none` target |
| harness/generate.js | 305-320 | Skip the Claude emit for `none` |
| harness/test/generate.test.js | 335-400 | `claude: none` cases (append) |
| harness/install-manifest.js | 1-60 | Import marker helper; constants |
| harness/install-manifest.js | 60-110 | `listCoreFiles` ships `.rad` sources and marked outputs |
| harness/test/install-manifest.test.js | 560-640 | Shipping cases (append) |
| scripts/test-install-harness.sh | 420-470 | Fresh-install slice assertions |
| scripts/lint-agent-files.sh | 10-20 | Comment fix |
| .rad/agents/quality-reviewer.md | 1-15 | New source (body moved unchanged) |
| .rad/agents/accessibility-reviewer.md | 1-15 | New source (body moved unchanged) |
| .rad/skills/quality-review/SKILL.md | 1-45 | New source |
| .rad/skills/quality-review/codex.md | 1-30 | New Codex body |
| .rad/skills/accessibility-review/SKILL.md | 1-45 | New source |
| .rad/skills/accessibility-review/codex.md | 1-30 | New Codex body |
| .rad/skills/rad-status/SKILL.md | 1-40 | New source |
| .rad/skills/rad-review/SKILL.md | 1-80 | New Codex-only source |
| .claude/agents/quality-reviewer.md | 1-15 | Regenerated (marker) |
| .claude/agents/accessibility-reviewer.md | 1-15 | Regenerated (marker) |
| .claude/commands/team/quality-review.md | 1-10 | Regenerated (marker) |
| .claude/commands/team/accessibility-review.md | 1-10 | Regenerated (marker) |
| .claude/commands/shared/rad-status.md | 1-10 | Regenerated (marker) |
| .codex/agents/quality-reviewer.toml | 1-10 | Generated |
| .codex/agents/accessibility-reviewer.toml | 1-10 | Generated |
| .agents/skills/quality-review/SKILL.md | 1-10 | Generated |
| .agents/skills/accessibility-review/SKILL.md | 1-10 | Generated |
| .agents/skills/rad-status/SKILL.md | 1-10 | Generated |
| .agents/skills/rad-review/SKILL.md | 1-10 | Generated |
| docs/rad-tool-portability.md | 15-80 | Matrix statuses, `rad-review` row, shipping-gaps table |
| docs/invariants.yaml | 260-300 | `generated-wrappers-match-source` (append) |

## Execution Notes

### Do Not Touch
- `.claude/commands/team/rad-review.md` (stays hand-written).
- Every other `.claude/commands/**`, `.claude/skills/**` and `.claude/agents/*` file.
- `CLAUDE.md`, `install.sh`, `scripts/deliver-gate-hook.mjs`, `.claude/settings.json`.
- In `generate.js`, nothing beyond the `claude: none` change. If another defect turns up, stop and report `blocked_code`.
- `harness/cli.js`. `rad review` must work unchanged on the generated reviewer.

### Key Files
- `harness/generate.js`: target parsing, emit, `hasGeneratedMarker`, `OUTPUT_ROOTS`.
- `harness/install-manifest.js`: `CORE_TREES`, `walkTree`, `listCoreFiles`.
- `.claude/commands/team/rad-review.md`: the deterministic checks the Codex wrapper reuses (sections around 64-168).
- `scripts/test-install-harness.sh`: `run_install`, `new_repo`, the `assert_*` helpers.

### Reminders
- **Migrate by delete-then-generate in one commit.** Use `git rm` on the hand-written file, add its source, run `node harness/cli.js generate`, and commit everything together. `generate --check` must be clean at every commit.
- **Bodies move verbatim.** Use `git mv` into `.rad/` where possible, so history follows the file.
- **Codex bodies never contain Claude-only syntax** (`$ARGUMENTS`, the Task tool, `subagent_type`).
- No en dashes.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: claude: none target
File: harness/generate.js:105-140, harness/generate.js:305-320, harness/test/generate.test.js:335-400
What: Implement the generator part of AC#3.
Validate: AC#3. Edge cases:
- `claude: none` + `codex: skill` emits only the Codex skill;
- `claude: none` + `codex: none` is an error;
- a `claude.md` override with `claude: none` is an error;
- the existing target tests are unchanged.

Command: `npm test --prefix harness`.

#### Task 1.2: Ship sources and marked outputs through core
File: harness/install-manifest.js:1-60, harness/install-manifest.js:60-110, harness/test/install-manifest.test.js:560-640
What: Implement the `install-manifest.js` part of AC#4.
Validate: AC#4. Edge cases:
- a marked file under each new root ships;
- an unmarked file is not shipped;
- the `.rad/skills` and `.rad/agents` trees ship;
- `.rad/config.yml` and `.rad/installed.json` don't ship;
- a symlinked marked file is not followed;
- the existing core set is unchanged when no sources exist.

Command: `npm test --prefix harness`.

### Wave 2 — sequential
This wave depends on both Wave 1 tasks.

#### Task 2.1: Migrate the slice
File: .rad/agents/quality-reviewer.md:1-15, .rad/agents/accessibility-reviewer.md:1-15, .rad/skills/quality-review/SKILL.md:1-45, .rad/skills/quality-review/codex.md:1-30, .rad/skills/accessibility-review/SKILL.md:1-45, .rad/skills/accessibility-review/codex.md:1-30, .rad/skills/rad-status/SKILL.md:1-40, .rad/skills/rad-review/SKILL.md:1-80, .claude/agents/quality-reviewer.md:1-15, .claude/agents/accessibility-reviewer.md:1-15, .claude/commands/team/quality-review.md:1-10, .claude/commands/team/accessibility-review.md:1-10, .claude/commands/shared/rad-status.md:1-10, .codex/agents/quality-reviewer.toml:1-10, .codex/agents/accessibility-reviewer.toml:1-10, .agents/skills/quality-review/SKILL.md:1-10, .agents/skills/accessibility-review/SKILL.md:1-10, .agents/skills/rad-status/SKILL.md:1-10, .agents/skills/rad-review/SKILL.md:1-10, scripts/test-install-harness.sh:420-470, scripts/lint-agent-files.sh:10-20
What: Implement AC#1, AC#2, the source part of AC#3, the installer test in AC#4, and the `lint-agent-files` fix in AC#5.
Validate: AC#1, AC#2, AC#3, AC#4. Edge cases:
- `generate --check` is clean after the commit;
- `lint-agent-files.sh` passes;
- the `rad review quality-reviewer` resolution test passes;
- each regenerated Claude file's diff against main is reported;
- a fresh install contains the slice and no internal agent;
- `generate --check` in the installed target exits 0.

Commands:
- `npm test --prefix harness`;
- every `scripts/test-*.sh` under both shells;
- `scripts/lint-agent-files.sh`;
- `node harness/cli.js generate --check`.

### Wave 3 — sequential
This wave documents the migration.

#### Task 3.1: Matrix and invariant
File: docs/rad-tool-portability.md:15-80, docs/invariants.yaml:260-300
What: Implement the docs part of AC#5.
Validate: AC#5, AC#6. Commands: `scripts/lint-invariants.sh`, `bash scripts/test-lint-invariants.sh`, and the full suite list in AC#6.

## Program Design

### Signatures
- `harness/generate.js`: the claude target parser accepts `'none'` and returns `{ kind: 'none' }`. The emit skips Claude output for `kind: 'none'`.
- `harness/install-manifest.js`: `listCoreFiles(sourceRoot)` keeps its signature. It now also walks `.rad/skills` and `.rad/agents`, and the marked files under `.claude/agents`, `.agents/skills` and `.codex/agents`.

### Call stack
```
install.sh → rad install-core → listCoreFiles(source) → CORE_TREES + CORE_FLAT + .rad sources + marked outputs
rad generate → readSources(.rad) → renderOutputs → planGenerate → applyGenerate
```

### File tree
```
.rad/agents/{quality,accessibility}-reviewer.md          (new, bodies moved)
.rad/skills/{quality-review,accessibility-review}/{SKILL,codex}.md  (new)
.rad/skills/{rad-status,rad-review}/SKILL.md            (new)
.codex/agents/{quality,accessibility}-reviewer.toml     (generated)
.agents/skills/{quality-review,accessibility-review,rad-status,rad-review}/SKILL.md (generated)
```

## Tests to Write
- [ ] claude: none target cases — harness/test/generate.test.js
- [ ] core ships .rad sources and marked outputs only — harness/test/install-manifest.test.js
- [ ] fresh install contains the generated slice, no internal agents — scripts/test-install-harness.sh

## Non-Goals
- Changing what any reviewer or command does on Claude.
- Generating the Claude `rad-review` command.
- Shipping the deliver-gate hook (#186).
- AGENTS.md (part 3). The reviewer bodies still say "Reads CLAUDE.md".

## Out-of-Scope Dependencies
None.

## Risks
- **Upgrading a project with a hand-made reviewer file.** If an installed project has its own unmarked `.claude/agents/quality-reviewer.md`, the next core upgrade finds no baseline and uses `backup-write`. The user's file is backed up under `.rad/upgrade-backup/`, not lost.
- **The Codex sub-agent is invoked by name, which isn't confirmed.** Codex docs and a third-party source disagree on spawn-by-name. The Codex skill bodies therefore name the agent file path as well as its name.
- **Frontmatter re-serialization.** The generator may render `description: >` differently. The executor reports the exact diff, and `lint-agent-files` and the `rad review` test guard the behaviour.

## Issue Gaps
- **Assumption:** the Codex `rad-review` uses the deterministic scripts plus reviewer sub-agents, matching the reviewer decision. It does not use `rad review` as the portability doc first said; the doc row is updated.
- **Assumption:** the Codex `rad-review` doesn't write `.agents/findings.jsonl`. It stays strictly read-only, and findings recording can come with #186.
- **Assumption:** the reviewer bodies keep "Reads CLAUDE.md" until part 3 moves conventions to AGENTS.md.
- **Assumption:** generated-output line ranges in Files in Scope cover the marker and frontmatter region, because their content comes from `rad generate`, not hand edits.
