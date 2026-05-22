---
name: delegation-rules
type: enforcement
description: Delegation enforcement rules for the multi-agent system.
---

# Delegation Rules

## Global Output Language
All generated artifacts, source-code comments, documentation, ADRs, plans, reports, C4 descriptions, examples, and user-facing messages produced by this agent/workflow MUST be written in English. Preserve non-English text only when quoting an existing source verbatim or when an external term intentionally requires it.


These rules are enforced by the validator at every delegation step.

## Rule 1: Workflow Binding

```
IF a workflow is active:
  → The system MUST use ONLY that workflow
  → Using any other workflow or ad-hoc agent = VIOLATION
  → Using no workflow (when one is active) = VIOLATION
```

## Rule 2: Hierarchy from Workflow Only

```
Agent hierarchy is defined SOLELY by the active workflow:
  - The workflow defines which agents are primary (root)
  - The workflow defines parent-child relationships
  - An agent has NO fixed role — it depends on the workflow
  - Violation: using a hierarchy different from the workflow's definition
```

## Rule 3: Forced Delegation

```
For any task T assigned to agent A (where A has children C1..Cn in the workflow):
  IF any child Ci can handle T (T ∈ Ci.capabilities):
    → A MUST delegate T to Ci
    → A CANNOT execute T directly
    → Violation = BLOCK

  IF no child can handle T:
    → A MAY execute T directly
    → This is valid — no delegation possible
```

## Rule 4: Recursive Delegation

```
IF agent Ci receives T and Ci has children:
  → Repeat Rule 3 for Ci with its children
  → Delegation propagates down until a leaf agent is reached
  → Leaf agent = agent with no children that can handle T
```

## Rule 5: Sequential Execution

```
Agents execute STRICTLY SEQUENTIALLY:
  - No two agents run in parallel
  - Parent waits for child to complete before continuing
  - Child waits for grandchild to complete
  - Violation: any detected parallelism = BLOCK
```

## Rule 6: Single Active Workflow

```
Only ONE workflow can be active at a time:
  - Activating a new workflow while one is active = deactivate first
  - Violation: concurrent workflows = BLOCK
```

## Violation Handling

When a violation is detected:
1. The violating action is BLOCKED
2. A report is generated describing the violation
3. The correct action is suggested
4. The system waits for correction before proceeding
