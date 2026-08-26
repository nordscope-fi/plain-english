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

Swap the id for `copilot`, `codex`, `cursor`, `vibe`, `gemini` or `qwen`, or pass `all`. `claude-code` is the default if you leave the flag off.

`init` wires up the whole repo in one step: that agent's hook config merged into whatever
is already there, an offline launcher, a generated `AGENTS.md` section, and a starter
`.plain-english.yml` if you have none. Claude Code also gets its output styles and skill.
The hooks arrive advisory, so nothing starts refusing writes today. Step 5 says when to
change that.

[`docs/agents.md`](agents.md) has the per-agent detail. Trust is separate from
installation: Copilot, Codex, Cursor, Vibe, Gemini and Qwen protect repository hooks with
vendor approval. Codex also asks you to approve the exact hook command. Copilot's cloud
agent turns an advisory `ask` into a denial.

Fill in the vocabulary your readers already use daily:

```yaml
version: 1
extends: default

allow:
  - pattern: "\\bMRR\\b"
    rules: [unglossed-term]
    semantic: true
  - pattern: "\\bpicklist\\b"
    rules: [unglossed-term]
    semantic: true
  - pattern: "hs_[a-z_]+"
    rules: [unglossed-term]
    semantic: true

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

Write these as mappings rather than bare strings. A bare string silences every rule on any line it matches, so an entry naming one word also hides an em dash sitting next to it.

Naming `rules` keeps the entry to the rule you meant. Setting `semantic: true` passes the same words to the model that judges sentence shapes, which reads no config of its own. Run `plain-english lint --show-suppressed` afterwards to see what each entry actually cost.

`extends: default` matters. A copied ruleset stops receiving upstream fixes on the day you copy it.

See `examples/revops.yml` for a filled-in example.

## 4. Turn it on in CI before turning it on locally

```yaml
- uses: nordscope-fi/plain-english/integrations/github-action@v0.24.0
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
    rev: v0.24.0
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

## 7. Know what covers the chat window

Step 3 already installed all of this. This step is about which part does what, because the three pieces have very different strengths.

**An output style** shapes the reply before it exists. `init` writes three levels under `.claude/output-styles/` and selects the middle one, so there is nothing to copy and no menu to hunt for. Switch level under `/config` > **Output style**. A style is part of the system prompt, which Claude Code reads once at session start, so a change takes effect after `/clear`. (The standalone `/output-style` command was removed in Claude Code v2.1.91.)

This one is Claude Code only. Elsewhere the same guidance arrives through the `AGENTS.md` section from step 6, loaded once per session rather than restated each turn, and weaker for it.

**A completed-turn hook** reads the finished reply and hands any finding back to the
model, which then writes again. That is weaker than a refused write, since the words
already exist, and much stronger than a prompt, since something measures them. Each
profile uses the vendor's current reply field or transcript path. The evidence ranges
from live observation to documentation; [`docs/agents.md`](agents.md#the-chat-channel)
marks the difference.

**A scan of what was actually said:**

```bash
npx plain-english lint --chat --summary
```

It reads the session transcripts your agents write to local disk and reports findings per 1,000 words, split main loop against subagent. That split is the point: a style never reaches a subagent, so one number across both hides the one gap it cannot close. Local only, never a CI step, because a transcript holds whatever passed through a tool.

Two limits are worth knowing before you rely on any of it. A style is a prompt, so nothing measures compliance, which is what the scan is for. And under `claude -p` the stop hook runs but the block does not land, so treat chat as advisory there whatever `failOn` says. [`docs/limitations.md`](limitations.md#what-reaches-chat-and-what-it-costs) covers both.

Everything else runs before the write lands.

## 8. Generate the policy document, and put it in CI

Once the config is tuned, write down what the team agreed to:

```bash
npx plain-english policy
```

That writes `docs/ai-writing-policy.md` from your merged config. What your `failOn` actually does, which agent hooks are on disk, the rules at your severities, everything you changed in step 3, and every waiver in the tree with its reason. It also states what none of it reaches, which is the part people assume is covered.

Add `npx plain-english policy --check` beside your other checks. It exits 1 when the document no longer matches the config and names the sections that moved, so a rule somebody turned off in a hurry cannot stay out of the policy.

Two things make the document worth reading rather than filing. The waivers with no stated reason get their own heading, so the count is visible and can be worked down. And the deviations section prints the `reason:` you wrote next to each rule you changed, so nobody has to guess later:

```yaml
rules:
  - id: load-bearing
    severity: off
    reason: structural engineering, the term is literal here
```

## Common problems

**The whole repo lights up on the first run.** Expected. Work through step 2 before changing any rule severity, since most of it is usually two or three files that quote the list.

**A rule blocks a word your industry uses.** Lower it to `warn` in your config and open an issue upstream with the sentence. A rule that is wrong for you is usually wrong for others.

**The semantic hook keeps refusing text that looks fine.** It has a false-positive floor above zero. If it refuses the same passage more than twice while proposing contradictory rewrites, it is looping. Take the deterministic result as authoritative and move on. `docs/design-rationale.md` covers why.

**Someone is running the whole-file directive routinely.** Treat that as a calibration signal, not a discipline problem.

**A hook is refusing a write or reply you need to send now.** `touch .plain-english-ack-docs`
waives that channel for ten minutes, then expires on its own. The four channels are
`docs`, `github`, `issue` and `chat`; replace the suffix to choose one. Reach for it when
the finding is wrong and you are mid-task. Fix the config afterwards, since a hatch nobody
follows up on is a rule nobody trusts.

**Your agent has no hook here.** Two fallbacks, in `docs/post-edit-lint.md` and `docs/editors.md`: tell it to run `plain-english lint` after it edits, or feed findings into your editor's Problems list, which several agents read.

**`unglossed-term` fires on a name everybody on the team knows.** That is the rule doing its job for a reader outside the team, and `known` is the answer. If you find yourself adding more than a dozen entries, the doc may genuinely need a glossary.
