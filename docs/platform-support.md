# Platform Support

RAD works with any git platform. GitHub is the default with full CLI automation.
Other platforms degrade gracefully to manual mode.

---

## Supported platforms

| Platform | PR automation | Approval check | Status |
|----------|--------------|----------------|--------|
| GitHub | ✅ Full (`gh` CLI) | ✅ Automatic | Default |
| GitLab | ✅ Full (`glab` CLI) | ✅ Automatic | Supported |
| Bitbucket | ⚠️ Manual instructions | ⚠️ Local git check | Partial |
| Forgejo / Gitea | ⚠️ `tea` CLI if available | ⚠️ Local git check | Partial |
| Self-hosted GitLab | ✅ Full (`glab` CLI) | ✅ Automatic | Supported |
| Any other | ⚠️ Manual instructions | ⚠️ Local git check | Manual |

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

Create these labels in your repo before first use:
```bash
gh label create "rad:plan" --color "0075ca" --description "RAD plan PR"
gh label create "rad:pending-review" --color "e4e669" --description "Awaiting architect review"
gh label create "rad:deliver" --color "0e8a16" --description "RAD delivery PR"
gh label create "rad:changes-requested" --color "d93f0b" --description "Changes requested on plan"
```

### Branch protection (recommended)

Protect `main` to enforce the gatekeeper role:
```bash
# Require PR reviews before merging
# Require status checks to pass
# Restrict who can push directly to main (architect only)
gh api repos/:owner/:repo/branches/main/protection \
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
glab label create "rad:plan" --color "#0075ca" --description "RAD plan MR"
glab label create "rad:pending-review" --color "#e4e669" --description "Awaiting architect review"
glab label create "rad:deliver" --color "#0e8a16" --description "RAD delivery MR"
glab label create "rad:changes-requested" --color "#d93f0b" --description "Changes requested"
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

When `/rad-plan` completes, it will output:
```
┌─────────────────────────────────────────────────────┐
│  Manual PR Creation Required                        │
└─────────────────────────────────────────────────────┘

Branch pushed: plan/feature-name
Target:        main

Title: Plan: Feature Name

Open a PR at: https://bitbucket.org/your-org/your-repo/pull-requests/new?source=plan/feature-name

After creating the PR, paste the URL here so it can be
recorded in the plan file.
```

The approval check falls back to local git:
```bash
git fetch origin main
git branch -r --merged origin/main | grep plan/feature-name
```

This correctly detects merge status but requires a recent `git fetch`.

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
- `/rad-plan` prints PR creation instructions instead of opening the PR
- After you manually create the PR, paste the URL and it's recorded in the plan
- `check-plan-approved.sh` uses local git to detect merge status
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
