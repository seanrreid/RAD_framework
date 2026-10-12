# Vendored dependencies

## acorn.mjs

- **Version:** acorn 8.14.0, `dist/acorn.mjs` (self-contained ESM build, zero dependencies). Licence: `ACORN-LICENSE` (MIT).
- **Source:** the npm package `acorn@8.14.0`.
- **Used by:** `scripts/lint-function-length.mjs`, which parses the harness sources to measure function lengths.
- **Why `scripts/vendor/` and not `harness/vendor/`:** the installer copies `harness/` into target projects. A lint-only parser has no business there, so it lives under `scripts/vendor/`, a subdirectory the installer does not copy (it takes only top-level `scripts/*.sh` and `scripts/*.mjs`).
- **Do not hand-edit** — it is a verbatim copy. To regenerate after a version bump, from the repo root:

  ```bash
  tmp=$(mktemp -d) && (cd "$tmp" && npm pack acorn@<version> && tar xzf acorn-*.tgz)
  cp "$tmp/package/dist/acorn.mjs" scripts/vendor/acorn.mjs
  cp "$tmp/package/LICENSE" scripts/vendor/ACORN-LICENSE
  ```

  Then update the version above and re-run `scripts/lint-function-length.mjs --write-baseline` only if the parse results change.
