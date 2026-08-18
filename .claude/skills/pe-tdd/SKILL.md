---
name: pe-tdd
description: Test-first discipline. Use before writing implementation code for any new function, rule, adapter, or CLI behavior that can be tested. Iron law - watch a test fail before writing production code.
user-invocable: true
---

# pe-tdd — Test-Driven Development

Watch red, then green, then refactor. No production code without a
failing test first. No shortcuts, no "I'll add the test after".

## When to use

- Adding a new rule to the ruleset
- Adding or changing an adapter
- Adding or changing a CLI command
- Fixing a bug where you can reproduce it with a test
- Any new function, hook, or module in `src/`

## When to skip

- Pure refactoring with no behavior change (existing tests are the safety net)
- Documentation-only changes
- Config changes with no logic

## The cycle

### 1. RED — write the failing test

```
# Add a spec that exercises the behavior you are about to add.
# Path convention: test/<area>.test.ts
```

Write ONE test that describes the intended behavior in the simplest
terms possible. Do not write the implementation yet.

### 2. VERIFY RED — run it, watch it fail

```
npx vitest run test/<file>
```

The test MUST fail for the reason you expect. If it passes, one of:
- The behavior you thought was missing is already there. Read the code
  before adding more.
- The test is not actually exercising the code you meant. Fix the test
  first.
- The assertion is trivially true. Rewrite it.

**Ferry trap** (applies here too): an assertion that cannot fail looks
exactly like a pass. `expect(foo).toBeDefined()` after you just built
`foo` is not a test.

### 3. GREEN — write the minimum code that passes

Write ONLY the code needed for THIS test to pass. Not the next test.
Not the interface you'll want later. The smallest change.

### 4. VERIFY GREEN — run it

```
npx vitest run test/<file>
```

If more tests fail than passed, you have gone too broad — revert to the
last green, retry with a smaller change.

### 5. REFACTOR (optional)

With the test green, tidy the implementation. The test must stay green.
If refactoring breaks a test, the refactor changed behavior — either
change the test deliberately or revert.

## Common anti-patterns (do not do)

- Testing the mock. `expect(fs.readFile).toHaveBeenCalledWith(...)` is
  testing your mock setup, not your code.
- Adding a test-only method to production code. If the code is hard to
  test, the code is wrong, not the test.
- `expect(true).toBe(true)` and its cousins.
- Snapshotting output of a function that hasn't been characterised. A
  passing snapshot on an unspecified function tells you nothing.
- Writing five tests before running any of them. Cycle per test.

## Verification

`pe-verify` covers the full suite. `pe-tdd` is about the one test you
are writing right now.
