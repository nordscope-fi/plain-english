# ADR-004: Ruleset is data, not code

**Status:** Accepted
**Date:** 2026-08-18 (extracted from docs/design-rationale.md § "Why the ruleset is data")

## Context

The previous version of this system maintained the same word list in
five places: a regex pasted into three shell scripts, a prose list
inside three prompt bodies, and a table in a markdown file. Nothing
checked they agreed. They did not.

Similarly, adding a new host initially meant a per-host instruction
file, per-host rule format, and per-host update on every ruleset
change, a file per host per release to keep true.

## Decision

`rules/default.yml` is the only hand-written source. The docs and
prompt bodies are generated from it. Adapters translate host payloads
onto a canonical event; nothing about the rules themselves lives in an
adapter.

`AGENTS.md`-style single-file contracts win over per-host instruction
files: worse at each host by a small margin, but immune to per-host
drift by design.

CI fails when the working tree changes after running the render
(`node dist/cli.js render`).

## Consequences

- Contributors editing the ruleset never touch the generated docs or
  prompts. If they do, CI reverts the change on next render.
- Any consumer of the shipped ruleset (adapters, IDE integrations,
  downstream policies) reads one canonical source.
- A per-host quirk that would benefit from bespoke instruction is
  handled by the adapter's translation layer, not by forking the
  ruleset. Bespoke rules were considered and rejected.
- The `rules/default.yml` schema is foundational (ADR-003 and
  everything downstream depends on it). A breaking schema change is a
  semver-major.

## Alternatives considered

- **Per-host instruction files.** Considered and rejected. Every host
  drifts on its own release cadence. Seven adapters would drift the
  way five word lists did.
- **Ruleset embedded in code.** Rejected. A prose contributor can
  propose a new rule with a YAML edit, not a TypeScript PR.

## Re-evaluation triggers

- The ruleset schema grows complex enough that YAML is no longer the
  right container (>500 lines, deep nesting, etc.).
- The generator becomes a bottleneck for contributors.
