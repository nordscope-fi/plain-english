---
description: TypeScript conventions, reuse-before-write gate, testing patterns. Auto-loads on any src/ or test/ edit.
globs: "src/**,test/**,scripts/**"
---

# Code Conventions

## Reuse before write

Before adding a helper to `src/`, search for one that already exists.

- Grep for the name you are about to define: `rg -n "^export (const|function) <name>" src/`
- Grep for the shape you are about to write: patterns matching the same
  argument names and return types often exist under a different name
- The `.claude/hooks/reuse-guard.sh` PreToolUse hook fires once per new
  file created under `src/` and reminds you to check first. Fail-open;
  escape with `PE_REUSE_GUARD_MODE=observe`

If no existing helper covers the need, write the file. The rule targets
duplicates inside the same layer, not deliberate mirrors (for example
the adapter files under `src/adapters/**` legitimately repeat structure).

## Before adding a dependency

A new entry in `package.json` needs one line of justification:

1. Does the standard library do it?
2. Does the platform (Node runtime, TypeScript compiler) do it?
3. Does something already installed do it?

Record the answer in the PR body. Unjustified dependencies are
over-engineering.

## TypeScript

- `tsconfig.json` `strict: true`; do not weaken
- Prefer interfaces for object shapes
- `unknown` over `any` when possible
- Prefix unused parameters with `_`

## Testing

- Test files: `*.test.ts` under `test/`
- Use vitest patterns; setup lives in `test/` alongside the spec
- Every new rule or adapter needs a test case in the AI-tell corpus
  (`test/corpus/`) or a dedicated spec

## Path alias

Imports from `src/` use relative paths. No path-alias configured. Keep it
that way unless a Large workflow adds one.

## Lint

- `npm run lint:self` — dogfood the linter on the repo's own docs
- No ESLint on source code by design; `tsc --strict` is the code gate
