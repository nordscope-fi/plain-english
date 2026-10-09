# plain-english for Claude Code

A Claude Code plugin that checks prose the way a code linter checks source. It refuses a Markdown write, a commit or pull request message, or a tracker issue that breaks the ruleset, and holds a chat reply that does. Each refusal quotes the passage, names the rule and gives a rewrite hint. The ruleset and its exceptions are in the [rule guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/writing-style.md).

The plugin is a mod: TypeScript functions Claude Code runs on its own events. The settings-hook install that `npx plain-english init --agent claude-code` writes does the same job from outside the agent. The [agent guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/agents.md#claude-code) says how the two differ.

## Install

In a Claude Code session, version 2.1.293 or later:

```text
/plugin install plain-english --marketplace nordscope-fi/plain-english
```

The plugin carries its own copy of the CLI under `dist/`, one file with every dependency inlined, and the ruleset beside it. Nothing is downloaded at install and no script runs.

Standalone compressed archives (ZIP) and checksums are attached to [GitHub releases](https://github.com/nordscope-fi/plain-english/releases). Extract an archive, then pass its `plain-english` directory to `claude --plugin-dir`. The repository marketplace already supplies the plugin. An Anthropic directory listing requires a separate account-owner submission; the [release guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/releasing.md#submit-the-directory-listing) contains the prepared details. The event checks described here target Claude Code.

## What you see

The plugin checks writes and completed replies. Select **Plain English** under `/config` > **Output style** for writing guidance, then start a new session. Brief and full styles are also included. The bundled **writing-a-document** skill supplies document guidance when Claude invokes it.

1. **A save is questioned.** Claude tries to save `notes.md` opening with `Furthermore, the build is slow.` Before the file is written, a dialog headed `Prose check` opens:

   ```text
   plain-english found one passage in notes.md that breaks its rules:

   line 1: "Furthermore" (furthermore) Start the sentence with its own point.

   Refusing hands Claude the findings and a way to fix each. Save the file as it is?
   ```

   Two answers: save it as it is, or refuse so Claude rewrites. A refusal hands Claude the finding and the ways to resolve it, and Claude rewrites. With `failOn: error` in the project config there is no dialog: the save is refused outright and Claude reads the finding.
2. **A reply is held.** Claude ends a turn with a reply over the length limit, or one carrying a stock phrase. The turn does not end. Claude reads the finding and answers again, once.
3. **A commit message is questioned the same way.** `git commit -m "Leverage the new cache"` waits on the dialog, which names the commit message and quotes `"leverage" (leverage) Use 'use'.` Under `failOn: error` the command is refused and Claude commits with a plainer message.

The example sentences above sit in code spans and a code block so this file passes its own check.

Commands you run yourself:

- `/plain-english docs/` checks files without an extra model call. Quote paths containing spaces.
- `/plain-english review` opens the recent findings panel.
- `/plain-english status` reports the session's repair setting and recent findings.
- `/plain-english repair on` allows one automatic rewrite of an advisory write. A repeated attempt asks you before proceeding. `/plain-english repair off` restores the immediate question. Required checks still refuse the write.

## What it hooks

| Event | What the hook does |
| --- | --- |
| `tool.call` | On `Write`, `Edit` and `MultiEdit` of a `.md` or `.mdx` file, on a supported `Bash` Markdown write or message command (`git commit`, `gh pr`, `gh issue` or `gh release`), and on the Linear MCP save tools: runs the CLI's hook adapter on the call and returns its decision. A deny refuses the call with the reason. An ask opens a dialog headed `Prose check` that names the file or command and quotes one passage with its rule; a refusal there hands Claude the full finding, and where nobody can answer it refuses. Everything else passes through untouched. |
| `classic.Stop`, `classic.SubagentStop` | Runs the chat adapter on the reply. A block holds the turn with the reason, in an interactive session and under `claude -p` alike. |
| `session.start` | Registers `/plain-english`. |
| `prompt.context` | Adds declared project vocabulary and loaded writing-profile observations to the conversation. The selected output style supplies general writing guidance. |
| `command.run` | `/plain-english [paths]` lints the working tree and prints the findings. No model turn. |

## What it reads, writes and sends

- **Reads:** proposed prose, its surrounding document when an edit needs context, the project config, configured writing-profile summaries, and files you request. Excluded documents and paths outside the project are skipped before extra model checks. Edits report findings only on changed prose.
- **Writes:** temporary reply-control files with turn identifiers and small counters. The review panel retains recent findings in session memory. Approving a project term writes an exception to the project config after your confirmation.
- **Sends:** pattern matching stays on this machine. Extra checks ask the session's own model through Claude Code (`$.model.complete`), with your account and model service. Where Claude Code cannot make that call, the check falls back to `claude -p`. Document checks receive the complete proposed document as context, including its code examples and quoted material, but judge changed prose. Chat checks can also include your last question. These calls use your plan or API usage. Set `modelChecks: false` to disable them.
- **Keeps:** an extra check sent through the session is one request with no conversation history. The `claude -p` fallback disables local session persistence. Provider retention follows your account and provider settings. The host conversation still follows Claude Code's normal storage behavior.

Each extra check used to start a second copy of Claude Code, which took 1.3 to 1.6 seconds before the question was sent (measured on 2.1.294). The mod now asks the session's model itself. The CLI hands the question back, and the mod runs the CLI again with the answer, which takes about 0.18 seconds. A check can ask two questions at most. Both routes gave the same verdicts on 16 test prompts, recorded in [ADR-006](https://github.com/nordscope-fi/plain-english/blob/main/docs/architecture/adr/006-model-checks-through-the-host.md).

A failed checker produces a notice rather than a clean result. If the bundled CLI cannot run, the original action proceeds. If an extra model check cannot run, the pattern checks still apply. Document model calls share a 15-second deadline inside a 20-second tool check. Chat model calls share 45 seconds inside a 60-second hook.

On macOS, cancellation and timeouts were verified to stop the checker and its model child on Claude Code 2.1.293 and 2.1.294. Linux uses the same handling to stop a group of related processes and is checked in CI. Windows uses a process-tree termination command, but native Windows cancellation has not been verified. The checker wrapper also enforces its own timeout. Optional maintainer measurements record provider-reported usage and API price estimates without recording source prose. A missing measurement remains unknown; a reported price is not an account charge.

## For reviewers: every program, file and outbound call

This section answers the Claude directory's findings by their titles, then lists every call. Paths are relative to the plugin folder.

### The submission statement about helper servers

A plugin can declare helper servers that Claude calls for it, through the Model Context Protocol (MCP). The submission form asks the publisher to confirm that "the plugin does not exfiltrate credentials or execute code outside its declared MCP servers." This plugin declares no MCP servers. The credential half holds: nothing in it reads a credential. The code half needs this note. The mod starts the bundled plain-english checker on the user's computer with Node.js, as the sections below and the directory's own findings show. In one fallback case the checker runs `claude -p`. Those are the only programs it starts, and it makes no network request of its own.

### Mod starts other programs

The mod starts one program, `node`, the runtime Claude Code itself uses, on one file: `hooks/run-checker.mjs`. That wrapper starts the plain-english checker, `dist/cli.mjs` beside it. The checker has to run as a program because it reads the project's config and files, which a mod's own code cannot do without the same calls. The table below lists every command.

### Mod starts a program with a command the directory couldn't read in full

Every command and every setting is fixed text at the call, started in the plugin folder (`$.plugin.root`). Everything that varies goes in one JSON request on standard input, which the wrapper reads. It holds `cwd`, the project folder from `$.session.cwd()`, and `paths`, the paths you typed after `/plain-english`. It also holds `route`, whether the mod answers model questions itself, and `input`, the event or approval request for the checker. No shell is started, so nothing in a command is parsed or expanded.

`hooks/run-checker.mjs` writes out its own commands in full the same way. For each command from the mod it starts `node dist/cli.mjs` with fixed arguments, such as `node dist/cli.mjs lint --paths-from-stdin`. It names the project folder in the `PLAIN_ENGLISH_CWD` setting and gives typed paths on the checker's standard input.

| Where in `hooks/register.ts` | Command | Settings | Why |
| --- | --- | --- | --- |
| `spawnHook`, through `$.process.spawn` | `node hooks/run-checker.mjs hook docs --agent claude-code`, and the same with `github`, `issue` or `chat`, each written out in full | `PLAIN_ENGLISH_CHECK_TIMEOUT_MS: '20000'`, or `'60000'` for chat | Checks one proposed write or finished reply. |
| term approval, through `$.process.run` | `node hooks/run-checker.mjs approve` | `PLAIN_ENGLISH_CHECK_TIMEOUT_MS: '5000'` | Checks and then saves one approved term in the project config, once to check and once to write after you confirm. |
| `prompt.context`, through `$.process.run` | `node hooks/run-checker.mjs guidance` | `PLAIN_ENGLISH_CHECK_TIMEOUT_MS: '5000'` | Reads the project's declared vocabulary to add to the conversation. |
| `/plain-english`, through `$.process.run` | `node hooks/run-checker.mjs lint` | `PLAIN_ENGLISH_CHECK_TIMEOUT_MS: '120000'` | Checks the files you name. |

`hooks/run-checker.mjs` stops the checker, with any child of its own, when Claude Code cancels the hook or its time runs out. On Windows it runs `cmd.exe /d /c taskkill /pid %PLAIN_ENGLISH_CHECKER_PID% /t /f`, with the checker's process number in that setting. This is the only shell the plugin starts, and its command is fixed text. The checker starts one more program in a single case: `claude -p`, the fallback for an extra model check when `$.model.complete` cannot be made.

### Mod can read local data and can also send data out

What the mod reads: `session.cwd`, the session's working folder.

What it sends, and where: that folder's path, to the plain-english checker on the same computer. The way out the directory names is `process.run`. It starts `node hooks/run-checker.mjs` from the plugin folder and writes the path to that program's standard input, so the checker reads that project's config and files. The path does not leave the computer.

### Mod can read the conversation and can also send data out

What the mod reads: in `tool.call`, proposed file writes, shell commands and tracker-tool calls; in `classic.Stop` and `classic.SubagentStop`, finished replies and your last question.

What it sends, and where:

- **To the checker on the same computer**, through `process.run` and `process.spawn`: the text being checked, on the standard input of `node hooks/run-checker.mjs`.
- **To Claude**, through `model.complete`: the same text, for the extra model checks, using the session's own model and account. When that call cannot be made, the checker runs `claude -p`, which sends the same text to the same account.

Nothing else leaves the computer. Neither the mod nor the checker makes any other network request. Set `modelChecks: false` to keep everything on the computer.

### Uses a credential from the user's machine

Nothing in the plugin reads a credential, so there is no value to ask for through `user_config`. In each finding the address and the "credential" are unrelated: the address is text the checker prints or follows no link to, and the "credential" is an ordinary word in code. No file sends anything to any of these addresses.

| Address in the plugin | What the address is | What a scan may read as a credential beside it |
| --- | --- | --- |
| `github.com` (bundled checker) | This repository's pages: the design notes, recorded as the source of each built-in rule that names no other, and the project page in a code-scanning report. | Nothing. Its lists of allowed field names are called `ALLOW_FIELDS` and the like. |
| `json.schemastore.org` | The schema address that a code-scanning report (the format GitHub reads for findings) must name. It is written into the report, never requested. | The fallback that runs `claude -p` passes the environment unchanged, so that program can sign in to the account it already uses. Nothing in it is read or sent anywhere else. |
| `github.com` (`rules/default.yml`) | Links to this repository's pages, and credits to the sources of some rules, printed with findings. | The ruleset's example sentences, which contain words such as "secret" and "token". No pattern in it spells a shell command such as `set`. |
| `http://` | The prefix the bundled Markdown parser adds to a web address it finds in a document, such as `www.example.com`. | The bundled YAML and Markdown parsers name each piece of text they split a document into a `token`, and the YAML parser's error codes include `DUPLICATE_KEY`. The YAML library's two debug switches, which read `LOG_STREAM` and `LOG_TOKENS` from the environment, are off in the plugin's copy, so the bundle reads neither. |

A test fails if the bundle ever holds a host this table does not answer.

### Files written

The mod itself reads and writes no files. The checker it starts writes two kinds:

- **The project's plain-english config, usually `.plain-english.yml`.** Written only when you approve a term in the review panel and then confirm it in a dialog. `node hooks/run-checker.mjs approve` adds one exception for that term, and the checker reads it on its next run. The write step refuses unless the project folder and the file are byte for byte what the check step saw. It refuses an inherited or linked config too. It never writes Claude Code's own settings, instruction files or build files.
- **Temporary files** in the system's temporary folder, holding turn identifiers and small counters that stop a reply being held twice.

### Events that see or change other content

- `tool.call`: can refuse a call or ask you about it, and never changes its input.
- `classic.Stop` and `classic.SubagentStop`: can hold a reply for a rewrite, and change nothing else.
- `prompt.context`: adds one section with your project's declared vocabulary, and leaves the existing context in place.
- `command.run`: answers `/plain-english`, which the mod registers on `session.start`, and no other command.

### Bundled code

`dist/` is the plain-english checker from this repository, bundled with its dependencies by `scripts/build-plugin.mjs`. It is unminified and has no comments. It is split into files under the directory's read limit of 256 KiB (262,144 bytes), and `dist/cli.mjs` is the entry. The plugin's copy leaves out the JavaScript parser that only `lint --source-prose` uses. The same checker is published on npm with a signed record of the GitHub build that produced it.

## Configuration

The CLI reads `.plain-english.yml` in the project as it does everywhere else. With no file, a finding is advisory and the mod asks before the write. To make findings refuse outright, set `failOn: error` there. Chat has its own setting and blocks errors by default. Set `chat.failOn: never` to report chat findings without holding the reply. Extra model checks follow `modelChecks`: `false` disables them, `true` enables them, and omission retains the Claude Code default. The [adoption guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/adopting.md#3-write-a-project-config) walks through the file, and the [vocabulary section](https://github.com/nordscope-fi/plain-english#configure-project-vocabulary) of the main README covers project terms.

## When it misfires

A term the ruleset flags that is ordinary in your field goes in the config under `allow`, or on the line itself as an HTML comment naming the rule and, after a colon, the reason. The [rule guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/writing-style.md) shows the comment. A suppression without a reason is itself a finding. The review panel offers a one-use exception for the identical advisory attempt, approval of a term for one rule across the project, or a suppression comment copied with your reason. Paste that comment above the intended passage yourself. Inherited or linked configuration needs a manual edit. Term approval asks you to confirm: the named rule is waived on matching lines across the project. A required check must be fixed or resolved through the project config or a valid suppression comment. `plain-english doctor` prints the environment for a bug report.

Report a problem at <https://github.com/nordscope-fi/plain-english/issues>. Security concerns go to <peter@nordscope.fi>, not to the public tracker.

## Develop and test

`npm run build` at the repository root compiles the CLI and writes the bundle and ruleset copy into this folder. The build also copies generated styles and the document skill. These files are committed, and CI fails when a build changes them and the change was not committed. Then, from this folder:

```text
claude --plugin-dir .
claude plugin validate --strict .
claude plugin test .
```

The manifest's `version` moves with each release; `npm version` does that.

## Licence

MIT, as the rest of the repository.
