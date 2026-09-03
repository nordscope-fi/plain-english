# Linting after an edit, in any agent

A pre-tool-call hook refuses a write before it happens. Not every agent has one, and the
ones that do change their JSON from time to time. There is a second route that every agent
supports and that no vendor can break, because it is not a protocol. Tell the agent to run
a command after it edits a file, and let it read the output.

The loop is: agent edits a markdown file, the command runs, `plain-english lint` exits
non-zero, the agent sees the findings and fixes them. Weaker than a refusal, since the bad
text exists for a moment. Stronger than an instruction in a prose file, since it is
deterministic and the model cannot talk itself out of it.

Use `--fail-on error` in all of these. The default is `never`, which exits 0, and an agent
that sees exit 0 has no reason to act.

## aider

Auto-lint is on by default for files aider edits, so this is the only line needed.

```yaml
# .aider.conf.yml
lint-cmd:
  - "markdown: npx plain-english lint --fail-on error"
```

Or for one run: `aider --lint-cmd "markdown: npx plain-english lint --fail-on error"`.

Aider does not load a conventions file on its own. Add `read: AGENTS.md` to the same file
if you want the style guide in front of it as well.

## Agents without a native profile here

Put the loop in that agent's repository instructions:

```markdown
After editing Markdown, run:

npx --no-install plain-english lint <changed-markdown-files> --fail-on error

Fix every blocking finding before finishing. Do not use `--no-verify` or a whole-file
waiver to make the command pass.
```

The changed paths matter. Calling `plain-english lint` with no path reads standard input;
it does not discover the files an agent just edited. Calling it on the whole repository
works, but makes the agent repair unrelated existing text.

Claude Code, Copilot, Codex, Cursor, Vibe, Gemini and Qwen already have native profiles.
Use `plain-english init --agent <id>` for them; hand-written post-tool examples duplicate
the generated hooks and are more likely to drift from a vendor's current event format.

## Git, for everything else

An agent that has none of the above still commits. `pre-commit` catches that:

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v1.2.0
    hooks:
      - id: plain-english
      - id: plain-english-commit-msg
```

Treat this as a nudge and not a gate. `--no-verify` skips it, and agents have been
observed reaching for exactly that when a hook blocks them. The only gate an agent cannot
route around is a required status check on the server, which is what the GitHub Action in
the README is for.

## What this cannot do

It runs after the text exists. On a file write that is fine, since the fix is another
edit. On a `git commit` it is too late: the commit is already made, and the agent has to
amend. Use the pre-tool-call hook for commit messages where you have one.

It also depends on the agent choosing to act on a failing command. That is an instruction,
not enforcement. The required server-side status check remains the final gate.
