# plain-english

Catch AI writing tells before they land in a commit, a doc, or an issue somebody else
reads. Hooks into Claude Code, Copilot, Codex and Cursor; runs anywhere else as a
command.

## Two problems, one tool

**Prose that reads as machine-generated.** AI-generated text reuses a small set of words
and a handful of sentence shapes. That set is short enough to check exactly.

**Prose nobody can follow.** A different complaint, and the more common one. It usually
turns out not to be about length. This sentence is 26 words, which is ordinary:

> The OIDC trusted publisher attaches SLSA provenance to the tarball at publish time,
> which the registry verifies against the workflow identity asserted by the id-token
> claim.

Nothing in it was ever explained. Five names arrive with no gloss, and the reader carries
all five to the end. Length is not the fault here. The rule that catches it counts how
many terms arrived unexplained.

```
$ plain-english lint docs/

docs/onboarding.md
     3:1   block  "Furthermore" (furthermore)  Start the sentence with its own point.
     3:27  block  "boasts" (boasts)  State the number without the verb: 'uptime is 99.9%'.
     3:36  block  "seamless" (seamless)  Say what actually happens, or cut the word.
     4:1   block  "leverage" (leverage)  Use 'use'.
     6:5    warn  "OIDC" (unglossed-term)  "OIDC" is not explained. Say what it does, then name it.
     6:37   warn  "SLSA" (unglossed-term)  "SLSA" is not explained. Say what it does, then name it.

4 blocking, 2 warnings across 2 files
```

## Install

```bash
npm install -D plain-english
npx plain-english lint .
```

No config needed to start. `.plain-english.yml` is optional.

## What a finding actually does

Nothing, by default. The run above exits 0.

Three settings decide the outcome, and they are easy to confuse because two of them use
different words for the same thing:

| | Values | Meaning |
|---|---|---|
| Rule severity, in config | `error`, `warn`, `off` | how seriously the rule takes itself |
| Label, in the output | `block`, `warn` | the same two levels, printed |
| `failOn`, in config | `never`, `error`, `warn` | what happens as a result |

`failOn` defaults to `never`, so a finding labelled `block` reports and exits 0. The label
names the rule's tier. What happens as a result is `failOn`'s job. Set `failOn: error` to
make blocking findings fail the build and refuse a write, or `failOn: warn` to fail on
everything.

Blocking is opt-in on purpose. A gate that fires on day one, before anyone has tuned the
config for their vocabulary, is a gate people learn to route around.

## What makes this different from a grep

**Non-prose is never scanned.** Code, frontmatter, blockquotes, link targets and tables
are blanked before matching, so a sample calling `leverage()` is not a finding and neither
is a customer quote. The exact list is in
[`docs/writing-style.md`](docs/writing-style.md#what-is-never-scanned).

**Words with a real technical sense do not block.** `silently`, `quietly`, `mechanical`,
`holistic` and `dive into` warn instead. Rules also carry exceptions, so `fails silently`,
`silently drops`, `mechanical keyboard`, `leveraged buyout` and `load-bearing wall`
produce nothing at all.

**You can escape a finding at five scopes**, narrowest first:

```markdown
<!-- plain-english-disable-next-line leverage -->   one line, one rule
<!-- plain-english-disable leverage -->             a range, until
<!-- plain-english-enable -->
<!-- plain-english-disable-file -->                 the whole file
```

Plus an `exclude` glob and a severity downgrade in config. Every one of these came from a
false positive in the version this replaces.

## The rules

`plain-english explain` lists all of them. `plain-english explain <id>` shows one, with
its pattern, its exceptions and its rewrite hint.

### Words and punctuation (30)

Stock transitions, corporate verbs, buzzwords, AI self-reference, and three punctuation
rules. Deterministic, tested, and the only tier that can fail a build.

### Sentence shapes (9)

A regex cannot reach these. The optional semantic layer asks a model, using prompts
generated from the same ruleset.

| Shape | Bad | Good |
|---|---|---|
| Binary contrast | "This isn't just a bug. It's a trust problem." | "This bug will make people distrust the report." |
| Throat-clearing | "Here's the thing: the deal stalled because..." | "The deal stalled because..." |
| Weasel attribution | "Experts agree this is best practice." | Name the source, or drop the claim. |
| Fake-strong verbs | "This property serves as a centralized hub for deal stage." | "This property stores the deal stage." |

### Readability (2)

These read the shape of a sentence, so there is no term to match. Both are warnings.

- `unglossed-term` fires on an acronym or camel-cased name used before it is explained,
  on first use only. A term that arrives with its gloss is never reported: "is called X",
  "known as X", "X stands for Y" and a parenthetical expansion all count. About eighty
  names a reader already has, such as JSON and GitHub, are exempt by default.
- `long-sentence` fires past 35 words. Set generously, so that dense but explained
  writing is left alone.

Full list: [`docs/writing-style.md`](docs/writing-style.md), generated from the ruleset.

## Where it runs

| Channel | Deterministic | Semantic |
|---|---|---|
| Markdown files | `plain-english lint`, or a hook in your agent | agent prompt hook |
| Commit messages | pre-commit hook, or an agent hook | agent prompt hook |
| PR and issue bodies | GitHub Action, or an agent hook | agent prompt hook |
| Issue tracker (Linear-shaped tool calls) | agent hook | agent prompt hook |
| Editor diagnostics | `--format unix` or `--format sarif` | none |
| A chat reply | `AGENTS.md`, or a Claude Code output style | none |

Under the default `failOn: never`, an agent hook surfaces a finding and lets you decide.
Under `failOn: error` it refuses the write outright. The semantic layer rides on a prompt
hook, which today only Claude Code provides.

### Coding agents

```bash
npx plain-english init --agent claude-code   # default
npx plain-english init --agent copilot
npx plain-english init --agent codex
npx plain-english init --agent cursor
npx plain-english init --agent all
```

Each writes that agent's hook config, merging into whatever is already there without
disturbing it, plus a generated `AGENTS.md` section and a starter `.plain-english.yml`.
Run it twice and nothing changes the second time. Add `--dry-run` to see first.

The hooks cover file writes, `Bash` (commit and `gh` invocations, including message files
passed with `-F` or `--body-file`), and Linear-shaped `save_issue` / `save_comment` calls.
Only the inserted side of an edit is judged, so you can still edit a file that already
contains a banned term.

Claude Code's hook contract became the shape everyone copied. That is why four agents
cost four translation tables and not four linters.

[`docs/agents.md`](docs/agents.md) has the per-agent detail. Two caveats are worth
knowing before you rely on a hook: Copilot's cloud agent turns an `ask` into a `deny`,
and Codex will not run a hook until you approve it with `/hooks`.

Under the default `failOn: never` the finding is advisory. Claude Code and Copilot surface
it and let you decide; Codex and Cursor parse and discard that request, so on those the
finding is fed back to the model as text instead.
[`docs/agents.md`](docs/agents.md) has the table.

If a finding is wrong and you need past it once, `touch .plain-english-ack-docs` waives
that channel for ten minutes, then expires on its own. It silences the advisory too.

If a hook is not firing, or is firing and reading nothing, set
`PLAIN_ENGLISH_RECORD=./captures` and run the agent again. Each call writes one redacted
JSON file describing what arrived, which is what an adapter bug report needs.

### Agents with no adapter

Not every agent has a hook this package speaks, and some have none at all. Three things
work regardless:

- **`AGENTS.md`**, written by `init`. Roughly twenty agents read it. It shapes behaviour
  and enforces nothing.
- **A post-edit lint command.** Most agents can be told to run a command after editing and
  act on the output. [`docs/post-edit-lint.md`](docs/post-edit-lint.md) has the config for
  aider, Claude Code, Cursor and Codex.
- **Editor diagnostics.** Several agents read their editor's Problems list. Findings
  reach it as `path:line:col` text, or as SARIF (Static Analysis Results Interchange
  Format). [`docs/editors.md`](docs/editors.md) covers both.

### The Claude Code output style

Hooks sit on tool calls. A chat reply is not a tool call, so nothing can gate one. What
reaches chat instead is an output style, generated from the same ruleset:

```bash
mkdir -p .claude/output-styles
cp node_modules/plain-english/integrations/claude-code/output-styles/plain-english.md \
   .claude/output-styles/
```

Then run `/config` and pick it under **Output style**. (The standalone `/output-style`
command was removed in Claude Code v2.1.91.) It is a prompt, so nothing measures
compliance, and it does not reach subagents, which run their own system prompt.
[`docs/limitations.md`](docs/limitations.md) covers both.

Elsewhere the portable equivalent is the `AGENTS.md` section, which `init` writes for
every agent.

### pre-commit

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v0.4.0
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

### GitHub Actions

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v0.4.0
  with:
    paths: docs README.md    # default: .
    fail-on: warn            # default: error
    check-pr-body: "true"    # default: false
    version: latest          # pin to a release to freeze the ruleset
    sarif-file: pe.sarif     # default: none. Upload it yourself; the step
                             # needs security-events: write.
```

The action defaults to `fail-on: error`, unlike the command line, which defaults to
`never`. Failing a build is the reason to add the action, so it starts strict.

## Config

`.plain-english.yml` at the repo root. A project adds vocabulary and exclusions on top of
the built-in set, and still gets upstream rule fixes.

```yaml
version: 1
extends: default            # never fork the ruleset

failOn: never               # never (default) | error | warn

allow:                      # suppresses every rule on a matching line
  - "\\bMRR\\b"
  - "hs_[a-z_]+"

exclude:                    # files skipped entirely
  - "docs/writing-style.md"
  - "CHANGELOG.md"

rules:                      # adjust without copying the file
  - id: showcase
    severity: warn
  - id: load-bearing
    severity: off
  - id: leverage
    unless:                 # add a domain exception
      - "\\bleverage\\s+ratio\\b"

readability:
  - id: unglossed-term
    known:                  # adds to the defaults, does not replace them
      - RevOps
      - ARR
```

`allow` and `known` are separate on purpose. `allow` silences every rule on any line it
matches, so putting a name there would also hide an em dash on the same line. `known`
silences only `unglossed-term`.

An unknown key is a hard error with a suggestion. A typo'd `allowlist:` used to suppress
nothing while looking like it worked.

See [`examples/revops.yml`](examples/revops.yml) for a filled-in config, and
[`docs/adopting.md`](docs/adopting.md) for a rollout order that does not annoy everyone.

## CLI

```
plain-english lint [PATH...]       lint files or directories (default: stdin)
plain-english render               regenerate docs/ and prompt templates
plain-english explain [RULE]       show a rule, or list them all
plain-english doctor               environment dump for bug reports
plain-english init                 wire this repo up
plain-english hook <CHANNEL>       pre-tool-call adapter (docs|github|issue)

LINT OPTIONS
  --format text|json|unix|github|sarif
                                     output shape (default: text).
                                     unix is path:line:col for editors.
  --fail-on never|error|warn         exit-code threshold (default: never)

RENDER OPTIONS
  --check                            exit 1 if generated files are stale
  --root PATH                        repo root (default: cwd)

INIT OPTIONS
  --agent ID                         claude-code (default), copilot, codex,
                                     cursor, or all
  --dry-run                          print what would change
  --root PATH                        repo root (default: cwd)

HOOK OPTIONS
  --agent ID                         which agent's protocol to speak.
                                     Detected from the payload when omitted.
  --event pre|post                   pre refuses before the write, post tells
                                     the model after it (default: pre)

  --version                          print the version and exit

Set PLAIN_ENGLISH_RECORD=<dir> to write each hook payload there, redacted, for
reporting an adapter bug. Add --record-verbatim only for a payload you wrote
yourself.
```

Exit codes: 0 clean or advisory, 1 a finding at or above `failOn`, 2 a bad path or a
config error. `--format github` emits CI annotations, `--format unix` feeds an editor
and `--format sarif` feeds GitHub code scanning. Attach `doctor` output to a bug
report.

## One hand-written source

`rules/default.yml` is edited by hand. `plain-english render` generates six files from it:

- `docs/writing-style.md`
- `integrations/agents-md/plain-english.md`
- `integrations/claude-code/output-styles/plain-english.md`
- `integrations/claude-code/prompts/{docs,github,issue}.txt`

CI fails if any of them drift, which keeps the docs, the regexes, the prompt text and the
output style saying the same thing. Never edit a generated file; edit the ruleset and
re-render.

Adding a rule means adding a corpus case that blocks and a case that exercises its
exceptions. `npm test` refuses to pass if a rule has neither.

## How this relates to other tools

The rules here are not original, and the sources are worth reading directly.

| Project | What it is |
|---|---|
| [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) | The canonical catalogue of these patterns, maintained by WikiProject AI Cleanup. Describes itself as observations, not rules. |
| [stop-slop](https://github.com/hardikpandya/stop-slop) | A skill file that tells a model what to avoid writing. Generation side. |
| [Vale](https://github.com/errata-ai/vale) | A general prose linter with a much larger rule surface and a style-package ecosystem. |
| [textlint](https://github.com/textlint/textlint), [alex](https://github.com/get-alex/alex) | Pluggable prose linting on the unified stack. |

stop-slop and the Wikipedia list describe the patterns. This runs them against text that
already exists, deterministically, with a test corpus and an exit code. To make a model
write better in the first place, use a skill file or the output style above. To check what
landed, use this.

For general prose linting beyond AI tells, use Vale. It is a bigger tool and it is very
good.

## Contributing

Every bug that reaches a user becomes a permanent fixture in
`test/corpus/regressions.yml`. A case in `test/corpus/cases.yml` is a complete bug report
for a false positive.

Adding a fifth agent, or checking an existing one against a live binary, is
[`docs/verifying-an-adapter.md`](docs/verifying-an-adapter.md). It is worth
reading first: four adapters were written from vendor documentation, and four
defects were later found in them.

```bash
npm ci
npm run build                             # render and the exit-code tests need dist/
npm test
npm run render && git diff --exit-code    # generated files must be current
npm run lint:self                         # this repo passes its own linter
```

## Limitations

[`docs/limitations.md`](docs/limitations.md) covers what this gets wrong and who it gets
wrong for: the published false-positive rate against non-native English writers, dialect
exposure in the word list, English-only scope, and why the signal decays. Read it before
turning on blocking.

## Design notes

[`docs/design-rationale.md`](docs/design-rationale.md) covers why the checks run before
the write, why there are two layers, and the calibration problem the semantic layer has.

## Licence

MIT.
