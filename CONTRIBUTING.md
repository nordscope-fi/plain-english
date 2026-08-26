# Contributing

## Before writing code

Open an issue first. For a false positive, the sentence that was wrongly flagged is a complete bug report, and it usually becomes the test case verbatim.

## The rules your coding agent reads

If you work here with an AI coding agent, it has instructions waiting for it.

`AGENTS.md` at the repository root is the host-neutral contract: what this project is, how to size a task, which areas cannot be changed casually, and what to run before claiming you are done. Roughly twenty agents read that filename, Mistral Vibe among them, so most agents need nothing else to work here.

Claude Code receives the same public rules through `AGENTS.md`. Reusable output styles,
prompts, hooks and a document-writing skill live under `integrations/claude-code/`.
Personal Claude Code settings are not part of this repository.

## Setup

```bash
npm ci
npm run build
npm test
```

## The one rule about rules

`rules/default.yml` is the only hand-written source. The writing guide, agent guidance,
Claude Code output styles, prompt bodies and document-writing skill are generated from it
by `npm run render`, and CI fails if they drift. Never edit a generated file.

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

`lint:self` reads the public docs and root community files, and fails on a blocking
finding. Generated reference material and the changelog are excluded in
`.plain-english.yml` because they quote the terms they document.

## What gets rejected

- A rule with no corpus case.
- An edit to a generated file.
- A new dependency without a reason in the pull request description. Runtime dependencies are kept to the markdown parser and a YAML reader.

## Releasing

A merge to `main` releases when `package.json` names a version no tag points at. So a change worth shipping carries its own bump, in the same pull request:

```bash
npm version minor --no-git-tag-version    # patch / minor / major
```

Commit that with the rest of the branch. The flag keeps npm from making its own commit and tag. The tag is CI's, made after both gates pass.

Leave the bump out for a change that ships nothing: documentation, comments, tests, CI. Then it rides along with the next release.

Maintainers: see [`docs/releasing.md`](docs/releasing.md). The one-time manual bootstrap is
complete; current releases are made by merging a version bump to `main`.
