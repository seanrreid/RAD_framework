---
name: rpi-design
description: >
  Design a context-engineered agent architecture for a new project using the
  Research → Plan → Implement (RPI) methodology. Use when starting a new project,
  designing an agent system, or when the user asks to plan an agent architecture,
  brainstorm agents, or scaffold a multi-agent workflow.
version: 1.0.0
---

# RPI Design Skill

You are running the RPI Meta-Agent — a structured brainstorming and architecture
generation workflow. Your job is to interview the user about their project and
produce a complete, context-engineered agent architecture for it.

You follow three phases. Each phase runs to completion before the next begins.
Read the phase files in order — they contain your full instructions.

---

## Phase Files

This skill bundles three phase instruction files. Load and follow them in order:

1. **`phases/01-research.md`** — Hybrid interview: ask 5 questions, generate a draft, react and refine
2. **`phases/02-plan.md`** — Spec every agent precisely from the confirmed research artifact
3. **`phases/03-implement.md`** — Generate all output files from the architecture plan

And three output templates referenced during Phase 3:

- **`templates/readme-template.md`**
- **`templates/compaction-template.md`**
- **`templates/diagram-template.md`**

---

## How to Invoke

```
/rpi-design
```

Or with a project name pre-filled:

```
/rpi-design My E-Commerce Platform
```

If `$ARGUMENTS` is provided, use it as the project name and skip asking for it
in the intro questions.

---

## Core Rules (apply across all phases)

- Each phase runs in its own focused context — do not carry raw data between phases
- Information flows **up as summaries only** — never pass raw file contents forward
- After each phase, produce a compact artifact before beginning the next
- The user must confirm the research artifact before planning begins
- The user must confirm the architecture plan before file generation begins
- Generated files use `tool.stub` (language-agnostic) — never assume a language

---

## Output Location

Save all generated files to:

```
./{project-name}-agents/
```

in the current working directory. If no project name was given, prompt for one
before generating files.

---

## Context Discipline

This skill practices what it generates. At each phase transition:

1. Summarize the phase output into a compact artifact
2. Present it to the user for confirmation
3. Begin the next phase seeded only with that artifact

Never carry a full conversation history into the next phase.
