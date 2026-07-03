#!/usr/bin/env bash
# check-events-append-only.sh
# All-PR check: the RAD event logs (.agents/state/*/events.jsonl, including the
# reserved .agents/state/_architecture/events.jsonl) are append-only audit
# trails. For every event log touched in `git diff <base>...<head>`:
#
#   - FAIL if the diff removes or modifies any existing line (any '-' line in
#     the file's hunks, other than the "\ No newline at end of file" marker,
#     which git prefixes with '\', not '-').
#   - Every ADDED line must parse as JSON (node — no jq dependency) and carry
#     non-empty string fields: feature, type, actor, ts.
#
# Files outside .agents/state/**/events.jsonl are ignored. No relevant changes
# → exit 0 with a "no event-log changes" notice. Unresolvable refs fail closed.
#
# Usage: scripts/check-events-append-only.sh <base-ref> [head-ref]
#   head-ref defaults to HEAD.
#   e.g. scripts/check-events-append-only.sh origin/main
#
# Exit codes:
#   0 = pass (append-only, all added events well-formed — or nothing to check)
#   1 = fail (rewrite/deletion detected, malformed event, or error — fail closed)
#   2 = usage error

set -euo pipefail

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

[[ -z "$BASE_REF" ]] && {
  echo "Usage: check-events-append-only.sh <base-ref> [head-ref]"
  exit 2
}

# Fail closed on unresolvable refs — an undiffable range is ambiguity, not a pass.
git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null \
  || { echo "FAIL: base ref '${BASE_REF}' does not resolve. Failing closed."; exit 1; }
git rev-parse --verify --quiet "$HEAD_REF^{commit}" >/dev/null \
  || { echo "FAIL: head ref '${HEAD_REF}' does not resolve. Failing closed."; exit 1; }

# Event logs touched in the PR range (merge-base diff, as PR checks see it).
CHANGED=$(git diff --name-only "${BASE_REF}...${HEAD_REF}" \
  | grep -E '^\.agents/state/.+/events\.jsonl$' || true)

if [[ -z "$CHANGED" ]]; then
  echo "ok: no event-log changes in ${BASE_REF}...${HEAD_REF}"
  exit 0
fi

VIOLATIONS=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  DIFF=$(git diff "${BASE_REF}...${HEAD_REF}" -- "$file")

  # ── Append-only: no existing line may be removed or modified ────────────────
  # Hunk '-' lines (excluding the '---' file header) mean a line was deleted or
  # rewritten. The "\ No newline" marker starts with '\', so it never matches.
  REMOVED=$(printf '%s\n' "$DIFF" | grep -E '^-' | grep -Ev '^---' || true)
  if [[ -n "$REMOVED" ]]; then
    echo "FAIL: ${file} — existing event lines removed or modified (event logs are append-only):"
    printf '%s\n' "$REMOVED" | sed 's/^/  /'
    VIOLATIONS=1
  fi

  # ── Schema: every added line must be a well-formed event ────────────────────
  ADDED=$(printf '%s\n' "$DIFF" | grep -E '^\+' | grep -Ev '^\+\+\+' | sed 's/^+//' || true)
  if [[ -n "$ADDED" ]]; then
    if ! ERRORS=$(printf '%s\n' "$ADDED" | node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "");
      const required = ["feature", "type", "actor", "ts"];
      let bad = 0;
      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch {
          console.log("not valid JSON: " + line);
          bad = 1;
          continue;
        }
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
          console.log("not a JSON object: " + line);
          bad = 1;
          continue;
        }
        for (const field of required) {
          if (typeof ev[field] !== "string" || ev[field].trim() === "") {
            console.log("missing/empty required field: " + field + " -- " + line);
            bad = 1;
          }
        }
      }
      process.exit(bad);
    '); then
      echo "FAIL: ${file} — malformed added event line(s):"
      printf '%s\n' "$ERRORS" | sed 's/^/  /'
      VIOLATIONS=1
    fi
  fi
done <<< "$CHANGED"

if [[ "$VIOLATIONS" -ne 0 ]]; then
  exit 1
fi

echo "PASS: event-log changes in ${BASE_REF}...${HEAD_REF} are append-only and well-formed"
exit 0
