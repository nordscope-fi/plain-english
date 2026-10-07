# plain-english for Claude Code

A Claude Code plugin that runs the plain-english prose linter inside the agent. It refuses a Markdown write, a commit or pull request message, or a tracker issue that breaks the ruleset, and holds a chat reply that does. Each refusal quotes the passage, names the rule and gives a rewrite hint. The ruleset and its exceptions are in the package's [rule guide](../../docs/writing-style.md).

The plugin is a mod: TypeScript functions Claude Code runs on its own events. The settings-hook install that `npx plain-english init --agent claude-code` writes does the same job from outside the agent. The [agent guide](../../docs/agents.md#claude-code) says how the two differ.

## Install

In a Claude Code session, version 2.1.287 or later:

```text
/plugin install plain-english --marketplace nordscope-fi/plain-english
```

The plugin carries its own copy of the CLI under `dist/`, one file with every dependency inlined, and the ruleset beside it. Nothing is downloaded at install and no script runs.

## What it hooks

| Event | What the hook does |
| --- | --- |
| `tool.call` | On `Write`, `Edit` and `MultiEdit` of a `.md` or `.mdx` file, on a `Bash` command that is `git commit`, `gh pr`, `gh issue` or `gh release`, and on the Linear MCP save tools: runs the CLI's hook adapter on the call and returns its decision. A deny refuses the call with the reason. An ask puts the question to you in the engine's own dialog, and refuses where nobody can answer. Everything else passes through untouched. |
| `classic.Stop`, `classic.SubagentStop` | Runs the chat adapter on the reply. A block holds the turn with the reason, in an interactive session and under `claude -p` alike. |
| `session.start` | Registers `/plain-english`. |
| `command.run` | `/plain-english [paths]` lints the working tree and prints the findings. No model turn. |

## What it calls

`process.run`, to run the bundled CLI with `node`; `session.cwd` and `session.id`, to build the hook payload; `ui.ask` for an advisory finding; `ui.log` for a notice; `command.register`. It makes no network request of its own. The chat adapter may run `claude -p` as a judge when a reply limit is the only thing failing, as the settings hook does today.

Every hook fails open. If the CLI cannot run, the write goes ahead and the reply is shown.

## Configuration

The CLI reads `.plain-english.yml` in the project as it does everywhere else. With no file, a finding is advisory and the mod asks before the write.

## Develop and test

`npm run build` at the repository root compiles the CLI and writes the bundle and ruleset copy into this folder. Both are committed, and CI fails when a build changes them and the change was not committed. Then, from this folder:

```text
claude --plugin-dir .
claude plugin validate --strict .
claude plugin test .
```

The manifest's `version` moves with each release; `npm version` does that.
