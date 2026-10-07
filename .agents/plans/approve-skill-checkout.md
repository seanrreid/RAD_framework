# Plan: rad checkout, and Generate /rad-approve from .rad/skills (#186 part 2d)
Created: 2026-10-07
Author: architect
Status: pending-review
Branch: rad/approve-skill-checkout
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
After 2b, every state change in `/rad-approve` goes through `rad approve` or `rad plan-status`. One shell step is left: Step 2 runs `scripts/checkout-plan.sh` to land on the work branch at its remote tip. On 2026-10-07 the user chose consistency, so that step also becomes a `rad` command, `rad checkout <feature>`. The command is a thin wrapper over `checkout-plan.sh`, so the fetch/fast-forward/divergence logic stays in one place. Then `/rad-approve` moves to `.rad/skills/rad-approve/SKILL.md`. It gets one shared tool-neutral body (the 2c pattern) and `codex_implicit: false`, so Codex never starts an approval on its own. This plan also fixes the self-contradictory rule found in 2c's `rad-plan` and `rad-adopt` bodies ("Do not read files directly — … otherwise run it inline").

## Scope
| In scope | Out of scope |
|---|---|
| New `rad checkout <feature\|plan-path>` command wrapping `scripts/checkout-plan.sh` | Changing `checkout-plan.sh` behavior |
| `.rad/skills/rad-approve/SKILL.md`, with generated Claude command, Codex skill and `openai.yaml` | Switching `/rad-deliver` to `rad checkout` (part 3) |
| Tool-neutral approve body: `{{args}}` handling, `PLAN_ARG`, command names | Changing approve, plan-status or proxy semantics |
| Fixing the Rules line in the rad-plan and rad-adopt sources | Other wording changes to plan or adopt |
| skill-bodies test: approve, plus a per-skill required-command map; install check | part 3 and part 4 commands |
| Docs: `rad checkout` in rad-cli.md, the portability row, an UPGRADE note | |

## Acceptance Criteria
1. `rad checkout <feature>` accepts a bare feature name, `<feature>.md`, or `.agents/plans/<feature>.md`.
   - **Refusals (exit 2, nothing run):** an unsafe name (`isSafeFeature`), the reserved `_architecture`, or a bad argument count. These print the usage.
   - **Checkout:** otherwise it runs `scripts/checkout-plan.sh <conventionWorkBranch(feature)>` through the injected `sh`.
   - **Success (exit 0):** after a successful checkout it confirms `.agents/plans/<feature>.md` exists on the branch, then prints `rad checkout: ok feature=<f> branch=<b> head=<sha> plan=.agents/plans/<f>.md`.
   - **Failure (exit 1):** a non-zero script exit (missing branch, divergence, invalid branch) or a missing plan file exits 1, passing on the script's stderr.
2. `rad checkout` is registered in `harness/cli.js` with a usage line, listed in the header's Subcommands, and documented in `docs/rad-cli.md`.
3. `.rad/skills/rad-approve/SKILL.md` exists with `targets: { claude: command:architect/rad-approve, codex: skill, codex_implicit: false }` and no overrides. `rad generate` writes the marked `.claude/commands/architect/rad-approve.md`, `.agents/skills/rad-approve/SKILL.md` and `.agents/skills/rad-approve/agents/openai.yaml` (`allow_implicit_invocation: false`). `generate --check` exits 0.
4. The approve body is tool-neutral:
   - **Input handling:** `{{args}}` appears only in prose. A first step sets `PLAN_ARG` (the plan name or path), `ON_BEHALF_OF` and `EVIDENCE` from the input, and bash blocks use those variables, never the token.
   - **Checkout:** Step 2 runs `node harness/cli.js checkout "$PLAN_ARG"`.
   - **Command names:** commands are referred to by name, with the Claude slash form given once.
   - **Forbidden content:** no `$ARGUMENTS` in the Codex body, no `scripts/checkout-plan.sh`, no `git add|commit|push|checkout`, no `rad-label.sh`.
   - **Unchanged:** every other step, rule, review summary, proxy rule and exit-code instruction stays as it is today. The generated Claude command differs from main only by these edits, its frontmatter and the marker.
5. In both the `rad-plan` and `rad-adopt` sources, the Rules line says to keep raw file contents out of the working context, and no longer says "Do not read files directly". Their generated outputs are regenerated.
6. `harness/test/skill-bodies.test.js` covers `rad-approve`. Its required strings are a per-skill map: `plan-open` for plan and adopt; `approve`, `plan-status` and `checkout` for approve. The forbidden list adds `scripts/checkout-plan.sh`. It checks that approve's `openai.yaml` sets `allow_implicit_invocation: false`. The harness suite passes.
7. `scripts/test-install-harness.sh` checks that a fresh install ships `.agents/skills/rad-approve/SKILL.md` and its `agents/openai.yaml`, and it passes under both `bash` and `/bin/bash`.
8. The `rad-approve` row in `docs/rad-tool-portability.md` says `as-is` and `generated (#186 part 2d)`, with `codex_implicit: false` noted. `UPGRADE.md` notes that `rad-approve` is generated and that `rad checkout` is new.

## Agent Scope
Research was done directly in this session: scripts/checkout-plan.sh and its callers, the rad-approve command, the cli.js header and SUBCOMMANDS, the 2c skill sources, the skill-bodies test, the install-test slice, and the doc anchors. No context-tool agents were called. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/checkout.js | 1-1 | New: `checkoutCommand`, `parseCheckoutArgs`, `CHECKOUT_USAGE` |
| harness/cli.js | 10-20 | Header Subcommands: add `checkout` |
| harness/cli.js | 62-66 | Import the checkout module |
| harness/cli.js | 188-200 | Add the `checkout` SUBCOMMANDS entry next to plan-open and plan-status |
| harness/plan-open.js | 1-130 | Read only: arg parsing, plan-path resolution and stop pattern to mirror |
| scripts/checkout-plan.sh | 1-92 | Read only: the wrapped behavior and exit codes |
| harness/test/cli-checkout.test.js | 1-1 | New: real-git tests with a bare origin and the real checkout-plan.sh |
| .rad/skills/rad-approve/SKILL.md | 1-1 | New source: today's rad-approve body, made tool-neutral |
| .claude/commands/architect/rad-approve.md | 1-461 | Read as the starting body; then regenerated |
| .agents/skills/rad-approve/SKILL.md | 1-1 | New: generated |
| .agents/skills/rad-approve/agents/openai.yaml | 1-1 | New: generated |
| .rad/skills/rad-plan/SKILL.md | 440-450 | Fix the Rules line |
| .rad/skills/rad-adopt/SKILL.md | 298-306 | Fix the Rules line |
| .claude/commands/team/rad-plan.md | 1-1 | Regenerated |
| .claude/commands/team/rad-adopt.md | 1-1 | Regenerated |
| .agents/skills/rad-plan/SKILL.md | 1-1 | Regenerated |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | Regenerated |
| harness/test/skill-bodies.test.js | 1-62 | Add rad-approve, the per-skill required map, the forbidden addition and the openai.yaml check |
| scripts/test-install-harness.sh | 436-455 | Add rad-approve to `SLICE_SKILLS`; assert its `openai.yaml` ships |
| docs/rad-cli.md | 100-215 | A new `### rad checkout` section after `### rad plan-status` |
| docs/rad-tool-portability.md | 45-60 | Update the rad-approve row |
| UPGRADE.md | 410-440 | A note in the #186 section style for rad-approve and rad checkout |

## Execution Notes

### Do Not Touch
- scripts/checkout-plan.sh — wrapped, not changed
- harness/generate.js, harness/install-manifest.js
- harness/plan-open.js, harness/plan-status.js, and `approveCommand` in harness/cli.js — read only
- .claude/commands/team/rad-deliver.md — it switches to `rad checkout` in part 3

### Key Files
- harness/plan-open.js — the argument and plan-path resolution, `isSafeFeature` and reserved-slug refusals, the exit-code constants and the success-line format to mirror
- harness/plan-commit.js — `conventionWorkBranch`
- .rad/skills/rad-plan/SKILL.md (frontmatter) and .agents/skills/rad-plan/SKILL.md — the 2c source/output pattern
- harness/generate.js `renderSkill` (about lines 295-315) — `codex_implicit: false` emits `agents/openai.yaml`; `{{args}}` is the only token; generate refuses to overwrite an unmarked file, so delete the old command before generating

### Reminders
- `rad checkout` doesn't reimplement any git logic. It calls `scripts/checkout-plan.sh` with an args array through `sh`, with `cwd` set to the repo root and the environment passed through (it honors `RAD_BRANCH_PREFIX`).
- The plan doc isn't on the default branch before checkout, so derive the branch from `conventionWorkBranch(feature)`, never from a local plan header.
- In the approve body, `{{args}}` renders to prose for Codex, so it must never appear inside a bash block. Set `PLAN_ARG`, `ON_BEHALF_OF` and `EVIDENCE` from the input in a prose step, then use the variables.
- Copy today's approve body and make only the AC#4 edits. Review the generated Claude diff against main yourself.
- Commit each source together with its regenerated outputs.

## Program Design

**Signatures**
```js
// harness/checkout.js
export const CHECKOUT_USAGE = 'rad checkout <feature | .agents/plans/<feature>.md>';
export function parseCheckoutArgs(argv)          // → { feature } | throws usage error
export async function checkoutCommand(argv, ctx) // → 0 | 1 | 2
```

**Call stack: `rad checkout <arg>`**
```
checkoutCommand
  parseCheckoutArgs → strip .agents/plans/ and .md → feature
  isSafeFeature(feature) && feature !== '_architecture'   else exit 2 + usage
  branch = conventionWorkBranch(feature)
  sh('scripts/checkout-plan.sh', [branch], { cwd: repoRoot })   non-zero → stderr, exit 1
  existsSync(.agents/plans/<f>.md)                               else exit 1
  sh('git', ['rev-parse', 'HEAD']) → head
  print 'rad checkout: ok feature=… branch=… head=… plan=…' → exit 0
```

**File tree diff**
```
harness/checkout.js                         + new
harness/cli.js                              ~ import, SUBCOMMANDS, header
harness/test/cli-checkout.test.js           + new
harness/test/skill-bodies.test.js           ~ approve + required map
.rad/skills/rad-approve/SKILL.md            + new
.rad/skills/rad-{plan,adopt}/SKILL.md       ~ Rules line
.claude/commands/architect/rad-approve.md   ~ regenerated (marked)
.claude/commands/team/rad-{plan,adopt}.md   ~ regenerated
.agents/skills/rad-approve/SKILL.md         + generated
.agents/skills/rad-approve/agents/openai.yaml + generated
.agents/skills/rad-{plan,adopt}/SKILL.md    ~ regenerated
scripts/test-install-harness.sh             ~ slice
docs/rad-cli.md, docs/rad-tool-portability.md, UPGRADE.md ~
```

## Wave Plan

### Wave 1 — sequential
`rad checkout` comes first, because the approve body calls it.

#### Task 1.1: rad checkout
File: harness/checkout.js:1-1, harness/cli.js:10-20, 62-66, 188-200
What: Implement `checkoutCommand` as in the Program Design. Mirror plan-open.js for the argument handling, refusals (exit 2 with usage on stderr), `--help`/`-h` (usage, exit 0) and the success-line style. Use named constants for the exit codes and the script path. Pass on the script's stderr on failure. Register `checkout` in SUBCOMMANDS next to `plan-open`/`plan-status` with a one-line summary ("Check out a plan's work branch at its remote tip."), and add it to the header Subcommands list.
Validate: AC#1, AC#2 — `node harness/cli.js checkout --help` exits 0; `node harness/cli.js checkout _architecture` and `node harness/cli.js checkout 'Bad Name'` exit 2

#### Task 1.2: rad checkout tests
File: harness/test/cli-checkout.test.js:1-1
What: Run real git against a bare origin, using the real `scripts/checkout-plan.sh` copied into the temp repo, or run with cwd at a repo that has it. Cases:
- bare name;
- `.md` suffix;
- full plan path;
- the branch only on origin → creates a tracking branch, exit 0, success line fields;
- an existing local branch behind origin → fast-forwards;
- diverged local → exit 1 with the script's message;
- a branch missing on origin → exit 1;
- a branch whose plan file is missing → exit 1;
- `_architecture` → 2;
- an unsafe name → 2;
- no argument → 2;
- two arguments → 2;
- `RAD_BRANCH_PREFIX` honored.
Validate: AC#1 — `node --test harness/test/cli-checkout.test.js` passes

### Wave 2 — sequential
The approve source, then the plan and adopt fix. Both run the generator, so they go one after the other.

#### Task 2.1: rad-approve source
File: .rad/skills/rad-approve/SKILL.md:1-1, .claude/commands/architect/rad-approve.md:1-461, .agents/skills/rad-approve/SKILL.md:1-1, .agents/skills/rad-approve/agents/openai.yaml:1-1
What: Create the source with frontmatter:
- `name: rad-approve`;
- `description`: today's text, with `/rad-deliver` written as `rad-deliver`;
- `targets: { claude: command:architect/rad-approve, codex: skill, codex_implicit: false }`.

The body is today's command body with the AC#4 edits:
- the H1 becomes `# rad-approve`;
- the Input section describes `{{args}}` in prose;
- the proxy-flag parsing step (Step 1) sets `PLAN_ARG`, `ON_BEHALF_OF` and `EVIDENCE` from the input, and later bash uses `"$PLAN_ARG"`, `"$ON_BEHALF_OF"` and `"$EVIDENCE"`;
- Step 2's `FEATURE=$(basename "$ARGUMENTS" .md)` becomes `FEATURE=$(basename "$PLAN_ARG" .md)`;
- `scripts/checkout-plan.sh "$WORK_BRANCH"` becomes `node harness/cli.js checkout "$FEATURE"`, with its exit codes stated (0 continue; 1 stop and report, since it means a missing branch or divergence; 2 fix the name);
- slash references become command names, with the slash form given once.

Delete the old `.claude/commands/architect/rad-approve.md`, run `node harness/cli.js generate`, and commit the source and its three outputs.
Validate: AC#3, AC#4 — `generate --check` exits 0; `git diff main -- .claude/commands/architect/rad-approve.md` shows only these edits plus frontmatter/marker; `grep -nE '\$ARGUMENTS|checkout-plan\.sh|git (add|commit|push|checkout)|rad-label' .agents/skills/rad-approve/SKILL.md` returns nothing; `grep -n 'allow_implicit_invocation: false' .agents/skills/rad-approve/agents/openai.yaml` matches

#### Task 2.2: Fix the plan and adopt Rules line
File: .rad/skills/rad-plan/SKILL.md:440-450, .rad/skills/rad-adopt/SKILL.md:298-306, .claude/commands/team/rad-plan.md:1-1, .claude/commands/team/rad-adopt.md:1-1, .agents/skills/rad-plan/SKILL.md:1-1, .agents/skills/rad-adopt/SKILL.md:1-1
What: Replace each "Do not read files directly — delegate … otherwise run it inline …" Rules line with: "Keep raw file contents out of your working context — delegate research to a sub-agent if your tool can run one, otherwise run it inline with the same caps; either way keep only the bounded summary (`RESEARCH_SUMMARY` for rad-plan)". Change nothing else. Run `generate` and commit the sources and their outputs.
Validate: AC#5 — `grep -n 'Do not read files directly' .rad/skills/rad-plan/SKILL.md .rad/skills/rad-adopt/SKILL.md` returns nothing; `generate --check` exits 0

### Wave 3 — parallel
Tests and docs.

#### Task 3.1: skill-bodies test and install check
File: harness/test/skill-bodies.test.js:1-62, scripts/test-install-harness.sh:436-455
What: Replace the single required `plan-open` string with a `REQUIRED_COMMANDS` map: `rad-plan` and `rad-adopt` require `node harness/cli.js plan-open`; `rad-approve` requires `node harness/cli.js approve`, `node harness/cli.js plan-status` and `node harness/cli.js checkout`. Add `rad-approve` to `TOOL_NEUTRAL_SKILLS` and `scripts/checkout-plan.sh` to the forbidden patterns. Add a test that `.agents/skills/rad-approve/agents/openai.yaml` contains `allow_implicit_invocation: false`. Keep the negative case. In the install test, add `rad-approve` to `SLICE_SKILLS` and assert that `.agents/skills/rad-approve/agents/openai.yaml` ships on a fresh install.
Validate: AC#6, AC#7 — `node --test harness/test/skill-bodies.test.js` passes; the full harness suite passes; `bash` and `/bin/bash scripts/test-install-harness.sh` pass

#### Task 3.2: Docs
File: docs/rad-cli.md:100-215, docs/rad-tool-portability.md:45-60, UPGRADE.md:410-440
What: Add a `### rad checkout` section after `### rad plan-status`, in the same style (usage, behavior, exit codes, success line, the note that it wraps `scripts/checkout-plan.sh`). The `rad-approve` portability row becomes `Body: as-is` with `Status: generated (#186 part 2d)`; note `codex_implicit: false` (`agents/openai.yaml`) in the row or the table notes. In UPGRADE.md, extend the 2c section or add a sibling saying `rad-approve` is now generated the same way, Codex can't invoke it on its own, and `rad checkout` is new. Correct 2c's sentence about "your own `.rad/skills` source": install ships those sources to every project.
Validate: AC#8 — `grep -n 'generated (#186 part 2d)' docs/rad-tool-portability.md` matches; `grep -n 'rad checkout' docs/rad-cli.md UPGRADE.md` matches

## Tests to Write
- [ ] rad checkout argument, refusal and real-git checkout cases — harness/test/cli-checkout.test.js
- [ ] Tool-neutrality across plan, adopt and approve, with per-skill required commands and the openai.yaml policy — harness/test/skill-bodies.test.js
- [ ] The install ships the rad-approve skill and its openai.yaml — scripts/test-install-harness.sh

## Non-Goals
- Switching `/rad-deliver` (or anything else) from `checkout-plan.sh` to `rad checkout` — part 3.
- Changing `checkout-plan.sh`, or approve, plan-status or proxy behavior.
- A `codex.md` override for approve.
- Unifying approve's legacy exit-1 refusals.

## Out-of-Scope Dependencies
None

## Risks
- **The approve body is the human gate's prose.** A drift during generation could change how approval is presented or confirmed. Mitigation: AC#4 requires the generated Claude diff to show only the listed edits, and Task 2.1 validates that by diffing against main.
- **`rad checkout` changes the working branch.** That's the same effect as today's script call, and it refuses unsafe names before running anything.
- **Self-protected paths** (`harness/`, `.rad/`, `.claude/`, `scripts/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — exit codes:** `rad checkout` maps all script failures to exit 1 (nothing for the caller to retry automatically; the message says why), and argument refusals to exit 2.
- **Assumption — branch source:** the branch comes from `conventionWorkBranch`, not the plan header, because the header isn't readable before checkout. A plan whose `Branch:` header differs from the convention was already refused by plan-open.
- **Assumption — plan-file check:** after checkout, `rad checkout` confirms `.agents/plans/<f>.md` exists, and exits 1 if not, so a stray `rad/<f>` branch without a plan isn't treated as a plan branch.
- **Assumption — the Rules fix** for plan and adopt rides in this plan because it touches the same generated-body surface.
