# Verifying an adapter

An adapter that reads nothing allows everything, and looks exactly like an
adapter that found nothing to say. That is the failure this page exists to
prevent, and it has happened here more than once.

Four agents were added in 0.4.0 from vendor documentation. By 0.7.0, five
separate defects had been found in them, and **only one was findable by
reading**. This is what the other four took.

## Vendor prose is the weakest evidence available

Three claims that shaped the original adapters turned out to be false, and none
came from carelessness.

**Copilot's compatibility mode does not rename `tool_input`.** It has two event
names for the same hook: a camelCase one, and a capitalised one written
`PreToolUse`. The camelCase event uses `toolArgs`, and the documented
camelCase-to-snake_case rule implies `tool_args` for the capitalised one. It
does not. That one sends `tool_input`, already parsed. Following the rule gave
the wrong answer. Reading the payload schema gave the right one.

**Codex does not route file edits through `Bash`.** A third-party integration's
reference said it did as of 0.130.0. That described `openai/codex#16732`, fixed
months before the version named. A shell-redirection parser was nearly written
on the strength of it, which would have been the second hand-written parser in
the hook path in a week.

**Codex's `ask` is not merely ignored.** Its reference used to call the value
"parsed but not supported yet", which reads as harmless. On 0.147.0 the hook run
is reported Failed and the reason reaches nobody. Current documentation no
longer lists `ask` at all, so a claim can also rot in place while the sentence
that carried it disappears.

So rank your evidence, and say which you have:

| | |
|---|---|
| **observed** | seen against a running agent |
| **source** | the vendor's own code or published JSON schema |
| **docs** | the vendor's prose |

`docs/agents.md` marks every claim with one of these. Keep doing that. An
adapter built on `docs` alone is a guess with good manners.

## Capture the payload

```bash
PLAIN_ENGLISH_RECORD=./captures <the agent, doing the thing that fails>
```

One JSON file per hook invocation, holding the payload's structure, the
canonical event parsed out of it, the decision, and the reply's keys. Paths
become `{{TMP}}` and `~`, prose becomes a length and a hash, identity is
removed, and a capture that still holds a home directory is not written at all.
It is safe to attach to an issue.

A capture answers the only question that matters: did the adapter read the
right field. Everything else follows from that.

## Register a tracer on every event

The single most useful trick. Write a hook that only records what it was given:

```bash
#!/usr/bin/env bash
cat > "$TRACE_DIR/$1-$(date +%s%N).json"
exit 0
```

Register it on every event the agent has, including the ones you do not want.
Then silence is diagnosable. "No hook fired at all" and "only the post hook
fired" and "the tool was called something else" look identical from inside the
adapter and completely different in a trace directory.

Registering **both** payload formats at once, where an agent has two, settles in
one run which it dispatches and with which field names.

## What each agent needs

### Cursor

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent -p --force --output-format stream-json "…"
```

`--force` is mandatory. Without it, print mode does not apply proposed changes,
so no file is written and no write hook fires. That is the likeliest cause of a
false "the hook is dead".

`--output-format stream-json` gives a transcript to check the capture against.

### GitHub Copilot

```bash
npm install -g @github/copilot
copilot -p "…" --allow-all-tools --no-ask-user --log-level debug --log-dir ./logs
```

The Free plan covers the CLI. Two traps:

- **The CLI does not read `.github/hooks/*.json`**, although its own
  configuration help says repo-level hooks live there. Install to
  `~/.copilot/hooks/` for the CLI. Use `COPILOT_HOME` to point at a throwaway
  directory rather than touching the real one while testing.
- **Copilot writes files through the shell**, so a write-tool matcher may never
  fire. Watch for `Bash` in the trace before concluding the hook is broken.

### OpenAI Codex CLI

```bash
npm install -g @openai/codex
codex login                    # opens a browser
CODEX_HOME=$TW codex exec --approve-for-me --skip-git-repo-check \
  --dangerously-bypass-hook-trust "…" < /dev/null
```

Four traps, all of which make a correct configuration do nothing:

- **Folder trust.** `<repo>/.codex/hooks.json` is read only when
  `$CODEX_HOME/config.toml` marks the project `trust_level = "trusted"`.
- **Hook trust**, separate, hashed against the command string, and skipped by
  `--dangerously-bypass-hook-trust`.
- **`codex exec` runs no hooks at all** without that flag, even when everything
  is trusted.
- **Worktrees** resolve to the main working tree's file.

`CODEX_HOME` moves the whole user-level directory somewhere disposable, which is
the same trick `COPILOT_HOME` allows. Authentication lives in there, so symlink
`auth.json` into it rather than copying credentials around.

Two more things to know. Close stdin with `< /dev/null` or `codex exec` waits on
it forever. And `--sandbox` cannot be combined with `--approve-for-me`.

### Ask the agent what it loaded

Codex has the most useful verification tool found on any of the four, and it
costs no model tokens. `codex app-server` speaks JSON-RPC (JSON Remote Procedure
Call) over stdin. Its `hooks/list` call returns Codex's own view of the
configuration: every hook it discovered, the file each came from, the scope it
assigned, the trust state, the effective timeout, and any error it swallowed.

```
initialize → initialized → {"method":"hooks/list","params":{"cwds":["<repo>"]}}
```

Six of the eight Codex findings came from that call rather than from a session.
It answers "did it read my file" directly, which is the question a trace answers
only by inference. Look for the equivalent before spending model turns: Copilot
has `--log-level debug`, Cursor has `--output-format stream-json`.

### Replay a keyboard-only approval

Codex will not run a hook until a human approves it, which blocks any scripted
run that wants to test the approved state. Approving one by hand once shows
where the answer is kept, and `hooks/list` supplies both halves of it:

```toml
[hooks.state."<sourcePath>:<event>:<group>:<index>"]   # the `key` field
trusted_hash = "sha256:…"                              # the `currentHash` field
```

Write that and the next run starts trusted. Two guesses at this shape failed
before a real approval was watched. The general lesson is there: when a gate
opens only by hand, open it by hand once and record what changed.

Handle a persisted approval carefully. It is a security control, so seed it only
in a throwaway configuration directory for a hook you wrote yourself, never in
somebody's real one.

### Claude Code

`init` writes it, and it is the reference implementation for the other three,
since its hook contract is the shape they all copied.

## Chat transcripts

The chat channel reads what an agent already said, which means finding where it keeps it.
That turned into the cleanest worked example on this page of why both halves of the order
below matter.

**Disk first, and it was not enough.** Inspecting a live machine found
`~/.cursor/chats/<hash>/<uuid>/store.db`, a SQLite file whose `blobs` table holds message
JSON. It looked like the answer. In the store examined, 11 of 39 blobs parsed as JSON and 4
of those were assistant messages; the rest are opaque to a plain JSON read. A reader built
on it would have returned a fraction of the replies and looked exactly like one that found
nothing, which is the failure this page opens by naming.

**Then documentation, which named a different file.** Cursor documents neither the location
nor the format, but third-party writing on it pointed at
`~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`. That path existed on
the same machine, held the full transcript, and was never going to be found by looking at
the obviously-named directory.

**And documentation alone would have been worse.** Claude Code's own subagent transcripts
live in a nested `subagents/` directory that no page describes, and only a walk of the tree
turns them up. Codex's rollout record shape, Copilot's table names and the write-ahead
logging behaviour of its store all came off disk too.

So the order that worked here was: read the disk, read the documentation, and treat
disagreement between them as the interesting part rather than as noise.

### Two traps specific to a store rather than a payload

**A SQLite file may be mostly log.** Copilot's `session-store.db` was 4 KB with a 650 KB
write-ahead log beside it. `file:<path>?immutable=1` promises SQLite the file cannot
change, so SQLite skips the log entirely. The query then returned "no such table" against
a store that plainly had one. A plain read-only open does read the log, but it wants to
touch the `-shm` file to do it, which is a write to somebody's agent state. Copy the
database and its sidecars to a scratch directory and open the copy.

**A store that cannot be read must not report clean.** Every reader answers `available()`
with a reason rather than a boolean, and the CLI prints one line per reader that could not
run, counted separately from zero findings. Without that, a missing `node:sqlite`, a moved
`COPILOT_HOME` and a genuinely clean scan all print the same thing.

### Fixtures, not captures

`test/chat.test.ts` hand-authors one fixture per agent in that agent's real record shape.
None is copied from a real session, and none should be. A transcript holds file contents,
command output and pasted text. Claude Code's documentation adds that a credential printed
by a command lands in one too.

## Install the way a user would

Pack the tarball and install it into a scratch repository:

```bash
TARBALL=$(npm pack --silent | tail -1)
cd "$(mktemp -d)" && git init -q && npm init -y
npm install "/path/to/$TARBALL"
npx --no-install plain-english init --agent <id>
```

Every installed hook runs `npx --no-install plain-english`, which resolves from
the project's own `node_modules`. A global install with no local one makes every
hook do nothing while the config still reads correctly. `plain-english doctor`
reports this, and testing against a shortcut would hide it.

## Turn the capture into a test

A capture that is read once and thrown away has bought a single afternoon. Add
it to `test/corpus/regressions.yml` with an `agent:` field and `{{TMP}}` in
place of paths, and it becomes a permanent check.

Keep the whole envelope, not only the fields the adapter reads. Cursor sends no
`cwd`, it sends `workspace_roots`, and that only became visible because the
recorded payload kept everything.

## What a fixture cannot catch

A frozen recording pins the parser against itself. If a vendor renames a field
tomorrow, the fixture still names the old one and the test still passes, while
the hook allows everything in the field that moved.

The runtime signal is a write-shaped call that yields no path and no text, which
`decide` reports on stderr. That is the drift canary, it is free on every user's
machine, and it is the only thing here that catches a change nobody has heard
about yet.

## The order that worked

Each step found something the one before it missed, so none of them is
redundant.

1. Read the vendor's prose. Cheapest, and wrong three times out of six claims.
2. Read the vendor's source or schema. A shipped binary often embeds the schema.
   Codex's carries the JSON Schema for every hook event, and the error strings
   its runtime prints. That beats the source of a version you are not running.
3. Read the vendor's issue tracker. Codex has open reports on trust prompts,
   worktrees and `codex exec`. Each one leaves an installed hook running zero
   times with nothing said, and none of them appears in any documentation.
4. Have someone attack the plan. A critique pass found five blockers in a plan
   that had already been researched, plus a shipped hang in code nobody had
   changed.
5. Run it on every platform. Windows found a capture that could not be replayed
   anywhere else.
6. Ask the agent what it loaded, if it will say. `hooks/list` answered six
   questions about Codex for no model tokens.
7. Run the real agent. It found six things nothing above could. A project scope
   read from the wrong field. A repository hook location that does not work. Two
   agents that write files through the shell. A reply value that fails the hook
   rather than being ignored. And a recorder leaking an email address into a
   file designed to be safe to publish.
