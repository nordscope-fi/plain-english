# plain-english for Claude Code

A Claude Code plugin that checks prose the way a code linter checks source. It refuses a Markdown write, a commit or pull request message, or a tracker issue that breaks the ruleset, and holds a chat reply that does. Each refusal quotes the passage, names the rule and gives a rewrite hint. The ruleset and its exceptions are in the [rule guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/writing-style.md).

The plugin is a mod: TypeScript functions Claude Code runs on its own events. The settings-hook install that `npx plain-english init --agent claude-code` writes does the same job from outside the agent. The [agent guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/agents.md#claude-code) says how the two differ.

## Install

In a Claude Code session, version 2.1.287 or later:

```text
/plugin install plain-english --marketplace nordscope-fi/plain-english
```

The plugin carries its own copy of the CLI under `dist/`, one file with every dependency inlined, and the ruleset beside it. Nothing is downloaded at install and no script runs.

## What you see

Three things happen without any prompt from you.

1. **A write is refused.** Claude tries to save a document that opens with `Furthermore, the build is slow.` The save does not happen. Claude reads `"Furthermore" (furthermore) Start the sentence with its own point.` and rewrites.
2. **A reply is held.** Claude ends a turn with a reply over the length limit, or one carrying a stock phrase. The turn does not end. Claude reads the finding and answers again, once.
3. **A commit message is refused.** `git commit -m "Leverage the new cache"` never runs. Claude reads `"leverage" (leverage) Use 'use'.` and commits with a plainer message.

The example sentences above sit in code spans so this file passes its own check.

And one command you run yourself: `/plain-english docs/` lints those files and prints the findings, with no model turn.

## What it hooks

| Event | What the hook does |
| --- | --- |
| `tool.call` | On `Write`, `Edit` and `MultiEdit` of a `.md` or `.mdx` file, on a `Bash` command that is `git commit`, `gh pr`, `gh issue` or `gh release`, and on the Linear MCP save tools: runs the CLI's hook adapter on the call and returns its decision. A deny refuses the call with the reason. An ask puts the question to you in the engine's own dialog, and refuses where nobody can answer. Everything else passes through untouched. |
| `classic.Stop`, `classic.SubagentStop` | Runs the chat adapter on the reply. A block holds the turn with the reason, in an interactive session and under `claude -p` alike. |
| `session.start` | Registers `/plain-english`. |
| `command.run` | `/plain-english [paths]` lints the working tree and prints the findings. No model turn. |

## What it reads, writes and sends

- **Reads:** the text of the write, commit message or reply being judged, as Claude Code hands it to the hook; `.plain-english.yml` in the project, when present; the files you name to `/plain-english`.
- **Writes:** one small state file per turn in the system's temporary directory, so a held reply is held once and not in a loop. Nothing in the project, and nothing about the text itself.
- **Sends:** nothing to any network service. The chat adapter may run `claude -p` on this machine as a judge when a reply limit is the only thing failing. That is your own Claude Code, under your own account, with no tools.
- **Keeps:** nothing. No text is logged or retained.

What it calls on the engine: `process.run`, to run the bundled CLI with `node`; `session.cwd` and `session.id`, to build the hook payload; `ui.ask` for an advisory finding; `ui.log` for a notice; `command.register`. Every hook fails open: if the CLI cannot run, the write goes ahead and the reply is shown.

## Configuration

The CLI reads `.plain-english.yml` in the project as it does everywhere else. With no file, a finding is advisory and the mod asks before the write. To make findings refuse outright, set `failOn: error` there. The [adoption guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/adopting.md#3-write-a-project-config) walks through the file, and the [vocabulary section](https://github.com/nordscope-fi/plain-english#configure-project-vocabulary) of the main README covers project terms.

## When it misfires

A term the ruleset flags that is ordinary in your field goes in the config under `allow`, or on the line itself as `<!-- plain-english-disable-next-line leverage: finance sense -->`, with the reason after the colon, since a suppression without one is itself a finding. A refusal you need to get past once: `touch .plain-english-ack-docs` in the project root waives that channel for ten minutes. `plain-english doctor` prints the environment for a bug report.

Report a problem at <https://github.com/nordscope-fi/plain-english/issues>. Security concerns go to <peter@nordscope.fi>, not to the public tracker.

## Develop and test

`npm run build` at the repository root compiles the CLI and writes the bundle and ruleset copy into this folder. Both are committed, and CI fails when a build changes them and the change was not committed. Then, from this folder:

```text
claude --plugin-dir .
claude plugin validate --strict .
claude plugin test .
```

The manifest's `version` moves with each release; `npm version` does that.

## Licence

MIT, as the rest of the repository.
