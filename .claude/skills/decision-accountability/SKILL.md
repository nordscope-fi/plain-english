---
name: decision-accountability
description: Runtime falsification procedure for the decision-accountability.md rule. Invoke when about to defer, describe something as "simpler for now", or classify a change as additive. Returns PROCEED or BLOCKED.
user-invocable: true
---

# decision-accountability: falsification procedure

Runtime skill paired with `.claude/rules/decision-accountability.md`.
Invoke when about to defer, describe something as "simpler for now",
or classify a change as additive.

## Step 1: extract decisions and claims

List every decision and every claim in the artifact being examined.
Focus on:

- Deferrals ("v2", "later", "out of scope", "Phase 2")
- Complexity claims ("too complex now", "would require rewriting X")
- Ownership assertions ("owned by team X", "already tracked in Y")
- Foundational classifications ("this is additive", "this is a small change")

## Step 2: falsify complexity claims

For each "too complex" or "simpler for now" claim:

- What is the actual line count needed to do it now? Estimate before
  looking. Then check.
- **Under 20 lines heuristic:** if the change is under 20 lines and does
  not touch a foundational area, the "too complex" claim is falsified.
  Do it now.
- **Foundational exception:** for the areas listed below, the 20-line
  heuristic does **not** apply. Small diffs can carry high blast radius.

## Step 3: check ownership

Every deferral needs an owner who will actually do the work. Test:

- 6 months from now, will this specific person still be here and remember?
- 12 months from now, will the trigger fire?
- 5 years from now, if it never happened, what breaks?

If the answer to the last question is "nothing", the deferral is fine.
If the answer is "the foundation is wrong", it is not a deferral, it
is abandonment.

## Step 4: classify foundational vs additive

Foundational areas in this project (a small diff does **not** mean small risk):

- The ruleset schema (`rules/**` JSON files and `src/rules.ts`)
- The adapter contract (`src/adapters/**`, `docs/verifying-an-adapter.md`)
- The three settings (`never`/`ask`/`block`) and their exit-code semantics
- The CLI command names and exit codes
- The on-disk `.plain-english.yml` format
- The generated policy artifact (`docs/ai-writing-policy.md`)

A change to any of these is foundational. There is no "v2", only a
rewrite of every downstream integration that depended on the old shape.

## Step 5: verdict

- `PROCEED`: all complexity claims falsified; no foundational
  deferral; every deferral carries the four fields (Why not now / Cost
  comparison / Owner / Trigger).
- `BLOCKED`: any of an unfalsified claim, a foundational deferral,
  incomplete four-field record. Revise the artifact.

`BLOCKED` at a workflow gate forces revision, not override.

## Output template

```
Decisions examined: <count>
Falsified:          <count>
Confirmed:          <count>
Foundational hits:  <count>
Verdict:            PROCEED | BLOCKED

Details:
- <decision>: <verdict + evidence>
```
