---
name: pe-debugging
description: Systematic root-cause investigation. Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes. Blocks symptom fixes.
user-invocable: true
---

# pe-debugging — Systematic Debugging

Fix causes, not symptoms. Four phases: reproduce, root cause, fix,
prevent regression.

## The gate

If you catch yourself typing "this might fix it" or reaching for the
first change that stops the error, stop. That is a symptom fix.

## Phase 1: reproduce

- Get the failing case down to the smallest reliable reproduction
- Prefer a failing test in `test/` over "I can trigger it in my terminal"
- If you cannot reproduce, you have not confirmed the bug

## Phase 2: root cause

Trace data BACKWARDS from the failure to its source.

- Where does the wrong value first appear?
- What produced it?
- What was that producer's input?
- Continue until the input is either user-controlled or a static value

Common root causes in this project:

- **Rule pattern too greedy or too narrow.** Test the regex against the
  corpus, not just the failing case. `test/corpus/` has the AI-tell test
  fixtures.
- **Adapter contract drift.** An adapter written against version N of the
  contract stops working when the contract changes. Check `src/adapters/`
  against `docs/verifying-an-adapter.md`.
- **Sentence splitter edge case.** `src/sentences.ts` handles a lot;
  a failure with unusual punctuation usually traces here.
- **CLI exit code mismatch.** `docs/post-edit-lint.md` names the codes;
  hooks read them. A mismatch produces "silent block" or "silent pass".
- **YAML config resolution.** The linter walks up looking for
  `.plain-english.yml`. A stray one in a parent dir changes results.

## Phase 3: fix

The fix targets the root cause. If it also incidentally masks other
symptoms, add tests for those to prove.

Three-fix rule: if you are about to make the third fix in the same
area, stop and ask whether the design is wrong. Three symptom fixes in
one function usually mean the function is doing too much.

## Phase 4: prevent regression

- The test you wrote in Phase 1 stays in the suite
- If the root cause was a class of problem (not a one-off), add tests
  for near-neighbors
- If the root cause was a missing invariant, encode it (type, assertion,
  linter rule)

## Do not

- Skip Phase 1. "I know what's wrong" is how you fix the wrong thing.
- Skip Phase 4. A bug that shipped once and got fixed will ship again
  without a test.
- Bundle a debug fix with unrelated cleanup. Separate commits.

## Handoff

If you cannot find the root cause, hand off with what you know:

- What you tried
- What was ruled out
- What still fits the symptoms
- The reproduction

Do not hand off "it's broken, please look". That wastes the next person's
first hour.
