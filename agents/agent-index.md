---
name: agent-index
type: index
description: Registry of reusable base agents shipped with pi-multiagent.
---

# Base Agent Registry

The base `pi-multiagent` skill ships only cross-workflow reusable agents.
Workflow-specific agents are installed by workflow packs.

| Agent | Capabilities | Notes |
|---|---|---|
| [documenter](documenter.md) | readme-management, plan-management, arc42-documentation, adr-management, c4-diagram-integration | Generic documentation agent reusable across workflow packs |
| [c4model](c4model.md) | c4-architecture-diagrams, structurizr-dsl, structurizr-export, diagram-export | Generic C4/Structurizr agent reusable across workflow packs |

All installed agents must write generated artifacts in English.
