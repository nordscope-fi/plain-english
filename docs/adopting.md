# Adopting plain-english

A checklist for putting this in front of a repo that already has writing in it.

## 1. See where you stand before turning anything on

```bash
npx plain-english lint .
```

Nothing is turned on yet: the default reports every finding and exits 0.

On an existing repo the first run is usually noisy. Most of that noise tells you something about the ruleset, not about your writing.

## 2. Sort the findings into four piles

| Finding | Fix |
|---|---|
| Real AI tell | Rewrite the sentence. |
| A file that quotes the banned list on purpose | Add it to `exclude`. |
| A word used in its real technical sense | Add an `unless` clause upstream, or lower the rule to `warn`. |
| `unglossed-term` on your own domain vocabulary | Add the name to `known`. |

The third pile is the interesting one. If a word blocks you more than twice for a legitimate reason, it is miscalibrated. Open an issue with the sentence, since that is a complete bug report.

The fourth is the cheapest. Every industry has fifty acronyms its readers know cold, and `known` is where you declare them once.

## 3. Write a project config

```bash
npx plain-english init --agent claude-code --dry-run
npx plain-english init --agent claude-code
```

Swap the id for `copilot`, `codex` or `cursor`, or pass `all`. `claude-code` is the default if you leave the flag off.

`init` wires up the whole repo in one step: that agent's hook config merged into whatever is already there, a generated `AGENTS.md` section, and a starter `.plain-english.yml` if you have none. Claude Code additionally gets three shims under `.claude/hooks/`. The hooks arrive advisory, so nothing starts refusing writes today. Step 5 says when to change that.

[`docs/agents.md`](agents.md) has the per-agent detail. Three caveats are worth reading before you rely on a hook. Copilot's CLI does not read the repository file, so it needs `init --agent copilot --user` as well ([why](agents.md#what-a-live-copilot-session-showed)). Copilot's cloud agent turns an `ask` into a `deny`. And Codex needs two separate approvals before a hook runs ([which two](agents.md#openai-codex-cli)).

Fill in the vocabulary your readers already use daily:

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

readability:
  - id: unglossed-term
    known:
      - RevOps
      - ARR
      - ICP
```

`extends: default` matters. A copied ruleset stops receiving upstream fixes on the day you copy it.

See `examples/revops.yml` for a filled-in example.

## 4. Turn it on in CI before turning it on locally

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v0.7.3
  with:
    paths: docs README.md
    fail-on: warn      # start loud, tighten later
```

CI gives you a week of real data at no cost to anybody's flow. A gate that blocks writes on day one, before the config is tuned, is a gate people learn to route around.

## 5. Decide when the hooks start refusing writes

Step 3 already installed them. This step is the one line of config that changes what they do.

Under the default `failOn: never` a hook surfaces a finding and lets the human decide. Under `failOn: error` it refuses the write. The same three hooks are advisory or blocking depending on that setting, so tighten it once CI has been quiet for a week.

Always dry-run first against a repo that already has a hooks file. The merge preserves unrelated hooks, and the dry run tells you how many it found.

For git, whatever your agent:

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v0.7.3
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

## 6. Check the AGENTS.md section init wrote

`init` splices a generated section into `AGENTS.md` between markers, creating the file if you had none. Roughly twenty agents read that file, so it is the one instructions artifact that is worth maintaining. Re-running `init` replaces what is between the markers and leaves the rest of your file alone.

If your tooling reads `CLAUDE.md` instead, point it at the same place rather than restating the rules:

```markdown
## Writing style

See the Writing style section in AGENTS.md.
Full ruleset: docs/writing-style.md
```

A summary that drifts from the generated guide is worse than a pointer.

## 7. Install the output style, and know what it cannot do

A chat reply has no tool call between being written and being read, so no linting hook can sit in that path. What reaches chat instead is an output style, generated from the same ruleset:

```bash
mkdir -p .claude/output-styles
cp node_modules/plain-english/integrations/claude-code/output-styles/plain-english.md \
   .claude/output-styles/
```

Then run `/config` and pick it under **Output style**. The standalone `/output-style` command was deprecated in Claude Code v2.1.73 and removed in v2.1.91.

This one is Claude Code only. Elsewhere the portable equivalent is the `AGENTS.md` section from step 6, which is loaded once per session rather than restated each turn, and is weaker for it.

Two limits are worth stating up front. It is a prompt, so nothing measures compliance. And it does not reach subagents, which run their own system prompt, so any research or exploration agent keeps writing the old way. `docs/limitations.md` covers both.

Everything else runs before the write lands.

## Common problems

**The whole repo lights up on the first run.** Expected. Work through step 2 before changing any rule severity, since most of it is usually two or three files that quote the list.

**A rule blocks a word your industry uses.** Lower it to `warn` in your config and open an issue upstream with the sentence. A rule that is wrong for you is usually wrong for others.

**The semantic hook keeps refusing text that looks fine.** It has a false-positive floor above zero. If it refuses the same passage more than twice while proposing contradictory rewrites, it is looping. Take the deterministic result as authoritative and move on. `docs/design-rationale.md` covers why.

**Someone is running the whole-file directive routinely.** Treat that as a calibration signal, not a discipline problem.

**A hook is refusing a write you need to land now.** `touch .plain-english-ack-docs` waives that channel for ten minutes, then expires on its own. The channels are `docs`, `github` and `issue`. (Before 0.4.0 this lived at `.claude/.docs-plain-english-ack`, which is still honoured. It moved to the repository root because the message tells you to `touch` it and `touch` will not create a missing directory.) Reach for it when the finding is wrong and you are mid-task; fix the config afterwards, since a hatch nobody follows up on is a rule nobody trusts.

**Your agent has no hook here.** Two fallbacks, in `docs/post-edit-lint.md` and `docs/editors.md`: tell it to run `plain-english lint` after it edits, or feed findings into your editor's Problems list, which several agents read.

**`unglossed-term` fires on a name everybody on the team knows.** That is the rule doing its job for a reader outside the team, and `known` is the answer. If you find yourself adding more than a dozen entries, the doc may genuinely need a glossary.
