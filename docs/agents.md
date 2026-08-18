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

Every run also writes an `AGENTS.md` section and a starter `.plain-english.yml`. Run it
twice and nothing changes the second time.

## What each agent gets

| Agent | Config written | Can refuse a write | Honours `ask` | Semantic layer |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` + three shims in `.claude/hooks/` | yes | yes | yes, prompt hooks |
| GitHub Copilot | `.github/hooks/plain-english.json` | yes | yes | no |
| OpenAI Codex CLI | `.codex/hooks.json` | yes, in a trusted folder you have approved | no | no |
| Cursor | `.cursor/hooks.json` | yes | no | no |

The semantic layer is the model-judged pass over the nine sentence shapes a regex cannot
reach. It rides on Claude Code's `prompt` hook type. Copilot documents an equivalent that
this package does not yet use; Codex and Cursor have none. The deterministic rules, which
are the ones that can fail a build, run everywhere.

## What the advisory default means on each agent

`failOn: never` is the default, and it means "tell me, do not stop me". Two of
the four have no way to express that on a pre-tool-call hook. Cursor's docs say
`ask` "is accepted by the schema but not enforced for preToolUse today", so it
accepts the value and allows the write. Codex is worse: 0.147.0 reports the hook
run as **Failed** and the reason reaches neither the model nor the user. Either
way, an adapter that emits `ask` and stops there looks installed and reports
nothing.

So the advisory finding is fed back to the model as text instead:

| Agent | `failOn: never` | `failOn: error` |
|---|---|---|
| Claude Code | `PreToolUse` → `ask`, a human decides | `PreToolUse` → `deny` |
| GitHub Copilot | `PreToolUse` → `ask` | `PreToolUse` → `deny` |
| OpenAI Codex CLI | `PreToolUse` → `additionalContext` | `PreToolUse` → `deny` |
| Cursor | `preToolUse` → `allow` plus `additional_context` | `preToolUse` → `deny` |

Neither needs a second hook. Cursor's `additional_context` works on `preToolUse`
itself, which Cursor staff confirmed in July 2026, and its `postToolUse`
equivalent has been a known-broken ticket since March. Codex accepts
`additionalContext` on the pre event too, verified against 0.147.0: the text
arrives as a developer message before the write, and the run reports Completed.

Until 0.7.0 the Codex advisory rode on a second `PostToolUse` hook, because the
pre event was believed unable to speak. Re-running `init` deletes that entry.
Upgrading without re-running it is harmless too: the post event now says nothing
at all, so the finding is reported once rather than twice.

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

Two separate approvals stand between an installed hook and a running one. Miss either and
Codex runs the hook zero times, prints no warning and writes no log line.

**Folder trust decides whether the file is read at all.** Codex loads
`<repo>/.codex/hooks.json` only when `~/.codex/config.toml` marks the project trusted.
Until then it finds no hooks, reports no warning and logs no error. Start a session in the
repository and answer yes, or write the entry yourself:

```toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

`plain-english doctor` says so when the entry is missing, because the state is otherwise
indistinguishable from a linter with nothing to say.

**Hook trust decides whether it runs.** Starting an interactive session offers this
straight away, with a "Trust all and continue" option, and `/hooks` does the same later.
Trust is recorded against the command string, so it is asked again whenever a new version
of this package is pinned.

Do that once before any `codex exec` run. Non-interactive mode has nobody to ask, so it
skips an untrusted hook with nothing printed at all. Once trusted it runs them, verified
on 0.147.0 for both `PreToolUse` and `UserPromptSubmit`. For a machine with no one at the
keyboard, `--dangerously-bypass-hook-trust` skips the trust step instead.

Inside a git worktree, Codex reads the **main** working tree's `.codex/hooks.json` and
ignores the worktree's own copy. Install in the main checkout;
`doctor` reports this too.

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

## The chat channel

Chat is the newest channel and the only one that reads a reply rather than gating a write.
Two mechanisms, and they do not reach equally far.

| Agent | Event carrying the reply | Field | Can block | Evidence |
|---|---|---|---|---|
| Claude Code | `Stop`, `SubagentStop` | `last_assistant_message`, documented as the complete final message | yes, `decision: "block"` with `reason` | docs |
| OpenAI Codex CLI | `Stop`, `SubagentStop` | `last_assistant_message`, documented as "if available" and possibly incomplete | yes | docs |
| GitHub Copilot | `subagentStop` only | `response` / `last_assistant_message`. `Stop` documents that it carries no reply | yes, plus `modifiedResponse` | docs |
| Cursor | documents `stop` and `afterAgentResponse` | unverified | unverified | docs, plus bug reports |

Every row is `docs` tier, the weakest this project accepts, so none of it has been watched
happening. The tracer procedure in
[`verifying-an-adapter.md`](verifying-an-adapter.md#register-a-tracer-on-every-event) is
what moves a row to `observed`, and it has three questions to answer:

1. Does the event fire, and does it carry the reply under the documented field name?
2. For Codex and Copilot, has the transcript caught up by the time the event fires? Claude
   Code's documentation says its own transcript is written asynchronously and may lag, and
   assuming the other two behave the same way either direction is a guess.
3. Does Cursor's command-line tool dispatch `stop` or `afterAgentResponse` at all? Several
   reports say it sends only `beforeShellExecution` and `afterShellExecution`, and that
   cloud agents run neither. Nothing is installed there until that is settled.

**Copilot's `modifiedResponse` is deliberately unused.** It would replace a subagent's
output before the parent sees it, which is a stronger tool than anything else here.
Replacing a reply means generating prose, and nothing in this package generates prose.
`Decision.replacement` exists for it and stays unset, so the contract does not have to
change if that ever becomes true.

**Blocking is guarded three ways**, because a blocked turn produces a new reply that can
trip a different rule and block again:

- `stop_hook_active`, which Claude Code and Copilot both document, and which is the agent
  saying this turn already exists because a hook blocked the last one.
- one block per turn, recorded in `.plain-english-chat-<prompt-id>` at the repository root,
  on the same ten-minute self-expiring clock as the ack file.
- `.plain-english-ack-chat`, which waives the channel like any other.

### Where each agent keeps its transcripts

`plain-english lint --chat` reads these. Locations were read off live stores on one machine
and then checked against each vendor's documentation, which is not the same as watching a
session write one.

| Agent | Location | Reply text | Evidence |
|---|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl`, and subagents at `<session>/subagents/agent-*.jsonl` | `type=assistant`, `message.content[]` where `type=text` | observed, and docs |
| OpenAI Codex CLI | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `response_item`, `payload.role=assistant`, `content[].type=output_text` | observed, and docs |
| Cursor | `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl` | `{role:"assistant", message.content[].text}` | observed, only after docs pointed at the path |
| GitHub Copilot | `$COPILOT_HOME/session-store.db`, SQLite | `turns.assistant_response`, scoped by `sessions.cwd` | observed, and docs |

Three things about that table are worth carrying:

- **Claude Code's subagent replies are in their own nested files.** A scan of the top level
  only finds every main-loop reply and no subagent reply, and reports that as zero. On the
  machine this was written on that silently dropped 1,845 replies, which are exactly the
  ones an output style cannot reach.
- **Cursor's `~/.cursor/chats/*/store.db` is not the transcript.** It is session metadata,
  and in the store examined only 11 of 39 blobs parsed as JSON with 4 assistant messages
  among them. See [`verifying-an-adapter.md`](verifying-an-adapter.md#chat-transcripts).
- **Copilot's store runs in write-ahead logging mode.** Opening it with `immutable=1` skips
  the log, so a live store reads as empty or as a missing table. The reader copies the
  database and its log to a scratch directory and opens the copy, which honours the log and
  cannot write to somebody's agent state.

Reading is local only. A transcript holds whatever passed through a tool, and Copilot's
documentation notes that its sessions sync to the user's GitHub account by default.

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
| OpenAI Codex CLI | observed | observed, **with two gates, see below** | observed |
| GitHub Copilot | observed | **observed wrong, see below** | observed |

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

### What a live Codex session showed

Verified against `codex-cli 0.147.0` on 2026-08-09, on OpenAI's paid consumer
plan, which covers the CLI.
Six of the eight findings came from Codex's own `hooks/list` call, which costs
no model tokens and is described in
[`verifying-an-adapter.md`](verifying-an-adapter.md).

**`PreToolUse` fires for `apply_patch`,** with `tool_name: "apply_patch"` and
the envelope under `tool_input.command`. A widely-linked third-party reference
says the event "intercepts the `shell` (Bash) tool only, by design". It names no
version and shows no run. It is wrong here.

**`ask` fails the hook.** The reply is reported as `PreToolUse Failed` and the
reason reaches nobody. Current OpenAI documentation no longer lists `ask` as a
decision at all, and the binary carries the string
`PreToolUse hook returned unsupported permissionDecision:ask`. `allow` is
rejected the same way. Only `deny` is acted on, and its reason must be non-empty.

**`additionalContext` on the pre event works**, which is why the advisory tier
moved there.

**`deny` is enforced.** Two `apply_patch` calls were refused and reported
`Blocked`, which contradicts
[openai/codex#27833](https://github.com/openai/codex/issues/27833) for this
version. Two things spoil it. The denial message appends the raw patch after the
hook's own reason, so a hook cannot promise its reason is all the user sees
([#32573](https://github.com/openai/codex/issues/32573)). And Codex works around
the refusal: after two blocked patches it wrote the file anyway with

```
perl -0pi -e '$_ = "We leverage this approach.\n"' notes.md
```

That is an in-place rewrite through an interpreter, not a redirect, and the
shell scanner refuses to read one. Guessing the content out of a Perl expression
would mean inventing a write, and under `failOn: error` an invented write
refuses somebody's edit. So on Codex a refusal can be routed around within the
same turn, and this package does not pretend otherwise.

**Two gates.** Folder trust says nothing at all when it stops a hook. Hook trust
announces itself properly in an interactive session, and not at all in
`codex exec`, which has nobody to ask.

**A trusted hook does run in `codex exec`.**
[openai/codex#32491](https://github.com/openai/codex/issues/32491) reports
otherwise. On 0.147.0, with trust persisted and no bypass flag, both
`PreToolUse` and `UserPromptSubmit` fired and both reported `Completed`.

**Worktrees resolve to the wrong file.** With hooks installed in a linked
worktree and not in the main checkout, `hooks/list` reports nothing at all.
With both, it reports the main checkout's file as the source.
[openai/codex#27133](https://github.com/openai/codex/issues/27133) calls this
"silently ignored in a worktree"; the more exact statement is that the path
resolves to the main working tree.

**`timeout` is the config key**, in seconds, although Codex reports the value
back as `timeoutSec`. A `timeoutSec` in the file is ignored and the hook gets
the 600 second default. `SessionEnd` is clamped to three seconds with a warning.

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

Reported upstream as
[github/copilot-cli#1730](https://github.com/github/copilot-cli/issues/1730),
with a controlled run: one session, the same `sessionStart` hook in all three
documented locations, and only the user-level one fires.

Until it changes, ask `init` for the location the CLI reads:

```bash
npx plain-english init --agent copilot --user
```

`--user` is the only thing that makes `init` write outside the project, and it
is opt-in for that reason. Without it you get the repository file, which is
still correct for the cloud agent, plus the manual one-liner:

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
sees it. It is the github channel that gets the call, not the docs channel, and
before 0.6.0 that channel read only `git commit` and `gh` message text and found
none here. Since 0.6.0 a shell write like this **is** checked. The
command is scanned for a trailing redirect whose content the command itself
carries. The resulting file then goes through the same markdown, project-scope
and `exclude` filters a write through a tool call gets.

It is a scanner rather than a regex, because `echo "see > README.md" >> log.txt`
redirects to a log file and any pattern reading the first `>` gets that wrong.
Under `failOn: error` a false positive refuses a write that was never going to a
file. So the parser gives up rather than guesses. No `sed -i`, no `cp` or `mv`,
no path or content the shell would expand, and nothing when two plain redirects
make the target ambiguous.

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
Project hooks are skipped with no prompt and no warning until the **folder** is
trusted (`#35306`), and inside a git worktree the path resolves to the main
working tree (`#27133`). A denial message has the raw command or patch appended
after the hook's reason (`#32573`). All three were seen on 0.147.0. Two others
did not reproduce there: `deny` is enforced for `apply_patch` (`#27833`), and
`codex exec` does dispatch hooks whose trust has been recorded (`#32491`).

**Cursor.** `updated_input` is silently dropped for the Write tool, so a hook can
refuse but cannot rewrite. The `AskQuestion` tool skips hooks entirely.
`postToolUse` with `additional_context` has been broken since March (T-C20310),
which is why the advisory tier uses `preToolUse` instead.

[`verifying-an-adapter.md`](verifying-an-adapter.md) is how each of these was
checked, and what to do when you add a fifth agent.

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
