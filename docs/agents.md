# Coding agents

`plain-english init --agent <id>` wires this repository up for one agent. The linter is
the same in every case; only the shape of the conversation with the agent changes.

```bash
npx plain-english init --agent claude-code   # default
npx plain-english init --agent copilot
npx plain-english init --agent codex
npx plain-english init --agent cursor
npx plain-english init --agent all
npx plain-english init --agent cursor --dry-run   # see what would change
```

Every run also writes an `AGENTS.md` section and a starter `.plain-english.yml`, and
every run is idempotent.

## What each agent gets

| Agent | Config written | Can refuse a write | Semantic layer |
|---|---|---|---|
| Claude Code | `.claude/settings.json` + three shims in `.claude/hooks/` | yes | yes, prompt hooks |
| GitHub Copilot | `.github/hooks/plain-english.json` | yes | no |
| OpenAI Codex CLI | `.codex/hooks.json` | yes, after you approve it | no |
| Cursor | `.cursor/hooks.json` | see the note below | no |

The semantic layer is the model-judged pass over the nine sentence shapes a regex cannot
reach. It rides on Claude Code's `prompt` hook type. Copilot documents an equivalent that
this package does not yet use; Codex and Cursor have none. The deterministic rules, which
are the ones that can fail a build, run everywhere.

## Why this took four adapters and not four linters

Claude Code's hook contract became the shape everyone copied. Copilot ships an explicit
compatibility mode that reads `tool_name` and `tool_input`; Codex uses the same field
names and the same `permissionDecision` reply; Cursor uses the same event with different
words. So a profile in `src/agents/` is a translation table, and the deciding is shared.

The four wire formats, which is all that genuinely differs:

```jsonc
// claude-code, codex
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                          "permissionDecision": "ask",
                          "permissionDecisionReason": "..." } }

// copilot
{ "permissionDecision": "ask", "permissionDecisionReason": "..." }

// cursor
{ "permission": "ask", "user_message": "...", "agent_message": "..." }
```

An allow writes nothing at all and exits 0, in every profile.

## Per-agent notes

`init` prints these too, because none of them is guessable from the config file.

### Claude Code

Select the output style with `/config`, then **Output style**. The standalone
`/output-style` command was deprecated in v2.1.73 and removed in v2.1.91.

A style applies to the main conversation only. Subagents run their own system prompt and
do not see it.

### GitHub Copilot

The cloud coding agent reads `.github/hooks/` from the default branch only, so the hook
starts working there once the config is merged, not when you install it.

**The cloud agent treats `ask` as `deny`.** Under the default `failOn: never` a finding is
advisory in the CLI and blocking in the cloud. If that is not what you want, exclude the
paths rather than relying on `failOn`.

Copilot is also the one agent whose pre-tool-call hook fails closed: an unexpected
non-zero exit refuses the write rather than allowing it. This package never exits non-zero
on that path, which matters more here than anywhere else.

### OpenAI Codex CLI

Codex will not run a hook you have not approved. After installing, start a session and run
`/hooks` to review and trust the entries. Approval is asked for again whenever the command
string changes, which includes pinning a new version of this package.

Hooks also have to be enabled: `[features] hooks = true` in `config.toml` if your build
has them switched off.

Codex writes files with `apply_patch` rather than a `Write` tool, so the adapter reads the
inserted lines out of the patch envelope. Added lines are kept per file, so a patch that
touches a README and a source file has only the README judged.

### Cursor

Cursor's documentation contradicts itself here. One page states there is no
`beforeFileEdit` hook and that only `beforeReadFile` can block file access; another
documents `preToolUse` as generic over all tool types with a `Write` matcher. This package
takes the `preToolUse` route. **Write a markdown file containing a banned term and confirm
the hook fires before you rely on it.**

The argument names inside a Cursor `Write` are not published, so the adapter accepts
several spellings. If it reads nothing, it allows the write.

## Verification status

Honesty matters more than coverage here, so this table says what was actually observed
against a running agent as opposed to taken from a vendor's documentation.

| Agent | Wire format | Config path | Fires on a real write |
|---|---|---|---|
| Claude Code | verified | verified | verified |
| GitHub Copilot | from docs | from docs | not yet verified |
| OpenAI Codex CLI | from docs | from docs | not yet verified |
| Cursor | from docs | from docs | not yet verified |

Two known documentation gaps, both recorded in the source:

- `openai/codex#18491` reports that `PreToolUse` may dispatch for shell calls only on some
  builds, and that `updatedInput` is rejected at runtime. This package never sends
  `updatedInput`, so only the first matters. Check `/hooks` output against your version.
- Cursor's own docs disagree about pre-write blocking, as above.

If you run one of these and it behaves differently, that is a bug report worth filing.
Attach `plain-english doctor` output and the agent's version.

## Agents with no adapter

Not every agent has a pre-tool-call hook, and some have one this package does not speak.
Three things still work for all of them.

**`AGENTS.md`.** `init` writes a generated section into it between markers. Roughly twenty
agents read the file, including Zed, aider, Warp, Windsurf, Amp and opencode. It shapes
behaviour and enforces nothing.

**A post-edit lint command.** Most agents can be told to run a command after they edit a
file and read the output. See [`post-edit-lint.md`](post-edit-lint.md).

**Editor diagnostics.** See [`editors.md`](editors.md). Several agents read their editor's
Problems list and treat what they find there as work to do.

Windsurf, Gemini CLI, Antigravity, Cline, opencode and Amp all have real interception
points and no profile here yet. Adding one is a file in `src/agents/` plus a row in the
registry; the deciding does not change.

## Which agent am I talking to?

The shim `init` writes always passes `--agent`, so the answer is normally settled. When it
is missing, the profile is picked in this order:

1. `--agent`
2. `PLAIN_ENGLISH_AGENT` in the environment
3. the payload's own shape, where it is distinctive
4. an agent-specific environment variable
5. Claude Code

Detection is deliberately weak, because four agents send the same field names. Guessing
wrong is not fatal: every profile parses the shared envelope, so a misdetected agent still
reads the text correctly and only the reply envelope would be wrong. An agent that cannot
parse the reply treats the call as unhandled and carries on.
