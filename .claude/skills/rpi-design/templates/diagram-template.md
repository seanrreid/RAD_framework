# Output Template: Architecture Diagram

Use this template when generating the architecture-diagram.md for a project.
The Mermaid diagram renders in GitHub, Obsidian, Notion, and most modern markdown viewers.

---

```markdown
# Architecture Diagram — [Project Name]

## Agent Hierarchy

```mermaid
graph TD
    User(["👤 User"])
    PO["Parent Orchestrator"]

    User --> PO

    %% Role Orchestrators
    PO --> DOM1["[Domain 1] Orchestrator"]
    PO --> DOM2["[Domain 2] Orchestrator"]
    PO --> DOM3["[Domain 3] Orchestrator"]

    %% Domain 1 Tools
    DOM1 --> T1A["[Tool 1A]\n reads [scope]"]
    DOM1 --> T1B["[Tool 1B]\n reads [scope]"]

    %% Domain 2 Tools
    DOM2 --> T2A["[Tool 2A]\n reads [scope]"]
    DOM2 --> T2B["[Tool 2B]\n reads [scope]"]

    %% Domain 3 Tools
    DOM3 --> T3A["[Tool 3A]\n reads [scope]"]

    %% Styling
    classDef parent fill:#1a1a2e,stroke:#e94560,color:#fff,font-weight:bold
    classDef orchestrator fill:#16213e,stroke:#0f3460,color:#a8dadc
    classDef tool fill:#0f3460,stroke:#457b9d,color:#f1faee

    class PO parent
    class DOM1,DOM2,DOM3 orchestrator
    class T1A,T1B,T2A,T2B,T3A tool
```

---

## Information Flow

```mermaid
sequenceDiagram
    actor User
    participant PO as Parent Orchestrator
    participant RO as Role Orchestrator
    participant CT as Context Tool

    User->>PO: Task description
    PO->>RO: Scoped delegation
    RO->>CT: Bounded query
    CT-->>RO: ≤15 line summary
    RO-->>PO: Domain plan + summaries
    PO-->>User: Implementation plan
```

---

## Agent Summary

| Agent | Type | Reads | Returns | Token Budget |
|-------|------|-------|---------|-------------|
| Parent Orchestrator | Parent Orchestrator | Nothing | Implementation plan | 2000 |
| [Domain] Orchestrator | Role Orchestrator | Nothing | Domain plan | 1000 |
| [Tool Name] | Context Tool | [scope] | [output contract, ≤15 lines] | 300 |

---

## Scope Map

Which directories each context tool is allowed to read:

| Tool | Allowed Scope |
|------|--------------|
| [tool name] | [directory/file pattern] |
| [tool name] | [directory/file pattern] |

Everything outside a tool's allowed scope is invisible to it.
```
