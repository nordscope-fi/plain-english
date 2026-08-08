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

| Agent | Config written | Can refuse a write | Honours `ask` | Semantic layer |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` + three shims in `.claude/hooks/` | yes | yes | yes, prompt hooks |
| GitHub Copilot | `.github/hooks/plain-english.json` | yes | yes | no |
| OpenAI Codex CLI | `.codex/hooks.json` | yes, after you approve it | no | no |
| Cursor | `.cursor/hooks.json` | yes | no | no |

The semantic layer is the model-judged pass over the nine sentence shapes a regex cannot
reach. It rides on Claude Code's `prompt` hook type. Copilot documents an equivalent that
this package does not yet use; Codex and Cursor have none. The deterministic rules, which
are the ones that can fail a build, run everywhere.

## What the advisory default means on each agent

`failOn: never` is the default, and it means "tell me, do not stop me". Two of
the four have no way to express that on a pre-tool-call hook. Codex's reference
says `permissionDecision: "ask"` is "parsed but not supported yet". Cursor's
says `ask` "is accepted by the schema but not enforced for preToolUse today".
Both parse it and then allow, so an adapter that emits `ask` and stops there
looks installed and reports nothing.

So the advisory finding is fed back to the model as text instead:

| Agent | `failOn: never` | `failOn: error` |
|---|---|---|
| Claude Code | `PreToolUse` → `ask`, a human decides | `PreToolUse` → `deny` |
| GitHub Copilot | `PreToolUse` → `ask` | `PreToolUse` → `deny` |
| OpenAI Codex CLI | `PostToolUse` → `additionalContext` | `PreToolUse` → `deny` |
| Cursor | `preToolUse` → `allow` plus `additional_context` | `preToolUse` → `deny` |

Cursor needs no second hook: `additional_context` works on `preToolUse` itself,
which Cursor staff confirmed in July 2026. Its `postToolUse` equivalent has been
a known-broken ticket since March, which is why the advisory does not go there.

Codex does need one, so `init --agent codex` writes both events into
`.codex/hooks.json`. The pre hook still emits the `ask` Codex discards, on
purpose: somebody who upgrades this package without re-running `init` has a
config with pre entries only. Saying nothing there would switch Codex off with
no error at all.

A `touch`ed acknowledgement file silences the advisory as well as the refusal.
An agent that can only be told things would otherwise keep being told this one
for the whole ten minutes.

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

Cursor's documentation contradicts itself about which hook can block a file
write. One page says only `beforeReadFile` can; another documents `preToolUse`
as generic over all tool types with a `Write` matcher. This package takes the
`preToolUse` route, and a live session on 2026.08.04-aaa8809 confirms it fires
for a `Write`. The argument names are `file_path` and `content`, captured from
that same session.

`ask` is settled, and separately: Cursor accepts it and does not enforce it for
`preToolUse`, so the advisory tier uses `additional_context` instead.

The adapter still accepts several spellings for each argument. The captured
names go first, and the rest cost nothing: a wrong guess falls through, while a
missing one means reading nothing and allowing the write.

## Verification status

Honesty matters more than coverage, so each claim carries what backs it. Three
different things get three different names:

- **observed**: seen against a running agent
- **source**: read from the vendor's own code or published JSON schema
- **docs**: taken from a vendor's prose, which has been wrong twice here

| Agent | Wire format | Config path | Fires on a real write |
|---|---|---|---|
| Claude Code | observed | observed | observed |
| Cursor | observed | observed | observed |
| OpenAI Codex CLI | source | docs | not yet |
| GitHub Copilot | observed | **observed wrong, see below** | **no, see below** |

Cursor was verified against `cursor-agent 2026.08.04-aaa8809` on 2026-08-09.
`preToolUse` does fire for a `Write` in the CLI, which no source settled either
way, and the payloads are in `test/corpus/regressions.yml` so a change breaks a
test rather than going unnoticed. What that session established:

- The `Write` arguments are `file_path` and `content`. The adapter had been
  guessing among four spellings because nobody had published them.
- The shell tool is `Shell`, with `command`, `cwd` and `timeout`.
- **There is no `cwd` on the envelope.** Cursor sends `workspace_roots`, an
  array. Reading the wrong one put the project scope wherever the hook process
  happened to start, which was right by accident and wrong in general.
- `Read` and `Grep` fire `preToolUse` too, and are correctly ignored.
- The envelope also carries `user_email`, which is why a capture redacts
  identity whatever else it keeps.

Codex reads **source** because `codex-rs/core/src/tools/handlers/apply_patch.rs`
emits `tool_input: json!({ "command": command })` and
`codex-rs/core/src/tools/hook_names.rs` says "the serialized name remains
`apply_patch`". That settles the two things a single session would have, more
firmly than a session would.

Reading documentation harder is not a substitute for a capture. Two claims that
shaped an earlier version of this adapter turned out to be false:

- Copilot's compatibility mode, the one whose event names are capitalised like
  `PreToolUse`, was assumed to rename `toolArgs` to `tool_args`,
  following its own camelCase-to-snake_case rule. It does not; it sends
  `tool_input`, already parsed. The camelCase mode really does send a JSON
  *string*, which is `copilot-cli#3349`.
- Codex was reported to route file edits through `Bash` rather than
  `apply_patch`. That described `openai/codex#16732`, fixed by PR #18391 in
  April, months before the version the claim named. A shell-redirection parser
  was nearly written on the strength of it.

### What a live Copilot session showed

Verified against `GitHub Copilot CLI 1.0.78` on 2026-08-09, on a Copilot Free
plan, which does cover the CLI. Two useful confirmations and two problems.

Both payload formats are exactly as documented, and both fire at once if you
register both:

| Event name | Tool names | Arguments field | Type |
|---|---|---|---|
| `PreToolUse` | `Bash`, `Read`, `Glob` | `tool_input` | object |
| `preToolUse` | `bash`, `view`, `glob` | `toolArgs` | JSON **string** |

`asArgs` handles both, which is what it was written for.

**`.github/hooks/*.json` is not read by the CLI.** Copilot's own configuration
help says repo-level hooks live there, and an identical `sessionStart` hook
fired from `~/.copilot/hooks/` and did not fire from `.github/hooks/`. Inline
`hooks` in `.github/copilot/settings.json`, the other documented repo-level
route, did not fire either. So `init --agent copilot` writes a file the local
CLI ignores. It is still the right place for the **cloud** coding agent, which
the documentation says reads it from the default branch and which was not
tested here.

Until that changes, install for the CLI by hand:

```bash
mkdir -p ~/.copilot/hooks
cp .github/hooks/plain-english.json ~/.copilot/hooks/
```

**Copilot writes files through the shell.** Asked to edit a markdown file, it
did not use a write tool. It ran:

```
printf '%s\n' "We leverage this approach to showcase a seamless workflow." > notes.md && echo 'WROTE'
```

That arrives as `tool_name: "Bash"`, so the `Write|Edit|MultiEdit` matcher never
sees it, and the github channel reads only `git commit` and `gh` message text.
**A file Copilot writes this way is not currently checked**, tracked as
[issue #7](https://github.com/nordscope-fi/plain-english/issues/7). Catching it
needs shell-redirection parsing, which is deliberately not in the package yet.
Telling a real redirect from one inside a quoted string needs more than a
regex, and a false positive there refuses a write under `failOn: error`.

## Recording a payload

If a hook is not firing, or is firing and reading nothing, capture what actually
arrived:

```bash
PLAIN_ENGLISH_RECORD=./captures <your agent, doing whatever fails>
```

Each invocation writes one JSON file holding the payload's structure, the
canonical event parsed out of it, the decision, and the keys of the reply.

It is safe to attach to an issue. Paths are rewritten to `{{TMP}}` and `~`, and
prose is reduced to a length and a hash. A capture that still holds a home
directory after all that is not written at all.

`--record-verbatim` keeps the prose, and is for a payload you wrote yourself.

`plain-english doctor` reports which agent configs exist, which carry our entry,
and whether `npx --no-install plain-english` resolves from the project root. A
global install with no local one makes every hook do nothing, while the config
still reads correctly.

The linter also says something on its own when a write-shaped call yields no
path and no text, which is what a renamed field looks like from inside. That
goes to stderr and never refuses a write.

## Vendor bugs worth knowing about

None of these is fixable here, and all of them look like "the hook is broken".

**Copilot.** Plugin-supplied `preToolUse` hooks never execute (`#2540`, `#3659`),
which is why `init` writes `.github/hooks/` and never a plugin. Hooks do not fire
for subagents (`#2392`) or background agents (`#3013`), and can be skipped under
parallel tool calls (`#2893`). `updatedInput` is ignored (`#2013`); this package
never sends it.

**Codex.** `PreToolUse` covers shell, `apply_patch` and MCP (Model Context
Protocol) tool calls. `read_file`, `grep`, `list_dir` and several others emit no
hook events at all (`#20204`).
Codex rejects the entire hook output on an unrecognised key, so a reply carrying
`updatedInput`, `continue`, `stopReason` or `suppressOutput` loses the finding
rather than having the field ignored.

**Cursor.** `updated_input` is silently dropped for the Write tool, so a hook can
refuse but cannot rewrite. The `AskQuestion` tool skips hooks entirely.
`postToolUse` with `additional_context` has been broken since March (T-C20310),
which is why the advisory tier uses `preToolUse` instead.

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
