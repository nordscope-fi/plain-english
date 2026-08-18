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

## Claude Code

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "if": "Write(*.md) or Edit(*.md) or MultiEdit(*.md)",
            "command": "npx --no-install plain-english lint --fail-on error"
          }
        ]
      }
    ]
  }
}
```

Exit 2 blocks and returns stderr to the model. The `if` rule keeps the hook off source
files, so it never runs where it has nothing to say.

This is a complement to `plain-english init`, which installs the `PreToolUse` hooks. Run
both if you want the write refused and the result checked.

## Cursor

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [
      {
        "type": "command",
        "command": "npx --no-install plain-english lint --fail-on error",
        "timeout": 30
      }
    ]
  }
}
```

Goes in `.cursor/hooks.json`, the same file `init --agent cursor` writes, so merge rather
than replace.

## OpenAI Codex CLI

```toml
# .codex/config.toml
[[hooks.PostToolUse]]
matcher = "apply_patch|Write|Edit"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "npx --no-install plain-english lint --fail-on error"
timeout = 30
```

`apply_patch` fires both `PreToolUse` and `PostToolUse`, so this catches the same writes
the pre-hook does. Codex caps the text it feeds back at roughly 2,500 tokens by default
(`additionalContextLimit`); a run with many findings spills the rest to a temporary file
rather than truncating in place.

Note the file. This is `.codex/config.toml`, a second documented route with an open bug of
its own ([openai/codex#17532](https://github.com/openai/codex/issues/17532)), and not the
`.codex/hooks.json` that `init --agent codex` writes. Keeping them separate means a
re-run of `init` cannot touch this block. If you would rather have one file, the same hook
goes in `.codex/hooks.json` under a `PostToolUse` key, which `init` leaves alone.

Codex needs two approvals before it runs any hook, one for the folder and one for the hook
itself. [`agents.md`](agents.md#openai-codex-cli) says what each does.

## Git, for everything else

An agent that has none of the above still commits. `pre-commit` catches that:

```yaml
repos:
  - repo: https://github.com/nordscope-fi/plain-english
    rev: v0.10.0
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

It also depends on the agent choosing to act on a failing command. Every agent listed here
documents that it does, and all of them do it most of the time. None of them guarantees it.
