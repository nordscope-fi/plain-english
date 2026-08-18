# ADR-003: Severity gradient — warn some words, block others

**Status:** Accepted
**Date:** 2026-08-18 (extracted from docs/design-rationale.md § "Severity, and why some words only warn")

## Context

The initial ruleset blocked on `silently`, `quietly`, `mechanical`,
`underscores`, `holistic`, and `dive into`. Every one of those has an
ordinary technical or domain sense:

- "The parser fails silently when the file is missing."
- "Use a mechanical keyboard for this."
- "The filename underscores are significant."
- "A holistic medicine startup, our client."

All four were blocked in real production text. Thirteen such strings
are collected in `test/corpus/cases.yml`.

Blocking on every term in the list produced enough false positives to
sink adoption. Removing terms from the list lost the tells they were
meant to catch.

## Decision

Three mechanisms per rule, in order of preference:

1. **Severity gradient** — `block`, `ask`, `warn`, `never`. Terms
   with legitimate technical senses default to `warn` unless the
   surrounding context resolves the ambiguity.
2. **Per-rule `unless` clauses** — a rule can whitelist specific
   contexts (regex or sentence-shape) where a match should be dropped.
3. **Masking pass** (see ADR-004's twin) — code blocks, inline code,
   URLs, and blockquotes are masked out before scanning, so
   `leverage` inside a customer quote or a fenced example never
   triggers.

Every default in `rules/default.yml` records which of the three it uses
and why.

## Consequences

- Contributors adjusting the ruleset must choose severity deliberately,
  not pick `block` as a default.
- CI includes a test that every term in the corpus produces its
  expected verdict; a mis-set severity fails a specific corpus case.
- The `warn` severity implies a UI mechanism at the adapter layer.
  Adapters that only support pass/fail lose warn-level information —
  documented in `docs/verifying-an-adapter.md`.

## Alternatives considered

- **All-or-nothing.** The initial state. Rejected — see the four cases
  above.
- **Model-only judgment on ambiguous terms.** Rejected — a model with
  the false-positive floor documented in
  `docs/design-rationale.md § "The semantic layer gets calibrated wrong"`
  should not be the last line of defense on an ambiguous term.

## Re-evaluation triggers

- Adapter authors regularly report that `warn` semantics are unclear.
- The corpus grows to a size (>50 cases) where hand-tuning severities
  becomes unwieldy and warrants a different classification approach.
