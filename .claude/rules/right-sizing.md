---
description: Gates over-engineering. Counterpart to decision-accountability.md. Auto-loads on spec/design/plan/ADR paths and when red-flag phrases appear.
globs: "docs/architecture/adr/**,docs/**/*plan*.md,docs/**/*spec*.md,docs/**/*design*.md,docs/**/*brief*.md"
---

# Right-Sizing (Mandatory)

The mirror of `decision-accountability.md`. That rule stops scope being
cut too far. This one stops scope being added too far.

## The principle

Build the smallest slice that delivers the core value. Everything else
is a candidate for fast-follow, not this iteration. Adding scope must
be justified the same way cutting scope must be: name why each included
item belongs now.

## The precise trigger (fires rarely, by design)

This gate BLOCKS only when at least one of these is objectively true.
If none hold, it stays silent. A gate that fires on proportionate work
gets switched off.

1. **Unjustified P1** — the plan pulls in P1 items with no per-item
   reason for being in this iteration rather than a fast-follow.
2. **Untraceable scope** — a file, abstraction, or utility that traces
   to no P0 acceptance criterion.
3. **Disproportionate size** — task count exceeds what the P0 stories
   require, measured against the task's Trivial / Medium / Large
   classification.

## When it fires

BLOCK and propose the smaller build:

1. Name the minimal build.
2. List what to cut, and where each cut goes.
3. Re-present at the reduced scope.

## Where cut scope goes

- **Fast-follow** — an additive P1/P2 that can wait stays in the spec's
  own P1/P2 list as a documented follow-up. It is not built this
  iteration.
- **Deferred issue** — scope actively pushed out of an agreed plan
  gets a GitHub issue with the four fields from `decision-accountability.md`.

## Deconfliction

`decision-accountability` asks: is this cut an abandonment of something
foundational? (*removing* scope)

`right-sizing` asks: is this inclusion over-engineering? (*adding* scope)

A single item is one or the other, never both.
