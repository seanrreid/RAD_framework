#!/usr/bin/env bash
# test-fetch-epic.sh
# Regression tests for fetch-epic.sh's input normalization (URL/#NN → bare
# number) and its GitHub-only platform gate. Self-contained (no external
# harness): stubs gh/jq/detect-platform.sh on PATH and uses the RAD_PLATFORM
# override hook so no live network is touched. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-fetch-epic.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

SCRIPT="$HERE/fetch-epic.sh"

# ── Stub binaries on PATH ──────────────────────────────────────────────────────
# A stub `gh` that records the issue number it was asked to view (so the URL/#NN
# normalization can be asserted) and emits minimal valid JSON for each shape the
# script consumes. A stub `jq` is NOT provided — the real jq is expected on PATH;
# if absent the gh-path test is skipped (the platform test needs neither).
BIN="$TMP/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<EOF
#!/usr/bin/env bash
# Record the requested issue number from \`gh issue view <N> ...\`.
if [[ "\$1" == "issue" && "\$2" == "view" ]]; then
  printf '%s\n' "\$3" >> "$TMP/asked-numbers"
  echo '{"number":'"\$3"',"title":"t","body":"","url":"u","milestone":null,"labels":[],"state":"OPEN"}'
  exit 0
fi
if [[ "\$1" == "repo" && "\$2" == "view" ]]; then
  echo 'org/repo'
  exit 0
fi
if [[ "\$1" == "issue" && "\$2" == "list" ]]; then
  exit 0
fi
if [[ "\$1" == "api" ]]; then
  exit 0
fi
exit 0
EOF
chmod +x "$BIN/gh"

# ── AC#3: URL → issue-number extraction ────────────────────────────────────────
# Feed a full GitHub issue URL; the stub gh records the number it was asked to
# view. We assert the script extracted "42" from the URL (not the raw URL).
url_extraction_test() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "⚠ AC#3: jq not on PATH — skipping URL-extraction test (needs real jq)"
    return 0
  fi
  rm -f "$TMP/asked-numbers"
  PATH="$BIN:$PATH" RAD_PLATFORM=github \
    bash "$SCRIPT" "https://github.com/org/repo/issues/42" >/dev/null 2>&1 \
    || fail "AC#3: script exited non-zero on a valid issue URL"
  [[ -f "$TMP/asked-numbers" ]] || fail "AC#3: gh issue view was never invoked"
  # The epic must have been fetched as bare number 42.
  head -1 "$TMP/asked-numbers" | grep -qx "42" \
    || fail "AC#3: URL not normalized to 42 (got '$(head -1 "$TMP/asked-numbers")')"
  echo "✓ AC#3: GitHub issue URL is normalized to bare issue number 42"
}

# ── AC#3 (cont.): #NN form is also stripped to a bare number ───────────────────
hash_extraction_test() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "⚠ AC#3: jq not on PATH — skipping #NN-extraction test (needs real jq)"
    return 0
  fi
  rm -f "$TMP/asked-numbers"
  PATH="$BIN:$PATH" RAD_PLATFORM=github \
    bash "$SCRIPT" "#42" >/dev/null 2>&1 \
    || fail "AC#3: script exited non-zero on a valid #NN arg"
  head -1 "$TMP/asked-numbers" | grep -qx "42" \
    || fail "AC#3: #42 not normalized to 42 (got '$(head -1 "$TMP/asked-numbers")')"
  echo "✓ AC#3: #NN form is normalized to bare issue number 42"
}

# ── AC#6: non-github platform exits non-zero with the documented message ───────
# Use the RAD_PLATFORM override hook to force a non-github platform; the script
# must exit non-zero before touching gh, with its GitHub-only message.
platform_error_test() {
  local out code
  set +e
  out=$(PATH="$BIN:$PATH" RAD_PLATFORM=gitlab bash "$SCRIPT" 42 2>&1)
  code=$?
  set -e
  [[ "$code" -ne 0 ]] || fail "AC#6: non-github platform should exit non-zero (got $code)"
  printf '%s\n' "$out" | grep -q "GitHub-only" \
    || fail "AC#6: expected GitHub-only message, got: $out"
  printf '%s\n' "$out" | grep -q "Detected platform: gitlab" \
    || fail "AC#6: error should report the detected platform (gitlab)"
  echo "✓ AC#6: non-github platform exits non-zero with the GitHub-only message"
}

url_extraction_test
hash_extraction_test
platform_error_test
echo "ALL PASS"
