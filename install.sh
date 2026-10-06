#!/usr/bin/env bash
# install.sh
# Installs or upgrades the RAD framework into a target project.
#
# Usage:
#   ./install.sh                        # interactive — prompts for target directory
#   ./install.sh --dir /path/to/project # non-interactive target
#   ./install.sh --upgrade              # update commands + skills + scripts, skip user data
#   ./install.sh --yes                  # accept all defaults without prompting
#   ./install.sh --architect <id>       # architect for .rad/config.yml (default: git user.email)
#   ./install.sh --preset <dir>         # apply a team preset (files + settings), with or without --upgrade
#
# Fresh install writes .rad/config.yml via `harness/cli.js config init`; upgrade
# migrates it from a pre-#87 CLAUDE.md via `config migrate` when it is absent.
# An existing .rad/config.yml is never touched. If the config cannot be created,
# every other file is still installed and the installer exits 1.
#
# Conventions: the AGENTS.md (conventions) and CLAUDE.md (`@AGENTS.md` import)
# templates are copied only into absent paths, on install and upgrade alike. A
# target with only its own CLAUDE.md keeps it as the conventions file (readers
# fall back to it) and gets a hint pointing at UPGRADE.md's manual move.
#
# On upgrade, AGENTS.md, CLAUDE.md, .rad/config.yml, .claude/agents/, and
# .agents/ content are never overwritten. Framework files are installed through the manifest at
# .rad/installed.json: a locally edited framework file is kept (its update is
# staged under .rad/upgrade-pending/) and the installer exits 1; with no
# manifest, a differing file is backed up under .rad/upgrade-backup/ first.
# A malformed manifest stops the install before any framework file is written.
#
# Presets: after the config step, --preset <dir> runs `install-preset --source`;
# a plain --upgrade re-applies the recorded preset (`install-preset --reapply`).
# A preset never removes or reverts the core install: a kept/deleted preset
# file or an unseeded setting, or a preset that could not be applied at all,
# makes the installer exit 1 after every other step has run. With no config,
# the preset step is skipped (a preset needs .rad/config.yml).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAD_DIR="$SCRIPT_DIR"

TARGET_DIR=""
UPGRADE=false
YES=false
ARCHITECT=""
PLATFORM="manual"
CONFIG_FAILED=false
# Set by install_core when install-core kept a locally edited file; main exits 1
# after every other step has run.
CORE_KEPT=false
# Whether the target had its own CLAUDE.md before scaffold_conventions ran: an
# upgrade must migrate only from the user's file, never from the RAD template.
CLAUDE_MD_PREEXISTED=false
# Absolute path of the --preset directory; empty when the flag was not given.
PRESET=""
# Set by install_preset: INCOMPLETE on install-preset exit 1 (kept/deleted file
# or unseeded setting), FAILED on exit 2 (nothing written). main exits 1.
PRESET_INCOMPLETE=false
PRESET_FAILED=false
# First line of the install-preset output when it failed (exit 2), for main's summary.
PRESET_FAILURE_REASON=""

readonly USAGE="Usage: ./install.sh [--dir <path>] [--upgrade] [--yes] [--architect <id>] [--preset <dir>]"
readonly RAD_CONFIG=".rad/config.yml"
readonly FALLBACK_DEFAULT_BRANCH="main"
readonly CONVENTIONS_MOVE_HINT='Conventions stay in CLAUDE.md (read as the fallback). To move them to AGENTS.md, see UPGRADE.md "Moving conventions to AGENTS.md".'

# ── Output helpers ────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "  ${GREEN}→${NC} $*"; }
warn()    { echo -e "  ${YELLOW}!${NC} $*"; }
error()   { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }
success() { echo -e "  ${GREEN}✓${NC} $*"; }
header()  { echo ""; echo "$*"; echo "$(echo "$*" | sed 's/./-/g')"; }

# ── Argument parsing ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)     TARGET_DIR="$2"; shift 2 ;;
    --upgrade) UPGRADE=true;    shift   ;;
    --yes|-y)  YES=true;        shift   ;;
    --architect)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || error "--architect requires a value. $USAGE"
      ARCHITECT="$2"; shift 2 ;;
    --preset)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || error "--preset requires a directory. $USAGE"
      [[ -d "$2" ]] || error "--preset must name an existing directory, got: '$2'. $USAGE"
      PRESET="$(CDPATH='' cd -- "$2" && pwd)"; shift 2 ;;
    *) error "Unknown option: $1. $USAGE" ;;
  esac
done

# The architect id is handed to node as one argv element (never interpolated
# into code), but reject anything that could be read as a flag or is multi-line.
if [[ -n "$ARCHITECT" ]] && ! [[ "$ARCHITECT" =~ ^[^-[:space:]][^[:space:]]*$ ]]; then
  error "--architect must be a single non-flag token, got: '$ARCHITECT'. $USAGE"
fi

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_prereqs() {
  header "Checking prerequisites"

  command -v git >/dev/null 2>&1 \
    && success "git $(git --version | awk '{print $3}')" \
    || error "git is required but not installed"

  # node runs harness/cli.js, which lays down every framework file.
  command -v node >/dev/null 2>&1 \
    && success "node $(node --version)" \
    || error "node is required but not installed (install Node.js from https://nodejs.org)"

  if command -v claude >/dev/null 2>&1; then
    success "claude CLI found"
  else
    warn "claude CLI not found — install from https://claude.ai/code before using RAD"
  fi

  if command -v gh >/dev/null 2>&1; then
    success "gh (GitHub CLI) found"
  elif command -v glab >/dev/null 2>&1; then
    success "glab (GitLab CLI) found"
  else
    warn "No git platform CLI found — install gh or glab to enable PR automation"
    warn "RAD will fall back to manual mode (scripts print instructions instead)"
  fi
}

# ── Target directory ──────────────────────────────────────────────────────────

get_target() {
  if [[ -n "$TARGET_DIR" ]]; then
    return
  fi

  if [[ "$YES" == "true" ]]; then
    TARGET_DIR="$(pwd)"
    return
  fi

  echo ""
  echo "  Target directory for installation:"
  echo "  (press Enter to use current directory)"
  read -rp "  > [$(pwd)]: " input
  TARGET_DIR="${input:-$(pwd)}"
}

validate_target() {
  [[ -d "$TARGET_DIR" ]] \
    || error "Directory does not exist: $TARGET_DIR"

  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

  [[ -d "$TARGET_DIR/.git" ]] \
    || error "$TARGET_DIR is not a git repository. Run 'git init' first."

  [[ "$TARGET_DIR" != "$RAD_DIR" ]] \
    || error "Target cannot be the RAD framework directory itself."
}

# ── Installation steps ────────────────────────────────────────────────────────

create_dirs() {
  header "Creating directory structure"

  local dirs=(
    ".claude/commands"
    ".claude/skills"
    ".claude/agents"
    ".agents/research"
    ".agents/architecture"
    ".agents/plans"
    ".agents/logs"
    ".agents/findings"
    "scripts"
  )

  for dir in "${dirs[@]}"; do
    mkdir -p "$TARGET_DIR/$dir"
  done

  success "Directory structure ready"
}

# The rpi-design skill was retired (absorbed into /rad-research + /rad-design).
# `cp -r` never deletes, so an upgrade must remove the stale copy explicitly.
# Exact relative path only — never a glob.
STALE_SKILL_RPI_DESIGN=".claude/skills/rpi-design"

remove_stale_skills() {
  # An empty TARGET_DIR would turn "$TARGET_DIR/.claude/..." into an absolute
  # path under /, so refuse rather than guess.
  [[ -n "$TARGET_DIR" ]] || error "remove_stale_skills: TARGET_DIR is empty — refusing to remove anything"

  if [[ -e "$TARGET_DIR/$STALE_SKILL_RPI_DESIGN" ]]; then
    rm -rf "$TARGET_DIR/$STALE_SKILL_RPI_DESIGN"
    info "removed stale skill: rpi-design"
  fi
}

# Exit codes of `harness/cli.js install-core` (see harness/install-manifest.js).
readonly CORE_EXIT_WRITTEN=0
readonly CORE_EXIT_KEPT=1

# Installs the framework core (.claude/commands, .claude/skills, ai/, scripts,
# scripts/lib, scripts/hooks, harness/ minus node_modules) through the install
# manifest. Locally edited files are kept, never overwritten (exit 1 sets
# CORE_KEPT so main exits 1 after every other step); any other non-zero exit
# (bad argv, malformed .rad/installed.json) stops the install fail-closed.
install_core() {
  header "Installing framework core"

  local out rc
  if out=$(node "$RAD_DIR/harness/cli.js" install-core --source "$RAD_DIR" --target "$TARGET_DIR" 2>&1); then
    rc=$CORE_EXIT_WRITTEN
  else
    rc=$?
  fi
  case "$rc" in
    "$CORE_EXIT_WRITTEN")
      printf '%s\n' "$out" | sed 's/^/    /'
      success "Framework core installed (manifest: .rad/installed.json)" ;;
    "$CORE_EXIT_KEPT")
      printf '%s\n' "$out" | sed 's/^/    /'
      CORE_KEPT=true
      warn "Locally edited framework files were kept; their updates are staged under .rad/upgrade-pending/" ;;
    *) error "install-core failed (exit $rc), no framework files installed: $out" ;;
  esac

  info "commands: architect/ rad-design, rad-approve, rad-epic-decompose"
  info "          team/ rad-research, rad-plan, rad-adopt, rad-deliver, rad-review"
  info "          shared/ rad-status, rad-insights"
  info "skills:   kickoff (/kickoff session start), wrap (/wrap session end)"
  info "ai/guardrails.md     - baseline coding-agent rules"
  info "ai/slop-register.md  - project-specific overrides (customize for your stack)"
  info "ai/extensions/       - domain extensions: backend, database, frontend, security, testing"
  info "scripts/             - includes get-default-branch.sh, checkout-plan.sh, rad-label.sh, lib/"
  info "harness/cli.js       - zero-npm rad CLI (vendored js-yaml, lazy SDK)"
  info "scripts/hooks/       - pre/post-wave + on-outcome lifecycle hook dirs"
}

# Exit codes of `harness/cli.js install-preset` (see harness/cli.js).
readonly PRESET_EXIT_APPLIED=0
readonly PRESET_EXIT_INCOMPLETE=1

# Applies --preset, or on a plain --upgrade re-applies the recorded preset,
# through the source clone's CLI (same version as the core just installed).
# Never fails the run here: outcomes set PRESET_INCOMPLETE / PRESET_FAILED and
# main exits 1 after every other step. Skipped when the config step failed.
install_preset() {
  if [[ -z "$PRESET" && "$UPGRADE" != "true" ]]; then return; fi
  header "Preset"

  if [[ "$CONFIG_FAILED" == "true" ]]; then
    warn "Preset step skipped: a preset needs $RAD_CONFIG, which was not created"
    return
  fi

  local mode out rc
  if [[ -n "$PRESET" ]]; then mode="--source"; else mode="--reapply"; fi
  if out=$(run_install_preset "$mode" 2>&1); then rc=$PRESET_EXIT_APPLIED; else rc=$?; fi
  printf '%s\n' "$out" | sed 's/^/    /'
  case "$rc" in
    "$PRESET_EXIT_APPLIED") success "Preset step complete" ;;
    "$PRESET_EXIT_INCOMPLETE")
      PRESET_INCOMPLETE=true
      warn "Preset applied incompletely: some preset files or settings were not written" ;;
    *)
      PRESET_FAILED=true
      PRESET_FAILURE_REASON="$(printf '%s\n' "$out" | head -n 1)"
      warn "Preset not applied (install-preset exit $rc); the core install is unaffected" ;;
  esac
}

# run_install_preset <--source|--reapply> -> runs install-preset, passing its exit code.
run_install_preset() {
  if [[ "$1" == "--source" ]]; then
    node "$RAD_DIR/harness/cli.js" install-preset --source "$PRESET" --target "$TARGET_DIR"
  else
    node "$RAD_DIR/harness/cli.js" install-preset --reapply --target "$TARGET_DIR"
  fi
}

copy_agents_meta() {
  header "Setting up .agents/ structure"

  # Copy READMEs only — never overwrite user data
  local subdirs=(research architecture plans logs findings)
  for dir in "${subdirs[@]}"; do
    local src="$RAD_DIR/.agents/$dir/README.md"
    local dst="$TARGET_DIR/.agents/$dir/README.md"
    if [[ -f "$src" && ! -f "$dst" ]]; then
      cp "$src" "$dst"
    fi
  done

  # Create empty findings log if missing
  if [[ ! -f "$TARGET_DIR/.agents/findings.jsonl" ]]; then
    touch "$TARGET_DIR/.agents/findings.jsonl"
  fi

  success ".agents/ structure ready"
}

# Copies the AGENTS.md and CLAUDE.md templates into absent paths only; an
# existing file is never edited or overwritten. A CLAUDE.md-only target keeps
# its file as the conventions source and gets CONVENTIONS_MOVE_HINT instead.
scaffold_conventions() {
  header "AGENTS.md + CLAUDE.md"

  local has_agents=false has_claude=false
  if [[ -f "$TARGET_DIR/AGENTS.md" ]]; then has_agents=true; fi
  if [[ -f "$TARGET_DIR/CLAUDE.md" ]]; then has_claude=true; fi

  if [[ "$has_claude" == "true" ]]; then
    if [[ "$has_agents" == "true" ]]; then
      warn "AGENTS.md and CLAUDE.md already exist — skipping"
      return
    fi
    warn "CLAUDE.md already exists — skipping AGENTS.md and CLAUDE.md"
    if [[ "$UPGRADE" != "true" ]]; then
      warn "RAD settings live in .rad/config.yml, not CLAUDE.md. See AGENTS.md and CLAUDE.md in the RAD repo for the templates."
    fi
    info "$CONVENTIONS_MOVE_HINT"
    return
  fi

  if [[ "$has_agents" == "true" ]]; then
    warn "AGENTS.md already exists — kept"
  else
    cp "$RAD_DIR/AGENTS.md" "$TARGET_DIR/AGENTS.md"
    success "AGENTS.md created from template"
  fi
  cp "$RAD_DIR/CLAUDE.md" "$TARGET_DIR/CLAUDE.md"
  success "CLAUDE.md created from template (imports AGENTS.md)"
  info "Fill in AGENTS.md before running /rad-research"
}

# Sets PLATFORM (one of the valid platforms; `manual` when detection is unusable).
detect_and_report_platform() {
  header "Platform detection"

  local platform
  platform=$(cd "$TARGET_DIR" && bash scripts/detect-platform.sh --quiet 2>/dev/null | tail -n 1) \
    || platform="unknown"

  case "$platform" in
    github)    PLATFORM="github";    success "Detected: GitHub" ;;
    gitlab)    PLATFORM="gitlab";    success "Detected: GitLab" ;;
    bitbucket) PLATFORM="bitbucket"; success "Detected: Bitbucket (manual PR mode)" ;;
    forgejo)   PLATFORM="forgejo";   success "Detected: Forgejo/Gitea" ;;
    manual)    PLATFORM="manual";    warn "Could not detect platform — set it manually in $RAD_CONFIG" ;;
    *)         PLATFORM="manual";    warn "Platform detection failed — set it manually in $RAD_CONFIG" ;;
  esac
}

# origin/HEAD's branch with the `origin/` prefix stripped; FALLBACK_DEFAULT_BRANCH when absent.
target_default_branch() {
  local ref
  ref=$(cd "$TARGET_DIR" && git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || ref=""
  ref="${ref#origin/}"
  echo "${ref:-$FALLBACK_DEFAULT_BRANCH}"
}

# Reports a config failure: the CLI's reason, the exact command to run, and the
# CONFIG_FAILED flag that makes main exit 1 after every file is laid down.
report_config_failure() {
  local reason="$1" command="$2"
  CONFIG_FAILED=true
  warn "Could not create $RAD_CONFIG:"
  printf '%s\n' "$reason" | sed 's/^/      /' >&2
  warn "Run this in $TARGET_DIR to finish setup:"
  warn "  $command"
}

config_init() {
  local args=(config init --platform "$PLATFORM" --default-branch "$(target_default_branch)")
  [[ -n "$ARCHITECT" ]] && args+=(--architect "$ARCHITECT")

  local out
  if out=$(cd "$TARGET_DIR" && node harness/cli.js "${args[@]}" 2>&1); then
    success "$out"
    info "Architect: $(printf '%s' "$out" | sed -n 's/.*architect=\([^,]*\),.*/\1/p')"
    info "Review $RAD_CONFIG (roles, platform, default_branch) before your first plan"
  else
    report_config_failure "$out" "node harness/cli.js config init --architect <you@example.com>"
  fi
}

config_migrate() {
  if [[ "$CLAUDE_MD_PREEXISTED" != "true" ]]; then
    report_config_failure "no $RAD_CONFIG and no CLAUDE.md to migrate from" \
      "node harness/cli.js config init --architect <you@example.com>"
    return
  fi

  local out
  if out=$(cd "$TARGET_DIR" && node harness/cli.js config migrate 2>&1); then
    printf '%s\n' "$out" | sed 's/^/    /'
    success "Migrated $RAD_CONFIG from CLAUDE.md (CLAUDE.md was not modified)"
    warn "Remove the RAD Configuration block from CLAUDE.md"
  else
    report_config_failure "$out" "node harness/cli.js config migrate"
  fi
}

setup_rad_config() {
  header "RAD config ($RAD_CONFIG)"

  if [[ -f "$TARGET_DIR/$RAD_CONFIG" ]]; then
    success "$RAD_CONFIG already exists — kept"
    return
  fi

  if [[ "$UPGRADE" == "true" ]]; then
    config_migrate
  else
    config_init
  fi
}

# ── Deliver-PR label ──────────────────────────────────────────────────────────

ensure_deliver_label() {
  header "Deliver-PR label"

  # Best-effort: create the rad:deliver label up front so the first /rad-deliver
  # PR doesn't fail with "label not found". No-op when gh is unavailable or
  # unauthenticated (the printed next-steps cover the manual case).
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    warn "gh unavailable — create the 'rad:deliver' label manually (see next steps)"
    return
  fi

  # Idempotent: `gh label create` exits non-zero if the label already exists, which
  # is fine — either outcome leaves the label present, and neither fails the install.
  if (cd "$TARGET_DIR" && gh label create rad:deliver --color 0e8a16 \
        --description "RAD delivery PR" >/dev/null 2>&1); then
    success "Created label 'rad:deliver'"
  else
    # Non-zero almost always means "label already exists" (idempotent re-run); it
    # could also be a permissions issue. Either way the install proceeds; the
    # next-steps section repeats the manual `gh label create` command.
    info "Label 'rad:deliver' already exists (or needs manual creation — see step 2 below)"
  fi
}

# ── Next steps ────────────────────────────────────────────────────────────────

print_next_steps() {
  echo ""
  echo "┌──────────────────────────────────────────────────────────────────┐"
  if [[ "$UPGRADE" == "true" ]]; then
    echo "│  RAD upgraded in $TARGET_DIR"
  else
    echo "│  RAD installed in $TARGET_DIR"
  fi
  echo "└──────────────────────────────────────────────────────────────────┘"
  echo ""

  if [[ "$UPGRADE" == "true" ]]; then
    echo "  Commands and scripts are up to date, except locally edited framework files:"
    echo "  those were kept, with their updates staged under .rad/upgrade-pending/."
    echo "  CLAUDE.md, .rad/config.yml, .claude/agents/, and .agents/ content were not changed."
    echo ""
    echo "  Run /rad-status in Claude Code to verify everything looks right."
    echo ""
    return
  fi

  echo "  Next steps:"
  echo ""
  echo "  1. Review $RAD_CONFIG and fill in CLAUDE.md"
  echo "     Check roles, platform, and default_branch in $TARGET_DIR/$RAD_CONFIG."
  echo "     Open $TARGET_DIR/CLAUDE.md and complete the project and conventions sections."
  echo ""
  echo "  2. Create the deliver-PR label (GitHub example)"
  echo "     gh label create 'rad:deliver' --color '0e8a16' --description 'RAD delivery PR'"
  echo "     (rad:<status> labels are auto-created on first use by scripts/rad-label.sh)"
  echo ""
  echo "  3. Commit the RAD files"
  echo "     git add .claude/ .agents/ .rad/ scripts/ harness/ ai/ CLAUDE.md"
  echo "     git commit -m 'chore: install RAD framework'"
  echo ""
  echo "  4. Start the architecture process"
  echo "     Open Claude Code in $TARGET_DIR and run:"
  echo "     /rad-research path/to/your-prd.md"
  echo ""
  echo "  See docs/daily-workflow.md for the full guide."
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "RAD Framework — $(if [[ "$UPGRADE" == "true" ]]; then echo "Upgrade"; else echo "Install"; fi)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  check_prereqs
  get_target
  validate_target

  echo ""
  if [[ "$UPGRADE" == "true" ]]; then
    info "Upgrading RAD in: $TARGET_DIR"
    info "User data (AGENTS.md, CLAUDE.md, .rad/config.yml, .claude/agents/, .agents/) will not be changed"
    info "Locally edited framework files are kept; updates are staged in .rad/upgrade-pending/"
  else
    info "Installing RAD into: $TARGET_DIR"
  fi

  create_dirs
  install_core
  if [[ "$UPGRADE" == "true" ]]; then remove_stale_skills; fi
  copy_agents_meta
  if [[ -f "$TARGET_DIR/CLAUDE.md" ]]; then CLAUDE_MD_PREEXISTED=true; fi
  scaffold_conventions
  detect_and_report_platform
  setup_rad_config
  install_preset
  ensure_deliver_label
  print_next_steps
  exit_on_incomplete
}

# Reports every incomplete step, then exits 1 if there was any. Each step has
# already run, so the core install is never reverted by a later failure.
exit_on_incomplete() {
  local incomplete=false
  if [[ "$CONFIG_FAILED" == "true" ]]; then
    echo -e "  ${RED}✗${NC} Installed, but $RAD_CONFIG was not created — run the command above, then re-check with: node harness/cli.js config validate" >&2
    incomplete=true
  fi
  if [[ "$CORE_KEPT" == "true" ]]; then
    echo -e "  ${RED}✗${NC} Installed, but locally edited framework files were kept — review them with: node harness/cli.js install-status, and merge the staged copies under .rad/upgrade-pending/" >&2
    incomplete=true
  fi
  if [[ "$PRESET_INCOMPLETE" == "true" ]]; then
    echo -e "  ${RED}✗${NC} Installed, but the preset was applied incompletely — review it with: node harness/cli.js install-status, and the staged copies under .rad/upgrade-pending/" >&2
    incomplete=true
  fi
  if [[ "$PRESET_FAILED" == "true" ]]; then
    echo -e "  ${RED}✗${NC} Installed, but the preset was not applied: $PRESET_FAILURE_REASON" >&2
    incomplete=true
  fi
  if [[ "$incomplete" == "true" ]]; then exit 1; fi
}

main
