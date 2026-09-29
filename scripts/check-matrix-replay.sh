#!/usr/bin/env bash
# check-matrix-replay.sh
# Advisory replay of recorded decisions under a table change. Re-derives every
# matrix decision (wave-attempt outcome → action) and gate decision (at each
# deliver-started) found in the repo's event logs twice — once under the BASE
# harness/matrix.yaml + harness/gates.yaml, once under the working-tree
# (proposed) tables — and prints every decision the edit would change.
#
# Event logs replayed: every branch tip under refs/remotes/origin/<prefix>
# (RAD_BRANCH_PREFIX, default rad/) that carries .agents/state/<f>/events.jsonl,
# then every working-tree .agents/state/*/events.jsonl for a feature not already
# collected (the branch tip is preferred). Local refs only — no fetch here; CI
# fetches before calling.
#
# Advisory: a divergence never fails the check. It is a prompt to review.
#
# Usage: scripts/check-matrix-replay.sh [--base <ref>]   (run from the repo root)
#   --base <ref>  table baseline (default: git merge-base HEAD origin/<default>)
#
# Exit codes:
#   0 = report printed (including when divergences were found)
#   1 = mechanical failure (unresolvable ref, unreadable/unparseable table or log)
#   2 = usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_REL_DIR=".agents/state"
LOG_NAME="events.jsonl"
MATRIX_REL="harness/matrix.yaml"
GATES_REL="harness/gates.yaml"
REF_PATTERN='^[A-Za-z0-9._/@^~-]+$'
PREFIX_PATTERN='^[A-Za-z0-9._/-]+$'
FEATURE_PATTERN='^[A-Za-z0-9._-]+$'

usage() {
  echo "Usage: check-matrix-replay.sh [--base <ref>]" >&2
  exit 2
}

BASE_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      [[ $# -ge 2 ]] || usage
      BASE_ARG="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [[ -n "$BASE_ARG" ]]; then
  if [[ ! "$BASE_ARG" =~ $REF_PATTERN ]] || [[ "$BASE_ARG" == -* ]]; then
    echo "error: invalid --base ref: $BASE_ARG" >&2
    exit 2
  fi
fi

PREFIX="${RAD_BRANCH_PREFIX:-rad/}"
if [[ ! "$PREFIX" =~ $PREFIX_PATTERN ]] || [[ "$PREFIX" == -* ]]; then
  echo "error: invalid RAD_BRANCH_PREFIX: $PREFIX" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ── Resolve the base ref ──────────────────────────────────────────────────────
if [[ -n "$BASE_ARG" ]]; then
  BASE_REF="$BASE_ARG"
else
  DEFAULT_BRANCH="$("$SCRIPT_DIR/get-default-branch.sh")"
  if ! BASE_REF="$(git merge-base HEAD "origin/${DEFAULT_BRANCH}" 2>/dev/null)"; then
    echo "error: cannot resolve base ref: no merge-base of HEAD and origin/${DEFAULT_BRANCH}" >&2
    exit 1
  fi
fi
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "error: cannot resolve base ref: ${BASE_REF}" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/base" "$TMP/logs"

for rel in "$MATRIX_REL" "$GATES_REL"; do
  if ! git show "${BASE_REF}:${rel}" > "$TMP/base/${rel##*/}"; then
    echo "error: cannot read ${rel} at base ${BASE_REF}" >&2
    exit 1
  fi
done

# ── Collect event logs: branch tips first, then working tree ──────────────────
REMOTE_ROOT="refs/remotes/origin/"
while IFS= read -r ref; do
  name="${ref#"$REMOTE_ROOT"}"
  [[ "$name" == "$PREFIX"* ]] || continue
  feature="${name#"$PREFIX"}"
  [[ "$feature" =~ $FEATURE_PATTERN ]] || continue
  spec="${ref}:${LOG_REL_DIR}/${feature}/${LOG_NAME}"
  # Absence is expected (a branch without a log yet); a probe miss is not an error.
  git cat-file -e "$spec" 2>/dev/null || continue
  if ! git show "$spec" > "$TMP/logs/${feature}.jsonl"; then
    echo "error: cannot read branch-tip event log for ${feature} (${ref})" >&2
    exit 1
  fi
done < <(git for-each-ref --format='%(refname)' "$REMOTE_ROOT")

for log in "$LOG_REL_DIR"/*/"$LOG_NAME"; do
  [[ -f "$log" ]] || continue
  feature="${log#"$LOG_REL_DIR"/}"
  feature="${feature%/"$LOG_NAME"}"
  [[ "$feature" =~ $FEATURE_PATTERN ]] || continue
  [[ -e "$TMP/logs/${feature}.jsonl" ]] && continue
  cp "$log" "$TMP/logs/${feature}.jsonl"
done

# ── Replay under both table pairs and diff (fixed script; paths as argv) ──────
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, tmp] = process.argv.slice(1);
const harness = (m) => import(pathToFileURL(join(repoRoot, "harness", m)).href);
const { loadMatrix } = await harness("matrix.js");
const { loadGates } = await harness("gates.js");
const { replayDecisions, diffDecisions, gateNameUnion } = await harness("replay.js");

function die(msg) { console.log(`error: ${msg}`); process.exit(1); }
function load(fn, path, which) {
  try { return fn(path); } catch (err) { die(`unparseable ${which} table: ${err.message}`); }
}

const bm = load(loadMatrix, join(tmp, "base", "matrix.yaml"), "base matrix");
const bg = load(loadGates, join(tmp, "base", "gates.yaml"), "base gates");
const pm = load(loadMatrix, join(repoRoot, "harness", "matrix.yaml"), "proposed matrix");
const pg = load(loadGates, join(repoRoot, "harness", "gates.yaml"), "proposed gates");
const names = gateNameUnion(bg, pg);

const files = readdirSync(join(tmp, "logs")).filter((f) => f.endsWith(".jsonl")).sort();
if (files.length === 0) { console.log("no history to replay"); process.exit(0); }

let total = 0;
for (const file of files) {
  const feature = file.slice(0, -".jsonl".length);
  let history;
  try {
    history = readFileSync(join(tmp, "logs", file), "utf8")
      .split("\n").filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l))
      .map((e) => (e && typeof e === "object" && !Array.isArray(e) && e.feature == null ? { ...e, feature } : e));
  } catch (err) {
    die(`malformed event log for ${feature}: ${err.message}`);
  }
  const base = replayDecisions(history, { matrix: bm, gates: bg, gateNames: names });
  const prop = replayDecisions(history, { matrix: pm, gates: pg, gateNames: names });
  for (const d of diffDecisions(base, prop)) {
    console.log(`divergence: ${d.feature} ${d.kind} #${d.index} ${d.detail}: ${d.base} → ${d.proposed}`);
    total += 1;
  }
}
const k = files.length;
console.log(total === 0
  ? `no divergences across ${k} feature(s)`
  : `${total} divergence(s) across ${k} feature(s) — advisory; review before merging`);
' -- "$REPO_ROOT" "$TMP"
