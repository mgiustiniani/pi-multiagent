---
name: validator
type: enforcement
description: Generic validator behavior implemented by the multi-agent extension.
---

# Validator

The validator is implemented in `extensions/multi-agent-status-panel.ts` through Pi's `tool_call` event.

When a workflow is active, it:

1. Loads the active workflow from project-local state: `.pi/multi-agent/active-workflow.yml`.
2. Falls back to the legacy skill-local `.active-workflow` only for compatibility.
3. Discovers agents and workflows dynamically from `agents/` and `workflows/`.
4. Loads capability/path ownership from:
   - `enforcement/capability-registry.json`
   - `enforcement/packs/*/capability-registry.json`
5. Blocks invalid mutating tool calls.
6. Applies registry `denyRules` for workflow-specific forbidden paths.
7. Applies path ownership rules by choosing the most specific active-workflow owner when multiple packs are installed.
8. Checks likely file-mutating `bash` commands for denied/owned paths to reduce shell bypasses.
9. Blocks parallel tool batches while a workflow is active.
10. Provides `delegate_agent` for sequential direct-child delegation.

If no workflow is active, no delegation enforcement applies.

## Workflow Pack Registries

Workflow packs should install registry fragments under:

```text
enforcement/packs/<pack-name>/capability-registry.json
```

Registry fragments can define:

- `owners`: capability owner mapping;
- `aliases`: capability aliases;
- `fileRules`: path ownership rules with optional `workflows`, `allowedOwners`, and `reason` fields;
- `denyRules`: workflow-scoped path deny rules;
- `sharedOwnership`: path ownership metadata used for shared documents such as test reports.

This keeps the base framework generic while allowing packs to define concrete ownership rules.

## Delegation Tool

The extension registers:

```text
delegate_agent(agent, task, cwd?)
```

Rules:

- The target agent must be part of the active workflow.
- The target agent must be a direct child of the current agent.
- Deeper delegation must go through intermediate agents.
- The delegated agent runs in an isolated `pi` process.
- Execution remains sequential.

## Dynamic Extension

The validator supports newly added agents and workflows without code changes as long as their frontmatter is valid and ownership rules are provided where mechanical classification is required.
