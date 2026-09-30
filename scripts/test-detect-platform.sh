#!/usr/bin/env bash
# test-detect-platform.sh
# Regression test for detect-platform.sh platform precedence (issue #156):
# CLAUDE.md `platform:` (at the git top level) wins over origin-URL detection;
# an invalid value warns on stderr and resolves to manual; absent falls back
# to today's URL detection. Each case runs in a throwaway git repo.
#
# Usage: scripts/test-detect-platform.sh   (exit 0 = all assertions pass)
# Runs under bash 3.2+ (set -u safe).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="$HERE/detect-platform.sh"
TMP="$(mktemp -d)"
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

# new_repo <name> <remote-url|""> [claude-md-content]  → prints repo path
new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  if [[ -n "$2" ]]; then git -C "$dir" remote add origin "$2"; fi
  if [[ $# -ge 3 ]]; then printf '%s\n' "$3" > "$dir/CLAUDE.md"; fi
  echo "$dir"
}

# run_detect <repo> [args...] → stdout in $TMP/out, stderr in $TMP/err
run_detect() {
  local dir="$1"; shift
  rm -f "$TMP/cli-calls"
  (cd "$dir" && PATH="$STUBS:$PATH" bash "$DETECT" "$@" >"$TMP/out" 2>"$TMP/err") \
    || fail "detect-platform.sh exited non-zero in $dir: $(cat "$TMP/err")"
}
last_line() { tail -n 1 "$TMP/out"; }

# 1. platform: manual beats a github.com remote; no host CLI is consulted.
repo=$(new_repo manual "git@github.com:o/r.git" "platform: manual")
run_detect "$repo"
[[ "$(last_line)" == "manual" ]] || fail "manual config: got [$(last_line)]"
grep -q "from CLAUDE.md" "$TMP/out" || fail "manual config: source not reported as CLAUDE.md"
[[ ! -f "$TMP/cli-calls" ]] || fail "manual config invoked a host CLI: $(cat "$TMP/cli-calls")"
ok "platform: manual overrides github.com remote; no host CLI checked"

# 2. platform: github beats an unknown-host remote (no glab-first fallback).
repo=$(new_repo ghconf "https://git.example.internal/o/r.git" "platform: github")
run_detect "$repo" --quiet
[[ "$(last_line)" == "github" ]] || fail "github config: got [$(last_line)]"
ok "platform: github overrides unknown-host remote"

# 3. Invalid value → manual + warning on stderr naming the value.
repo=$(new_repo invalid "git@github.com:o/r.git" "platform: githubb")
run_detect "$repo" --quiet
[[ "$(last_line)" == "manual" ]] || fail "invalid config: got [$(last_line)]"
grep -qF "warning: invalid platform 'githubb' in CLAUDE.md — using manual (valid: github|gitlab|bitbucket|forgejo|manual)" "$TMP/err" \
  || fail "invalid config: warning missing from stderr: [$(cat "$TMP/err")]"
grep -q "warning" "$TMP/out" && fail "invalid config: warning leaked to stdout" || true
ok "invalid platform value → manual + stderr warning"

# 4. Absent platform line + github.com remote → github via URL detection.
repo=$(new_repo absent-gh "git@github.com:o/r.git" "default_branch: main")
run_detect "$repo"
[[ "$(last_line)" == "github" ]] || fail "absent/github remote: got [$(last_line)]"
grep -q "from origin URL" "$TMP/out" || fail "absent/github remote: source not reported as origin URL"
ok "absent platform + github.com remote → github (from origin URL)"

# 5. No CLAUDE.md, no remote → manual.
repo=$(new_repo absent-none "")
run_detect "$repo" --quiet
[[ "$(last_line)" == "manual" ]] || fail "absent/no remote: got [$(last_line)]"
ok "no CLAUDE.md + no remote → manual"

# 6. --quiet prints only the platform (exactly one stdout line).
repo=$(new_repo quiet "git@gitlab.com:o/r.git" "platform: bitbucket")
run_detect "$repo" --quiet
[[ "$(wc -l < "$TMP/out" | tr -d ' ')" == "1" ]] || fail "--quiet: expected 1 line, got [$(cat "$TMP/out")]"
[[ "$(cat "$TMP/out")" == "bitbucket" ]] || fail "--quiet: got [$(cat "$TMP/out")]"
[[ ! -s "$TMP/err" ]] || fail "--quiet: unexpected stderr [$(cat "$TMP/err")]"
ok "--quiet prints only the platform"

# 7. Real CLAUDE.md shape: fenced block, indented key, trailing comment.
repo=$(new_repo fenced "git@github.com:o/r.git" '## RAD Configuration

### Git Platform

```
  platform: forgejo        # github | gitlab | bitbucket | forgejo | manual
default_branch: main
```')
run_detect "$repo" --quiet
[[ "$(last_line)" == "forgejo" ]] || fail "fenced block: got [$(last_line)]"
ok "fenced platform line with trailing comment parses"

# 8. Outside any git repo → no CLAUDE.md lookup, URL detection → manual.
mkdir -p "$TMP/norepo"
(cd "$TMP/norepo" && GIT_CEILING_DIRECTORIES="$TMP" PATH="$STUBS:$PATH" bash "$DETECT" --quiet >"$TMP/out" 2>"$TMP/err") \
  || fail "outside repo: exited non-zero: $(cat "$TMP/err")"
[[ "$(last_line)" == "manual" ]] || fail "outside repo: got [$(last_line)]"
ok "outside a git repo → manual"

echo "ALL PASS ($PASS cases)"
