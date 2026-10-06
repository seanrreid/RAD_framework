#!/usr/bin/env bash
# test-install-harness.sh
# Smoke test locking in the install-ships-harness behavior:
#   - install.sh ships harness/ source (EXCLUDING the ~250M node_modules dir)
#   - the vendored js-yaml bundle ships (gate path needs zero npm)
#   - scripts/hooks/ (README + lifecycle dirs) ships
#   - harness/cli.js loads and `rad gate` runs with NO node_modules present
#     (proves the lazy SDK import / zero-npm property)
#   - .rad/config.yml: fresh install runs `config init` (--architect, else the
#     repo's git email; no identity -> files laid down, no config, exit 1);
#     upgrade runs `config migrate` from an old CLAUDE.md block (placeholder
#     architect -> exit 1) and never touches an existing config
#   - framework core goes through the install manifest (.rad/installed.json):
#     scripts/lib ships, a local edit is kept + staged (exit 1), a pre-manifest
#     upgrade backs up then overwrites, a malformed manifest stops the install,
#     and a missing node is a named prerequisite error
# Every installer run uses an isolated git identity (no global/system config,
# empty HOME) so the developer's real git email never leaks into a result.
# Self-contained: installs into a throwaway temp dir, asserts, always cleans up.
#
# Usage: scripts/test-install-harness.sh   (exit 0 = all assertions pass)

set -euo pipefail

# The script lives in scripts/, so REPO_ROOT is its parent.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

ok()   { echo "✓ $1"; PASS=$((PASS + 1)); }
bad()  { echo "✗ $1"; FAIL=$((FAIL + 1)); }

readonly FIXTURE_ARCHITECT="architect@example.com"
readonly FIXTURE_EMAIL="repo-email@example.com"
readonly MIGRATED_ARCHITECT="a@b.c"
EMPTY_HOME="$TMP/empty-home"
mkdir -p "$EMPTY_HOME"

# Runs a command with no global/system git config and an empty HOME.
isolated() {
  HOME="$EMPTY_HOME" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 "$@"
}

# run_install <target> <output-file> [install.sh args...] -> sets INSTALL_RC
run_install() {
  local target="$1" out="$2"
  shift 2
  INSTALL_RC=0
  ( cd "$REPO_ROOT" && isolated bash install.sh --dir "$target" --yes "$@" ) >"$out" 2>&1 \
    || INSTALL_RC=$?
}

# new_repo <name> -> echoes the path of a fresh git repo under $TMP
new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  isolated git init -q "$dir"
  echo "$dir"
}

# Exit 0 when `config validate` passes in <target>.
config_valid() { ( cd "$1" && isolated node harness/cli.js config validate >/dev/null 2>&1 ); }

# Echoes the first roles.architect entry in <target>/.rad/config.yml.
config_architect() { ( cd "$1" && isolated node harness/cli.js config get roles.architect 2>/dev/null ) | head -n 1; }

assert_contains() { grep -qF -- "$2" "$1" && ok "$3" || bad "$3 (missing '$2' in $1)"; }

# Minimal pre-#87 CLAUDE.md RAD Configuration block, with <architect> as architect.
write_old_claude_md() {
  cat >"$1/CLAUDE.md" <<MD
# Project Context

## RAD Configuration

### Git Platform

\`\`\`
platform: github
default_branch: main
\`\`\`

### Role Assignments

\`\`\`
architect:  $2
developers: []
designers:  []
\`\`\`
MD
}

assert_exists()     { [[ -e "$1" ]] && ok "$2" || bad "$2 (missing: $1)"; }
assert_dir()        { [[ -d "$1" ]] && ok "$2" || bad "$2 (not a dir: $1)"; }
assert_not_exists() { [[ ! -e "$1" ]] && ok "$2" || bad "$2 (should not exist: $1)"; }

# ── 1. throwaway git repo as install target ─────────────────────────────────
MAIN="$(new_repo main)"

# ── 2. run the installer non-interactively (deterministic: --architect) ─────
run_install "$MAIN" "$TMP/main.out" --architect "$FIXTURE_ARCHITECT"
[[ "$INSTALL_RC" -eq 0 ]] && ok "installer exits 0 with --architect" \
  || bad "installer exited $INSTALL_RC with --architect (see output below)"
[[ "$INSTALL_RC" -eq 0 ]] || cat "$TMP/main.out"

# ── 3a. harness source shipped; node_modules excluded ───────────────────────
assert_exists "$MAIN/harness/cli.js" "harness/cli.js shipped"
assert_not_exists "$MAIN/harness/node_modules" "harness/node_modules excluded (the ~250M dir)"

# ── 3b. vendored js-yaml bundle shipped ─────────────────────────────────────
assert_exists "$MAIN/harness/vendor/js-yaml.mjs" "vendored js-yaml bundle shipped"

# ── 3c. wave-lifecycle hooks shipped ────────────────────────────────────────
assert_exists "$MAIN/scripts/hooks/README.md" "scripts/hooks/README.md shipped"
assert_dir "$MAIN/scripts/hooks/on-error"  "scripts/hooks/on-error dir shipped"
assert_dir "$MAIN/scripts/hooks/post-wave" "scripts/hooks/post-wave dir shipped"

# ── 3d. cli.js loads with NO node_modules present (lazy SDK / zero-npm) ──────
if node "$MAIN/harness/cli.js" >/dev/null 2>&1; then
  ok "harness/cli.js loads with no node_modules present (lazy SDK import)"
else
  bad "harness/cli.js failed to load without node_modules (exit $?)"
fi

# ── 3e. `rad gate` over a synthetic approved event exits 0 (zero-npm gate) ───
EVENT='{"feature":"x","type":"approved","actor":"a","role":"architect","ts":"2026-01-01T00:00:00Z","recordedBy":"a"}'
if printf '%s\n' "$EVENT" | node "$MAIN/harness/cli.js" gate x approved --stdin >/dev/null 2>&1; then
  ok "rad gate x approved --stdin passes on a synthetic approved event"
else
  bad "rad gate x approved --stdin failed (exit $?)"
fi

# ── 4a. fresh install with --architect -> valid config with that id ──────────
assert_exists "$MAIN/.rad/config.yml" "fresh install wrote .rad/config.yml"
config_valid "$MAIN" && ok "config validate exits 0 after fresh install" \
  || bad "config validate failed after fresh install"
[[ "$(config_architect "$MAIN")" == "$FIXTURE_ARCHITECT" ]] \
  && ok "--architect recorded as roles.architect" \
  || bad "roles.architect is '$(config_architect "$MAIN")', expected $FIXTURE_ARCHITECT"
grep -q '^default_branch: main$' "$MAIN/.rad/config.yml" \
  && ok "no origin remote -> default_branch main" \
  || bad "default_branch is not main with no origin remote"

# ── 4b. fresh install with only a repo-local git email -> that email ─────────
EMAIL_T="$(new_repo email)"
isolated git -C "$EMAIL_T" config user.email "$FIXTURE_EMAIL"
run_install "$EMAIL_T" "$TMP/email.out"
[[ "$INSTALL_RC" -eq 0 ]] && ok "installer exits 0 with a repo git email" \
  || bad "installer exited $INSTALL_RC with a repo git email"
[[ "$(config_architect "$EMAIL_T")" == "$FIXTURE_EMAIL" ]] \
  && ok "git user.email recorded as roles.architect" \
  || bad "roles.architect is '$(config_architect "$EMAIL_T")', expected $FIXTURE_EMAIL"

# ── 4c. fresh install with no identity -> files laid down, no config, exit 1 ─
NOID_T="$(new_repo noid)"
run_install "$NOID_T" "$TMP/noid.out"
[[ "$INSTALL_RC" -eq 1 ]] && ok "no identity -> installer exits 1" \
  || bad "no identity -> installer exited $INSTALL_RC, expected 1"
assert_exists "$NOID_T/harness/cli.js" "no identity -> harness/cli.js still laid down"
assert_exists "$NOID_T/CLAUDE.md" "no identity -> CLAUDE.md still laid down"
assert_not_exists "$NOID_T/.rad/config.yml" "no identity -> no .rad/config.yml"
assert_contains "$TMP/noid.out" "node harness/cli.js config init --architect" \
  "no identity -> output names the config init command"

# ── 4d. upgrade with an old CLAUDE.md block and no config -> migrated ────────
MIG_T="$(new_repo migrate)"
write_old_claude_md "$MIG_T" "$MIGRATED_ARCHITECT"
CLAUDE_BEFORE="$TMP/claude-before.md"
cp "$MIG_T/CLAUDE.md" "$CLAUDE_BEFORE"
run_install "$MIG_T" "$TMP/migrate.out" --upgrade
[[ "$INSTALL_RC" -eq 0 ]] && ok "upgrade migrate -> installer exits 0" \
  || { bad "upgrade migrate -> installer exited $INSTALL_RC"; cat "$TMP/migrate.out"; }
config_valid "$MIG_T" && ok "migrated config validates" || bad "migrated config failed validate"
[[ "$(config_architect "$MIG_T")" == "$MIGRATED_ARCHITECT" ]] \
  && ok "migrated architect carried over" \
  || bad "migrated roles.architect is '$(config_architect "$MIG_T")'"
cmp -s "$CLAUDE_BEFORE" "$MIG_T/CLAUDE.md" && ok "upgrade never edits CLAUDE.md" \
  || bad "upgrade modified CLAUDE.md"
assert_contains "$TMP/migrate.out" "Remove the RAD Configuration block from CLAUDE.md" \
  "upgrade migrate -> tells the operator to remove the old block"

# ── 4e. upgrade with an existing config -> byte-for-byte unchanged ───────────
KEEP_T="$(new_repo keep)"
mkdir -p "$KEEP_T/.rad"
cp "$MAIN/.rad/config.yml" "$KEEP_T/.rad/config.yml"
CONFIG_BEFORE="$TMP/config-before.yml"
cp "$KEEP_T/.rad/config.yml" "$CONFIG_BEFORE"
write_old_claude_md "$KEEP_T" "$MIGRATED_ARCHITECT"
run_install "$KEEP_T" "$TMP/keep.out" --upgrade
[[ "$INSTALL_RC" -eq 0 ]] && ok "upgrade with config -> installer exits 0" \
  || bad "upgrade with config -> installer exited $INSTALL_RC"
cmp -s "$CONFIG_BEFORE" "$KEEP_T/.rad/config.yml" \
  && ok "upgrade leaves an existing .rad/config.yml byte-for-byte unchanged" \
  || bad "upgrade changed an existing .rad/config.yml"

# ── 4f. upgrade with a placeholder architect -> no config, exit 1 ────────────
PH_T="$(new_repo placeholder)"
write_old_claude_md "$PH_T" "[name]"
run_install "$PH_T" "$TMP/placeholder.out" --upgrade
[[ "$INSTALL_RC" -eq 1 ]] && ok "placeholder architect -> installer exits 1" \
  || bad "placeholder architect -> installer exited $INSTALL_RC, expected 1"
assert_exists "$PH_T/harness/cli.js" "placeholder architect -> harness still laid down"
assert_not_exists "$PH_T/.rad/config.yml" "placeholder architect -> no .rad/config.yml"
assert_contains "$TMP/placeholder.out" "node harness/cli.js config migrate" \
  "placeholder architect -> output names the config migrate command"

# ── 4g. upgrade with no CLAUDE.md and no config -> exit 1, names init ────────
BARE_T="$(new_repo bare)"
run_install "$BARE_T" "$TMP/bare.out" --upgrade
[[ "$INSTALL_RC" -eq 1 ]] && ok "upgrade without CLAUDE.md or config -> exits 1" \
  || bad "upgrade without CLAUDE.md or config -> exited $INSTALL_RC, expected 1"
assert_contains "$TMP/bare.out" "node harness/cli.js config init --architect" \
  "upgrade without CLAUDE.md -> output names the config init command"

# ── 4h. --architect with no value -> usage error ────────────────────────────
USAGE_T="$(new_repo usage)"
run_install "$USAGE_T" "$TMP/usage.out" --architect
[[ "$INSTALL_RC" -eq 1 ]] && ok "--architect without a value -> usage error (exit 1)" \
  || bad "--architect without a value -> exited $INSTALL_RC, expected 1"
assert_contains "$TMP/usage.out" "--architect requires a value" "--architect usage error names the flag"
assert_not_exists "$USAGE_T/harness" "--architect usage error installs nothing"

# ── 5f. fresh install writes the manifest and ships scripts/lib ──────────────
assert_exists "$MAIN/.rad/installed.json" "fresh install wrote .rad/installed.json"
assert_exists "$MAIN/scripts/lib/plan-paths.sh" "fresh install shipped scripts/lib/plan-paths.sh"

# ── 5g. lint-plan.sh in the installed repo finds its sourced lib ─────────────
printf '# Plan: fixture\n' >"$MAIN/fixture-plan.md"
# The fixture plan is incomplete, so lint-plan.sh's own verdict is not asserted
# (the rc is recorded for the failure message); only the lib-sourcing error is.
LINT_RC=0
( cd "$MAIN" && bash scripts/lint-plan.sh fixture-plan.md ) >"$TMP/lint-plan.out" 2>&1 || LINT_RC=$?
if grep -q "No such file" "$TMP/lint-plan.out"; then
  bad "lint-plan.sh in the installed repo cannot source its lib (exit $LINT_RC)"; cat "$TMP/lint-plan.out"
else
  ok "lint-plan.sh in the installed repo sources lib/plan-paths.sh"
fi

# upgrade_target <name> -> echoes a repo freshly installed with --architect, so
# its upgrades carry an existing config and only install-core drives the exit.
upgrade_target() {
  local dir
  dir="$(new_repo "$1")"
  run_install "$dir" "$TMP/$1-fresh.out" --architect "$FIXTURE_ARCHITECT"
  [[ "$INSTALL_RC" -eq 0 ]] || { echo "fixture install of $1 failed ($INSTALL_RC)" >&2; cat "$TMP/$1-fresh.out" >&2; }
  echo "$dir"
}

# ── 5j. clean upgrade (no edits) exits 0 ────────────────────────────────────
UPG_T="$(upgrade_target upgrade)"
run_install "$UPG_T" "$TMP/upgrade-clean.out" --upgrade
[[ "$INSTALL_RC" -eq 0 ]] && ok "clean upgrade -> installer exits 0" \
  || { bad "clean upgrade -> installer exited $INSTALL_RC, expected 0"; cat "$TMP/upgrade-clean.out"; }

# ── 5h. upgrade keeps a local edit, stages the update, exits 1 ──────────────
readonly LOCAL_EDIT="# local edit kept by upgrade"
echo "$LOCAL_EDIT" >>"$UPG_T/ai/slop-register.md"
run_install "$UPG_T" "$TMP/upgrade-edit.out" --upgrade
[[ "$INSTALL_RC" -eq 1 ]] && ok "upgrade with a local edit -> installer exits 1" \
  || { bad "upgrade with a local edit -> installer exited $INSTALL_RC, expected 1"; cat "$TMP/upgrade-edit.out"; }
grep -qF -- "$LOCAL_EDIT" "$UPG_T/ai/slop-register.md" && ok "upgrade kept the local edit" \
  || bad "upgrade overwrote the local edit in ai/slop-register.md"
assert_exists "$UPG_T/.rad/upgrade-pending/ai/slop-register.md" "upgrade staged the new version in .rad/upgrade-pending/"
assert_contains "$TMP/upgrade-edit.out" "node harness/cli.js install-status" \
  "kept-file exit names the install-status review command"
STATUS_RC=0
( cd "$UPG_T" && isolated node harness/cli.js install-status ) >"$TMP/status.out" 2>&1 || STATUS_RC=$?
[[ "$STATUS_RC" -eq 1 ]] && ok "install-status exits 1 on drift" \
  || bad "install-status exited $STATUS_RC on drift, expected 1"
assert_contains "$TMP/status.out" "modified: [core] ai/slop-register.md" "install-status reports the kept local edit"

# ── 5i. first upgrade with no manifest backs up, then overwrites ────────────
BK_T="$(upgrade_target backup)"
rm "$BK_T/.rad/installed.json"
echo "# pre-manifest local edit" >>"$BK_T/ai/guardrails.md"
run_install "$BK_T" "$TMP/upgrade-backup.out" --upgrade
[[ "$INSTALL_RC" -eq 0 ]] && ok "upgrade without a manifest -> installer exits 0" \
  || { bad "upgrade without a manifest -> installer exited $INSTALL_RC, expected 0"; cat "$TMP/upgrade-backup.out"; }
BACKUP_COPY="$(find "$BK_T/.rad/upgrade-backup" -path '*/ai/guardrails.md' 2>/dev/null | head -n 1)"
[[ -n "$BACKUP_COPY" ]] && grep -qF "# pre-manifest local edit" "$BACKUP_COPY" \
  && ok "no manifest -> the differing file was backed up under .rad/upgrade-backup/" \
  || bad "no manifest -> no backup of ai/guardrails.md under .rad/upgrade-backup/"
cmp -s "$REPO_ROOT/ai/guardrails.md" "$BK_T/ai/guardrails.md" \
  && ok "no manifest -> the file was overwritten with the source version" \
  || bad "no manifest -> ai/guardrails.md does not equal the source"

# ── 5k. a malformed manifest stops the install, naming the problem ──────────
MAL_T="$(upgrade_target malformed)"
echo '{not json' >"$MAL_T/.rad/installed.json"
run_install "$MAL_T" "$TMP/malformed.out" --upgrade
[[ "$INSTALL_RC" -ne 0 ]] && ok "malformed manifest -> installer exits non-zero" \
  || bad "malformed manifest -> installer exited 0"
assert_contains "$TMP/malformed.out" ".rad/installed.json is not valid JSON" \
  "malformed manifest -> output names the problem"

# ── 5l. node missing -> named prerequisite error, nothing installed ─────────
# PATH holds only the tools install.sh needs before check_prereqs stops it;
# node is absent (on this host node and git share a bin dir, so a shim dir).
NOBIN="$TMP/no-node-bin"
mkdir -p "$NOBIN"
for tool in git dirname sed awk; do ln -s "$(command -v "$tool")" "$NOBIN/$tool"; done
NONODE_T="$(new_repo nonode)"
BASH_BIN="$(command -v bash)"
NONODE_RC=0
( cd "$REPO_ROOT" && PATH="$NOBIN" isolated "$BASH_BIN" install.sh --dir "$NONODE_T" --yes ) \
  >"$TMP/nonode.out" 2>&1 || NONODE_RC=$?
[[ "$NONODE_RC" -ne 0 ]] && ok "node missing -> installer exits non-zero" \
  || bad "node missing -> installer exited 0"
assert_contains "$TMP/nonode.out" "node is required" "node missing -> error names node"
assert_not_exists "$NONODE_T/harness" "node missing -> nothing installed"

# ── summary ─────────────────────────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: ALL PASS"
