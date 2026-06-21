# Vendored dependencies

## js-yaml.mjs

- **Source:** js-yaml 4.1.1, `dist/js-yaml.mjs` (the self-contained ESM build, zero transitive deps).
- **Why vendored:** lets the harness load YAML without a runtime `dependencies` install.
- **Do not hand-edit** — it is a verbatim copy. To regenerate after a version bump:

  ```bash
  cp node_modules/js-yaml/dist/js-yaml.mjs vendor/js-yaml.mjs
  ```

  Run from the `harness/` directory.
