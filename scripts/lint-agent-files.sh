#!/usr/bin/env bash
# lint-agent-files.sh
# All-PR repo-convention lint over the agent definitions. READ-ONLY — reports
# drift, never rewrites anything (the Agent Scope Map is /rad-design-generated;
# reconciling drift is the architect's call).
#
# Part 1 — frontmatter lint, every <agents-dir>/*.md:
#   - must open with a `---` YAML frontmatter block containing non-empty
#     name, description, model, tools;
#   - name must equal the filename minus .md;
#   - context tools (tools drawn from {Read, Grep, Glob} — a stray Task is
#     itself a violation, not an exemption): model must start with
#     claude-haiku, must not list Task, and the description must start with
#     "MUST BE USED" or "Use PROACTIVELY".
#   - files WITHOUT a `roles:` field are RAD-external utility agents (e.g.
#     quality-reviewer): basic frontmatter is linted, but they are exempt from
#     the context-tool description/model rules and the scope-map bijection.
#
# Part 2 — scope-map sync against the `### Agent Scope Map` table in CLAUDE.md:
#   - every table row's agent name must have a matching <agents-dir>/<name>.md;
#   - every agent file WITH a roles: field must have a table row.
#
# Usage: scripts/lint-agent-files.sh [claude-md] [agents-dir]
#   defaults: CLAUDE.md  .claude/agents
#
# Exit codes:
#   0 = clean
#   1 = one or more violations (each reported with file + reason)
#   2 = usage error (CLAUDE.md or agents dir not found)

set -euo pipefail

CLAUDE_MD="${1:-CLAUDE.md}"
AGENTS_DIR="${2:-.claude/agents}"

[[ -f "$CLAUDE_MD" ]]  || { echo "ERROR: CLAUDE.md not found at: $CLAUDE_MD"; exit 2; }
[[ -d "$AGENTS_DIR" ]] || { echo "ERROR: agents dir not found at: $AGENTS_DIR"; exit 2; }

VIOLATIONS=0
violation() { echo "✗ $1: $2"; VIOLATIONS=1; }

# strip_quotes — strip ONE pair of surrounding double or single quotes from
# stdin (YAML quoted scalars, e.g. description: "MUST BE USED ...").
strip_quotes() {
  sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

# fm_field <frontmatter> <field> — print the same-line value of a field
# (trimmed, unquoted), empty if absent.
fm_field() {
  printf '%s\n' "$1" | sed -n "s/^$2:[[:space:]]*//p" | head -1 \
    | sed 's/[[:space:]]*$//' | strip_quotes
}

# fm_description <frontmatter> — print the effective description TEXT: the
# same-line value, or (for `>` / `|` block scalars) the first following
# indented non-empty line, so prefix checks see the real opening words.
fm_description() {
  printf '%s\n' "$1" | awk '
    !seen && /^description:/ {
      seen = 1
      v = $0
      sub(/^description:[[:space:]]*/, "", v)
      if (v ~ /^[>|]-?[[:space:]]*$/) { block = 1; next }
      print v
      exit
    }
    block {
      if ($0 ~ /^[[:space:]]+[^[:space:]]/) {
        sub(/^[[:space:]]+/, "")
        print
        exit
      }
      exit
    }
  ' | strip_quotes
}

# ── Part 1: frontmatter lint over every agent file ─────────────────────────────
ROLE_AGENTS=""   # newline-separated names of agent files that declare roles:

for file in "$AGENTS_DIR"/*.md; do
  [[ -e "$file" ]] || continue
  base=$(basename "$file" .md)

  if [[ "$(head -1 "$file")" != "---" ]]; then
    violation "$file" "does not open with a --- YAML frontmatter block"
    continue
  fi

  # Frontmatter body: lines between the opening --- and the next ---.
  FM=$(awk 'NR==1 { next } /^---[[:space:]]*$/ { exit } { print }' "$file")
  if ! awk 'NR==1 { next } /^---[[:space:]]*$/ { found=1; exit } END { exit !found }' "$file"; then
    violation "$file" "frontmatter block is not closed with ---"
    continue
  fi

  NAME=$(fm_field "$FM" name)
  MODEL=$(fm_field "$FM" model)
  TOOLS=$(fm_field "$FM" tools)
  DESC=$(fm_description "$FM")

  [[ -n "$NAME" ]]  || violation "$file" "frontmatter field 'name' is missing or empty"
  [[ -n "$DESC" ]]  || violation "$file" "frontmatter field 'description' is missing or empty"
  [[ -n "$MODEL" ]] || violation "$file" "frontmatter field 'model' is missing or empty"
  [[ -n "$TOOLS" ]] || violation "$file" "frontmatter field 'tools' is missing or empty"

  if [[ -n "$NAME" && "$NAME" != "$base" ]]; then
    violation "$file" "frontmatter name '$NAME' does not equal filename '$base'"
  fi

  HAS_ROLES=0
  printf '%s\n' "$FM" | grep -q '^roles:' && HAS_ROLES=1
  if [[ "$HAS_ROLES" -eq 1 ]]; then
    ROLE_AGENTS="${ROLE_AGENTS}${base}
"
  fi

  # RAD-external utility agents (no roles:) are exempt from context-tool rules.
  [[ "$HAS_ROLES" -eq 1 ]] || continue
  [[ -n "$TOOLS" ]] || continue

  # Context-tool classification: every listed tool is one of Read/Grep/Glob
  # (Task tolerated for CLASSIFICATION only — listing it is a violation, so a
  # mapper that sprouts Task cannot dodge the lint by no longer being a
  # "subset"), and at least one read tool is present (so a pure-Task
  # orchestrator is NOT a context tool).
  IS_CONTEXT=1
  HAS_READ_TOOL=0
  LISTS_TASK=0
  OLD_IFS="$IFS"; IFS=','
  for tool in $TOOLS; do
    tool=$(echo "$tool" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$tool" ]] && continue
    case "$tool" in
      Read|Grep|Glob) HAS_READ_TOOL=1 ;;
      Task)           LISTS_TASK=1 ;;
      *)              IS_CONTEXT=0 ;;
    esac
  done
  IFS="$OLD_IFS"
  [[ "$HAS_READ_TOOL" -eq 1 ]] || IS_CONTEXT=0

  if [[ "$IS_CONTEXT" -eq 1 ]]; then
    if [[ "$LISTS_TASK" -eq 1 ]]; then
      violation "$file" "context tool must not list Task in tools"
    fi
    case "$MODEL" in
      claude-haiku*) : ;;
      *) violation "$file" "context tool model '$MODEL' must start with claude-haiku" ;;
    esac
    case "$DESC" in
      "MUST BE USED"*|"Use PROACTIVELY"*) : ;;
      *) violation "$file" "context tool description must start with 'MUST BE USED' or 'Use PROACTIVELY'" ;;
    esac
  fi
done

# ── Part 2: Agent Scope Map sync (read-only — report drift, never rewrite) ─────
MAP_ROWS=$(awk '/^### Agent Scope Map/ { found=1; next } found && /^### / { exit } found && /^\|/ { print }' "$CLAUDE_MD" \
  | grep -v '^| *Agent ' | grep -v '^|[-| ]*$' \
  | awk -F'|' '{ print $2 }' \
  | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
  | grep -v '^$' || true)

# Every table row must have a matching agent file.
if [[ -n "$MAP_ROWS" ]]; then
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    if [[ ! -f "$AGENTS_DIR/$row.md" ]]; then
      violation "$CLAUDE_MD" "Agent Scope Map row '$row' has no matching $AGENTS_DIR/$row.md"
    fi
  done <<< "$MAP_ROWS"
fi

# Every roles-declaring agent file must have a table row.
if [[ -n "$ROLE_AGENTS" ]]; then
  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    if ! printf '%s\n' "$MAP_ROWS" | grep -qx "$agent"; then
      violation "$AGENTS_DIR/$agent.md" "declares roles: but has no Agent Scope Map row in $CLAUDE_MD"
    fi
  done <<< "$ROLE_AGENTS"
fi

if [[ "$VIOLATIONS" -ne 0 ]]; then
  exit 1
fi

echo "PASS: agent files and Agent Scope Map are in sync"
exit 0
