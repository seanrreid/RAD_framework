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
#   - conventions scaffold: AGENTS.md + CLAUDE.md templates copy only into absent
#     paths (fresh and upgrade); a CLAUDE.md-only target is kept and gets a hint
#   - presets: --preset installs files + settings, a plain --upgrade re-applies
#     the recorded preset; a deleted tracked file, an unseeded setting, a gone
#     source or a different preset name exit 1 without reverting the core;
#     --preset usage errors install nothing; no config skips the preset step
#   - deliver-gate hook: install-hooks runs after the core on fresh install and
#     --upgrade; it creates .claude/settings.json, appends to one with other
#     keys, leaves a registered file byte-identical, and leaves a malformed one
#     byte-identical (exit 1, naming .claude/settings.json); a pre-seeded
#     .claude/settings.local.json is never touched
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

# ── 6. presets: --preset install, --upgrade re-apply, failure modes ─────────
readonly EXAMPLE_PRESET="$REPO_ROOT/presets/example"
readonly PRESET_HOOK="scripts/hooks/on-outcome/50-example-preset.sh"
readonly PRESET_EXT="ai/extensions/example-preset.md"
readonly PRESET_HIGH_RISK="$(grep '^  high_risk_patterns:' "$EXAMPLE_PRESET/preset.yml" | sed "s/^  high_risk_patterns: '//; s/'\$//")"

# expect_rc <expected> <label> <output-file> -> asserts INSTALL_RC, dumps output on mismatch.
expect_rc() {
  [[ "$INSTALL_RC" -eq "$1" ]] && ok "$2 -> installer exits $1" \
    || { bad "$2 -> installer exited $INSTALL_RC, expected $1"; cat "$3"; }
}

# copy_preset <name> -> echoes a writable copy of the example preset under $TMP.
copy_preset() {
  cp -R "$EXAMPLE_PRESET" "$TMP/$1"
  echo "$TMP/$1"
}

# install_status <target> -> echoes `install-status` output for <target>.
install_status() { ( cd "$1" && isolated node harness/cli.js install-status 2>&1 ); }

# 6a. fresh install with --preset lands files + settings and records the preset
PRE_T="$(new_repo preset-fresh)"
run_install "$PRE_T" "$TMP/preset-fresh.out" --architect "$FIXTURE_ARCHITECT" --preset "$EXAMPLE_PRESET"
expect_rc 0 "fresh install with --preset" "$TMP/preset-fresh.out"
[[ -x "$PRE_T/$PRESET_HOOK" ]] && ok "--preset -> the preset hook landed executable" \
  || bad "--preset -> $PRESET_HOOK missing or not executable"
cmp -s "$EXAMPLE_PRESET/files/$PRESET_EXT" "$PRE_T/$PRESET_EXT" \
  && ok "--preset -> the preset extension landed" || bad "--preset -> $PRESET_EXT missing or differs"
PRE_HR="$( ( cd "$PRE_T" && isolated node harness/cli.js config get settings.high_risk_patterns 2>&1 ) )"
[[ "$PRE_HR" == "$PRESET_HIGH_RISK" ]] && ok "--preset -> config get returns the preset high_risk_patterns" \
  || bad "--preset -> config get settings.high_risk_patterns returned '$PRE_HR'"
install_status "$PRE_T" >"$TMP/preset-fresh.status"
assert_contains "$TMP/preset-fresh.status" "preset: example 1 (" "--preset -> install-status records the preset"
config_valid "$PRE_T" && ok "--preset -> config stays valid" || bad "--preset -> config validate failed"

# 6b. --upgrade without --preset re-applies the recorded (copied) preset
RE_P="$(copy_preset preset-copy)"
RE_T="$(new_repo preset-reapply)"
run_install "$RE_T" "$TMP/preset-reapply-1.out" --architect "$FIXTURE_ARCHITECT" --preset "$RE_P"
expect_rc 0 "install from a copied preset" "$TMP/preset-reapply-1.out"
echo "# changed in the preset source" >>"$RE_P/files/$PRESET_EXT"
run_install "$RE_T" "$TMP/preset-reapply-2.out" --upgrade
expect_rc 0 "--upgrade re-applying the recorded preset" "$TMP/preset-reapply-2.out"
cmp -s "$RE_P/files/$PRESET_EXT" "$RE_T/$PRESET_EXT" \
  && ok "--upgrade -> the changed preset file was re-applied" || bad "--upgrade -> $PRESET_EXT not updated"

# 6c. a tracked preset file the user deleted is reported, not restored
rm "$RE_T/$PRESET_EXT"
run_install "$RE_T" "$TMP/preset-deleted.out" --upgrade
expect_rc 1 "--upgrade with a deleted preset file" "$TMP/preset-deleted.out"
assert_contains "$TMP/preset-deleted.out" "deleted: $PRESET_EXT" "deleted preset file -> output reports it"
assert_not_exists "$RE_T/$PRESET_EXT" "deleted preset file -> not restored"

# 6d. the recorded preset source is gone -> core still upgraded, exit 1
rm -rf "$RE_P"
cp "$REPO_ROOT/ai/guardrails.md" "$TMP/guardrails.src"
run_install "$RE_T" "$TMP/preset-gone.out" --upgrade
expect_rc 1 "--upgrade with the recorded preset source gone" "$TMP/preset-gone.out"
assert_contains "$TMP/preset-gone.out" "$RE_P" "missing preset source -> output names the path"
assert_contains "$TMP/preset-gone.out" "Framework core installed" "missing preset source -> core still upgraded"
cmp -s "$TMP/guardrails.src" "$RE_T/ai/guardrails.md" \
  && ok "missing preset source -> core files intact" || bad "missing preset source -> ai/guardrails.md differs"

# 6e. --preset usage errors install nothing
USAGE_N=0
for case_args in "/nonexistent-rad-preset" "" "--yes"; do
  USAGE_N=$((USAGE_N + 1))
  USE_T="$(new_repo "preset-usage-$USAGE_N")"
  if [[ -z "$case_args" ]]; then
    run_install "$USE_T" "$TMP/preset-usage.out" --preset
  else
    run_install "$USE_T" "$TMP/preset-usage.out" --preset "$case_args"
  fi
  [[ "$INSTALL_RC" -ne 0 ]] && ok "--preset '$case_args' -> usage error (non-zero)" \
    || bad "--preset '$case_args' -> installer exited 0"
  assert_contains "$TMP/preset-usage.out" "--preset" "--preset '$case_args' -> error names the flag"
  assert_not_exists "$USE_T/harness" "--preset '$case_args' -> nothing installed"
done

# 6f. --upgrade --preset over an existing settings: block that already has the key -> kept, exit 0
run_install "$PRE_T" "$TMP/preset-kept.out" --upgrade --preset "$EXAMPLE_PRESET"
expect_rc 0 "--upgrade --preset over an existing setting" "$TMP/preset-kept.out"
assert_contains "$TMP/preset-kept.out" "kept: high_risk_patterns" "existing setting -> reported kept"

# 6g. a settings: block without the key -> unseeded, exit 1, config stays valid
UNS_T="$(upgrade_target preset-unseeded)"
printf 'settings:\n  hooks_dir: x\n' >>"$UNS_T/.rad/config.yml"
run_install "$UNS_T" "$TMP/preset-unseeded.out" --upgrade --preset "$EXAMPLE_PRESET"
expect_rc 1 "--preset with an unseeded setting" "$TMP/preset-unseeded.out"
assert_contains "$TMP/preset-unseeded.out" "unseeded: high_risk_patterns" "unseeded setting -> output names it"
config_valid "$UNS_T" && ok "unseeded setting -> config stays valid" || bad "unseeded setting -> config validate failed"

# 6h. a different preset name over an installed one -> exit 1, not switched, core upgraded
OTHER_P="$(copy_preset preset-other)"
sed 's/^name: example$/name: other/' "$EXAMPLE_PRESET/preset.yml" >"$OTHER_P/preset.yml"
run_install "$PRE_T" "$TMP/preset-other.out" --upgrade --preset "$OTHER_P"
expect_rc 1 "--upgrade --preset with a different preset name" "$TMP/preset-other.out"
assert_contains "$TMP/preset-other.out" "Framework core installed" "different preset -> core still upgraded"
install_status "$PRE_T" >"$TMP/preset-other.status"
assert_contains "$TMP/preset-other.status" "preset: example 1 (" "different preset -> preset not switched"

# 6i. no config (no identity) -> preset step skipped with a warning, exit 1
NOCFG_T="$(new_repo preset-noconfig)"
run_install "$NOCFG_T" "$TMP/preset-noconfig.out" --preset "$EXAMPLE_PRESET"
expect_rc 1 "--preset with no config created" "$TMP/preset-noconfig.out"
assert_contains "$TMP/preset-noconfig.out" "Preset step skipped" "no config -> preset step skipped with a warning"
assert_not_exists "$NOCFG_T/$PRESET_EXT" "no config -> no preset file written"

# ── 7. the generated read-only slice ships (#171 part 2) ────────────────────
# A stable line from quality-reviewer's body, proving rad review read the agent.
readonly REVIEWER_BODY_LINE="Universal code quality review agent."
readonly SLICE_SKILLS=(quality-review accessibility-review rad-status rad-review rad-plan rad-adopt rad-approve)

# 7a. fresh install: generated outputs (marked), sources, no internal agents
for r in quality-reviewer accessibility-reviewer; do
  assert_contains "$MAIN/.claude/agents/$r.md" "generated by rad generate" "fresh install ships marked .claude/agents/$r.md"
  assert_exists "$MAIN/.codex/agents/$r.toml" "fresh install ships .codex/agents/$r.toml"
  assert_exists "$MAIN/.rad/agents/$r.md" "fresh install ships source .rad/agents/$r.md"
done
for s in "${SLICE_SKILLS[@]}"; do
  assert_exists "$MAIN/.agents/skills/$s/SKILL.md" "fresh install ships .agents/skills/$s/SKILL.md"
done
assert_exists "$MAIN/.agents/skills/rad-approve/agents/openai.yaml" "fresh install ships .agents/skills/rad-approve/agents/openai.yaml"
assert_not_exists "$MAIN/.claude/agents/event-fold-orchestrator.md" "fresh install ships no internal orchestrator agent"
( cd "$MAIN" && isolated node harness/cli.js generate --check ) >"$TMP/slice-check.out" 2>&1 \
  && ok "generate --check exits 0 in the installed target" \
  || { bad "generate --check failed in the installed target"; cat "$TMP/slice-check.out"; }

# 7b. rad review resolves and parses the generated quality-reviewer in the target
FAKE_REVIEW="$TMP/fake-review.js"
cat >"$FAKE_REVIEW" <<'EOF'
// Saves the prompt from stdin to argv[2], then prints an empty findings block.
const { writeFileSync } = require('node:fs');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; }).on('end', () => {
  writeFileSync(process.argv[2], prompt);
  console.log('````rad-findings\n{"reviewer":"quality-reviewer","findings":[]}\n````');
});
EOF
REVIEW_BASE="$(cd "$MAIN" && isolated git add -A && isolated git -c user.email=t@e.st -c user.name=t commit -qm base \
  && isolated git branch --show-current)"
( cd "$MAIN" && isolated git checkout -qb rad/slice-review )
REVIEW_RC=0
( cd "$MAIN" && RAD_REVIEW_AGENT_CMD="node $FAKE_REVIEW $TMP/review-prompt.txt" \
    isolated node harness/cli.js review quality-reviewer --base "$REVIEW_BASE" ) >"$TMP/review.out" 2>&1 \
  || REVIEW_RC=$?
[[ "$REVIEW_RC" -eq 0 ]] && ok "rad review quality-reviewer exits 0 on the generated agent" \
  || { bad "rad review quality-reviewer exited $REVIEW_RC"; cat "$TMP/review.out"; }
assert_contains "$TMP/review-prompt.txt" "$REVIEWER_BODY_LINE" "rad review prompt carries the generated reviewer body"

# ── 8. conventions scaffold: AGENTS.md + CLAUDE.md (#171 part 3) ───────────
# Each row of the scaffold table, fresh and upgrade. A user's own file must stay
# byte-identical; the move hint appears only when the target has CLAUDE.md alone.
readonly CONVENTIONS_ROWS="neither agents claude both"
readonly MOVE_HINT_MARKER='UPGRADE.md "Moving conventions to AGENTS.md"'
USER_AGENTS="$TMP/user-agents.md"
USER_CLAUDE="$TMP/user-claude.md"
printf '# My AGENTS\n\n## Coding Conventions\n\n- user rule\n' >"$USER_AGENTS"
printf '# My CLAUDE\n\n## Coding Conventions\n\n- user rule\n' >"$USER_CLAUDE"

# seed_conventions <dir> <row> -> leaves exactly the row's user files in <dir>.
seed_conventions() {
  rm -f "$1/AGENTS.md" "$1/CLAUDE.md"
  case "$2" in
    agents) cp "$USER_AGENTS" "$1/AGENTS.md" ;;
    claude) cp "$USER_CLAUDE" "$1/CLAUDE.md" ;;
    both)   cp "$USER_AGENTS" "$1/AGENTS.md"; cp "$USER_CLAUDE" "$1/CLAUDE.md" ;;
    neither) ;;
    *) echo "seed_conventions: unknown row '$2'" >&2; exit 2 ;;
  esac
}

# same_file <actual> <expected> <label> -> passes when the files are byte-identical.
same_file() { cmp -s "$1" "$2" && ok "$3" || bad "$3 ($1 differs from $2)"; }

# check_conventions <dir> <row> <output-file> <mode> -> asserts the row's outcome.
check_conventions() {
  local dir="$1" row="$2" out="$3" label="$4 $2"
  [[ "$INSTALL_RC" -eq 0 ]] && ok "$label -> installer exits 0" \
    || { bad "$label -> installer exited $INSTALL_RC"; cat "$out"; }
  case "$row" in
    neither)
      same_file "$dir/AGENTS.md" "$REPO_ROOT/AGENTS.md" "$label -> AGENTS.md template copied"
      same_file "$dir/CLAUDE.md" "$REPO_ROOT/CLAUDE.md" "$label -> CLAUDE.md stub copied" ;;
    agents)
      same_file "$dir/AGENTS.md" "$USER_AGENTS" "$label -> user AGENTS.md byte-identical"
      same_file "$dir/CLAUDE.md" "$REPO_ROOT/CLAUDE.md" "$label -> CLAUDE.md stub copied" ;;
    claude)
      same_file "$dir/CLAUDE.md" "$USER_CLAUDE" "$label -> user CLAUDE.md byte-identical"
      assert_not_exists "$dir/AGENTS.md" "$label -> no AGENTS.md added" ;;
    both)
      same_file "$dir/AGENTS.md" "$USER_AGENTS" "$label -> user AGENTS.md byte-identical"
      same_file "$dir/CLAUDE.md" "$USER_CLAUDE" "$label -> user CLAUDE.md byte-identical" ;;
  esac
  if [[ "$row" == "claude" ]]; then
    assert_contains "$out" "$MOVE_HINT_MARKER" "$label -> prints the move hint"
  elif grep -qF -- "$MOVE_HINT_MARKER" "$out"; then
    bad "$label -> printed the move hint, expected none"
  else
    ok "$label -> no move hint"
  fi
}

for row in $CONVENTIONS_ROWS; do
  CONV_T="$(new_repo "conv-fresh-$row")"
  seed_conventions "$CONV_T" "$row"
  run_install "$CONV_T" "$TMP/conv-fresh-$row.out" --architect "$FIXTURE_ARCHITECT"
  check_conventions "$CONV_T" "$row" "$TMP/conv-fresh-$row.out" "fresh install"

  CONV_T="$(upgrade_target "conv-upgrade-$row")"
  seed_conventions "$CONV_T" "$row"
  run_install "$CONV_T" "$TMP/conv-upgrade-$row.out" --upgrade
  check_conventions "$CONV_T" "$row" "$TMP/conv-upgrade-$row.out" "upgrade"
done

# Amendment 1: a fresh install's next steps point to AGENTS.md for conventions
# and stage it for commit; an upgrade names both files as unchanged.
NEXT_STEPS_OUT="$TMP/conv-fresh-neither.out"
assert_contains "$NEXT_STEPS_OUT" "1. Review .rad/config.yml and fill in AGENTS.md" \
  "fresh install next steps -> step 1 names AGENTS.md"
assert_contains "$NEXT_STEPS_OUT" "git add .claude/ .agents/ .rad/ scripts/ harness/ ai/ AGENTS.md CLAUDE.md" \
  "fresh install next steps -> git add includes AGENTS.md"
assert_contains "$TMP/conv-upgrade-neither.out" "AGENTS.md, CLAUDE.md, .rad/config.yml" \
  "upgrade next steps -> names AGENTS.md and CLAUDE.md as unchanged"

# ── deliver-gate hook registration (install-hooks) ───────────────────────────
readonly HOOK_SETTINGS=".claude/settings.json"
readonly HOOK_LOCAL_SETTINGS=".claude/settings.local.json"
readonly HOOK_MARKER="deliver-gate-hook.mjs"
readonly LOCAL_SETTINGS_FIXTURE="$TMP/settings.local.fixture.json"
printf '{ "permissions": { "allow": ["Bash(ls)"] } }\n' >"$LOCAL_SETTINGS_FIXTURE"

# seed_local_settings <dir> -> pre-seeds .claude/settings.local.json from the fixture.
seed_local_settings() { mkdir -p "$1/.claude"; cp "$LOCAL_SETTINGS_FIXTURE" "$1/$HOOK_LOCAL_SETTINGS"; }

# Fresh install: settings.json created with the hook; settings.local.json untouched.
HOOK_FRESH_T="$(new_repo hook-fresh)"
seed_local_settings "$HOOK_FRESH_T"
run_install "$HOOK_FRESH_T" "$TMP/hook-fresh.out" --architect "$FIXTURE_ARCHITECT"
expect_rc 0 "hooks: fresh install" "$TMP/hook-fresh.out"
assert_contains "$HOOK_FRESH_T/$HOOK_SETTINGS" "$HOOK_MARKER" "hooks: fresh install -> settings.json registers the hook"
same_file "$HOOK_FRESH_T/$HOOK_LOCAL_SETTINGS" "$LOCAL_SETTINGS_FIXTURE" \
  "hooks: fresh install -> settings.local.json byte-identical"

# Upgrade over a settings.json with other keys: keys kept, hook appended.
HOOK_UPG_T="$(upgrade_target hook-upgrade)"
printf '{ "env": { "KEEP_ME": "1" }, "hooks": { "Stop": [] } }\n' >"$HOOK_UPG_T/$HOOK_SETTINGS"
seed_local_settings "$HOOK_UPG_T"
run_install "$HOOK_UPG_T" "$TMP/hook-upgrade.out" --upgrade
expect_rc 0 "hooks: upgrade over existing settings" "$TMP/hook-upgrade.out"
assert_contains "$HOOK_UPG_T/$HOOK_SETTINGS" "KEEP_ME" "hooks: upgrade -> existing settings keys kept"
assert_contains "$HOOK_UPG_T/$HOOK_SETTINGS" "\"Stop\"" "hooks: upgrade -> existing hook events kept"
assert_contains "$HOOK_UPG_T/$HOOK_SETTINGS" "$HOOK_MARKER" "hooks: upgrade -> hook appended"
same_file "$HOOK_UPG_T/$HOOK_LOCAL_SETTINGS" "$LOCAL_SETTINGS_FIXTURE" \
  "hooks: upgrade -> settings.local.json byte-identical"

# A second upgrade leaves the registered settings.json byte-identical.
cp "$HOOK_UPG_T/$HOOK_SETTINGS" "$TMP/hook-upgrade.settings.before"
run_install "$HOOK_UPG_T" "$TMP/hook-upgrade-2.out" --upgrade
expect_rc 0 "hooks: second upgrade" "$TMP/hook-upgrade-2.out"
same_file "$HOOK_UPG_T/$HOOK_SETTINGS" "$TMP/hook-upgrade.settings.before" \
  "hooks: second upgrade -> settings.json byte-identical"

# A malformed settings.json is left byte-identical; the installer exits 1 naming it.
HOOK_MAL_T="$(upgrade_target hook-malformed)"
printf '{ not json\n' >"$HOOK_MAL_T/$HOOK_SETTINGS"
cp "$HOOK_MAL_T/$HOOK_SETTINGS" "$TMP/hook-malformed.settings.before"
seed_local_settings "$HOOK_MAL_T"
run_install "$HOOK_MAL_T" "$TMP/hook-malformed.out" --upgrade
expect_rc 1 "hooks: malformed settings.json" "$TMP/hook-malformed.out"
same_file "$HOOK_MAL_T/$HOOK_SETTINGS" "$TMP/hook-malformed.settings.before" \
  "hooks: malformed settings.json -> left byte-identical"
assert_contains "$TMP/hook-malformed.out" "the deliver-gate hook was not registered: rad install-hooks: $HOOK_SETTINGS" \
  "hooks: malformed settings.json -> summary names .claude/settings.json"
same_file "$HOOK_MAL_T/$HOOK_LOCAL_SETTINGS" "$LOCAL_SETTINGS_FIXTURE" \
  "hooks: malformed settings.json -> settings.local.json byte-identical"

# ── summary ─────────────────────────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: ALL PASS"
