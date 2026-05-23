# pi-multiagent

`pi-multiagent` is the base Multi-Agent System Framework (MASF) skill for pi.

It provides:

- workflow-bound hierarchical delegation rules;
- sequential execution constraints;
- dynamic discovery of agents and workflows;
- reusable generic agents: `documenter` and `c4model`;
- generic C4/Structurizr tooling used by `c4model`;
- a validator/runtime extension with `delegate_agent`;
- a TUI status panel extension;
- a generic capability registry that workflow packs can extend.

It does **not** include Java-specific implementation agents or the `full-development` workflow. Install workflow packs after installing this base skill.

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

## Workflow pack registry fragments

Workflow packs can install ownership rules under:

```text
enforcement/packs/<pack-name>/capability-registry.json
```

The base extension merges these fragments dynamically.

## Commands

Inside pi:

```text
/skill:multi-agent activate <workflow-name>
/skill:multi-agent list
/skill:multi-agent status
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
