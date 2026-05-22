---
name: multi-agent
description: >
  Multi-Agent System Framework (MASF). Define hierarchical agent workflows with
  strict delegation enforcement. Agents are capability units; workflows decide
  the primary agent, sub-agents, and delegation hierarchy. When a workflow is
  active, the system MUST use only that workflow. Execution is strictly sequential.
---

# Multi-Agent System Framework (MASF)

MASF is a framework for defining and executing hierarchical, workflow-bound,
sequentially delegated agent systems.

This base skill contains the framework, enforcement rules, the TUI status
extension, and shared operational tooling. Concrete agents and workflows are
installed as separate workflow packs.

## Core Principles

1. **Workflow Binding** — When a workflow is active, the system MUST exclusively use that workflow.
2. **Workflow-Defined Hierarchy** — Agents are capability units. The workflow decides which agent is primary and which agents are delegated children.
3. **Forced Delegation** — A parent agent CANNOT execute a task that falls within a child agent's capabilities. Delegation is mandatory.
4. **Sequential Execution** — Agents NEVER run in parallel. One agent completes before the next executes.
5. **Recursive Propagation** — Delegation propagates down the workflow-defined hierarchy.
6. **English-Only Generated Text** — All agents MUST write generated code comments, documentation, ADRs, README content, ARC42 content, plans, test reports, C4 descriptions, examples, and user-facing tool messages in English.

## Directory Layout

```text
multi-agent/
├── SKILL.md
├── agents/                     # Installed agent capability definitions
├── workflows/                  # Installed workflow definitions
├── enforcement/
│   ├── delegation-rules.md
│   └── validator.md
├── extensions/
│   └── multi-agent-status-panel.ts
├── tools/                      # Skill-owned operational tools
│   ├── c4model-local.sh
│   ├── c4model-validate.sh
│   ├── c4model-export.sh
│   ├── c4model-export-static.sh
│   ├── c4model-export-images.sh
│   └── c4model-build-structurizr.sh
└── templates/
    └── c4/
        └── structurizr.properties
```

## Agent Definition Format

Agent files live in `agents/` and define capabilities only. They do not define
hierarchy.

```yaml
---
name: example-agent
type: agent
description: What this agent does.
capabilities:
  - capability-name
---
```

## Workflow Definition Format

Workflow files live in `workflows/` and define the hierarchy.

```yaml
---
name: example-workflow
type: workflow
description: What this workflow does.
agents:
  - primary-agent
  - child-agent
hierarchy:
  - agent: primary-agent
    children:
      - child-agent
strict: true
sequential: true
---
```

## Global Language Policy

All installed agents and workflows MUST follow this policy:

- Generated documentation MUST be written in English.
- Generated source-code comments and Javadocs MUST be written in English.
- Generated ADRs, README content, ARC42 content, plans, test reports, C4 descriptions, examples, and user-facing messages MUST be written in English.
- Preserve non-English text only when quoting an existing source verbatim or when an external term intentionally requires it.
- If the user writes in another language, conversational replies may use that language, but generated project artifacts remain English-only.

## Skill-Owned C4 Tooling

The base skill owns Structurizr operational tooling so repositories do not need
to duplicate C4 workflow logic.

- `tools/c4model-local.sh` starts Structurizr local with Podman or Docker.
- `tools/c4model-validate.sh` validates a Structurizr workspace.
- `tools/c4model-export.sh` runs the official Structurizr export command.
- `tools/c4model-export-static.sh` exports a static Structurizr site.
- `tools/c4model-export-images.sh` exports PNG/SVG through Structurizr's browser-based renderer.
- `tools/c4model-build-structurizr.sh` builds the open-source Structurizr WAR when PNG/SVG support is required.
- `templates/c4/structurizr.properties` is the default Structurizr local configuration.

Project-level scripts may exist as thin wrappers around these skill-owned tools.

## Commands

```bash
/skill:multi-agent activate <workflow-name>
/skill:multi-agent list
/skill:multi-agent status
/skill:multi-agent deactivate
```

## Extension

The optional TUI widget extension is:

```text
extensions/multi-agent-status-panel.ts
```

It discovers installed agents/workflows dynamically and shows the current active
workflow and active agent.
