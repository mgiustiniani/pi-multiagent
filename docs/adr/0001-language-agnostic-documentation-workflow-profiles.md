# ADR 0001 — Propose language-agnostic documentation workflow profiles

## Status

Proposed

## Context

The base `pi-multiagent` repository provides reusable multi-agent framework behavior and shared documentation guidance.

Some documentation practices are independent of programming language or technology stack. These include maintaining architecture records, linking evidence, defining documentation ownership, tracking review status, and separating base framework guidance from pack-specific documentation details.

This ADR is a documentation-only proposal. It does not assert runtime behavior, activation changes, executable validation behavior, or delivery behavior.

## Decision

Define a language-agnostic documentation workflow/profile model in documentation only.

The base documentation proposal should describe reusable documentation concepts and extension points, including:

- documentation artifact ownership;
- documentation handoff boundaries;
- architecture record responsibilities;
- decision record indexing;
- evidence-linking expectations;
- English-only generated artifact policy;
- profile-specific documentation extension points.

Workflow packs may document their own additional documentation rules, paths, templates, evidence formats, and review expectations separately from the base proposal.

The base proposal must not define executable behavior, runtime activation, stack-specific execution rules, or project delivery behavior.

## Scope / Non-goals

In scope:

- defining the architectural separation between base documentation guidance and pack-specific documentation profiles;
- identifying extension points for documentation profiles;
- preserving existing pack ownership of pack-specific documentation details;
- documenting that this proposal is non-executable.

Out of scope:

- implementing runtime framework changes;
- changing active workflow activation behavior;
- migrating existing workflow files;
- introducing stack-specific documentation profiles;
- validating production behavior;
- claiming parity across technologies.

## Consequences

Positive consequences:

- Documentation guidance can be shared across workflow packs.
- Stack-specific documentation rules remain owned by the packs that need them.
- The base repository can describe documentation structure without adding runtime behavior.
- Review status and evidence-linking conventions become easier to apply consistently.

Negative consequences:

- Workflow packs need to document their own profile-specific details.
- The boundary between base documentation guidance and pack-specific documentation rules must remain explicit.
- Documentation profiles introduce another design concept that must be kept current.

Neutral consequences:

- Existing runtime behavior remains unchanged.
- Existing workflow activation behavior remains unchanged.
- Existing pack-specific documentation remains owned by its pack.

## Accepted Alternative

### Define language-agnostic documentation workflow profiles

This alternative is accepted.

It separates reusable documentation guidance from pack-specific documentation rules. It keeps the base framework broadly applicable while allowing each workflow pack to describe its own documentation conventions.

## Rejected Alternatives

### Keep all documentation guidance inside individual workflow packs

This alternative is rejected.

It would duplicate common documentation concepts across packs and make cross-pack documentation consistency harder to maintain.

### Put stack-specific documentation rules in the base repository

This alternative is rejected.

It would make the base repository depend on conventions that belong to individual packs.

### Add executable profile behavior now

This alternative is rejected for this ADR.

The ADR records a documentation structure only. Runtime behavior, migration, and activation changes require separate design and evidence.

## Evidence

No runtime evidence is claimed.

This ADR is based on repository documentation needs in the base `pi-multiagent` context.
