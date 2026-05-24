# pi-multiagent

`pi-multiagent` is the base Multi-Agent System Framework (MASF) skill for pi.

It provides:

- workflow-bound hierarchical delegation rules;
- sequential execution constraints;
- dynamic discovery of agents and workflows;
- reusable generic agents: `documenter`, `c4model`, and shared JavaScript/TypeScript frontend agents;
- generic C4/Structurizr tooling used by `c4model`;
- a validator/runtime extension with `delegate_agent`;
- a TUI status panel extension;
- a generic capability registry that workflow packs can extend.

It does **not** include Java-, Tauri-, or native C/C++/Objective-C-specific implementation agents or workflows. Install workflow packs after installing this base skill. Shared frontend agents live in the base skill so multiple packs can reuse the same JavaScript/TypeScript frontend workflow roles.

## Install in pi

From this repository root:

```bash
mkdir -p ~/.pi/agent/skills/multi-agent
rsync -a --delete --exclude .git ./ ~/.pi/agent/skills/multi-agent/
```

Verify:

```bash
ls ~/.pi/agent/skills/multi-agent
```

Expected files/directories include:

```text
SKILL.md
agents/documenter.md
agents/c4model.md
agents/frontend-scaffolder.md
agents/frontend-core-coder.md
agents/frontend-ui-coder.md
agents/frontend-app-coder.md
agents/browser-adapter-coder.md
agents/frontend-tester.md
workflows/
enforcement/
extensions/
tools/
templates/
```

## Enable the TUI status panel and validator

Start pi with the extension:

```bash
pi \
  --skill ~/.pi/agent/skills/multi-agent \
  --extension ~/.pi/agent/skills/multi-agent/extensions/multi-agent-status-panel.ts
```

Or add the extension to your pi settings:

```json
{
  "extensions": [
    "~/.pi/agent/skills/multi-agent/extensions/multi-agent-status-panel.ts"
  ]
}
```

## Install a workflow pack

Example Java workflow pack:

```bash
cd ~/workspace/pi-java-multiagent
./scripts/install.sh
```

Uninstall it with:

```bash
cd ~/workspace/pi-java-multiagent
./scripts/uninstall.sh
```

## Status panel layout

The TUI widget is split into two side-by-side blocks on wide terminals:

- **Workflow**: active workflow, agent chain, compact/list/detail views.
- **Agent Activity**: live delegated-agent activity counters and last operation.

The activity block is UI-only metadata. It does not stream child-agent tool output into the main model context.

On narrow terminals the blocks stack vertically.

## Shared frontend agents

The base skill provides reusable frontend agents for workflows that need JavaScript/TypeScript frontend work:

```text
frontend-scaffolder
frontend-core-coder
frontend-ui-coder
frontend-app-coder
browser-adapter-coder
frontend-tester
```

Workflow packs should include these agents in their workflow hierarchy when their domain stack needs frontend code. The base capability registry owns common frontend paths such as `packages/ui/**`, `packages/web-core/**`, `packages/browser-adapters/**`, and `apps/web/src/**`.

## Workflow pack registry fragments

Workflow packs can install ownership rules under:

```text
enforcement/packs/<pack-name>/capability-registry.json
```

The base extension merges these fragments dynamically.

## Workflow state scope

By default, active workflow state is **session-scoped**. Different pi sessions can use different active workflows even in the same project directory.

For special cases, set:

```bash
MULTI_AGENT_STATE_SCOPE=project   # share active workflow through .pi/multi-agent/active-workflow.yml
MULTI_AGENT_STATE_SCOPE=legacy    # use the old skill-local .active-workflow file
```

Session scope is recommended because it prevents a workflow activated in one session from leaking into another.

## Commands

Inside pi:

```text
/skill:multi-agent activate <workflow-name>
/skill:multi-agent status      # compact panel
/skill:multi-agent list        # workflow list without trees
/skill:multi-agent detail      # detailed active tree / workflow details
/skill:multi-agent compact     # return to compact panel
/skill:multi-agent deactivate
```

## Custom agents and workflows

See:

```text
docs/custom-agents-and-workflows.md
```

## English-only generated artifacts

The base policy is that installed agents and workflows generate project artifacts in English, including:

- source-code comments and Javadocs;
- README/PLAN/ARC42/ADR documentation;
- C4 diagram descriptions;
- test reports;
- user-facing generated artifact text.

Conversational replies may use the user's language, but generated project files remain English-only.
