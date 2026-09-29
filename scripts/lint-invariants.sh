#!/usr/bin/env bash
# lint-invariants.sh
# Anchor lint over the invariant registry (docs/invariants.yaml). "Prose
# explains; facts anchor": each invariant names the code anchors that enforce
# it, and this lint checks those anchors still EXIST (file present, symbol a
# literal substring). It is a COUPLING check — it catches a claim whose anchor
# was renamed or removed — NOT behavior verification: a present anchor does not
# prove the invariant holds. READ-ONLY.
#
# Validation (harness/invariants.js validateRegistry) runs first; anchors are
# checked only when the registry is schema-valid. Anchor paths resolve relative
# to the repo root (the parent of this script's dir), or RAD_INVARIANTS_ROOT.
#
# Usage: scripts/lint-invariants.sh [--inventory] [registry]
#   default registry: <root>/docs/invariants.yaml
#   --inventory  print the bypass inventory table instead of the anchor summary
#
# Exit codes:
#   0 = clean (or inventory printed)
#   1 = one or more validation/anchor violations (each printed as "✗ <error>")
#   2 = usage error (unknown flag, extra args, missing/unreadable registry,
#       unparseable YAML, bad RAD_INVARIANTS_ROOT)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(dirname "$HERE")/harness"
ROOT="${RAD_INVARIANTS_ROOT:-$(dirname "$HERE")}"

usage() { echo "usage: scripts/lint-invariants.sh [--inventory] [registry]" >&2; exit 2; }

# Control characters in a path are never legitimate — reject before any use.
[[ "$ROOT" =~ ^[^[:cntrl:]]+$ ]] || { echo "ERROR: invalid RAD_INVARIANTS_ROOT" >&2; exit 2; }
[[ -d "$ROOT" ]] || { echo "ERROR: invariants root not a directory: $ROOT" >&2; exit 2; }

MODE="lint"
REGISTRY=""
for arg in "$@"; do
  case "$arg" in
    --inventory) MODE="inventory" ;;
    -*) echo "ERROR: unknown flag: $arg" >&2; usage ;;
    *) [[ -z "$REGISTRY" ]] || { echo "ERROR: extra argument: $arg" >&2; usage; }
       REGISTRY="$arg" ;;
  esac
done
REGISTRY="${REGISTRY:-$ROOT/docs/invariants.yaml}"
[[ "$REGISTRY" =~ ^[^[:cntrl:]]+$ ]] || { echo "ERROR: invalid registry path" >&2; exit 2; }
[[ -f "$REGISTRY" && -r "$REGISTRY" ]] || { echo "ERROR: registry not found or unreadable: $REGISTRY" >&2; exit 2; }

# All inputs reach node as argv — never interpolated into the script literal.
exec node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const [harnessDir, root, registry, mode] = process.argv.slice(1);
const inv = await import(pathToFileURL(join(harnessDir, "invariants.js")).href);
const yaml = (await import(pathToFileURL(join(harnessDir, "vendor/js-yaml.mjs")).href)).default;
let doc;
try { doc = yaml.load(readFileSync(registry, "utf8")); }
catch (e) { console.error(`ERROR: cannot parse registry ${registry}: ${e.message.split("\n")[0]}`); process.exit(2); }
const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const readFile = (p) => {
  try { return readFileSync(resolve(root, p), "utf8"); }
  catch (e) { if (MISSING.has(e.code)) return null; throw e; }
};
const fail = (errors) => { for (const e of errors) console.log(`✗ ${e}`); process.exit(1); };
const schemaErrors = inv.validateRegistry(doc);
if (schemaErrors.length) fail(schemaErrors);
if (mode === "inventory") {
  console.log("invariant | bypass | surface | guarded | note");
  for (const r of inv.bypassInventory(doc)) {
    const guarded = r.guarded === "yes" ? "guarded" : "UNGUARDED";
    console.log(`${r.invariant} | ${r.id} | ${r.surface} | ${guarded} | ${r.note ?? ""}`);
  }
  process.exit(0);
}
const anchorErrors = inv.checkAnchors(doc, readFile);
if (anchorErrors.length) fail(anchorErrors);
const hasBoth = (a) => a && typeof a.file === "string" && a.file && typeof a.symbol === "string" && a.symbol;
const anchors = doc.invariants.reduce((n, e) =>
  n + [...e.enforced_by, ...(Array.isArray(e.display_only) ? e.display_only : [])].filter(hasBoth).length, 0);
console.log(`✓ invariants: ${doc.invariants.length} entries, ${anchors} anchors resolved`);
' -- "$HARNESS_DIR" "$ROOT" "$REGISTRY" "$MODE"
