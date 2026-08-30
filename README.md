# plain-english

[![npm](https://img.shields.io/npm/v/plain-english.svg)](https://www.npmjs.com/package/plain-english)
[![CI](https://github.com/nordscope-fi/plain-english/actions/workflows/ci.yml/badge.svg)](https://github.com/nordscope-fi/plain-english/actions/workflows/ci.yml)
[![licence](https://img.shields.io/npm/l/plain-english.svg)](LICENSE)

Catch stock AI phrases, vague claims, and unexplained jargon before readers see them.

`plain-english` checks prose in much the same way that a code linter checks source files.
It reports the exact passage, the rule it broke, and a direct rewrite hint.
It checks Markdown and plain text.

```text
docs/onboarding.md
  3:1   block  "Furthermore" (furthermore)  Start the sentence with its own point.
  3:27  block  "boasts" (boasts)  State the number without the verb.
  6:5    warn  "OIDC" (unglossed-term)  Explain what "OIDC" does before naming it.

2 blocking, 1 warning across 1 file
```

This is a style checker, not an authorship detector. It finds configured patterns no
matter who wrote them.

## Try it

```bash
npm install -D plain-english
npx plain-english lint .
```

Node 20 or newer is required. The first run needs no config. Blocking is opt-in. You can
tune the rules before they stop a build.

To make blocking findings return a failing exit code, add `.plain-english.yml`:

```yaml
version: 1
extends: default
failOn: error
```

Use `failOn: warn` to fail on warnings too. Use `failOn: never` to keep every run
advisory.

## What it checks

The built-in rules cover:

- stock transitions and filler, such as an opener that announces the conclusion;
- corporate verbs and vague claims that should name a concrete result;
- punctuation patterns strongly associated with generated prose;
- acronyms and product names used before they are explained;
- sentences that are long or show little variation across a document;
- suppressions that give no reason.

`plain-english explain` lists every rule. Pass a rule name to see its match, exceptions,
severity, and rewrite hint:

```bash
npx plain-english explain
npx plain-english explain unglossed-term
```

The normal scan is deterministic. An optional model-backed check covers sentence shapes
that regular expressions cannot judge, such as vague attribution and canned contrasts.
Agent support for that check varies. [The agent guide](docs/agents.md) records what each
integration can run.

## What it ignores

The scanner removes code, frontmatter, blockquotes, link targets, and tables before it
checks prose. A code sample that contains a banned word will not produce a finding.

Rules also include exceptions for valid technical uses. For example, a financial term
can pass while the same word used as a vague business verb can fail.

[The generated rule guide](docs/writing-style.md) lists the full ruleset, its exceptions,
and everything excluded from scanning.

## Add it to a coding agent

`init` adds the selected agent's hooks, a local launcher, project instructions, and a
starter config. It merges with files that already exist.

```bash
npx plain-english init --agent codex --dry-run
npx plain-english init --agent codex
```

The dry run shows the diff first.

Supported names are `claude-code`, `copilot`, `codex`, `cursor`, `vibe`, `gemini`, and
`qwen`. Use `--agent all` to install every profile.

The hooks can check file edits, commit and pull request text, issue text, and completed
chat replies. Each agent exposes different hook events and trust controls. Read
[the agent guide](docs/agents.md) before relying on a hook as a gate.

For agents without a profile, run the linter after each edit. The
[post-edit guide](docs/post-edit-lint.md) gives a portable setup.

## Add it to a build

### GitHub Actions

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v1.0.0
  with:
    paths: docs README.md
    fail-on: error
    check-pr-body: "true"
```

The action fails on blocking findings by default. It can also emit a findings file for
GitHub code scanning. [The adoption guide](docs/adopting.md) covers a staged rollout.

### pre-commit

If the repository already uses [pre-commit](https://pre-commit.com), add:

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v1.0.0
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

## Configure project vocabulary

Keep the built-in rules with `extends: default`, then add only the project-specific
differences:

```yaml
version: 1
extends: default
failOn: error

exclude:
  - "docs/reference/**"
  - "CHANGELOG.md"

rules:
  - id: showcase
    severity: warn
  - id: load-bearing
    severity: off
    reason: structural engineering term in this repository

readability:
  - id: unglossed-term
    known:
      - RevOps
      - ARR
```

Use a narrow allowance when one rule should ignore a project term:

```yaml
allow:
  - pattern: "\\bMRR\\b"
    rules: [unglossed-term]
    semantic: true
```

A bare pattern suppresses every rule on a matching line. Naming the affected rules avoids
hiding unrelated findings. Check the cost of each allowance with:

```bash
npx plain-english lint --show-suppressed
```

A complete example lives in [`examples/revops.yml`](examples/revops.yml).

## Suppress one passage

Every suppression needs a reason after the colon.

```markdown
<!-- plain-english-disable-next-line leverage: finance term -->
<!-- plain-english-disable leverage: quoted customer wording -->
Text in the disabled range.
<!-- plain-english-enable -->
<!-- plain-english-disable-file: generated reference -->
```

Use project config for a repeated exception. Use a comment for a passage that should stay
unusual and visible to the next reader.

## Other commands

| Command | Purpose |
|---|---|
| `plain-english lint --chat --summary` | Check local agent transcripts and separate main replies from subagent replies. |
| `plain-english policy` | Write a policy page from the active config and installed hooks. |
| `plain-english policy --check` | Fail when that generated policy no longer matches the repo. |
| `plain-english doctor` | Print the environment details needed for a hook bug report. |
| `plain-english render --check` | Check that generated rules and agent instructions are current. |
| `plain-english --help` | Show all commands, formats, and exit behaviour. |

Chat transcripts can contain file contents, command output, and pasted text. Keep
`lint --chat` on the local machine. Do not run it in a build.

## Limits

The rules are opinionated and English-only. False positives are expected. Some words in
the list are normal in a dialect, profession, or second-language writing style. The tool
cannot prove that text came from a model.

Read [the limitations](docs/limitations.md) before turning on blocking for a team. That
page also states which parts of chat each agent integration cannot reach.

## Contributing

```bash
npm ci
npm run build
npm test
npm run render && git diff --exit-code
npm run lint:self
```

Rules live in `rules/default.yml`. Generated guides and agent files should not be edited
by hand. A rule change needs corpus cases for the finding and its valid exceptions.

See [the documentation index](docs/README.md) for agent verification, design decisions,
editor output, and release notes.

## Licence

MIT.
