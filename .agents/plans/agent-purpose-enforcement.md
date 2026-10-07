# Plan: Enforce and Emit the Agent Purpose Tag (#46 part 2)
Created: 2026-10-07
Author: architect
Status: complete
Completed-At: 2026-10-07T13:01:44Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T12:49:41.186Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-purpose-enforcement
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/46
Issue-Title: Audit the agent orchestrator/mapper hierarchy: separate boundary-enforcement (keep) from context-chunking (deletable when context grows)

## Context

Part 1 (PR #193, merged 2026-10-07) added `purpose:` to all 27 internal agents and wrote `docs/agent-hierarchy-audit.md`:
- **Taxonomy:** `authority`, `context-discipline` and `capacity`. Only `capacity` depreciates, so it is flagged as provisional.
- **Result:** 16 orchestrators are `authority` and 11 mappers are `context-discipline`.

Nothing enforces the tag yet:
- **Generator:** `harness/generate.js` rejects `purpose` as an unknown key (`AGENT_KEYS`, line 53), so the two shipped reviewers can't carry it.
- **Lint:** `scripts/lint-agent-files.sh` doesn't check it.
- **`/rad-design`:** doesn't emit it, so every new agent arrives untagged.

Decisions (2026-10-07):
- **Reviewers are `authority`.** Review that is independent of the author is separation of duties, a boundary we'd still want with a perfect model.
- **Lint fails hard** when an agent with `roles:` has a missing or invalid `purpose`. The error lists the three allowed values, and `UPGRADE.md` gets a note for projects already using RAD. A `capacity` tag gets a non-blocking advisory instead of a failure.
- **The justification lives only in the architecture artifact (option D).**
  - `/rad-design` writes `- Purpose: <value>: <justification>` in each agent's block. Step 4 shows it to the architect at approval time.
  - The agent file copies only the value.
  - The justification never goes into the agent body, because the body is the agent's system prompt, nor into a frontmatter key.
- **Fold in the `docs/daily-workflow.md:86` fix:** the `git add` line after `/rad-design` omits `.rad/config.yml`, which Step 7 writes.

## Scope

| In scope | Out of scope |
|---|---|
| Generator accepts and emits `purpose` (Claude frontmatter only) | Emitting `purpose` into Codex TOML |
| `purpose: authority` on both reviewer sources, plus regenerated outputs | Changing any of the 27 internal agents' tags |
| Lint: required, enum-checked, `capacity` advisory, tests | Fixing the mapper drift in #192 |
| `/rad-design`: Purpose line in the artifact, shown at Step 4, copied to agent frontmatter | A justification field in agent frontmatter or body |
| Docs: `rad-cli.md` lint section, an `UPGRADE.md` note, a status line in the audit doc, the `daily-workflow.md:86` fix | Any change to `agent_scope_map` in `.rad/config.yml` |

## Acceptance Criteria

1. **`generate` accepts `purpose`.**
   - A `.rad/agents/*.md` source with `purpose: <non-empty string>` generates without error.
   - The Claude output has `purpose: <value>` directly after `roles:`, or after `tools:` when there is no `roles:`.
   - The Codex TOML output does not contain `purpose`.
   - A source without `purpose` generates exactly as before.
   - A `purpose` that is empty, not a string, or a list fails with `<file>: purpose must be a non-empty string`.
2. **The reviewers are tagged.**
   - `.rad/agents/quality-reviewer.md` and `.rad/agents/accessibility-reviewer.md` carry `purpose: authority`.
   - The regenerated `.claude/agents/` files carry it after `roles:`.
   - `node harness/cli.js generate --check` exits 0.
3. **Lint requires a valid `purpose` on every agent with `roles:`.**
   - A missing or empty `purpose` is a violation (exit 1). Its message names the field and the three allowed values.
   - A value outside {`authority`, `context-discipline`, `capacity`} is a violation that names the bad value and the three allowed values.
   - Agents without `roles:` are still exempt.
4. **`capacity` gets an advisory, not a failure.** Each `capacity` agent prints one non-blocking advisory line naming the file and saying the tag is provisional, to be revisited as context windows grow. The lint still exits 0 when nothing else is wrong.
5. **Lint tests.** `scripts/test-lint-agent-files.sh` covers:
   - the clean fixture (with `purpose` on every agent that has `roles:`);
   - missing `purpose`;
   - an empty `purpose:`;
   - an invalid value;
   - `capacity`: exit 0 with the advisory printed;
   - an agent without `roles:` and without `purpose`, which still passes;
   - a quoted value (`purpose: "authority"`), which passes.

   It passes under both `bash` and `/bin/bash`. `scripts/lint-agent-files.sh` passes on the repo's own tree.
6. **`/rad-design` emits the tag.** In `.claude/commands/architect/rad-design.md`:
   - **Step 2:** lists Purpose among the fields to decide for each agent, with each bucket's test question and the rule that `capacity` is provisional.
   - **Step 3:** each agent block in the artifact template has `- Purpose: [authority | context-discipline | capacity]: [one-line justification]`.
   - **Step 4:** shows each agent's Purpose and justification to the architect before asking for approval.
   - **Step 6:** the frontmatter template has `purpose: [purpose from architecture artifact]` after `roles:`, and says the justification is never written into the agent file.
7. **Docs.**
   - The `lint-agent-files.sh` section of `docs/rad-cli.md` describes the `purpose` rule and the `capacity` advisory.
   - `UPGRADE.md` has a section "Agent purpose tags (#46)": what fails, the three values with their test questions, and how to tag existing agents (pointing to `docs/agent-hierarchy-audit.md`).
   - The part-2 sentence in `docs/agent-hierarchy-audit.md` says enforcement has shipped.
   - The `git add` line at `docs/daily-workflow.md:86` includes `.rad/config.yml`.
8. **Every suite stays green:**
   - `npm test --prefix harness`;
   - every `scripts/test-*.sh` under both shells;
   - `lint-agent-files`;
   - `generate --check`.

## Agent Scope

Research was done directly by the architect, with no context tools. None of the scope-map agents cover `harness/generate.js`, `scripts/lint-agent-files.sh` or the `/rad-design` command. The closest, `lint-surface-mapper`, is scoped to the harness-ci feature.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/generate.js | 53 | `AGENT_KEYS` gains `purpose` |
| harness/generate.js | 180-220 | `agentFieldErrors` type-checks `purpose`; `readAgent` carries it |
| harness/generate.js | 316-321 | `renderClaudeAgent` emits `purpose:` after `roles:` |
| harness/test/generate.test.js | 119-135 | Frontmatter-order test extended with `purpose` |
| harness/test/generate.test.js | 177-192 | Invalid-`purpose` error cases |
| harness/test/generate.test.js | 360-370 | New test: `purpose` absent from TOML; missing `purpose` unchanged |
| .rad/agents/quality-reviewer.md | 1-15 | `purpose: authority` after `roles:` |
| .rad/agents/accessibility-reviewer.md | 1-15 | `purpose: authority` after `roles:` |
| .claude/agents/quality-reviewer.md | 1-12 | Regenerated (no hand edits) |
| .claude/agents/accessibility-reviewer.md | 1-12 | Regenerated (no hand edits) |
| scripts/lint-agent-files.sh | 1-30 | Header documents the `purpose` rule and advisory |
| scripts/lint-agent-files.sh | 120-140 | Purpose check inside the `roles:` block |
| scripts/lint-agent-files.sh | 222-231 | Print advisories before the result line |
| scripts/test-lint-agent-files.sh | 1-108 | Header; fixture agents with `roles:` gain `purpose` |
| scripts/test-lint-agent-files.sh | 190-201 | New cases 10-15 |
| .claude/commands/architect/rad-design.md | 64-100 | Step 2: Purpose field, test questions, `capacity` rule |
| .claude/commands/architect/rad-design.md | 115-126 | Step 3: Purpose line in the artifact template |
| .claude/commands/architect/rad-design.md | 138-160 | Step 4: show Purpose and justification |
| .claude/commands/architect/rad-design.md | 205-215 | Step 6: `purpose:` in the frontmatter template |
| docs/rad-cli.md | 873-897 | Lint section: `purpose` rule and advisory |
| UPGRADE.md | 370-380 | New "Agent purpose tags (#46)" section before "See also" |
| docs/agent-hierarchy-audit.md | 66-73 | Part-2 status sentence |
| docs/daily-workflow.md | 84-88 | `git add` includes `.rad/config.yml` |

## Execution Notes

### Do Not Touch
- The 27 internal `.claude/agents/*.md` files. Their tags were settled in part 1.
- `.codex/agents/*.toml`. Regeneration must leave them byte-identical.
- `.rad/config.yml` (`agent_scope_map`). Its `type` column is separate from `purpose`.

### Key Files
- `docs/agent-hierarchy-audit.md`: the taxonomy and the exact test questions to reuse word for word.
- `harness/generate.js`: `identityErrors` and the existing `roles` validation pattern.
- `scripts/lint-agent-files.sh`: the `fm_field` / `violation` helpers and the `HAS_ROLES` block.

### Reminders
- **Wave order matters.** Wave 1 must tag and regenerate the reviewers before Wave 2 turns on lint enforcement. Otherwise CI fails on the repo's own reviewers.
- **The two lists of allowed values must match.** The generator only type-checks `purpose`, and the lint is the authority on which values are allowed. Write that enum once, at the top of `lint-agent-files.sh`, as a named constant.
- **Only `node harness/cli.js generate` writes the generated reviewer files.** Never hand-edit them.
- **Advisories keep the lint's exit code unchanged:** 0 when clean, even with `capacity` agents present.

## Program Design

**Signatures (no new exports):**
- `generate.js`: `AGENT_KEYS` gains `'purpose'`. `agentFieldErrors(rel, data)` returns one more possible error. `readAgent` returns `agent.purpose?: string`. `renderClaudeAgent(agent)` emits one optional line.
- `lint-agent-files.sh`: new constants `PURPOSE_VALUES` and `PROVISIONAL_PURPOSE`, and a new buffer `ADVISORIES`. No new CLI flags, and exit codes are unchanged.

**Call stack:**
```
rad generate → readSources → readAgent → identityErrors(AGENT_KEYS) + agentFieldErrors   [type-check]
                           → renderAgent → renderClaudeAgent (purpose after roles) / renderCodexAgent (unchanged)
lint-agent-files.sh → Part 1 loop → HAS_ROLES block → purpose check → violation | ADVISORIES
                    → Part 2 scope-map sync → print ADVISORIES → exit on VIOLATIONS
/rad-design → Step 2 decide Purpose → Step 3 artifact "- Purpose:" → Step 4 Purpose table → Step 6 frontmatter purpose:
```

**File tree diff:** no files added or removed. Every change is an in-place edit to the files listed in Files in Scope.

## Wave Plan

### Wave 1 — sequential
The generator must accept `purpose` before the reviewer sources can carry it.

#### Task 1.1: Generator accepts and emits `purpose`
File: harness/generate.js:53, 180-220, 316-321, harness/test/generate.test.js:119-135, 177-192, 360-370
What:
- **Accept the key:** add `purpose` to `AGENT_KEYS`.
- **Validate it:** in `agentFieldErrors`, when `purpose` is defined but isn't a non-empty string, push `<rel>: purpose must be a non-empty string`.
- **Carry it:** `readAgent` puts `purpose` (trimmed) on the agent object.
- **Emit it:** `renderClaudeAgent` pushes `purpose: <yamlScalar>` after the `roles` line, when `purpose` is defined. Update that function's doc comment to list the new key order.
- **No Codex change:** `renderCodexAgent` stays as it is.
- **Tests:**
  - Extend the frontmatter-order test so `purpose` sits right after `roles`.
  - Add a test for an agent with no `roles` that has `purpose`, where it follows `tools`.
  - Add a test that `purpose` never appears in the TOML.
  - Add error cases for `purpose:` empty, `purpose: [a]` and `purpose: 3`.
Validate: AC#1 — `npm test --prefix harness` passes. The new cases cover: present with `roles`, present without `roles`, absent (output unchanged), empty, a list, a number, and absent from the TOML.

#### Task 1.2: Tag the reviewers and regenerate
File: .rad/agents/quality-reviewer.md:1-15, .rad/agents/accessibility-reviewer.md:1-15, .claude/agents/quality-reviewer.md:1-12, .claude/agents/accessibility-reviewer.md:1-12
What:
- Add `purpose: authority` after `roles:` in both sources.
- Run `node harness/cli.js generate`.
- Confirm that only the two `.claude/agents/` reviewer files changed and that the `.codex/agents/` TOMLs are byte-identical.
Validate: AC#2 — `node harness/cli.js generate --check` exits 0. `git diff --stat` shows only the 2 sources and the 2 generated Claude files. There is no testable surface beyond `generate --check` (data only).

### Wave 2 — sequential
Lint enforcement. Every agent with `roles:` in the repo is tagged after Wave 1.

#### Task 2.1: Lint the `purpose` field
File: scripts/lint-agent-files.sh:1-30, 120-140, 222-231, scripts/test-lint-agent-files.sh:1-108, 190-201
What:
- **Constants:** at the top of the script, define `PURPOSE_VALUES="authority context-discipline capacity"` and `PROVISIONAL_PURPOSE=capacity`.
- **Check, inside the `HAS_ROLES` block,** reading `PURPOSE=$(fm_field "$FM" purpose)`:
  - **Empty:** violation "frontmatter field 'purpose' is missing or empty; agents with roles: must declare purpose: authority | context-discipline | capacity (see UPGRADE.md)".
  - **Not in the list:** violation "purpose '<value>' is not one of: authority | context-discipline | capacity".
  - **`capacity`:** append to an `ADVISORIES` buffer: "advisory: <file>: purpose: capacity is provisional (exists only because its read won't fit); revisit as context windows grow".
- **Output:** print the advisories after Part 2's checks and before the exit decision, whatever the result. They never change the exit code.
- **Header comment:** document the rule and the advisory.
- **Tests:**
  - Add `purpose:` to the fixture agents that have `roles:` (`planner-orchestrator` is `authority`; `code-mapper` and `quoted-mapper` are `context-discipline`).
  - Case 10: missing `purpose`, exit 1, and the message names the three values.
  - Case 11: an empty `purpose:`, exit 1.
  - Case 12: an invalid value (`boundary`), exit 1, and the output names `boundary`.
  - Case 13: `capacity`, exit 0, and the output contains "advisory:" and the file name.
  - Case 14: an agent without `roles:` or `purpose:` still exits 0.
  - Case 15: a quoted value (`purpose: "authority"`) passes, exit 0.
Validate: AC#3, AC#4, AC#5 — `bash scripts/test-lint-agent-files.sh` and `/bin/bash scripts/test-lint-agent-files.sh` both print ALL PASS. `scripts/lint-agent-files.sh` on the repo exits 0 with no advisories, since there are 0 `capacity` agents. Named edge cases: a missing field, an empty value, an invalid value, the provisional value, the exemption for agents without `roles:`, and a quoted value.

### Wave 3 — parallel
These tasks touch independent text surfaces.

#### Task 3.1: `/rad-design` emits Purpose
File: .claude/commands/architect/rad-design.md:64-100, 115-126, 138-160, 205-215
What:
- **Step 2:** add `- Purpose:` to "For each agent, determine:". Follow it with a short "Purpose rules" block that gives the three test questions word for word from `docs/agent-hierarchy-audit.md`, plus:
  - orchestrators that only delegate are usually `authority`;
  - mappers that return anchors are usually `context-discipline`;
  - `capacity` is provisional and must say which read wouldn't fit.
- **Step 3:** add `- Purpose: [authority | context-discipline | capacity]: [one-line justification]` to the agent-block template, after `Roles:`.
- **Step 4:** render a Purpose table (agent | purpose | justification) built from the Agent Definitions, between the Scope Map and Notes. A `capacity` row is marked "(provisional)".
- **Step 6:** add `purpose: [purpose from architecture artifact]` after `roles:` in the frontmatter template, plus one line: "Copy only the value. The justification stays in the architecture artifact, never in the agent file."
Validate: AC#6 — `grep` finds the Purpose line in the Step 3 template, the `purpose:` line in the Step 6 frontmatter template, and the Purpose table in Step 4. No testable surface beyond that: this is prompt text, and `lint-agent-files` covers the files it produces.

#### Task 3.2: Docs
File: docs/rad-cli.md:873-897, UPGRADE.md:370-380, docs/agent-hierarchy-audit.md:66-73, docs/daily-workflow.md:84-88
What:
- **`docs/rad-cli.md`:** add a `purpose` bullet to the frontmatter-lint description: required on agents with `roles:`, must be one of the three values, `capacity` prints a non-blocking advisory.
- **`UPGRADE.md`:** add "## Agent purpose tags (#46)" before "## See also":
  - after upgrading, `lint-agent-files.sh` fails on agents that have `roles:` but no `purpose:`;
  - the three values with their test questions;
  - how to tag: one frontmatter line after `roles:`; for agents generated from `.rad/agents`, edit the source and run `generate`;
  - a link to `docs/agent-hierarchy-audit.md` for worked examples.
- **`docs/agent-hierarchy-audit.md`:** change the "(in part 2) lint enforcement and `/rad-design` emitting the tag" wording to say they shipped in part 2.
- **`docs/daily-workflow.md:86`:** add `.rad/config.yml` to the `git add` line.
Validate: AC#7 — `grep` confirms each edit, and the UPGRADE.md anchor link resolves. No testable surface (docs only).

#### Task 3.3: Full-suite check
File: scripts/lint-agent-files.sh:222-231
What: Read-only verification after 3.1 and 3.2. Run:
- `npm test --prefix harness`;
- every `scripts/test-*.sh` under `bash` and `/bin/bash`;
- `scripts/lint-agent-files.sh`;
- `node harness/cli.js generate --check`;
- `scripts/lint-plan.sh` on this plan.

Fix only regressions this plan caused, within the declared files.
Validate: AC#8 — every command exits 0. No new testable surface (verification only).

## Tests to Write
- [ ] `purpose` emitted after `roles` / after `tools`, absent from TOML, invalid-type errors: `harness/test/generate.test.js`
- [ ] Lint cases 10-15 (missing, empty, invalid, `capacity` advisory, exemption for agents without `roles:`, quoted value): `scripts/test-lint-agent-files.sh`

## Non-Goals
- No `purpose` in Codex TOML. Codex has no matching field, and the tag is metadata for humans and lint.
- No justification text in agent files (frontmatter or body). It lives only in the architecture artifact.
- No change to the 27 internal agents' tags, and no fixes for #192's mapper drift.
- No advisory-only grace period for missing tags. The lint fails hard, matching every other gate.

## Out-of-Scope Dependencies
None.

## Risks
- **Projects already using RAD break on upgrade.** Their agents from older `/rad-design` runs have `roles:` but no `purpose:`, so `lint-agent-files.sh` fails after an upgrade. This is intentional (decision 2). The error message and `UPGRADE.md` give the fix.
- **The generated reviewer files could drift if someone hand-edits them.** Task 1.2 regenerates them, and `generate --check` in CI catches drift.
- **`fm_field` might not strip quotes as expected.** Case 15 tests a quoted value (`purpose: "authority"`); `strip_quotes` already exists in the lint for it.

## Issue Gaps
- **[ASSUMPTION] The generator only type-checks `purpose`, and the lint alone enforces the allowed values.** This keeps a single source of truth for the enum (the lint constant), at the cost of `generate` accepting a typo that CI then rejects. Architect: confirm, or ask for the enum in both places.
- **[ASSUMPTION] Step 4 of `/rad-design` must show the justification.** Otherwise option D's "reviewed at approval time" doesn't hold, because Step 4 currently renders only the hierarchy, the Scope Map and Notes. Adding a Purpose table there wasn't in the original design and is added here.
- **[ASSUMPTION] Without `roles:`, `purpose` follows `tools` in the generator output.** Both shipped reviewers have `roles:`, so this matters only for future sources.
- **[ASSUMPTION] An advisory doesn't fail the lint and isn't written to findings or events.** It is printed to stdout only.
