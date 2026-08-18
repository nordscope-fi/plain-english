---
description: Falsification gate for deferrals and foundational-vs-additive classification. Auto-loads on spec/design/plan/ADR paths and when red-flag phrases appear.
globs: "docs/architecture/adr/**,docs/**/*plan*.md,docs/**/*spec*.md,docs/**/*design*.md,docs/**/*brief*.md"
---

# Decision Accountability (Mandatory)

Falsify every claim of "too complex", "simpler for now", "later", "v2",
"out of scope", "accepted tradeoff", "we can unify later" before it lands
in a spec, plan, or architecture decision record (`ADR`).

## The dual failure mode

- **Epistemic:** "I assumed X was complex without checking"
- **Ownership:** "I avoided checking because the answer might mean more work"

Both produce deferred foundations and duplicate implementations dressed
up as pragmatism.

## The four-field requirement

Every deferral must carry all four fields. Missing any of them equals
abandonment, not deferral.

| Field | Required content |
|---|---|
| **Why not now** | Actual blocker (not "too much work") |
| **Cost comparison** | Now versus later, with estimates |
| **Owner** | Who will do it (default: whoever wrote the deferral) |
| **Trigger** | When it gets done: a date or a measurable condition |

## Foundational areas (cannot be deferred)

Small diffs in these areas are not "simple" and their deferral is not
"lightweight". A change here needs the Large workflow:

- The ruleset schema (`rules/**` JSON files and `src/rules.ts`)
- The adapter contract (`src/adapters/**`, `docs/verifying-an-adapter.md`)
- The three settings (`never`/`ask`/`block`) and their exit-code semantics
- The CLI command names and exit codes
- The on-disk `.plain-english.yml` format
- Generated artifacts consumers cite (`docs/ai-writing-policy.md`)

There is no "v2" for a foundational contract, only a rewrite of every
downstream integration that depended on the old shape.

## Verdict

- `PROCEED`: all claims falsified, no foundational deferral, all
  deferrals carry the four fields.
- `BLOCKED`: any of an unfalsified complexity claim, a foundational
  deferral, incomplete four-field record. Revise before proceeding.

`BLOCKED` at any gate forces revision, not override.
