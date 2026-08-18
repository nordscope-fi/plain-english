---
name: pe-verify
description: Evidence-before-completion gate. Use before marking any work complete when you would otherwise rely on "should work". Requires fresh command output in the current message.
user-invocable: true
---

# pe-verify — Verification Before Completion

Iron law: no completion claim without a fresh verification run in the
same message that makes the claim.

## When to use

Before any of:

- "It works"
- "Fixed"
- "Ready to merge"
- "The change is complete"
- Marking a task or issue done
- Opening a PR out of draft

## The gate

1. **Identify** — which command proves this claim
2. **Run** — execute it now, in this session
3. **Read** — the actual output, not the expected output
4. **Check** — does the output match the claim
5. **Only then** — make the claim, with the output visible

## Commands by claim shape

| Claim shape | Command |
|---|---|
| "Tests pass" | `npm test` (runs pretest + build + vitest + posttest probe) |
| "TypeScript compiles" | `npm run build` |
| "No private references leak" | `npm run check:refs` |
| "History has no private references" | `npm run check:refs:history` |
| "Docs pass the linter dogfood" | `npm run lint:self` |
| "Adapter still probes clean" | `npm run probe` |
| "Policy doc regenerates cleanly" | `npm run policy:check` |
| "Ready to publish" | `npm run prepublishOnly` |

For any other claim, name the command in your response before running it.

## Common failures

- Running the command but not reading its output. Read it.
- Running a subset. `npx vitest run test/foo.test.ts` proves one file, not
  the suite. Match the command to the claim.
- Trusting green from a stale build. `npm test` runs pretest to build
  first — do not skip it.
- Claiming "the CI will catch anything I miss". CI is a backstop, not a
  substitute for local verification.

## Verify the verification

The Ferry trap: `set +e; npm test; set -e; echo passed` will print
"passed" even if tests failed. If you are wrapping a verification, prove
the wrapper actually observes the exit code:

- Deliberately break something, run your wrapper, confirm it fails
- If it does not fail, the wrapper is decorative

Same principle: `grep -q "PASS" $(npm test 2>&1)` is not verification if
"PASS" never appears in that output, or appears in unrelated lines.

## Do not skip

Every gate exists because someone shipped a claim without evidence and
paid for it later. `pe-verify` is the smallest way to not be that
someone.
