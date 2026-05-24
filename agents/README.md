# Agents directory

The base `pi-multiagent` skill ships reusable cross-workflow agents:

- `documenter`
- `c4model`
- `frontend-scaffolder`
- `frontend-core-coder`
- `frontend-ui-coder`
- `frontend-app-coder`
- `browser-adapter-coder`
- `frontend-tester`

Workflow packs install domain-specific agents into this same directory, for example Java, Tauri, native C/C++/Objective-C, web, or service agents. Workflows can reuse the shared frontend agents whenever a backend/native stack needs JavaScript/TypeScript frontend work.

All installed agent definitions must write generated project artifacts in English.
