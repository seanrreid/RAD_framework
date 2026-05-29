# Platform Support

RAD works with any git platform. GitHub is the default with full CLI automation.
Other platforms degrade gracefully to manual mode.

RAD opens exactly one PR per feature: the **deliver PR**, created by
`open-pr.sh` from the feature's `rad/[feature]` work branch to the default
branch. There is no plan PR — `/rad-approve` records `Status: approved` on the
`rad/` branch tip, and `check-plan-approved.sh` reads that approval directly
with `git show`, so the approval check is platform-agnostic and needs no
`gh`/`glab` PR-merge lookup.

---

## Supported platforms

"PR automation" below refers to the deliver PR — the only PR in the flow.
The approval check is platform-agnostic everywhere: `check-plan-approved.sh`
reads `Status: approved` from the `rad/` branch tip with `git show`.

| Platform | Deliver PR automation | Approval check | Status |
|----------|----------------------|----------------|--------|
| GitHub | ✅ Full (`gh` CLI) | ✅ `git show` on branch tip | Default |
| GitLab | ✅ Full (`glab` CLI) | ✅ `git show` on branch tip | Supported |
| Bitbucket | ⚠️ Manual instructions | ✅ `git show` on branch tip | Partial |
| Forgejo / Gitea | ⚠️ `tea` CLI if available | ✅ `git show` on branch tip | Partial |
| Self-hosted GitLab | ✅ Full (`glab` CLI) | ✅ `git show` on branch tip | Supported |
| Any other | ⚠️ Manual instructions | ✅ `git show` on branch tip | Manual |

---

## GitHub (default)

### Prerequisites

```bash
# Install gh CLI
# macOS
brew install gh

# Linux
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt update && sudo apt install gh

# Authenticate
gh auth login
```

### Labels setup

Create these labels in your repo before first use. The deliver PR carries
`rad:deliver`; the `rad:` status labels mirror the plan doc's `Status:` and are
applied best-effort by `scripts/rad-label.sh` (a no-op when `gh` is absent):
```bash
gh label create "rad:deliver" --color "0e8a16" --description "RAD delivery PR"
gh label create "rad:draft" --color "ededed" --description "Plan is a draft"
gh label create "rad:pending-review" --color "e4e669" --description "Plan awaiting review"
gh label create "rad:needs-revision" --color "d93f0b" --description "Plan needs revision"
gh label create "rad:rejected" --color "b60205" --description "Plan rejected"
gh label create "rad:approved" --color "0e8a16" --description "Plan approved"
gh label create "rad:in-progress" --color "1d76db" --description "Delivery in progress"
gh label create "rad:review" --color "fbca04" --description "Deliver PR in review"
gh label create "rad:done" --color "5319e7" --description "Feature delivered"
```

### Branch protection (recommended)

Protect your default branch to enforce the gatekeeper role. Lane B keeps the
plan and its approval entirely on the feature's `rad/[feature]` branch, so the
only thing that ever merges to the protected default branch is the reviewed
deliver PR — contributors never push directly to it:
```bash
# Require PR reviews before merging (the deliver PR)
# Require status checks to pass
# Restrict who can push directly to the default branch (architect only)
DEFAULT_BRANCH=$(scripts/get-default-branch.sh)
gh api "repos/:owner/:repo/branches/$DEFAULT_BRANCH/protection" \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field enforce_admins=false
```

---

## GitLab

### Prerequisites

```bash
# Install glab CLI
# macOS
brew install glab

# Linux
curl -sL https://packages.gitlab.com/cli/glab/gpgkey | sudo apt-key add -
# See https://gitlab.com/gitlab-org/cli for full install instructions

# Authenticate
glab auth login
```

### Labels setup

```bash
glab label create "rad:deliver" --color "#0e8a16" --description "RAD delivery MR"
glab label create "rad:draft" --color "#ededed" --description "Plan is a draft"
glab label create "rad:pending-review" --color "#e4e669" --description "Plan awaiting review"
glab label create "rad:needs-revision" --color "#d93f0b" --description "Plan needs revision"
glab label create "rad:rejected" --color "#b60205" --description "Plan rejected"
glab label create "rad:approved" --color "#0e8a16" --description "Plan approved"
glab label create "rad:in-progress" --color "#1d76db" --description "Delivery in progress"
glab label create "rad:review" --color "#fbca04" --description "Deliver MR in review"
glab label create "rad:done" --color "#5319e7" --description "Feature delivered"
```

### Self-hosted GitLab

```bash
# Point glab at your instance
glab config set host git.yourcompany.com

# Authenticate
glab auth login --hostname git.yourcompany.com
```

---

## Bitbucket

Bitbucket's CLI (`bb`) has limited functionality. RAD uses manual mode for Bitbucket.

When `/rad-deliver` completes, it will output:
```
┌─────────────────────────────────────────────────────┐
│  Manual PR Creation Required                        │
└─────────────────────────────────────────────────────┘

Branch pushed: rad/feature-name
Target:        <default branch>

Title: Deliver: Feature Name

Open a PR at: https://bitbucket.org/your-org/your-repo/pull-requests/new?source=rad/feature-name

After creating the PR, paste the URL here so it can be
recorded in the plan file.
```

The approval check (Gate 1) needs no PR on any platform:
`check-plan-approved.sh` runs `git show` against the `rad/` branch tip to read
the plan doc's `Status: approved`. Only the deliver PR (Gate 2) requires the
manual creation step above.

---

## Forgejo / Gitea

```bash
# Install tea CLI
# See https://gitea.com/gitea/tea for your Gitea/Forgejo instance

# Configure
tea login add --url https://your-forgejo-instance.com --token your-token
```

If `tea` is not available, falls back to manual mode.

---

## Manual mode

Set `platform: manual` in `CLAUDE.md` to always use manual mode, regardless
of what platform is detected.

Manual mode:
- `/rad-deliver` prints deliver-PR creation instructions instead of opening
  the PR (this is the only PR in the flow)
- After you manually create the deliver PR, paste the URL and it's recorded
  in the plan
- `check-plan-approved.sh` reads `Status: approved` from the `rad/` branch tip
  with `git show` — the same platform-agnostic check used everywhere
- All other RAD functionality works identically

Manual mode is useful for:
- Air-gapped environments
- Platforms not listed here
- Teams that prefer not to install platform CLIs
- CI/CD environments where CLI auth is complex

---

## Configuring platform in CLAUDE.md

```
## RAD Configuration

### Git Platform

platform: github        # github | gitlab | bitbucket | forgejo | manual
default_branch: main
```

Override auto-detection by setting `platform` explicitly. If not set,
`scripts/detect-platform.sh` auto-detects from the git remote URL.

---

## Detection order

`scripts/detect-platform.sh` detects in this order:

1. Remote URL contains `github.com` → `github`
2. Remote URL contains `gitlab.com` → `gitlab`
3. Remote URL contains `bitbucket.org` → `bitbucket`
4. Remote URL contains `codeberg.org` or `forgejo` → `forgejo`
5. `glab` CLI available → `gitlab` (self-hosted)
6. `gh` CLI available → `github` (self-hosted)
7. Fallback → `manual`
