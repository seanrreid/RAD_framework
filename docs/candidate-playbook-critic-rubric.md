# Candidate playbook: critic rubric

> Not a shipped playbook. `.agents/playbooks/` files must name only files that
> exist today (see `.agents/playbooks/README.md`), and no rubric-backed critic
> exists in RAD yet. Promote this to `critic--<slug>.md` after the first one
> ships, drafted from its real diff. `critic` is not a default kind; add it to
> `playbook_kinds:` in `.rad/config.yml` when promoting.

## Source

Observed in a downstream project that adapted RAD (its `/review-*` skills, a
`/preflight` gate, and CI critic workflows). Every critic there had the same
shape, which is the part worth keeping.

## The shape

One rubric file is the single source of truth. Two thin wrappers read it:

| Piece | Role |
|-------|------|
| `<rubric>.md` (one per bug class) | The rules, the finding classes, severity, and a worked "shipped" example per rule. The only place a rule is edited. |
| CI wrapper | Runs the rubric against the PR diff. Advisory or blocking is a wrapper decision, not a rubric decision. |
| Local skill | Reads the same rubric, then does what CI cannot because it has the repo: trace handlers, grep for siblings, run the edge-input audit. |
| Router (preflight) | Maps changed paths to the critics that apply, runs the mechanical gate first, and returns one go/no-go. |

Rules that made it work downstream:

- The skill never copies the rubric's rules; it cites the file. A rule change is a one-file edit.
- Every rule cites a regression that really shipped. A rule with no shipped example is a candidate for deletion.
- The report shows the sweep (pattern, instances found, covered/uncovered), so "no findings" is verifiable. An empty section is a claim that someone looked.
- Critics are read-only.
- Critics flag diff additions only; pre-existing issues are findings only when they are siblings of something the diff touched.

## Fit with RAD

- **Rubric location.** RAD already treats `.rad/agents/*.md` as the source and generates `.claude/agents` and `.codex/agents` from it (`rad generate`, `generated-drift` job). A rubric could be a source there, so both agent runtimes read one file.
- **Existing reviewers.** `quality-reviewer` and `accessibility-reviewer` are generic and stack-agnostic. A critic rubric is the project-specific complement: it encodes the regression classes this repo has actually shipped.
- **CI.** The wrapper belongs next to `plan-lint` / `deliver-integrity` in `.github/workflows/ci.yml`. Per the harness-ci rule, YAML stays a thin wrapper; the check logic is a script invocable on any runner.
- **Review step.** `/team:rad-review` is the natural router: map the changed paths to rubrics, run each, merge findings into the existing findings log so `/shared:rad-insights` can count recurrence per rubric class.
- **Authority.** Like playbooks, a critic is guidance. It must not approve a plan or change severity routing.

## Open decisions before promoting

1. Does the rubric live under `.rad/agents/` (generated into both runtimes) or in a new `.rad/critics/`?
2. Advisory by default, with an opt-in blocking list, or blocking by default?
3. Does a rubric's finding class feed `findings.jsonl` categories directly, so recurrence suggestions in `/rad-insights` work per class?
4. Ship one critic first (suggest the UI-integrity one, now installed globally as `/review-ui-integrity`) and write the playbook from that diff.
