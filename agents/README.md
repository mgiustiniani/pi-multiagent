# Agents directory

Install workflow packs into this directory.

The base `pi-multiagent` skill intentionally ships without domain-specific agents. Agent capability definitions are provided by separate workflow packs, for example:

```text
workflow/pi-java-multiagent/agents/
```

After installing a workflow pack, this directory should contain files such as:

```text
java-planner.md
java-scaffolder.md
...
```

All installed agent definitions must write generated project artifacts in English.
