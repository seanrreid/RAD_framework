#!/usr/bin/env bash
# test-detect-platform.sh
# Regression test for detect-platform.sh platform precedence (issues #156, #87):
# `platform` in .rad/config.yml (the script checkout's config, read via
# `rad config get`) wins over origin-URL detection; an invalid config warns on
# stderr and resolves to manual; an absent config, an absent config reader
# (no harness/cli.js), or no git top level falls back to URL detection. Each
# case runs in a throwaway git repo that is also the RAD checkout (a copy of
# detect-platform.sh + harness/, minus node_modules/test).
#
# Usage: scripts/test-detect-platform.sh   (exit 0 = all assertions pass)
# Runs under bash 3.2+ (set -u safe).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# Host-CLI stubs record any invocation, so a test can prove `manual` never
# consults gh/glab/tea and unknown-host fallback is deterministic.
STUBS="$TMP/stubs"
mkdir -p "$STUBS"
for cli in gh glab tea; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/cli-calls"\necho "%s version 0.0.0"\n' \
    "$cli" "$TMP" "$cli" > "$STUBS/$cli"
  chmod +x "$STUBS/$cli"
done

PASS=0
fail() { echo "✗ $1"; exit 1; }
ok() { echo "✓ $1"; PASS=$((PASS + 1)); }

# config_yml <platform-line> → a valid-shape .rad/config.yml body
config_yml() {
  printf 'version: 1\n%s\ndefault_branch: main\nroles:\n  architect:\n    - arch@example.com\n' "$1"
}

# new_repo <name> <remote-url|""> [config-yml|NOREADER]  → prints repo path
# The repo is its own RAD checkout: scripts/detect-platform.sh + harness/.
# A 3rd arg writes .rad/config.yml; NOREADER instead omits harness/ and writes
# a manual config, so only the missing reader can explain URL detection.
new_repo() {
  local dir="$TMP/$1" p
  mkdir -p "$dir/scripts" "$dir/harness" "$dir/.rad"
  git -C "$dir" init -q
  if [[ -n "$2" ]]; then git -C "$dir" remote add origin "$2"; fi
  cp "$HERE/detect-platform.sh" "$dir/scripts/"
  if [[ "${3:-}" == "NOREADER" ]]; then
    config_yml "platform: manual" > "$dir/.rad/config.yml"
  else
    for p in "$HERE/../harness/"*; do
      case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$dir/harness/" ;; esac
    done
    if [[ $# -ge 3 ]]; then printf '%s\n' "$3" > "$dir/.rad/config.yml"; fi
  fi
  echo "$dir"
}

# run_detect <repo> [args...] → stdout in $TMP/out, stderr in $TMP/err
run_detect() {
  local dir="$1"; shift
  rm -f "$TMP/cli-calls"
  (cd "$dir" && PATH="$STUBS:$PATH" bash "$dir/scripts/detect-platform.sh" "$@" >"$TMP/out" 2>"$TMP/err") \
    || fail "detect-platform.sh exited non-zero in $dir: $(cat "$TMP/err")"
}
last_line() { tail -n 1 "$TMP/out"; }

# 1. platform: manual beats a github.com remote; no host CLI is consulted.
repo=$(new_repo manual "git@github.com:o/r.git" "$(config_yml "platform: manual")")
run_detect "$repo"
[[ "$(last_line)" == "manual" ]] || fail "manual config: got [$(last_line)]"
grep -q "from .rad/config.yml" "$TMP/out" || fail "manual config: source not reported as .rad/config.yml"
[[ ! -f "$TMP/cli-calls" ]] || fail "manual config invoked a host CLI: $(cat "$TMP/cli-calls")"
ok "platform: manual overrides github.com remote; no host CLI checked"

# 2. platform: github beats an unknown-host remote (no glab-first fallback).
repo=$(new_repo ghconf "https://git.example.internal/o/r.git" "$(config_yml "platform: github")")
run_detect "$repo" --quiet
[[ "$(last_line)" == "github" ]] || fail "github config: got [$(last_line)]"
ok "platform: github overrides unknown-host remote"

# 3. Invalid value → config invalid → manual + stderr warning naming the value.
repo=$(new_repo invalid "git@github.com:o/r.git" "$(config_yml "platform: githubb")")
run_detect "$repo" --quiet
[[ "$(last_line)" == "manual" ]] || fail "invalid config: got [$(last_line)]"
grep -qF "warning: cannot read platform from .rad/config.yml (rad config get exit 1) — using manual" "$TMP/err" \
  || fail "invalid config: warning missing from stderr: [$(cat "$TMP/err")]"
grep -qF '"githubb"' "$TMP/err" || fail "invalid config: stderr does not name the bad value: [$(cat "$TMP/err")]"
grep -q "warning" "$TMP/out" && fail "invalid config: warning leaked to stdout" || true
ok "invalid platform value → manual + stderr warning"

# 4. Config absent + github.com remote → github via URL detection.
repo=$(new_repo absent-gh "git@github.com:o/r.git")
run_detect "$repo"
[[ "$(last_line)" == "github" ]] || fail "absent/github remote: got [$(last_line)]"
grep -q "from origin URL" "$TMP/out" || fail "absent/github remote: source not reported as origin URL"
grep -q "no .rad/config.yml" "$TMP/err" || fail "absent/github remote: missing-config notice absent: [$(cat "$TMP/err")]"
ok "absent config + github.com remote → github (from origin URL)"

# 5. No config, no remote → manual.
repo=$(new_repo absent-none "")
run_detect "$repo" --quiet
[[ "$(last_line)" == "manual" ]] || fail "absent/no remote: got [$(last_line)]"
ok "no config + no remote → manual"

# 6. --quiet prints only the platform (exactly one stdout line).
repo=$(new_repo quiet "git@gitlab.com:o/r.git" "$(config_yml "platform: bitbucket")")
run_detect "$repo" --quiet
[[ "$(wc -l < "$TMP/out" | tr -d ' ')" == "1" ]] || fail "--quiet: expected 1 line, got [$(cat "$TMP/out")]"
[[ "$(cat "$TMP/out")" == "bitbucket" ]] || fail "--quiet: got [$(cat "$TMP/out")]"
[[ ! -s "$TMP/err" ]] || fail "--quiet: unexpected stderr [$(cat "$TMP/err")]"
ok "--quiet prints only the platform"

# 7. Real config shape: platform line with a trailing YAML comment.
repo=$(new_repo commented "git@github.com:o/r.git" \
  "$(config_yml "platform: forgejo        # github | gitlab | bitbucket | forgejo | manual")")
run_detect "$repo" --quiet
[[ "$(last_line)" == "forgejo" ]] || fail "commented platform: got [$(last_line)]"
ok "platform line with trailing comment parses"

# 8. Config reader unavailable (no harness/cli.js) → URL detection, even though
#    the checkout's config says manual.
repo=$(new_repo noreader "git@github.com:o/r.git" NOREADER)
run_detect "$repo"
[[ "$(last_line)" == "github" ]] || fail "no reader: got [$(last_line)]"
grep -q "from origin URL" "$TMP/out" || fail "no reader: source not reported as origin URL"
grep -q "no config reader" "$TMP/err" || fail "no reader: notice missing from stderr: [$(cat "$TMP/err")]"
ok "config reader unavailable → URL detection"

# 9. Outside any git repo → no config lookup, URL detection → manual — even
#    with a checkout config that says github.
repo=$(new_repo outside "" "$(config_yml "platform: github")")
mkdir -p "$TMP/norepo"
(cd "$TMP/norepo" && GIT_CEILING_DIRECTORIES="$TMP" PATH="$STUBS:$PATH" bash "$repo/scripts/detect-platform.sh" --quiet >"$TMP/out" 2>"$TMP/err") \
  || fail "outside repo: exited non-zero: $(cat "$TMP/err")"
[[ "$(last_line)" == "manual" ]] || fail "outside repo: got [$(last_line)]"
ok "outside a git repo → manual"

# 10. No .rad/config.yml → the notice names both remedies: init (new install)
#     and migrate (pre-#87 CLAUDE.md).
repo=$(new_repo noconfig "git@github.com:o/r.git")
run_detect "$repo"
grep -qF "rad config init" "$TMP/err" || fail "no config: notice lacks 'rad config init': [$(cat "$TMP/err")]"
grep -qF "rad config migrate" "$TMP/err" || fail "no config: notice lacks 'rad config migrate': [$(cat "$TMP/err")]"
ok "no config → notice names rad config init and rad config migrate"

echo "ALL PASS ($PASS cases)"
