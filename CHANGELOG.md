# Changelog

Notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `npm version` dates the changelog. The `version` lifecycle script retitles `## [Unreleased]`, adds its link definition, repoints the Unreleased compare link and leaves a fresh heading for next time, all staged into the release commit. It refuses when the section is missing or empty, so a release with no entry fails before anything is tagged. `ALLOW_EMPTY_CHANGELOG=1` overrides. This was a manual checklist item missed on two consecutive releases, both times by someone who had just read the checklist naming it.
- A test asserting this repository's own changelog has an Unreleased heading, a link definition for every dated release, and either a dated section or a pending entry for the version in `package.json`. It failed on the first run, which is how the missing heading left behind by the 0.3.1 retitle was found.

## [0.3.1] - 2026-08-07

### Security

- `findUnsafe` sees through a character class when deciding whether the alternatives of a quantified group overlap. `^(?:[ab]|ab)+$` passed the screen and hangs the linter: `skeleton` blanked `[ab]` down to `[]`, so the check compared a `[` against an `a` and concluded the alternatives were disjoint. Measured at 207ms against a 49-character document, and each additional pair of characters doubles it. Every pattern in the shipped ruleset still passes.
- The engine calls `matchAllWithDeadline`. It had been exported, tested and described in comments as the runtime backstop since 0.1.0 while `lintText` called `rule.re.exec` directly, so no document-wide bound existed. `lintText` now takes `budgetMs`, defaulting to two seconds and shared across all rules, and returns `timedOut` naming any rule it abandoned. The Claude Code hook uses a 500ms budget and reports an incomplete scan rather than an empty one.
- Recorded what the deadline cannot do, in place of the claim that it was the backstop. A JavaScript regex match is atomic, so a check between matches bounds a pattern returning many matches and cannot interrupt one match that backtracks exponentially. Refusing that pattern at load is the only defence.

### Fixed

- `src/safe-regex.ts` contained a raw NUL byte in a string literal, so git classified the file as binary and a security-critical screen has had unreviewable diffs since it was written. Replaced with the `\0` escape, which is the same value.
- The release workflow runs the CI matrix before publishing. Its verify job was a single `ubuntu-latest`, node 22 run while CI covers five combinations, so the publish gate was weaker than the gate on an ordinary pull request. `v0.2.0` released green while its CI run was red on Windows.
- `lintText` tolerates a ruleset assembled without `readability`. It is the package's public entry point, and a pre-0.2.0 ruleset from a consumer threw instead of linting.

## [0.3.0] - 2026-08-07

### Added

- `explain` reaches every rule in the ruleset. It listed the 30 word and punctuation rules only, so the nine sentence shapes and the two readability rules had no way to be inspected from the command line while the README said they were listed. `explain unglossed-term` and `explain binary-contrast` now work, and the listing is grouped by kind.
- A Readability section in the generated `docs/writing-style.md`. Both readability rules ship `link: ...writing-style.md#readability`, an anchor that did not exist, so every readability finding printed a dead link.
- The acknowledgement file the refusal message advertises is now read. `touch .claude/.docs-plain-english-ack` waives that channel for ten minutes and then expires. It had been named in the message for three releases with nothing checking for it, so the advice was inert and the only real escape from a false positive was editing config.

### Changed

- The README is rewritten. It described the tool as it stood before 0.1.0: it did not mention the readability rules or the output style, it pinned `v0.1.0` in the pre-commit and Action snippets (a tag that was never pushed), it said `explain` listed the sentence shapes, and it said every channel blocks the write when the default has been advisory since 0.1.0. It now separates rule severity, the printed label and `failOn`, which are three vocabularies for two ideas and the main reason the old text was hard to follow.
- `--claude-code` is out of the usage text. `init` has always written the hooks unconditionally and never read the flag, so listing it implied a second mode that never existed. The flag is still accepted, so the command published in earlier READMEs keeps working.
- The "what is never scanned" list in the generated guide is accurate and complete. It appeared in three places with three different contents; the two hand-written copies now link to the generated one.

### Fixed

- `rules/schema.json` accepts the configuration the loader accepts. It was missing `failOn`, `readability`, `perThousandWords` and `link` while declaring `additionalProperties: false`, so an editor validating against it would have rejected this repo's own config. A test now holds the schema and the loader together.
- `docs/adopting.md` no longer says a project config is all `init` writes, no longer pins the missing `v0.1.0` tag, and no longer claims chat enforcement rests on a `CLAUDE.md` note alone.

## [0.2.0] - 2026-08-07

### Added

- Readability rules, a new rule kind measured over sentence structure rather than matched at a point. `unglossed-term` reports an acronym or camel-cased name on first use when nothing has explained it. `long-sentence` reports past 35 words. Both are warnings.
- A term introduced together with its explanation is not reported. "The identity check is called OIDC", "known as SLSA", "OIDC stands for OpenID Connect" and a parenthetical expansion all count as glosses.
- A `known` list of names a reader already has, so the rule does not fire on GitHub, TypeScript, JSON or MIT. A project's own `known` entries add to the defaults instead of replacing them, and are separate from `allow`, which suppresses every rule on a matching line.
- `integrations/claude-code/output-styles/plain-english.md`, generated from the same ruleset and covered by the drift check. This is the first artifact that reaches chat replies.
- `.plain-english.yml` at the repo root, so linting this repo no longer depends on whatever config sits in a developer's home directory.

### Changed

- Sentence segmentation comes from `retext-english` through `mdast-util-to-nlcst`, so a sentence never splits on `e.g.` or a version number, and code, tables, link destinations and blockquotes never reach the readability layer.
- `docs/limitations.md` and the README no longer claim that nothing can reach chat output. The `MessageDisplay` hook can, and the entry now records what it does, what it cannot do, and that its documented input schema disagrees with the shipped binary.

## [0.1.2] - 2026-08-06

Supersedes 0.1.1, which was tagged but never published.

### Fixed

- `init` no longer writes an absolute filesystem path into `.claude/settings.json`. That file is usually committed, so the machine's own directory layout was breaking the file for every other contributor and leaking a local path into what may be a public repo. The prompt never needed it: the command hook scopes by path and its `if` rule scopes by file type, both before the prompt runs. Two people running `init` on the same project now get byte-identical settings.

## [0.1.1] - 2026-08-06

### Fixed

- The generated semantic prompts now state that a pass is the normal answer, forbid returning a failure whose own reason says the content is acceptable, and report only the single clearest problem. Without these, a prompt asked to find patterns finds patterns: one document was refused twelve times in a row, twice on wording the model had proposed a turn earlier, and once after reasoning that no violation existed.
- The prompts no longer restate the banned word list. The deterministic layer has already checked every term by the time a prompt runs, so the prompt judges sentence shapes, which is the part a regex cannot reach.
- `workflow_dispatch` on the release workflow could never reach the publish job, because the tag check compared `main` against the package version. The check now runs only on a tag push.
- CI cancels superseded runs instead of queueing them.

## [0.1.0] - 2026-08-06

### Added

- Markdown parsing with mdast. Code blocks, inline code, tables and link destinations are structurally excluded, so a banned term inside any of them is not a finding.
- Rate-based rules via `perThousandWords`, and an `em-dash-density` rule shipped at `severity: off`.
- Range suppression (`<!-- plain-english-disable -->` and `enable`), completing the three tiers alongside next-line and whole-file.
- Per-rule `link` field, shown with findings and rendered into the generated guide.
- `--version` and a `doctor` subcommand for bug reports.
- `docs/limitations.md`, covering the published false-positive rate against non-native English writers, dialect exposure in the word list, English-only scope, signal decay, and the semantic layer's false-positive floor.
- Packaging gate in CI: `publint`, `@arethetypeswrong/cli`, and a tarball installed into a clean project and run.
- Windows and macOS in the test matrix.

### Changed

- Findings are warnings by default and the run exits 0. Blocking is opt-in via `failOn: error` or `--fail-on error`.
- The Claude Code adapter emits `permissionDecision: "ask"` for style findings, reserving `deny` for strict mode.
- `init` emits `if: "Write(*.md)"` permission-rule scoping.
- Package renamed to the unscoped `plain-english`.
- Minimum Node is 20.

### Fixed

- Configuration patterns are screened for catastrophic backtracking at load, and matching carries a deadline. A rule of `(a+)+$` against 30 characters previously ran for 142 seconds.
- `allow` matches the surrounding line. It was tested against the matched term alone, so a project vocabulary list suppressed nothing and the shipped example config was inert.
- Unknown configuration keys error with a suggestion instead of being ignored.
- HTML `<pre>` and `<code>` blocks, TOML frontmatter, footnote definitions, and four-space-indented list continuation prose are all handled correctly.
- Em dash variants are caught: HTML entities, the fullwidth dash, the horizontal bar, and a zero-width space inside a word.
- Suppression directives are read from a view with code fences blanked, so an example directive in the documentation is no longer live. The generated style guide was disabling itself.
- CI jobs build before running the CLI.

[Unreleased]: https://github.com/nordscope-fi/plain-english/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.1
[0.3.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.0
[0.2.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.2.0
[0.1.2]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.2
[0.1.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/plain-english/v/0.1.0
