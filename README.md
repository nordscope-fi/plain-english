# plain-english

Catch AI writing tells before they land in a commit, a doc, or an issue somebody else reads.

AI-generated prose reuses about thirty words and a handful of sentence shapes. This linter combines a word list with a semantic layer that understands technical usage.

```
$ plain-english lint docs/

docs/onboarding.md
     3:12  block  "-" (em-dash)            Use a comma, parentheses, or a full stop.
    11:1   block  "Furthermore" (furthermore)  Start the sentence with its own point.
    24:31  block  "leverage" (leverage)    Use 'use'.
    31:8    warn  "holistic" (holistic)    Say which parts you mean.

3 blocking, 1 warning across 6 files
```

## Install

```bash
npm install -D @nordscope/plain-english
npx plain-english lint .
```

No config needed to start. `.plain-english.yml` is optional.

## What makes this different from a grep

**Non-prose is never scanned.** Fenced and indented code, inline code spans, YAML frontmatter, blockquotes, URLs, link targets and HTML comments are blanked before matching. A code sample calling `leverage()` is not a finding. Neither is a customer quote in a blockquote.

**Words with a real technical sense do not block.** `silently`, `quietly`, `mechanical`, `holistic` and `dive into` warn instead. A rule can also carry exceptions, so `fails silently`, `mechanical keyboard`, `leveraged buyout` and `load-bearing wall` produce nothing at all.

**You can escape a finding at four scopes.** One line and one rule:

```markdown
<!-- plain-english-disable-next-line leverage -->
```

There is also a whole-file directive, an `exclude` glob, and a severity downgrade in config.

Each of those three came from a false positive in the version this replaces.

## Sentence shapes

The semantic layer detects nine sentence shapes. They are defined in `rules/default.yml`, each with a bad and a good example. `plain-english explain` lists them.

| Shape | Bad | Good |
|---|---|---|
| Binary contrast | "This isn't just a bug. It's a trust problem." | "This bug will make people distrust the report." |
| Throat-clearing | "Here's the thing: the deal stalled because..." | "The deal stalled because..." |
| Weasel attribution | "Experts agree this is best practice." | Name the source, or drop the claim. |
| Fake-strong verbs | "This property serves as a centralized hub for deal stage." | "This property stores the deal stage." |

Full list: [`docs/writing-style.md`](docs/writing-style.md), generated from the ruleset.

## Where it runs

| Channel | Deterministic | Semantic |
|---|---|---|
| Markdown files | `plain-english lint` | Claude Code prompt hook |
| Commit messages | pre-commit hook, or Claude Code hook | Claude Code prompt hook |
| PR and issue bodies | GitHub Action, or Claude Code hook | Claude Code prompt hook |
| Issue tracker (Linear-shaped MCP calls) | Claude Code hook | Claude Code prompt hook |
| A chat reply | none | none |

Chat replies are not checked. Every other channel blocks the write until it passes, since a commit or PR cannot be un-sent.

### Claude Code

```bash
npx plain-english init --claude-code
```

That writes three shim hooks, merges the hook blocks into your existing `.claude/settings.json` without disturbing anything already there, and drops a starter config. Run it twice and nothing changes the second time. Use `--dry-run` first.

The generated hooks cover `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` (commit and `gh` invocations, including message files passed with `-F` or `--body-file`), and Linear-shaped `save_issue` / `save_comment` calls.

### pre-commit

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v0.1.0
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

### GitHub Actions

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v0.1.0
  with:
    paths: docs README.md
    check-pr-body: "true"
```

## Config

`.plain-english.yml` at the repo root. A project can add vocabulary and exclusions on top of the built-in set, and you still get upstream rule fixes.

```yaml
version: 1
extends: default

allow:                      # your vocabulary, never flagged
  - "\\bMRR\\b"
  - "hs_[a-z_]+"

exclude:                    # skipped entirely
  - "docs/writing-style.md"
  - "CHANGELOG.md"

rules:                      # adjust without copying the file
  - id: showcase
    severity: warn
  - id: load-bearing
    severity: off
```

Severities are `error` (blocks, exit 1), `warn` (reported, exit 0) and `off`.

## CLI

```
plain-english lint [PATH...]     files, directories, or stdin with "-"
plain-english explain [RULE]     show one rule, or list them all
plain-english render             regenerate docs and prompt templates
plain-english init               wire up this repo
plain-english hook <CHANNEL>     PreToolUse adapter (docs|github|issue)

  --format text|json|github      github emits CI annotations
  --fail-on error|warn|never
```

## One hand-written source

`rules/default.yml` is edited by hand. `docs/writing-style.md` and the semantic prompt bodies are generated from it. CI fails if they drift, keeping the docs, regexes, and prompt text in sync.

Adding a rule means adding a corpus case that blocks and a case that exercises its exceptions. `npm test` refuses to pass if a rule has neither.

## Contributing

Every bug that reaches a user becomes a permanent fixture in `test/corpus/regressions.yml`. If you find a false positive, a case in `test/corpus/cases.yml` is a complete bug report.

```bash
npm ci && npm test
npm run render && git diff --exit-code    # generated files must be current
```

## Design notes

[`docs/design-rationale.md`](docs/design-rationale.md) covers why the checks block before the write, why there are two layers, and the calibration problem the semantic layer has.

## Licence

MIT.
