# Contributing

## Before writing code

Open an issue first. For a false positive, the sentence that was wrongly flagged is a complete bug report, and it usually becomes the test case verbatim.

## The rules your coding agent reads

If you work here with an AI coding agent, it has instructions waiting for it.

`AGENTS.md` at the repository root is the host-neutral contract: what this project is, how to size a task, which areas cannot be changed casually, and what to run before claiming you are done. Roughly twenty agents read that filename, Mistral Vibe among them, so most agents need nothing else to work here.

Three things live under `.claude/`. Rules that load when you touch the paths they describe. Skills for test-first work and for verifying a claim before making it. And a hook that reminds you to look for an existing helper before adding a new file under `src/`. All of it is prose the linter checks, so keep it in plain English too.

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

`lint:self` reads the docs, the root markdown files and everything under `.claude/`, and fails on a blocking finding. This repository does not exempt itself from its own rules.

## What gets rejected

- A rule with no corpus case.
- An edit to a generated file.
- A new dependency without a reason in the pull request description. Runtime dependencies are kept to the markdown parser and a YAML reader.

## Releasing

Maintainers: see [`docs/releasing.md`](docs/releasing.md). The first publish has to be done by hand, because npm cannot attach a trusted publisher to a package name that does not exist yet.
