#!/usr/bin/env bash
# test-lint-agent-files.sh
# Regression tests for lint-agent-files.sh: frontmatter fields, context-tool
# rules, the purpose field (required on roles agents; capacity advisory),
# roles-less utility exemption, and agent_scope_map sync. Self-contained:
# builds synthetic repo-root fixtures in a temp dir (no git needed) — each a
# .rad/config.yml, a copy of harness/ (minus node_modules/test; the config
# reader), and an agents dir — and runs the REAL script against them.
# Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-lint-agent-files.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# build_fixture <dir> — a CLEAN fixture: an orchestrator + a context tool (both
# with roles + scope-map rows), a roles-less utility agent, and a roles-less
# agent whose tools LOOK like a context tool (exercises the exemption).
build_fixture() {
  local dir="$1" p
  mkdir -p "$dir/agents" "$dir/harness" "$dir/.rad"
  for p in "$HERE/../harness/"*; do
    case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$dir/harness/" ;; esac
  done

  # One flow-style row per line so cases can add/drop a row with a line edit.
  cat > "$dir/.rad/config.yml" <<'EOF'
version: 1
platform: manual
default_branch: main
roles:
  architect:
    - arch@example.com
agent_scope_map:
  - {agent: planner-orchestrator, type: role-orchestrator, reads: nothing, roles: [architect]}
  - {agent: code-mapper, type: context-tool, reads: "src/**", roles: [architect]}
  - {agent: quoted-mapper, type: context-tool, reads: "lib/**", roles: [architect]}
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
purpose: context-discipline
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
purpose: authority
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
purpose: context-discipline
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

# set_purpose <agent-file> <line> — replace the purpose: line (an empty <line>
# deletes it), keeping the rest of the fixture intact.
set_purpose() {
  local file="$1" line="$2"
  if [[ -z "$line" ]]; then
    grep -v '^purpose:' "$file" > "$file.new"
  else
    sed "s/^purpose:.*\$/$line/" "$file" > "$file.new"
  fi
  mv "$file.new" "$file"
}

run_lint() {
  # run_lint <fixture-dir> — runs the REAL lint against the fixture; echoes code.
  local dir="$1" code
  set +e
  bash "$HERE/lint-agent-files.sh" "$dir" "$dir/agents" > "$TMP/out" 2>&1
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
printf '  - {agent: ghost-mapper, type: context-tool, reads: nothing, roles: [architect]}\n' \
  >> "$TMP/extrarow/.rad/config.yml"
code=$(run_lint "$TMP/extrarow")
[[ "$code" -eq 1 ]] || fail "case 6: extra scope-map row should exit 1 (got $code)"
grep -q "ghost-mapper' has no matching" "$TMP/out" || fail "case 6: expected extra-row reason"
echo "✓ case 6: scope-map row without an agent file fails (exit 1)"

# ── Case 7: roles-declaring agent file with no scope-map row fails ─────────────
build_fixture "$TMP/norow"
grep -v 'agent: code-mapper,' "$TMP/norow/.rad/config.yml" > "$TMP/norow/config.yml.new"
mv "$TMP/norow/config.yml.new" "$TMP/norow/.rad/config.yml"
code=$(run_lint "$TMP/norow")
[[ "$code" -eq 1 ]] || fail "case 7: roles agent without a row should exit 1 (got $code)"
grep -q "declares roles: but has no row in .rad/config.yml agent_scope_map" "$TMP/out" || fail "case 7: expected missing-row reason"
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

# ── Case 9: missing .rad/config.yml fails closed ───────────────────────────────
build_fixture "$TMP/noconfig"
rm "$TMP/noconfig/.rad/config.yml"
code=$(run_lint "$TMP/noconfig")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "case 9: missing config should exit 1 (got $code)"; }
echo "✓ case 9: missing .rad/config.yml fails closed (exit 1)"

# ── Case 10: roles agent with no purpose fails, naming the allowed values ─────
build_fixture "$TMP/nopurpose"
set_purpose "$TMP/nopurpose/agents/planner-orchestrator.md" ""
code=$(run_lint "$TMP/nopurpose")
[[ "$code" -eq 1 ]] || fail "case 10: missing purpose should exit 1 (got $code)"
grep -q "'purpose' is missing or empty" "$TMP/out" || fail "case 10: expected missing-purpose reason"
grep -q "authority | context-discipline | capacity" "$TMP/out" || fail "case 10: expected the three allowed values"
echo "✓ case 10: roles agent with no purpose fails (exit 1)"

# ── Case 11: empty purpose: fails ──────────────────────────────────────────────
build_fixture "$TMP/emptypurpose"
set_purpose "$TMP/emptypurpose/agents/code-mapper.md" "purpose:"
code=$(run_lint "$TMP/emptypurpose")
[[ "$code" -eq 1 ]] || fail "case 11: empty purpose should exit 1 (got $code)"
grep -q "'purpose' is missing or empty" "$TMP/out" || fail "case 11: expected missing-purpose reason"
echo "✓ case 11: empty purpose fails (exit 1)"

# ── Case 12: purpose outside the allowed set fails, naming the bad value ───────
build_fixture "$TMP/badpurpose"
set_purpose "$TMP/badpurpose/agents/code-mapper.md" "purpose: boundary"
code=$(run_lint "$TMP/badpurpose")
[[ "$code" -eq 1 ]] || fail "case 12: invalid purpose should exit 1 (got $code)"
grep -q "purpose 'boundary' is not one of: authority | context-discipline | capacity" "$TMP/out" \
  || fail "case 12: expected invalid-purpose reason naming 'boundary'"
echo "✓ case 12: invalid purpose fails (exit 1)"

# ── Case 13: capacity passes with a non-blocking advisory ──────────────────────
build_fixture "$TMP/capacity"
set_purpose "$TMP/capacity/agents/code-mapper.md" "purpose: capacity"
code=$(run_lint "$TMP/capacity")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 13: capacity should exit 0 (got $code)"; }
grep -q "^advisory: .*code-mapper\.md: purpose: capacity is provisional" "$TMP/out" \
  || { cat "$TMP/out"; fail "case 13: expected a capacity advisory naming code-mapper.md"; }
echo "✓ case 13: capacity passes with an advisory (exit 0)"

# ── Case 14: roles-less agent without purpose is exempt ────────────────────────
# quality-reviewer and utility-context carry no roles: and no purpose:.
build_fixture "$TMP/rolelesspurpose"
grep -q '^purpose:' "$TMP/rolelesspurpose/agents/utility-context.md" \
  && fail "case 14: fixture precondition — utility-context must have no purpose"
code=$(run_lint "$TMP/rolelesspurpose")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 14: roles-less agent needs no purpose (got $code)"; }
echo "✓ case 14: roles-less agent without purpose is exempt (exit 0)"

# ── Case 15: quoted purpose value passes ───────────────────────────────────────
build_fixture "$TMP/quotedpurpose"
set_purpose "$TMP/quotedpurpose/agents/planner-orchestrator.md" 'purpose: "authority"'
code=$(run_lint "$TMP/quotedpurpose")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 15: quoted purpose should exit 0 (got $code)"; }
grep -q "advisory:" "$TMP/out" && fail "case 15: no advisory expected without capacity"
echo "✓ case 15: quoted purpose value passes (exit 0)"

echo "ALL PASS"
