#!/usr/bin/env bash
# test-lint-agent-files.sh
# Regression tests for lint-agent-files.sh: frontmatter fields, context-tool
# rules, roles-less utility exemption, and Agent Scope Map sync. Self-contained:
# builds synthetic CLAUDE.md + agents-dir fixtures in a temp dir (no git needed)
# and runs the REAL script against them. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-lint-agent-files.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# build_fixture <dir> — a CLEAN fixture: an orchestrator + a context tool (both
# with roles + scope-map rows), a roles-less utility agent, and a roles-less
# agent whose tools LOOK like a context tool (exercises the exemption).
build_fixture() {
  local dir="$1"
  mkdir -p "$dir/agents"

  cat > "$dir/CLAUDE.md" <<'EOF'
# Project Context

### Agent Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| planner-orchestrator | role-orchestrator | nothing | architect |
| code-mapper | context-tool | src/** | architect |
| quoted-mapper | context-tool | lib/** | architect |
EOF

  # Quoted-scalar description (the shape /rad-design generates) — the prefix
  # check must see through the surrounding quotes.
  cat > "$dir/agents/quoted-mapper.md" <<'EOF'
---
name: quoted-mapper
description: "MUST BE USED by planner-orchestrator when mapping the lib surface. Returns anchors only."
model: claude-haiku-4-5-20251001
tools: Read, Grep, Glob
roles: architect
---

# quoted-mapper
EOF

  cat > "$dir/agents/planner-orchestrator.md" <<'EOF'
---
name: planner-orchestrator
description: Owns the planning surface. Delegate here for plan work.
model: claude-sonnet-4-6
tools: Task
roles: [architect]
---

# planner-orchestrator
EOF

  cat > "$dir/agents/code-mapper.md" <<'EOF'
---
name: code-mapper
description: >
  MUST BE USED by planner-orchestrator when mapping the code surface.
  Returns anchors — never raw file contents.
model: claude-haiku-4-5
tools: Read, Grep, Glob
roles: [architect]
---

# code-mapper
EOF

  cat > "$dir/agents/quality-reviewer.md" <<'EOF'
---
name: quality-reviewer
description: Universal code quality review. Read-only.
model: claude-sonnet-4-6
tools: Read, Bash
---

# quality-reviewer
EOF

  cat > "$dir/agents/utility-context.md" <<'EOF'
---
name: utility-context
description: A repo-external helper that only reads.
model: claude-sonnet-4-6
tools: Read, Grep, Glob
---

# utility-context
EOF
}

run_lint() {
  # run_lint <fixture-dir> — runs the REAL lint against the fixture; echoes code.
  local dir="$1" code
  set +e
  bash "$HERE/lint-agent-files.sh" "$dir/CLAUDE.md" "$dir/agents" > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

# ── Case 1: clean fixture passes ───────────────────────────────────────────────
build_fixture "$TMP/clean"
code=$(run_lint "$TMP/clean")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: clean fixture should exit 0 (got $code)"; }
echo "✓ case 1: clean fixture passes (exit 0)"

# ── Case 2: missing frontmatter field (model) fails ────────────────────────────
build_fixture "$TMP/nomodel"
sed 's/^model:.*$//' "$TMP/nomodel/agents/planner-orchestrator.md" > "$TMP/nomodel/agents/planner-orchestrator.md.new"
mv "$TMP/nomodel/agents/planner-orchestrator.md.new" "$TMP/nomodel/agents/planner-orchestrator.md"
code=$(run_lint "$TMP/nomodel")
[[ "$code" -eq 1 ]] || fail "case 2: missing model field should exit 1 (got $code)"
grep -q "'model' is missing or empty" "$TMP/out" || fail "case 2: expected missing-model reason"
echo "✓ case 2: missing frontmatter field fails (exit 1)"

# ── Case 3: context tool listing Task fails ────────────────────────────────────
build_fixture "$TMP/task"
sed 's/^tools: Read, Grep, Glob$/tools: Read, Grep, Glob, Task/' \
  "$TMP/task/agents/code-mapper.md" > "$TMP/task/agents/code-mapper.md.new"
mv "$TMP/task/agents/code-mapper.md.new" "$TMP/task/agents/code-mapper.md"
code=$(run_lint "$TMP/task")
[[ "$code" -eq 1 ]] || fail "case 3: context tool listing Task should exit 1 (got $code)"
grep -q "must not list Task" "$TMP/out" || fail "case 3: expected no-Task reason"
echo "✓ case 3: context tool listing Task fails (exit 1)"

# ── Case 4: context tool with non-haiku model fails ────────────────────────────
build_fixture "$TMP/model"
sed 's/^model: claude-haiku-4-5$/model: claude-opus-4-8/' \
  "$TMP/model/agents/code-mapper.md" > "$TMP/model/agents/code-mapper.md.new"
mv "$TMP/model/agents/code-mapper.md.new" "$TMP/model/agents/code-mapper.md"
code=$(run_lint "$TMP/model")
[[ "$code" -eq 1 ]] || fail "case 4: non-haiku context tool should exit 1 (got $code)"
grep -q "must start with claude-haiku" "$TMP/out" || fail "case 4: expected haiku-model reason"
echo "✓ case 4: context tool with non-haiku model fails (exit 1)"

# ── Case 5: context tool with a bad description prefix fails ───────────────────
build_fixture "$TMP/desc"
sed 's/^  MUST BE USED by planner-orchestrator when mapping the code surface\.$/  Maps the code surface for the planner./' \
  "$TMP/desc/agents/code-mapper.md" > "$TMP/desc/agents/code-mapper.md.new"
mv "$TMP/desc/agents/code-mapper.md.new" "$TMP/desc/agents/code-mapper.md"
code=$(run_lint "$TMP/desc")
[[ "$code" -eq 1 ]] || fail "case 5: bad description prefix should exit 1 (got $code)"
grep -q "MUST BE USED" "$TMP/out" || fail "case 5: expected description-prefix reason"
echo "✓ case 5: context tool with bad description prefix fails (exit 1)"

# ── Case 6: scope-map row with no matching agent file fails ────────────────────
build_fixture "$TMP/extrarow"
printf '| ghost-mapper | context-tool | nothing | architect |\n' >> "$TMP/extrarow/CLAUDE.md"
code=$(run_lint "$TMP/extrarow")
[[ "$code" -eq 1 ]] || fail "case 6: extra scope-map row should exit 1 (got $code)"
grep -q "ghost-mapper' has no matching" "$TMP/out" || fail "case 6: expected extra-row reason"
echo "✓ case 6: scope-map row without an agent file fails (exit 1)"

# ── Case 7: roles-declaring agent file with no scope-map row fails ─────────────
build_fixture "$TMP/norow"
grep -v '| code-mapper |' "$TMP/norow/CLAUDE.md" > "$TMP/norow/CLAUDE.md.new"
mv "$TMP/norow/CLAUDE.md.new" "$TMP/norow/CLAUDE.md"
code=$(run_lint "$TMP/norow")
[[ "$code" -eq 1 ]] || fail "case 7: roles agent without a row should exit 1 (got $code)"
grep -q "no Agent Scope Map row" "$TMP/out" || fail "case 7: expected missing-row reason"
echo "✓ case 7: agent file with roles but no scope-map row fails (exit 1)"

# ── Case 8: roles-less utility agents are exempt ───────────────────────────────
# The clean fixture already contains: quality-reviewer (Read, Bash) and
# utility-context (Read, Grep, Glob + non-haiku model + plain description),
# neither in the scope map — case 1 passing proves the exemption. Assert it
# explicitly: give utility-context a context-tool-violating shape and confirm
# it STILL passes because it has no roles: field.
build_fixture "$TMP/exempt"
code=$(run_lint "$TMP/exempt")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 8: roles-less utility agents must be exempt (got $code)"; }
echo "✓ case 8: roles-less utility agents are exempt (exit 0)"

echo "ALL PASS"
