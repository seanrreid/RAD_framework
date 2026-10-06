# Example Preset Guardrail Extension

<!-- CUSTOMIZE: rename this file and replace every section with your team's rules. -->

## Applies When

- Changing infrastructure-as-code: files under `infra/` or `terraform/`, or any `*.tf` file.
- Changing a wave-lifecycle hook under `scripts/hooks/`.

## Rules

- Treat infrastructure changes as high risk: they are flagged for architect review by this preset's `high_risk_patterns`.
- Never apply infrastructure changes from a wave; plan them and leave `apply` to the operator.
- Keep observe-only hooks (`on-outcome`, `on-retry`, `on-error`, `wave-complete`) side-effect free apart from logging or notifying.
- Keep hooks bash 3.2 compatible and fail loudly on their own errors (`set -euo pipefail`).

## Verification

- Run `bash -n` on every changed hook script.
- Run the relevant infrastructure validation (for example `terraform validate`) and report the exact command.
