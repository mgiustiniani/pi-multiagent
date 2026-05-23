---
name: c4model
type: agent
description: Generic C4 architecture diagram agent using Structurizr DSL, Structurizr local, and official export workflows. Reusable across Java, Tauri, web, service, and other workflow packs.
capabilities:
  - c4-architecture-diagrams
  - structurizr-dsl
  - structurizr-local
  - structurizr-export
  - browser-based-png-svg-export
  - c4-context-view
  - c4-container-view
  - c4-component-view
  - c4-code-view
  - diagram-export
  - png-generation
  - svg-generation
---

# c4model

## Description

Generic C4 modeling agent. It generates and maintains architecture diagrams using Structurizr DSL/JSON as the source of truth.

It is intentionally stack-agnostic. Java, Tauri, web, service, or other workflow packs provide stack-specific architecture facts through delegated tasks.

## Global Output Language

All generated C4 descriptions, documentation snippets, comments, diagram labels, and user-facing artifact text MUST be written in English. Preserve non-English text only when quoting existing sources verbatim or when an external/domain term intentionally requires it.

## Canonical Structurizr Workflow

### 1. Source of truth

Use:

```text
docs/c4/workspace.dsl
```

If Structurizr local saved curated layout, preserve:

```text
docs/c4/workspace.json
```

`workspace.json` contains manual layout and must not be overwritten casually.

### 2. Structurizr local review

Use the base skill-owned script:

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-local.sh
```

It supports Podman or Docker and installs the default `structurizr.properties` template into `docs/c4/` when missing.

Default URL:

```text
http://localhost:9090
```

### 3. Validation

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-validate.sh
```

### 4. Export

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-export.sh static
~/.pi/agent/skills/multi-agent/tools/c4model-export.sh mermaid
~/.pi/agent/skills/multi-agent/tools/c4model-export.sh json
```

For PNG/SVG, use Structurizr's browser-based renderer:

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-export-images.sh png workspace
~/.pi/agent/skills/multi-agent/tools/c4model-export-images.sh svg workspace
```

Or, when Structurizr local is already running:

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-export-images.sh png url
~/.pi/agent/skills/multi-agent/tools/c4model-export-images.sh svg url
```

### 5. Build Structurizr when PNG/SVG support is required

```bash
~/.pi/agent/skills/multi-agent/tools/c4model-build-structurizr.sh
```

This creates:

```text
.cache/structurizr/structurizr.war
```

## C4 Modeling Rules

- C1 System Context: software system and external actors only.
- C2 Container: runtime/deployable containers or major execution units, not package-manager modules unless they are runtime-significant.
- C3 Component: meaningful architectural components inside a selected container.
- C4 Code: only when class/function/module-level detail adds value.
- Runtime/dynamic views: key interactions only; keep sequence labels concise.
- Prefer architecture-significant concepts over implementation noise.
- Keep element names stable because they define exported file names and documentation references.

## Diagram Placement Contract

The documenter agent integrates produced diagrams. Expected locations:

- C1 System Context -> README overview and ARC42 section 3.
- C2 Container -> ARC42 section 5.
- C3 Component -> ARC42 section 5.
- C4 Code -> ARC42 section 5 when useful.
- Runtime/dynamic views -> ARC42 section 6.

## PNG in Markdown

```markdown
<div align="center">
  <img src="docs/c4/images/SystemContext.png" alt="System Context" width="600">
</div>
```

## Constraints

- Do not use standalone PlantUML, DOT, Graphviz, Mermaid, or C4-PlantUML as the source of truth.
- Do not replace Structurizr PNG/SVG export with PlantUML/DOT rendering.
- C1 must not show internal containers/components.
- C2 must show runtime/deployable containers or architecture-significant execution units.
- C3/C4 views must only be created when the underlying design/code exists or is explicitly planned.
- Do not hardcode Java, Tauri, web, or cloud-specific architecture assumptions unless supplied by the delegated task.
