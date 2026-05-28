---
description: >
  ARCHITECT ONLY. Consume a research artifact and produce the project's agent
  architecture. Run once after /rad-research to generate .agents/architecture/[slug].md
  (Status: draft). Review and approve the draft, then re-run to generate
  .claude/agents/ files and the CLAUDE.md scope map.
---

# /rad-design

Consume a RAD research artifact and generate the agent architecture for the
project. This is the A in Research/Architect/Deliver.

Runs in two modes depending on artifact state:
- **Draft mode** — research artifact exists, no approved architecture yet
- **Generate mode** — architecture artifact exists with `Status: approved`

## Input

`$ARGUMENTS` is the project slug. Examples: `habit-tracker-api`, `e-commerce-platform`

If `$ARGUMENTS` is empty, list all files in `.agents/research/` and ask which
project to design.

---

## Mode Detection

Check for `.agents/architecture/[slug].md`:

- **File does not exist** → run Draft mode
- **File exists, Status: draft** → stop and print review instructions (see below)
- **File exists, Status: approved** → run Generate mode

---

## Draft Mode

### Step 1: Read the research artifact

Read `.agents/research/[slug].md` directly. This is a small structured file —
no sub-agent needed.

If the file does not exist, stop:
```
No research artifact found for '[slug]'.
Run /rad-research first to produce one.
```

### Step 2: Design the agent hierarchy

From the research artifact, design the full agent hierarchy. Produce:

**Agent Hierarchy tree:**
```
Parent Orchestrator
├── [Domain] Orchestrator       roles: [architect | developer | designer]
│   ├── [Context Tool]          reads: [scope], returns: [contract]
│   └── [Context Tool]          reads: [scope], returns: [contract]
├── [Domain] Orchestrator       roles: [...]
│   └── ...
```

**For each agent, determine:**
- Type: `parent-orchestrator` | `role-orchestrator` | `context-tool`
- Roles: who can invoke it (inherit from parent orchestrator for context tools)
- Model: `claude-sonnet-4-6` for orchestrators, `claude-haiku-4-5-20251001` for context tools
- Tools: `Task` for anything that delegates, `Read, Grep, Glob` for anything that reads
- Reads: exact directories/patterns, or "nothing — delegates only"
- Returns: the output contract (what format, what fields, what line budget)
- Description: what goes in the frontmatter `description:` field

**Role assignment rules:**
- Parent orchestrator → `architect` only
- Domain orchestrators for auth, payments, infra, database → `architect` only by default
- UI, frontend, content, styling orchestrators → `developer, designer`
- API, backend, data orchestrators → `developer`
- Context tools inherit their parent orchestrator's roles
- Override defaults if the research artifact says otherwise

**Description writing rules:**
- Context tools must start with "MUST BE USED by [parent] when [specific condition]"
  or "Use PROACTIVELY when [condition]" — vague descriptions cause Claude Code to ignore them
- Orchestrators: describe the domain and what triggers delegation

### Step 3: Write the architecture artifact

Save to `.agents/architecture/[slug].md`:

```markdown
# Architecture: [Project Name]
Created: [YYYY-MM-DD]
Status: draft
Research: .agents/research/[slug].md

## Agent Hierarchy

[hierarchy tree]

## Agent Definitions

[for each agent:]

### [agent-name]
- Type: [parent-orchestrator | role-orchestrator | context-tool]
- Roles: [architect | developer | designer — comma-separated]
- Model: [claude-sonnet-4-6 | claude-haiku-4-5-20251001]
- Tools: [Task | Read, Grep, Glob]
- Reads: [exact scope, or "nothing — delegates only"]
- Returns: [output contract: format, fields, line budget]
- Description: "[exact text for frontmatter description field]"

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| [name] | [type] | [scope or "nothing"] | [roles] |

## Notes
[anything the architect should consider before approving — gaps, risks, open questions]
```

### Step 4: Print review instructions

```
Architecture draft written: .agents/architecture/[slug].md

Review the agent hierarchy and definitions. Edit the file directly if anything
needs to change — roles, scope, output contracts, model assignments.

When satisfied, change:
  Status: draft
to:
  Status: approved

Then re-run:
  /rad-design [slug]

This will generate the .claude/agents/ files and CLAUDE.md scope map.
```

---

## Generate Mode

### Step 1: Read the approved architecture artifact

Read `.agents/architecture/[slug].md` directly. Extract every agent definition.

### Step 2: Spawn parallel file-generation sub-agents

For each agent in the architecture, spawn one sub-agent using model
`claude-haiku-4-5-20251001`. Run all sub-agents in parallel.

Each sub-agent receives this prompt — fill in all bracketed values:

```
Generate a single Claude agent file. Write only the file contents.
No explanation, no preamble, no markdown fences around the output.

Output path: .claude/agents/[kebab-case-name].md

Frontmatter:
---
name: [kebab-case-name]
description: [description field from architecture artifact]
model: [model from architecture artifact]
tools: [tools from architecture artifact]
roles: [roles from architecture artifact]
---

Body sections (use exactly these headings):

## Role
[One sentence: what this agent is and what it does]

## Responsibilities
[3–5 bullet points derived from the agent's domain and output contract]

## Scope
[For context tools: the exact directories/patterns from the Reads field.
 For orchestrators: the domain boundary — what falls inside and outside.]

## Tool Call Order
[Role orchestrators only: numbered list of which context tools to call first and why.
 Omit this section for context tools and parent orchestrator.]

## Output Format
[The exact output format from the Returns field in the architecture artifact.
 Include field names and a brief example.]

## Rules
- Never read files outside the declared scope
- Never spawn sub-agents or call Task [context tools only]
- Never return raw file contents — always summarize to the output format
[Add 2–3 more rules specific to this agent's domain]
```

Wait for all sub-agents to complete before proceeding.

### Step 3: Generate the CLAUDE.md scope map

Read the current `CLAUDE.md`. Find the `### Agent Scope Map` section.

Generate the replacement block from the architecture artifact's Scope Map table:

```markdown
### Agent Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
[one row per agent from the architecture artifact]
```

Print the block and tell the architect:
```
Paste this into CLAUDE.md under '### Agent Scope Map', replacing the existing table.
```

Do not write to CLAUDE.md directly — the architect pastes it in.

### Step 4: Print installation summary

```
Agent files generated: [N]
  [list each .claude/agents/[name].md]

Next steps:

1. Paste the Scope Map above into CLAUDE.md → ### Agent Scope Map

2. Commit the generated files:
   git add .claude/agents/ .agents/architecture/[slug].md
   git commit -m "feat(agents): generate [project name] agent architecture"

3. Distribute architect commands to architect machines only (do not commit):
   cp .claude/commands/architect/*.md ~/.claude/commands/

4. Run /rad-status to verify the agent map loaded correctly.
```

---

## Rules

- Never run in Draft mode if an approved architecture artifact exists
- Never run in Generate mode if Status is not `approved` — print review instructions instead
- Never write to CLAUDE.md directly — print the scope map block for the architect to paste
- Never ask questions during Generate mode — resolve ambiguity from the architecture artifact
- Context tool files must have `model: claude-haiku-4-5-20251001`
- Orchestrator files must have `model: claude-sonnet-4-6`
- Every generated agent file must have at least 3 rules in its Rules section
- Context tool descriptions must start with "MUST BE USED" or "Use PROACTIVELY"
