# Custom Agents and Workflows

This skill supports user-defined agents and workflows. The predefined Java agents are defaults, not framework limits.

## Add an Agent

Create `agents/<agent-name>.md`:

```markdown
---
name: security-reviewer
type: agent
description: Reviews security-sensitive code and dependency risks.
capabilities:
  - security-review
  - dependency-vulnerability-analysis
---

# security-reviewer

## Description
Reviews security-sensitive changes.

## Capabilities
- security-review
- dependency-vulnerability-analysis

## Constraints
- Does not write application code unless explicitly allowed by a workflow and validator rules.
```

## Add a Workflow

Create `workflows/<workflow-name>.md`:

```yaml
---
name: secure-review

type: workflow
description: Planning with delegated security review.
agents:
  - java-planner
  - security-reviewer
hierarchy:
  - agent: java-planner
    children:
      - agent: security-reviewer
strict: true
sequential: true
---
```

Use object-style hierarchy entries (`- agent: <name>`) whenever a node can have children.

## Add Capability Ownership

If the task can be inferred from file paths, update `enforcement/capability-registry.json`:

```json
{
  "owners": {
    "security-review": "security-reviewer"
  },
  "fileRules": [
    {
      "pattern": "security/**",
      "capability": "security-review",
      "owner": "security-reviewer"
    }
  ]
}
```

For tasks that cannot be inferred mechanically, delegate explicitly with `delegate_agent`.

Optional `fileRules` fields:

```json
{
  "pattern": "src/**/*.ts",
  "capability": "frontend-app-code-generation",
  "owner": "frontend-app-coder",
  "workflows": ["my-workflow"],
  "allowedOwners": ["frontend-app-coder", "frontend-tester"],
  "reason": "frontend app source"
}
```

Use `denyRules` for workflow-specific forbidden paths:

```json
{
  "denyRules": [
    {
      "workflows": ["c-development"],
      "pattern": "**/*.cpp",
      "capability": "strict-c-language-mode",
      "reason": "C workflow forbids C++ files"
    }
  ]
}
```

The validator also checks likely file-mutating `bash` commands against `fileRules` and `denyRules`; avoid shell redirection to bypass ownership.

## Delegation Rules

- A parent may delegate only to direct children.
- A grandchild must be reached through its parent.
- Execution is sequential.
- When no workflow is active, no delegation enforcement applies.

## Activation

```text
/skill:multi-agent activate <workflow-name>
/skill:multi-agent status
/skill:multi-agent deactivate
```

Workflow state is project-local:

```text
.pi/multi-agent/active-workflow.yml
```
