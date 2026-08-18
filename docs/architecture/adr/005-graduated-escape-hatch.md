# ADR-005: Graduated escape hatch

**Status:** Accepted
**Date:** 2026-08-18 (extracted from docs/design-rationale.md § "Why the escape hatch is graduated")

## Context

A ten-minute acknowledgement file that disables an entire guard is a
blunt instrument. It was also the only tool the previous version had,
so it got used for cases that deserved a one-line suppression.

If the block-before-the-write model (ADR-002) is right, false
positives cost a person mid-task real time. Making the cheapest correct
fix easy to reach is a design requirement, not a courtesy.

## Decision

Six escape scopes, presented narrowest first. The refusal message
lists them in order and names the specific rule id to suppress, so the
cheapest correct fix is the first thing the human sees.

1. Suppress one rule on one line (inline directive)
2. Suppress one rule across a range (block directive)
3. Suppress the whole file (whole-file directive)
4. Add a path glob to `.plain-english.yml` (per-repo exclude)
5. Downgrade severity in `.plain-english.yml` (per-repo tuning)
6. Ten-minute acknowledgement file at the repo root
   (`.plain-english-lint-ack` etc.) — the sixth option, marked as the
   human's call

Option 6 stays because 1-5 all need a permanent decision, and somebody
mid-task does not always have one. It is not the first thing reached
for by design — the message puts it last.

## Consequences

- Adapter authors must render the refusal message in the order above.
  A reordered list makes the cheapest fix invisible.
- The acknowledgement file lives at the repo root (moved from
  `.claude/` in 0.4.0). `touch` will not create a missing parent, so
  the old path only worked because Claude Code had already made the
  directory. An agent that keeps no directory would have made the
  advice impossible to follow.
- Every escape scope is a source of drift risk. Ruleset changes must
  consider what happens to text that was suppressed under the old
  scope. `writing-style.md` documents the mechanisms so contributors
  editing rules can reason about impact.

## Alternatives considered

- **Single global override.** Reverted from — this is what we had, and
  see the second paragraph of context.
- **Model-mediated exception ("please pass this")** — considered and
  rejected. Every override should be traceable in git, not in
  conversation state.

## Re-evaluation triggers

- People routinely reach for option 6 without trying 1-5 first. That
  signals either the message is misordered or a rule is miscalibrated
  and should be a warning (ADR-003).
- A new host contract makes a seventh scope (e.g. session-scoped
  suppression) both possible and useful.
