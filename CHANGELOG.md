# Changelog

Notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.1
[0.1.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.0
