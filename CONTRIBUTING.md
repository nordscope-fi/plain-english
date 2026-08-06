# Contributing

## Before writing code

Open an issue first. For a false positive, the sentence that was wrongly flagged is a complete bug report, and it usually becomes the test case verbatim.

## Setup

```bash
npm ci
npm run build
npm test
```

## The one rule about rules

`rules/default.yml` is the only hand-written source. `docs/writing-style.md` and the prompt bodies under `integrations/` are generated from it by `npm run render`, and CI fails if they drift. Never edit a generated file.

Adding or changing a rule means:

1. Edit `rules/default.yml`.
2. Add a case to `test/corpus/cases.yml` that blocks, and a case that exercises the rule's exceptions.
3. Run `npm run render` and commit the regenerated files.

`npm test` refuses to pass if a rule has no corpus case.

## Test corpus

`test/corpus/cases.yml` holds behaviour. `expect: pass` asserts no error findings, and warnings are asserted exactly, so an omitted `warns` list means none fired.

`test/corpus/regressions.yml` holds one case per escape that reached a user. Anything that gets through in the wild lands here permanently.

## Before opening a pull request

```bash
npm run build && npm test
npm run render && git diff --exit-code
npm run lint:self
```

## What gets rejected

- A rule with no corpus case.
- An edit to a generated file.
- A new dependency without a reason in the pull request description. Runtime dependencies are kept to the markdown parser and a YAML reader.
