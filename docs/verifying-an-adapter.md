# Verifying an adapter

An adapter that reads nothing allows everything, and looks exactly like an
adapter that found nothing to say. That is the failure this page exists to
prevent, and it has happened here more than once.

Four agents were added in 0.4.0 from vendor documentation. By 0.6.0, four
separate defects had been found in them, and **only one was findable by
reading**. This is what the other three took.

## Vendor prose is the weakest evidence available

Two claims that shaped the original adapters turned out to be false, and both
came from documentation rather than from carelessness.

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

Never run here, for want of a subscription. `codex exec --full-auto` is the
non-interactive form, and Codex will not run a hook until it is approved with
`/hooks`, which is asked again whenever the command string changes.

Its Rust source settled the two questions that mattered more firmly than a
session would have: `codex-rs/core/src/tools/hook_names.rs` for the tool name,
`handlers/apply_patch.rs` for `tool_input.command`.

### Claude Code

`init` writes it, and it is the reference implementation for the other three,
since its hook contract is the shape they all copied.

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

1. Read the vendor's prose. Cheapest, and wrong twice out of five claims.
2. Read the vendor's source or schema. Settled Codex without a subscription.
3. Have someone attack the plan. A critique pass found five blockers in a plan
   that had already been researched, plus a shipped hang in code nobody had
   changed.
4. Run it on every platform. Windows found a capture that could not be replayed
   anywhere else.
5. Run the real agent. It found four things nothing above could. A project
   scope read from the wrong field. A repository hook location that does not
   work. An agent that writes files through the shell. And a recorder leaking
   an email address into a file designed to be safe to publish.
