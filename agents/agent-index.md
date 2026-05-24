---
name: agent-index
type: index
description: Registry of reusable base agents shipped with pi-multiagent.
---

# Base Agent Registry

The base `pi-multiagent` skill ships cross-workflow reusable agents.
Workflow-specific agents are installed by workflow packs.

| Agent | Capabilities | Notes |
|---|---|---|
| [documenter](documenter.md) | readme-management, plan-management, arc42-documentation, adr-management, c4-diagram-integration | Generic documentation agent reusable across workflow packs |
| [c4model](c4model.md) | c4-architecture-diagrams, structurizr-dsl, structurizr-export, diagram-export | Generic C4/Structurizr agent reusable across workflow packs |
| [frontend-scaffolder](frontend-scaffolder.md) | frontend-scaffolding, frontend-workspace-setup, vite-setup, typescript-config-setup | Shared JavaScript/TypeScript frontend scaffolding |
| [frontend-core-coder](frontend-core-coder.md) | frontend-core-code-generation, frontend-port-design, reusable-state-management | Shared reusable frontend core logic |
| [frontend-ui-coder](frontend-ui-coder.md) | frontend-ui-generation, component-design, design-system-generation, accessibility | Shared reusable UI component generation |
| [frontend-app-coder](frontend-app-coder.md) | frontend-app-code-generation, route-generation, app-shell-generation, feature-module-generation | Shared frontend app/page/routing implementation |
| [browser-adapter-coder](browser-adapter-coder.md) | browser-adapter-generation, webapp-port-implementation, fetch-adapters | Shared browser adapter implementation |
| [frontend-tester](frontend-tester.md) | frontend-web-testing, unit-test-generation, component-test-generation, web-build-validation | Shared frontend test/build validation |

All installed agents must write generated artifacts in English.
