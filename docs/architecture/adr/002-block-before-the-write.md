# ADR-002: Block before the write, not after

**Status:** Accepted
**Date:** 2026-08-18 (extracted from docs/design-rationale.md § "Why block before the write")

## Context

A fix applied after the write cannot un-push a commit, un-save an
issue, or un-show a doc that a reader already opened. If the goal is
"AI tells never reach a reader", the check has to sit in front of the
write, on the event an agent fires before it runs a tool. In Claude
Code that event is called `PreToolUse`.

The corollary: a false positive is expensive. Somebody is stuck,
mid-task, arguing with a gate.

## Decision

Every adapter checks the text about to be written: markdown content,
commit message, pull-request or issue body, or issue-tracker comment.
Strict mode refuses on the pre-tool event. Advisory mode uses either an
interactive question or the vendor's context field, which may arrive after
the tool where the pre event cannot carry advice.

## Consequences

- False positives cost real time. This forces three companion
  decisions: the severity gradient (ADR-003), the graduated escape
  hatch (ADR-005), and the ruleset-as-data structure that keeps every
  layer testable (ADR-004).
- Every host with a hook contract can adopt this. Every host without
  one (an editor with no pre-save hook) falls back to post-write
  linting, which is a strictly weaker guarantee.
- The gate must be fast. A slow gate is a broken gate, because it
  encourages `--no-verify`. The deterministic layer runs locally in
  milliseconds; the semantic layer has a network budget documented in
  the prompt config.

## Alternatives considered

- **Post-write linting only.** Fails the goal. Text has already
  reached its destination. Kept as a fallback for hosts with no
  pre-write hook; not the default.
- **Advisory pre-write (warn, do not block).** Considered. Rejected
  because the failure mode of "warn is ignored" is well documented
  across tooling generally, and the whole point is to keep tells out
  of shipped text.

## Re-evaluation triggers

- Adapter maintenance burden grows faster than the shared translation layer
  and live-verification process can support.
- A future host provides a native prose-quality gate we can defer to.
- False-positive rate on the semantic layer exceeds an acceptable
  threshold and the mitigations in
  `docs/design-rationale.md § "The semantic layer gets calibrated wrong"`
  no longer help.
