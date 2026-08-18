# ADR-001: Two-layer detection — deterministic then semantic

**Status:** Accepted
**Date:** 2026-08-18 (extracted from docs/design-rationale.md § "Why two layers")

## Context

AI-generated writing has predictable tells: a small set of overused
words, plus a handful of sentence shapes. The check has to run at
write time in every channel where text is produced. Two mechanisms are
available: a deterministic pattern matcher, and a semantic model call.

Word-list matching runs in about a millisecond, is fully testable, and
cannot see rephrased cliches or sentence shapes. A model call can see
those, costs a network round trip, and has a specific and repeatable
failure mode where it calibrates too aggressively.

## Decision

Run both layers. The cheap deterministic layer carries every finding
it can carry. The expensive semantic layer is the only thing that can
be wrong in an unbounded way.

## Consequences

- Every finding the deterministic layer catches has a testable pattern
  in `rules/default.yml`. That is the primary place new tells go.
- The semantic layer is a supplement, not a replacement. It never gets
  to be the only gate. Anything trustworthy enough to catch
  deterministically belongs in the ruleset.
- Adding a new tell requires updating the ruleset first, then
  regenerating the prompt bodies (they are outputs of the ruleset).
- The two-layer setup means two things must stay in sync. Because both
  are generated from `rules/default.yml`, they cannot disagree — see
  ADR-004.

## Alternatives considered

- **Model-only.** The failure mode documented in
  `docs/design-rationale.md § "The semantic layer gets calibrated wrong"`
  is not hypothetical — it was reproduced during development. A gate
  with a false-positive floor above zero cannot stand alone.
- **Deterministic-only.** Misses rephrased cliches (a binary-contrast
  cliche can be authored a hundred ways). The corpus of "shape" hits
  in `test/corpus/` justifies the semantic layer.

## Re-evaluation triggers

- Deterministic patterns cover >95% of production findings and the
  semantic layer catches nothing new for three months → consider
  dropping the semantic layer for cost reasons.
- A model becomes cheap enough that the round-trip cost is negligible
  → semantic layer could take on more of the ruleset (still not all —
  determinism is a feature).
