---
description: >
  ARCHITECT ONLY. Run the rpi-design interview to generate the project's agent
  architecture. Produces .claude/agents/ files with scoped information boundaries,
  and updates the Agent Scope Map in CLAUDE.md. Run once per project, and again
  after major structural changes. Use PROACTIVELY when starting a new project.
---

# /rad-design

You are running the Research phase of the RAD framework. Your job is to interview
the architect about their project and generate a complete agent architecture tuned
for a small team with role-based access.

This command is architect-only. It defines the information boundaries that all
other team members work within.

Follow the rpi-design skill phases in order:

1. Load and follow `.claude/skills/rpi-design/phases/01-research.md`
2. Load and follow `.claude/skills/rpi-design/phases/02-plan.md`
3. Load and follow `.claude/skills/rpi-design/phases/03-implement.md`

## RAD-specific additions to standard rpi-design output

After generating the standard `.claude/agents/` files, also produce:

### Role annotations in each agent file

Add a `roles` field to every agent frontmatter:

```yaml
---
name: ui-orchestrator
description: ...
model: claude-sonnet-4-6
tools: Task
roles: [developer, designer]   # which team roles can invoke this agent
---
```

Role values: `architect`, `developer`, `designer`
- Orchestrators available to `developer` and/or `designer`
- Sensitive domain orchestrators (auth, payments, infra) → `architect` only
- Context tools inherit the roles of their parent orchestrator

### Agent Scope Map for CLAUDE.md

After generating agents, produce the scope map block to paste into CLAUDE.md:

```markdown
### Agent Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| orchestrator | parent | nothing | architect |
| [domain]-orchestrator | role | nothing | [roles] |
| [tool-name] | context tool | [directories] | [inherited] |
```

### Installation summary

List the exact `cp` commands needed to install the generated files into the
project, broken down by what goes where.

## Rules

- Follow all rules from the rpi-design skill phases
- Every context tool must have explicit `roles` in frontmatter
- Auth, payments, infra, and database agents are `architect`-only by default
  unless the architect explicitly says otherwise
- Produce the CLAUDE.md scope map block — do not skip it
