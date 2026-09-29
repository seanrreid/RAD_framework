# Invariant Registry
`docs/invariants.yaml` lists every safety invariant RAD claims. For each one it records
the authority behind it, the code sites that enforce it, and the bypass surfaces that
have been analyzed.

## Why

Prose docs drift away from the code. #97 was that drift: the docs described a guarantee
that the code no longer enforced, and #91 was the same gap on the verification path
(a file-presence check that was described as if it ran the tests). The registry ties each
claim to literal anchors in the code, and a lint checks those anchors on every PR.

**Prose explains; facts anchor.** Docs explain *why*; the registry says *where*.

## Schema (version 1)

```yaml
version: 1
invariants:
  - id: unique-kebab-id
    claim: one precise sentence
    authority: the source of truth (event log, YAML table, plan section, …)
    enforced_by: [ { file, symbol, note? } ]    # non-empty
    display_only: [ { file?, symbol?, note } ]  # optional mirrors, never the gate
    bypasses: [ { id, surface, guarded: "yes"|"no", note } ]
```

- `symbol` is a **literal substring** that must appear in `file`, such as a function
  name, a constant, an event-type string, or distinctive error text. Never use a line
  number or a generic word.
- `bypasses` is **required**. An empty list (`[]`) means the invariant was analyzed and
  no bypass was found. A missing key means it was never analyzed, and that is an error.
- `guarded` is the quoted string `"yes"` or `"no"`. A `"no"` entry is a known, accepted
  gap, and its note must say why.
- A `display_only` entry is checked only when it has both `file` and `symbol`.

## Adding an entry

1. Write the claim as one falsifiable sentence and name its authority.
2. Find each enforcement site and pick a distinctive literal. Confirm it with
   `grep -F '<symbol>' <file>`.
3. List every env var, flag, or config surface that could weaken the claim under
   `bypasses`. Use `[]` if there are none.
4. Run the lint (below) and fix it until it reports zero errors.

## Running the lint

```bash
scripts/lint-invariants.sh              # validate schema + resolve every anchor
scripts/lint-invariants.sh --inventory  # print the bypass inventory table
```

The inventory is generated from the YAML; do not copy it into prose. The lint is
**fail-closed in CI**: a PR that renames an anchored symbol must update the registry.

## What the registry is not

The registry enforces nothing. It is documentation that a machine can check.
`harness/gates.js` is the only gate fold. The scripts and harness modules named in
`enforced_by` do the enforcement.
