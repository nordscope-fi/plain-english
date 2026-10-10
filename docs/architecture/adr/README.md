# Architecture Decision Records

When a future contributor reads the code and asks "why is it this
way", the answer is a written record of the decision and the reasoning
behind it. That record is known as an ADR (architecture decision
record). This directory holds the ones the rest of the design rests
on.

## Format

- Filename: `NNN-kebab-case.md`
- Fields: Status, Date, Context, Decision, Consequences, Alternatives
  considered, Re-evaluation triggers (see `_template.md`)
- Amendments: dated in-body under the original ADR. Do not renumber.

## Index

| # | Title | Status |
|---|---|---|
| 001 | [Two-layer detection (deterministic then semantic)](001-two-layer-detection.md) | Accepted |
| 002 | [Block before the write, not after](002-block-before-the-write.md) | Accepted |
| 003 | [Severity gradient (warn some words, block others)](003-severity-gradient.md) | Accepted |
| 004 | [Ruleset is data, not code](004-ruleset-is-data.md) | Accepted |
| 005 | [Graduated escape hatch](005-graduated-escape-hatch.md) | Accepted |
| 006 | [Model checks run through the Claude Code mod when it can make the call](006-model-checks-through-the-host.md) | Accepted |
| 007 | [Term approval reads and writes files in the checker, not the mod](007-term-approval-in-the-checker.md) | Accepted |
| 008 | [The Claude Code plugin runs the checker inside its mod](008-checker-runs-inside-the-mod.md) | Accepted |
| 009 | [The checker ships inside a writing skill for Claude chat and Cowork](009-checker-ships-in-a-skill.md) | Accepted |
