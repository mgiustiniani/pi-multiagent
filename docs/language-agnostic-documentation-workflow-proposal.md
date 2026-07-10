# Language-Agnostic Documentation Workflow Profile Proposal

Status: Proposed design
Scope: Documentation only; no runtime, activation, or executable behavior change is introduced by this page.

## Summary

The base `pi-multiagent` repository should document a reusable, language-agnostic model for documentation workflow profiles.

The base model describes how documentation responsibilities, handoff boundaries, evidence links, and profile-specific documentation rules can be organized across workflow packs. Concrete packs may add their own documentation paths, templates, conventions, and review rules without changing the base model.

## Goals

- Describe shared documentation responsibilities once, independent of programming language or technology stack.
- Make pack-specific documentation assumptions explicit through documentation profiles.
- Provide a common structure for architecture records, evidence links, and generated project documentation.
- Keep the base repository focused on documentation guidance and extension points.

## Non-goals

- Changing runtime behavior.
- Activating or changing workflow definitions.
- Defining stack-specific development, validation, or delivery behavior.
- Migrating existing workflow packs.
- Defining complete profiles for specific technologies.

## Base Documentation Model

A base documentation model defines common documentation concepts and profile extension points. It is not a concrete pack profile by itself.

### Shared responsibilities

The base model may define reusable responsibility groups, for example:

- documentation planning and sequencing;
- architecture documentation ownership;
- decision record indexing;
- glossary and terminology maintenance;
- evidence-linking expectations;
- generated artifact language policy;
- handoff boundaries between documentation owners;
- review status labels such as `draft`, `confirmed`, `planned`, `stale`, and `needs-review`.

The base model should avoid prescribing stack-specific paths, commands, tools, or generated report formats.

## Documentation Profiles

A documentation profile binds the base documentation model to a concrete workflow pack or technology context. A profile may specify:

- owned documentation artifact types;
- profile-specific paths and naming conventions;
- templates and front matter conventions;
- review and approval expectations;
- evidence formats used by that pack;
- architecture record locations;
- glossary sources and ownership rules;
- pack-specific generated documentation rules.

Profiles can live in workflow packs, installed registry fragments, or profile-specific documentation. They should be versioned and maintained with the pack that owns the corresponding documentation behavior.

## Base Framework versus Documentation Profiles

| Concern | Base `pi-multiagent` documentation model | Workflow pack documentation profile |
| --- | --- | --- |
| Documentation vocabulary | Defines shared concepts and status labels | Applies them to a concrete pack |
| Artifact ownership | Defines generic ownership patterns | Assigns paths and owners for the pack |
| Decision records | Defines index and linking expectations | Defines pack-specific record locations |
| Architecture documentation | Defines common structure and evidence expectations | Adds pack-specific chapters, appendices, or diagrams |
| Glossary management | Defines terminology stewardship expectations | Identifies pack-specific terminology sources |
| Generated artifact language | Provides the English-only artifact policy | Adds pack-specific wording constraints when needed |
| Review status | Provides common status labels | Defines profile-specific review gates |

## Proposed Documentation Extension Points

A future documentation profile contract could expose the following extension points:

- `docs.artifacts`: artifact types, paths, and owners;
- `docs.templates`: reusable templates and required headings;
- `docs.status`: allowed status labels and review transitions;
- `docs.evidence`: accepted evidence link formats;
- `docs.decisions`: decision record locations and index rules;
- `docs.glossary`: terminology sources and ownership;
- `docs.language`: generated artifact language rules.

These names are illustrative. They do not create runtime configuration by themselves.

## Relationship to ADRs

The architectural direction is recorded in [ADR 0001: Propose language-agnostic documentation workflow profiles](adr/0001-language-agnostic-documentation-workflow-profiles.md).
