# Output Template: Compaction Artifact

Use this template when generating the compaction-artifact.md for a new project.
This file is designed to be pasted directly as the opening context of any future session.

---

```markdown
# Compaction Artifact — [Project Name]
Generated: [date]
Phase: Architecture confirmed — implementation not yet started

---

## Project

**Name:** [project name]
**Description:** [2–3 sentences]
**Stack:** [language, framework, rough size]

---

## Confirmed Architecture

```
Parent Orchestrator
├── [Domain] Orchestrator
│   ├── [Tool] — reads [scope], returns [output contract]
│   └── [Tool] — reads [scope], returns [output contract]
└── [Domain] Orchestrator
    └── [Tool] — reads [scope], returns [output contract]
```

Total agents: [N] ([M] orchestrators, [P] context tools)

---

## Key Facts

### Architecture decisions
- [decision and why — e.g. "Auth and User domains merged — same file scope, no meaningful boundary"]
- [decision and why]

### Codebase constraints
- [constraint — e.g. "Monorepo: src/apps/web and src/apps/api are separate domains"]
- [constraint]

### Agent constraints
- All context tools are read-only
- Context tools scoped to specific directories — see each config.json
- No agent loads more than 15 lines of raw content upward

---

## Common Task Patterns

| Task | Route through |
|------|--------------|
| [task] | [orchestrator] → [tool(s)] |
| [task] | [orchestrator] → [tool(s)] |

---

## Starting Point

Begin with: **[recommended first orchestrator]**

Reason: [why this is the right starting point for this project]

Seed the first session with:
- This compaction artifact
- `agents/orchestrator/system-prompt.md`
- `agents/orchestrator/config.json`

Do not load file contents until the plan requires them.

---

## Files Generated

```
[project-name]-agents/
├── README.md
├── architecture-diagram.md
├── compaction-artifact.md          ← this file
├── agents/
│   ├── orchestrator/
│   │   ├── system-prompt.md
│   │   └── config.json
│   └── [domain]/
│       ├── system-prompt.md
│       ├── config.json
│       └── tools/
│           └── [tool]/
│               ├── system-prompt.md
│               ├── config.json
│               └── tool.stub
```

---

## Next Steps

1. Replace `tool.stub` files with your framework's implementation
2. Adjust `scoped_to` paths to match your actual directory structure
3. Run your first task through the Parent Orchestrator
4. Compact after each phase transition

---

## Open Questions

[anything unresolved from the research/planning session, or "None"]
```
