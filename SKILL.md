---
name: multi-agent
description: >
  Multi-Agent System Framework (MASF). Define hierarchical agent workflows with
  strict sequential delegation. Agents are capability units; workflows decide
  primary agents, sub-agents, and delegation hierarchy. Workflow packs can add
  custom agents, workflows, and capability ownership rules.
---

# Multi-Agent System Framework (MASF)

MASF is a framework for defining and executing hierarchical, workflow-bound,
sequentially delegated agent systems.

This base skill contains the generic framework, enforcement rules, the TUI status
extension, and the `delegate_agent` runtime tool. Concrete workflow-specific agents and workflows are installed as workflow packs. The base skill ships reusable `documenter`, `c4model`, and JavaScript/TypeScript frontend agents so workflow packs can share documentation, C4, and frontend behavior.

## Core Principles

1. **Workflow Binding** — When a workflow is active, the system MUST use that workflow.
2. **Workflow-Defined Hierarchy** — Agents are capability units; workflows define parent-child relationships.
3. **Forced Delegation** — A parent agent cannot execute a task that a child owns.
4. **Sequential Execution** — Agents never run in parallel.
5. **Recursive Propagation** — Delegation propagates down the workflow-defined hierarchy.
6. **English-Only Generated Artifacts** — Generated code comments, documentation, plans, reports, diagrams, and user-facing artifact text are written in English.

## Directory Layout

```text
multi-agent/
├── SKILL.md
├── agents/                     # Generic base agents + installed pack agents
│   ├── documenter.md
│   ├── c4model.md
│   ├── frontend-scaffolder.md
│   ├── frontend-core-coder.md
│   ├── frontend-ui-coder.md
│   ├── frontend-app-coder.md
│   ├── browser-adapter-coder.md
│   └── frontend-tester.md
├── workflows/                  # Installed workflow definitions
├── docs/
│   └── custom-agents-and-workflows.md
├── enforcement/
│   ├── capability-registry.json
│   ├── delegation-rules.md
│   ├── validator.md
│   └── packs/                  # Workflow pack registry fragments
├── extensions/
│   └── multi-agent-status-panel.ts
├── tools/                      # Generic C4/Structurizr tooling used by c4model
└── templates/
    └── c4/
```

## Agent Definition Format

```yaml
---
name: example-agent
type: agent
description: What this agent does.
capabilities:
  - capability-name
---
```

Agents define capabilities only. They do not define hierarchy.

## Workflow Definition Format

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
      - agent: child-agent
strict: true
sequential: true
---
```

Workflows define hierarchy and delegation structure.

## Workflow Pack Ownership Rules

The base registry is:

```text
enforcement/capability-registry.json
```

Workflow packs should install registry fragments under:

```text
enforcement/packs/<pack-name>/capability-registry.json
```

The extension merges all registries dynamically.

## Activation Commands

```text
/skill:multi-agent activate <workflow-name>
/skill:multi-agent status      # compact status panel
/skill:multi-agent list        # compact workflow list, no trees
/skill:multi-agent detail      # detailed active tree / workflow details
/skill:multi-agent compact     # return panel to compact mode
/skill:multi-agent deactivate
```

## Workflow Model Lock

When a workflow is activated, the extension snapshots the currently selected provider/model and thinking level for that activation. Parent turns re-apply that snapshot before agent execution, and `delegate_agent` starts child pi processes with the same locked model flags. This prevents model changes in another pi instance, or later global/default model changes, from changing the model used by an already-active workflow. To intentionally use a different model, deactivate and activate the workflow again after selecting the desired model.

## Delegation Traces

Every `delegate_agent` call records two trace layers:

- raw sealed training trajectories under `~/.pi/agent/trajectories` by default (override with `MULTI_AGENT_TRAJECTORY_DIR`);
- IDE-friendly trace events under `<workspace>/.ide/agent-runs/<run-id>/trace.jsonl` by default (override with `MULTI_AGENT_IDE_TRACE_DIR`, disable with `MULTI_AGENT_IDE_TRACE=0`).

Raw trajectories tee the child `pi --mode json` event stream, exclude thinking/reasoning fields, include prompt/tool/model fingerprints, and are sealed with SHA-256 metadata. IDE traces use Pi's normal event vocabulary (`agent_start`, `turn_end`, `message_end`, `tool_execution_start`, `tool_execution_end`, etc.) with a small `multiAgent` envelope for run/agent correlation. This keeps IDE integration Pi-native rather than coupled to plugin-specific event names.

Trace metadata is written to files and tool-result `details`, not appended to the delegated agent's textual result. Child-event forwarding through `tool_execution_update` is opt-in with `MULTI_AGENT_FORWARD_CHILD_EVENTS=1`; by default these implementation events do not grow the parent agent's prompt context.

## Extension

Load the extension to enable the status panel, validator, project-local workflow state, and `delegate_agent`:

```bash
pi --skill ~/.pi/agent/skills/multi-agent \
   --extension ~/.pi/agent/skills/multi-agent/extensions/multi-agent-status-panel.ts
```

The extension stores active workflow state in the current pi session by default. Different sessions can therefore use different active workflows.

Optional compatibility modes:

```bash
MULTI_AGENT_STATE_SCOPE=project   # store/read .pi/multi-agent/active-workflow.yml
MULTI_AGENT_STATE_SCOPE=legacy    # store/read the old skill-local .active-workflow
```

## Dependencies

This skill requires the following Pi packages:

- `@zosmaai/pi-llm-wiki` — Self-maintaining, Obsidian-compatible knowledge base for domain research (Karpathy LLM Wiki pattern). Install with:

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

## Extending the Framework

See `docs/custom-agents-and-workflows.md`.
