#!/usr/bin/env bash
# Example observe-only on-outcome hook shipped by presets/example.
# Contract (scripts/hooks/README.md): $1=feature $2=wave $3=point $4=outcome,
# mirrored in RAD_HOOK_FEATURE / RAD_HOOK_WAVE / RAD_HOOK_POINT / RAD_HOOK_OUTCOME.
# on-outcome is observe-only: stdout is ignored and the exit code never changes
# flow. Must stay bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail

# CUSTOMIZE: replace the echo below with your team's notification or metric.
feature="${1:-${RAD_HOOK_FEATURE:-}}"
wave="${2:-${RAD_HOOK_WAVE:-}}"
outcome="${4:-${RAD_HOOK_OUTCOME:-}}"

echo "example-preset: feature=${feature} wave=${wave} outcome=${outcome}" >&2
exit 0
