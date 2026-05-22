# pi-multiagent

`pi-multiagent` is the base Multi-Agent System Framework (MASF) skill for pi.

It provides:

- workflow-bound hierarchical delegation rules;
- sequential execution constraints;
- validator/enforcement documentation;
- a TUI status panel extension;
- shared C4/Structurizr operational tooling;
- an English-only generated-artifact policy.

It does **not** include project-specific agents or workflows. Install workflow packs after installing this base skill.

## Install in pi

From the repository root:

```bash
mkdir -p ~/.pi/agent/skills
rm -rf ~/.pi/agent/skills/multi-agent
cp -R pi-multiagent ~/.pi/agent/skills/multi-agent
```

Verify:

```bash
ls ~/.pi/agent/skills/multi-agent
```

Expected files/directories include:

```text
SKILL.md
agents/
workflows/
enforcement/
extensions/
tools/
templates/
```

## Optional: enable the TUI status panel

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

After installing this base skill, install a workflow pack such as:

```text
workflow/pi-java-multiagent
```

See:

```text
workflow/pi-java-multiagent/README.md
```

## Update an existing installation

```bash
rsync -a --delete pi-multiagent/ ~/.pi/agent/skills/multi-agent/
```

Then reinstall any workflow packs, because `--delete` removes pack-provided agents and workflows.

## English-only generated artifacts

The base skill enforces that all installed agents and workflows generate project artifacts in English, including:

- source-code comments and Javadocs;
- README/PLAN/ARC42/ADR documentation;
- C4 diagram descriptions;
- test reports;
- user-facing generated messages.

Conversational replies may use the user's language, but generated project files remain English-only.
