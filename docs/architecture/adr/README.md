# Architecture Decision Records

ADRs capture load-bearing decisions and why they were made. When a
future contributor reads the code and asks "why is it this way", the
ADR is the answer.

## Format

- Filename: `NNN-kebab-case.md`
- Fields: Status, Date, Context, Decision, Consequences, Alternatives
  considered, Re-evaluation triggers (see `_template.md`)
- Amendments: dated in-body under the original ADR. Do not renumber.

## Index

| # | Title | Status |
|---|---|---|
| 001 | [Two-layer detection: deterministic then semantic](001-two-layer-detection.md) | Accepted |
| 002 | [Block before the write, not after](002-block-before-the-write.md) | Accepted |
| 003 | [Severity gradient: warn some words, block others](003-severity-gradient.md) | Accepted |
| 004 | [Ruleset is data, not code](004-ruleset-is-data.md) | Accepted |
| 005 | [Graduated escape hatch](005-graduated-escape-hatch.md) | Accepted |
