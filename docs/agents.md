# Coding agents

`plain-english init --agent <id>` wires this repository up for one agent. The linter is
the same in every case; only the shape of the conversation with the agent changes.

```bash
npx plain-english init --agent claude-code   # default
npx plain-english init --agent copilot
npx plain-english init --agent codex
npx plain-english init --agent cursor
npx plain-english init --agent vibe
npx plain-english init --agent gemini
npx plain-english init --agent qwen
npx plain-english init --agent all
npx plain-english init --agent cursor --dry-run   # see what would change
```

Every run also writes an `AGENTS.md` section and a starter `.plain-english.yml`. Run it
twice and nothing changes the second time.

## What each agent gets

| Agent | Config written | Can refuse a write | Honours `ask` | Semantic layer |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` + generated launchers in `.claude/hooks/` | yes | yes | yes, prompt hooks |
| GitHub Copilot | `.github/hooks/plain-english.json` | yes | yes | no |
| OpenAI Codex CLI | `.codex/hooks.json` | yes, in a trusted folder you have approved | no | no |
| Cursor | `.cursor/hooks.json` | yes | no | no |
| Mistral Vibe | `.vibe/hooks.toml` + a judge in `.vibe/hooks/`, in a folder you have trusted | yes | no | yes, opt-in |
| Google Gemini CLI | `.gemini/settings.json` | yes | no | no |
| Qwen Code | `.qwen/settings.json` | yes | no | no |

The semantic layer is the model-judged pass over the ten sentence shapes a regex cannot
reach. It rides on Claude Code's `prompt` hook type. Copilot's prompt hooks submit text at
session start; they are not a model judge. Vibe has no prompt hook either, so its judge is
a shell command that asks Vibe, off unless `PLAIN_ENGLISH_VIBE_JUDGE=1`.
The deterministic rules, which are the ones that can fail a build, run everywhere.

## What the advisory default means on each agent

`failOn: never` is the default, and it means "tell me, do not stop me". Five of
the seven agents have no reliable interactive `ask` reply. An adapter that emits
an unsupported value can look installed and report nothing, or can turn advice
into a refusal in a headless run.

So the advisory finding is fed back to the model as text instead:

| Agent | `failOn: never` | `failOn: error` |
|---|---|---|
| Claude Code | `PreToolUse` → `ask`, a human decides | `PreToolUse` → `deny` |
| GitHub Copilot | `PreToolUse` → `ask` | `PreToolUse` → `deny` |
| OpenAI Codex CLI | `PreToolUse` → `additionalContext` | `PreToolUse` → `deny` |
| Cursor | `postToolUse` → `additional_context` | `preToolUse` → `deny` |
| Mistral Vibe | `post_tool` → `additional_context` | `pre_tool` → `deny` |
| Google Gemini CLI | `AfterTool` → `additionalContext` | `BeforeTool` → `deny` |
| Qwen Code | `PreToolUse` → `allow` plus `additionalContext` | `PreToolUse` → `deny` |

Codex and Qwen can attach advice to the pre event. Cursor, Vibe and Gemini use
their documented post-tool context field, so `init` installs both halves for
them. Codex accepts `additionalContext` on the pre event too, verified against
0.147.0: the text arrives as a developer message before the write.

Until 0.7.0 the Codex advisory rode on a second `PostToolUse` hook, because the
pre event was believed unable to speak. Re-running `init` deletes that entry.
Upgrading without re-running it is harmless too: the post event now says nothing
at all, so the finding is reported once rather than twice.

A `touch`ed acknowledgement file silences the advisory as well as the refusal.
An agent that can only be told things would otherwise keep being told this one
for the whole ten minutes.

## Why this takes one linter, not one per agent

The agents share enough concepts to use one decision engine, but their event names,
tool names and reply envelopes differ. A profile in `src/agents/` is the translation
table between one native protocol and the shared linter.

The wire formats, which are all that genuinely differ:

```jsonc
// claude-code, codex
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                          "permissionDecision": "ask",
                          "permissionDecisionReason": "..." } }

// copilot
{ "permissionDecision": "ask", "permissionDecisionReason": "..." }

// cursor
{ "permission": "ask", "user_message": "...", "agent_message": "..." }

// vibe
{ "hook_specific_output": { "additional_context": "..." } } // advisory, post-tool
{ "decision": "deny", "reason": "..." } // refuse

// gemini
{ "hookSpecificOutput": { "hookEventName": "AfterTool",
                          "additionalContext": "..." } }

// qwen
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                          "permissionDecision": "allow",
                          "additionalContext": "..." } }
```

An allow with nothing to say writes nothing and exits 0, in every profile.

## Per-agent notes

`init` prints these too, because none of them is guessable from the config file.

### Claude Code

Reference: [Claude Code hooks](https://code.claude.com/docs/en/hooks).

Select the output style with `/config`, then **Output style**. The standalone
`/output-style` command was deprecated in v2.1.73 and removed in v2.1.91.

A style applies to the main conversation only. Subagents run their own system prompt and
do not see it.

### GitHub Copilot

Reference: [GitHub Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).

Copilot CLI 1.0.80 reads `.github/hooks/*.json` and merges repository hooks with
user hooks. The cloud coding agent reads that directory from the default branch.
Its hook starts working once the config is merged. `--user` remains an explicit
fallback for older CLI releases and can duplicate calls on current releases.

Repository hooks in prompt mode need one more opt-in. Trust the folder in an
interactive session, or set `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true` for a
non-interactive run whose hook files you have already reviewed. Without either,
Copilot skips the repository hook. `plain-english doctor` reports that state.

**The cloud agent treats `ask` as `deny`.** Under the default `failOn: never` a finding is
advisory in the CLI and blocking in the cloud. If that is not what you want, exclude the
paths rather than relying on `failOn`.

Copilot is also the one agent whose pre-tool-call hook fails closed: an unexpected
non-zero exit refuses the write rather than allowing it. This package never exits non-zero
on that path, which matters more here than anywhere else.

### OpenAI Codex CLI

Reference: [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks).

Two separate approvals stand between an installed hook and a running one. Miss either and
Codex skips the project hook. Current Codex releases warn when an individual hook needs
review and direct you to `/hooks`; an untrusted project layer is not loaded.

**Folder trust decides whether the file is read at all.** Codex loads
`<repo>/.codex/hooks.json` only when `~/.codex/config.toml` marks the project trusted.
Until then the project layer is not loaded. Start a session in the repository and answer
yes, or write the entry yourself:

```toml
[projects."/absolute/path/to/repo"]
trust_level = "trusted"
```

`plain-english doctor` says so when the entry is missing, because the state is otherwise
indistinguishable from a linter with nothing to say.

**Hook trust decides whether it runs.** Starting an interactive session offers this
straight away, with a "Trust all and continue" option, and `/hooks` does the same later.
Trust is recorded against the exact hook definition's current hash. A changed definition
therefore needs another review; updating the package alone does not necessarily change it.

Do that once before any `codex exec` run. Non-interactive mode cannot open the review
screen, so review the definitions interactively first. Once trusted it runs them, verified
on 0.147.0 for both `PreToolUse` and `UserPromptSubmit`. For one-off automation that has
already reviewed the hook source, `--dangerously-bypass-hook-trust` bypasses only hook
trust for that invocation.

Inside a git worktree, Codex reads the **main** working tree's `.codex/hooks.json` and
ignores the worktree's own copy. Install in the main checkout;
`doctor` reports this too.

Codex writes files with `apply_patch` rather than a `Write` tool, so the adapter reads the
inserted lines out of the patch envelope. Added lines are kept per file, so a patch that
touches a README and a source file has only the README judged.

### Cursor

Reference: [Cursor hooks](https://cursor.com/docs/hooks).

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

Current Cursor documentation puts advisory context on `postToolUse`, so the
project config installs both `preToolUse` and `postToolUse`. It also installs
`stop` and `subagentStop`; a strict chat finding returns `followup_message`,
which asks Cursor to rewrite the reply.

### Google Gemini CLI

Reference: [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/).

Gemini reads repository hooks from `.gemini/settings.json`. It asks for trust
when a project hook is first seen and when the command fingerprint changes.
The generated config uses `BeforeTool` to refuse strict findings, `AfterTool`
to add advisory context, and `AfterAgent` to check the completed reply.

Gemini's native file tools are `write_file` and `replace`; shell work uses
`run_shell_command`. Hook timeouts are milliseconds, unlike the seconds used
by Codex, Cursor and Vibe.

### Qwen Code

Reference: [Qwen Code hooks](https://qwenlm.github.io/qwen-code-docs/).

Qwen reads repository hooks from `.qwen/settings.json` after the project hook
fingerprint is trusted. Its native tools are `write_file`, `edit` and
`run_shell_command`. Chat replies use `Stop` and `SubagentStop`.

Qwen documents `ask`, but a headless run or background subagent converts it to
a denial. The advisory path therefore returns an explicit `allow` with
`additionalContext`; strict mode returns `deny`.

### Mistral Vibe

Reference: [Mistral Vibe hooks](https://docs.mistral.ai/vibe/code/cli/hooks).

Config is `.vibe/hooks.toml`, a TOML array of tables rather than the JSON every other agent
reads, and this is the only place `init` writes TOML. Vibe reads it only in a folder you
have trusted; untrusted it finds no hooks and says nothing, so `plain-english doctor` names
that case.

Three events exist and no more: `pre_tool`, `post_tool` and `post_agent`. The vocabulary is
`allow` and `deny`, with no `ask` in it at all. Sending one is not ignored the way Cursor
ignores it: the schema is `Literal["allow", "deny"]`, and a reply that fails validation is
treated as a hook failure. `system_message` is UI-only, so the advisory tier travels as
`hook_specific_output.additional_context` on `post_tool`. Strict mode can still deny on
`pre_tool` before the tool runs.

Two things here are better than on Claude Code, and one is worse.

**The chat gate is real.** `post_agent` fires once per turn after the reply, and a denial is
injected back as a retry user message, capped at three per hook per user turn. Vibe applies
that cap itself.

**The style reaches subagents.** A Vibe subagent runs its own loop but is built with the
same system prompt, so the project `AGENTS.md` reaches it. A Claude Code output style never
reaches a subagent, which is why `SubagentStop` carries so much weight there. Verified by
reading a live subagent's recorded system prompt.

**There is no user-prompt event.** Nothing runs before the model sees a user turn, so that
channel is uncovered on Vibe and no workaround is offered.

One trap worth naming: `.vibe/prompts/` looks like the slot an output style belongs in and
is not. A file there replaces Vibe's entire system prompt rather than adding to it, so
putting a writing style in it would delete Vibe's own operating instructions.

## The chat channel

Chat is the newest channel and the only one that reads a reply rather than gating a write.
Two mechanisms, and they do not reach equally far.

| Agent | Event | Carries the reply | Transcript ready at hook time | Evidence |
|---|---|---|---|---|
| Claude Code 2.1.234 | `Stop`, `SubagentStop` | yes, `last_assistant_message` | **no**, it lags | observed |
| OpenAI Codex CLI 0.147.0 | `Stop` | yes, `last_assistant_message`, complete | yes | observed |
| GitHub Copilot CLI 1.0.78 | `Stop` | **no** | yes, in `events.jsonl` | observed |
| GitHub Copilot CLI 1.0.78 | `subagentStop` | yes, `response` | not applicable | docs |
| Cursor CLI 2026.08.04 | no dispatched stop event | not applicable | not applicable | observed, historical |
| Cursor current | `stop`, `subagentStop` | no, names `transcript_path` | documented | docs, installed by 0.24.0 |
| Gemini CLI | `AfterAgent` | yes, `prompt_response` | yes | docs |
| Qwen Code | `Stop`, `SubagentStop` | yes, `last_assistant_message` | documented fallback | docs |
| Mistral Vibe 2.24.1 | `post_agent` | no, names `transcript_path` | yes | observed |

The rows marked observed were run against live binaries with a tracer registered on
every available event. The newer rows marked docs were checked against each vendor's
current reference and are kept distinct from a live result.

**Claude Code rejects a flat `Stop` registration.** When this was tested, an older version
of the reference showed `Stop` as a bare `{ type, command }` in the event array. Written
that way, the settings file failed validation and print mode ignored it. Current Claude
Code documentation now describes the same three nested levels for every event. `init`
writes `{ matcher, hooks }`, and a test pins that shape.

**Claude Code does not act on a `Stop` block in print mode.** The hook runs, the block is
emitted and read, and the turn ends anyway. Isolated with a hook that has nothing to do
with this package: a minimal always-block `Stop` hook, correctly registered and confirmed
to run once, did not continue the turn. So under `claude -p` the chat channel is advisory
whatever `chat.failOn` says.

**An interactive session does act on it, and only for the flat body.** Run on 2026-08-18
against 2.1.234 by driving a real session through a pseudo-terminal, with a minimal
always-block `Stop` hook whose reason asked for a word the model would never otherwise
write. Same driver, same session, one variable changed:

| Body the hook printed | What happened |
|---|---|
| `{"hookSpecificOutput": {"hookEventName": "Stop", "decision": "block", ...}}` | `Stop` fired once, the turn ended, the word never appeared |
| `{"decision": "block", "reason": "..."}` | `Stop` fired again with `stop_hook_active: true`, and the reply carried the word |

This package emitted the nested body up to and including 0.11.0, so its chat gate could
never hold a turn on Claude Code. It ran, it reported, and every reply went through.
Copilot's profile had the flat shape from the start, which is why only this one was wrong.

Note that the two shapes are not the same question. Registration in `settings.json` must
be nested, or the whole file fails validation. The body a hook prints must be flat. Getting
either backwards fails without a word, which is why both now have a test.

**Claude Code's transcript really does lag.** At `Stop` and at `SubagentStop`, the reply
was absent from `transcript_path`. That confirms the documented warning and the design that
follows from it: `current()` takes `last_assistant_message` off the payload and never reads
the transcript for the turn it is judging.

**Codex's `last_assistant_message` was complete, and its transcript was already written.**
Its documentation hedges with "if available"; on this run neither hedge was needed. Codex
also names a turn `turn_id` rather than `prompt_id`, which matters for the once-per-turn
block key.

**Copilot's `Stop` carries no reply, as documented, and names something better.** Its
`transcriptPath` points at `session-state/<id>/events.jsonl`, a live event stream where an
`assistant.message` record holds the reply under `data.content`, present at hook time. The
reader prefers that over the SQLite store, which can lag the event asking about it.
Registering both `Stop` and `agentStop` runs the hook twice, so pick one casing.

**Cursor's current contract differs from the older live result.** The 2026.08.04
binary dispatched neither `stop` nor `afterAgentResponse`; current documentation
defines `stop` and `subagentStop`, with `followup_message` as the retry response.
The adapter follows the current contract and reads the named JSONL transcript.

Still unverified, and worth saying rather than leaving implied: Claude Code and Codex
`SubagentStop` blocking, Copilot's `subagentStop` payload, Cursor's current stop events,
and Gemini and Qwen completed-turn retries.

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
| Mistral Vibe | `$VIBE_HOME/logs/session/session_*/messages.jsonl`, and subagents at `<session>/agents/*/` | `{role:"assistant", content}` as a string, skipping `injected` | observed, and source |
| Google Gemini CLI | `$GEMINI_CLI_HOME/.gemini/tmp/<project>/chats/*.jsonl` | `type=gemini`, string or text parts, skipping thoughts | docs |
| Qwen Code | `$QWEN_HOME/projects/<project>/chats/*.jsonl`, with subagents beside it | `type=assistant`, `message.parts[].text`, skipping thoughts | docs |

Four things about that table are worth carrying:

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
- **Vibe's transcript carries no working directory and no timestamps.** Both live in a
  sibling `meta.json`, so scope is resolved per session rather than per record. An assistant
  turn that only called tools carries `content: null`, and a message Vibe injected itself
  carries `injected: true`. Counting either as a reply would lint text nobody wrote,
  including this package's own block messages.

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
| GitHub Copilot | observed, including 1.0.80 `file_text` | observed on 1.0.80 with prompt-mode opt-in | observed |
| Mistral Vibe | observed | observed, **needs a trusted folder, see below** | observed |
| Google Gemini CLI | docs | docs, **needs project hook trust** | not yet observed |
| Qwen Code | docs | docs, **needs project hook trust** | not yet observed |

Cursor's write path was verified against `cursor-agent 2026.08.04-aaa8809` on
2026-08-09. Its pre/post hooks were checked again on 2026.08.11-e8db854 on
2026-08-26.
`preToolUse` does fire for a `Write` in the CLI. No source settled that either
way. The payloads are in `test/corpus/regressions.yml`, so a change breaks a test
rather than going unnoticed. What that session established:

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

### What a live Vibe session showed

Verified against `vibe 2.24.1` on 2026-08-18, and unusually the source was
available first: Vibe ships as Python, so the hook models, the executor and the
handlers were read before anything was written. The live session was there to
answer what the source could not.

The generated `.vibe/hooks.toml` was fed back through Vibe's own
`_load_hooks_file`, which returned it with no issues, and every matcher was
checked against Vibe's own `name_matches`. A config this package believes in and
the vendor rejects is the failure worth designing against, so the vendor's own
loader gets to decide.

What the live session settled:

- **`post_agent` fires with five keys and no message.** `session_id`,
  `parent_session_id`, `transcript_path`, `cwd`, `hook_event_name`. Three of the
  several other agents put the reply on the event; Vibe does not, so the transcript
  is the only source there is.
- **The transcript has caught up by the time the hook runs.** This was the open
  question, because reading a reply that is not written yet would look exactly
  like a clean scan. A probe hook reading its own `transcript_path` found the
  complete final reply already there, so `current()` needs no retry.
- **A denial really is injected as a retry.** A reply carrying banned words came
  back into the same transcript as `{role: "user", injected: true}` holding the
  findings, and the model answered it.
- **A `pre_tool` denial is wrapped before the model sees it**, as
  `Tool 'write_file' was denied by hook 'plain-english-docs': ...`. That wrapper
  is why a reason must not name this package: it would read twice.
- **The judge does not deadlock**, but it does inherit. A judge call runs its own
  Vibe session in the same directory, so it reads the same `.vibe/hooks.toml` and
  fires the same hooks. It survives today only because the judge runs with every
  tool disabled, which is a property of one flag. The generated judge switches
  itself off for its own child rather than relying on that.

One behaviour worth knowing about rather than fixing: told to write blocked
prose, the model's second attempt was to add the file to `exclude` in
`.plain-english.yml`. It failed for an unrelated reason. A linter a model can
edit its way past is a linter that needs its config in review, on every agent.

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

**Two gates.** In the 0.147.0 probe, folder trust stopped discovery without a message and
hook trust announced itself only in an interactive session. Current Codex documentation
now promises a startup warning when a hook definition needs review and directs the user
to `/hooks`. `codex exec` still cannot perform that interactive review.

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

Verified again against GitHub Copilot CLI 1.0.80 on 2026-08-26. The supported
prompt-mode opt-in loaded `.github/hooks/plain-english.json`. A shell write was
stopped, then Copilot retried through `Write`; that event named the inserted text
`file_text`. The adapter now reads that live field, so the retry is checked too.

Verified against `GitHub Copilot CLI 1.0.78` on 2026-08-09, on a Copilot Free
plan, which does cover the CLI. Two useful confirmations and two problems.

Both payload formats are exactly as documented, and both fire at once if you
register both:

| Event name | Tool names | Arguments field | Type |
|---|---|---|---|
| `PreToolUse` | `Bash`, `Read`, `Glob` | `tool_input` | object |
| `preToolUse` | `bash`, `view`, `glob` | `toolArgs` | JSON **string** |

`asArgs` handles both, which is what it was written for.

**Copilot CLI 1.0.78 did not read `.github/hooks/*.json`.** An identical
`sessionStart` hook fired from `~/.copilot/hooks/` and did not fire from the
repository. Current 1.0.80 documentation now states that repository and user
hooks are both loaded and merged, so the default install follows the current
contract. The old user location remains available through `--user`.

Reported upstream as
[github/copilot-cli#1730](https://github.com/github/copilot-cli/issues/1730),
with a controlled run: one session, the same `sessionStart` hook in all three
documented locations, and only the user-level one fires.

For an older CLI, ask `init` for the compatibility location:

```bash
npx plain-english init --agent copilot --user
```

`--user` is the only thing that makes `init` write outside the project, and it
is opt-in for that reason. Do not use both scopes on a current CLI unless you
intend the same hook to run twice.

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
and whether the generated launcher can find a repository build, local dependency
or global install. The launcher never downloads a package while a hook is running.

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
refuse but cannot rewrite. The `AskQuestion` tool skips hooks entirely. Older
builds also failed to dispatch some events that current documentation defines;
capture a payload if `postToolUse` or `stop` is absent on a particular build.

[`verifying-an-adapter.md`](verifying-an-adapter.md) is how each of these was
checked, and what to do when you add another agent.

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

Windsurf, Antigravity, Cline, opencode and Amp all have real interception
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

Detection is deliberately weak, because several agents send the same field names. Guessing
wrong is not fatal: every profile parses the shared envelope, so a misdetected agent still
reads the text correctly and only the reply envelope would be wrong. An agent that cannot
parse the reply treats the call as unhandled and carries on.
