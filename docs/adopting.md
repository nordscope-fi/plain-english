# Adopting plain-english

A checklist for putting this in front of a repo that already has writing in it.

## 1. See where you stand before turning anything on

```bash
npx plain-english lint . --fail-on never
```

`--fail-on never` reports without exiting non-zero. On an existing repo the first run is usually noisy, and most of the noise tells you something about the ruleset rather than about your writing.

## 2. Sort the findings into three piles

| Finding | Fix |
|---|---|
| Real AI tell | Rewrite the sentence. |
| A file that quotes the banned list on purpose | Add it to `exclude`. |
| A word used in its real technical sense | Add an `unless` clause upstream, or lower the rule to `warn`. |

The third pile is the interesting one. If a word blocks you more than twice for a legitimate reason, it is miscalibrated. Open an issue with the sentence, since that is a complete bug report.

## 3. Write a project config

```bash
npx plain-english init
```

That drops a starter `.plain-english.yml`. Fill in the vocabulary your readers already use daily:

```yaml
version: 1
extends: default

allow:
  - "\\bMRR\\b"
  - "\\bpicklist\\b"
  - "hs_[a-z_]+"

exclude:
  - "docs/writing-style.md"
  - "CHANGELOG.md"
  - "docs/verbatim-quotes/**"
```

`extends: default` matters. A copied ruleset stops receiving upstream fixes on the day you copy it.

See `examples/revops.yml` for a filled-in example.

## 4. Turn it on in CI before turning it on locally

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v0.1.0
  with:
    paths: docs README.md
    fail-on: warn      # start loud, tighten later
```

CI gives you a week of real data at no cost to anybody's flow. A gate that blocks writes on day one, before the config is tuned, is a gate people learn to route around.

## 5. Add the write-time hooks

```bash
npx plain-english init --claude-code --dry-run
npx plain-english init --claude-code
```

Always dry-run first against a repo with an existing `.claude/settings.json`. The merge preserves unrelated hooks under the same matcher, and the dry run tells you how many it found.

For git, without Claude Code:

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v0.1.0
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

## 6. Point your agent instructions at the generated guide

Add a short section to `CLAUDE.md`, `AGENTS.md`, or whatever your tooling reads:

```markdown
## Writing style

No em dashes. No AI-tell words or sentence shapes.
Full ruleset: docs/writing-style.md
```

Keep it short. The generated guide holds the detail, and a summary that drifts from it is worse than a pointer.

## 7. Know which channel is unguarded

A chat reply has no tool call between being written and being read, so no hook can sit in that path. Enforcement there rests on the instruction in step 6 alone. Everything else blocks before the write lands.

## Common problems

**The whole repo lights up on the first run.** Expected. Work through step 2 before changing any rule severity, since most of it is usually two or three files that quote the list.

**A rule blocks a word your industry uses.** Lower it to `warn` in your config and open an issue upstream with the sentence. A rule that is wrong for you is usually wrong for others.

**The semantic hook keeps refusing text that looks fine.** It has a false-positive floor above zero. If it refuses the same passage more than twice while proposing contradictory rewrites, it is looping. Take the deterministic result as authoritative and move on. `docs/design-rationale.md` covers why.

**Someone is running the whole-file directive routinely.** Treat that as a calibration signal, not a discipline problem.
