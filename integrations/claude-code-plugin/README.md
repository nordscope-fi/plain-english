# plain-english for Claude Code

A Claude Code plugin that checks prose the way a code linter checks source. It refuses a Markdown write, a commit or pull request message, or a tracker issue that breaks the ruleset, and holds a chat reply that does. Each refusal quotes the passage, names the rule and gives a rewrite hint. The ruleset and its exceptions are in the [rule guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/writing-style.md).

The plugin is a mod: TypeScript functions Claude Code runs on its own events. The settings-hook install that the command-line checker's `init --agent claude-code` writes does the same job from outside the agent. The [agent guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/agents.md#claude-code) says how the two differ.

## Install

In a Claude Code session, version 2.1.293 or later:

```text
/plugin install plain-english --marketplace nordscope-fi/plain-english
```

The plugin carries the checker's core under `hooks/core/`, bundled with its dependencies and the built-in ruleset. Installing it copies these files and nothing else. A check starts no program: the mod runs the checker inside Claude Code.

Each [GitHub release](https://github.com/nordscope-fi/plain-english/releases) also carries a ZIP copy of this folder with checksums. The repository marketplace already supplies the plugin. An Anthropic directory listing requires a separate account-owner submission; the [release guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/releasing.md#submit-the-directory-listing) contains the prepared details. The event checks described here target Claude Code.

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
| `tool.call` | On `Write`, `Edit` and `MultiEdit` of a `.md` or `.mdx` file, on a supported `Bash` Markdown write or message command (`git commit`, `gh pr`, `gh issue` or `gh release`), and on the Linear MCP save tools: runs the checker on the call and returns its decision. A deny refuses the call with the reason. An ask opens a dialog headed `Prose check` that names the file or command and quotes one passage with its rule; a refusal there hands Claude the full finding, and where nobody can answer it refuses. Everything else passes through untouched. |
| `classic.Stop`, `classic.SubagentStop` | Runs the reply check. A block holds the turn with the reason, in an interactive session and under `claude -p` alike. |
| `session.start` | Registers `/plain-english`. |
| `prompt.context` | Adds declared project vocabulary and loaded writing-profile observations to the conversation. The selected output style supplies general writing guidance. |
| `command.run` | `/plain-english [paths]` lints the working tree and prints the findings. No model turn. |

## What it reads, writes and sends

- **Reads:** proposed prose, its surrounding document when an edit needs context, the project config, configured writing-profile summaries, and files you request. Excluded documents and paths outside the project are skipped before extra model checks. Edits report findings only on changed prose.
- **Writes:** nothing, unless you approve a project term: then, after you confirm it, an exception in the project config. The review panel and the reply checks keep recent findings, turn identifiers and small counters in session memory.
- **Sends:** pattern matching stays on this machine. Extra checks ask the session's own model through Claude Code (`$.model.complete`), with your account and model service. Where Claude Code cannot make that call, the extra check is reported unavailable and the pattern result stands. Document checks receive the complete proposed document as context, including its code examples and quoted material, but judge changed prose. Chat checks can also include your last question. These calls use your plan or API usage. Set `modelChecks: false` to disable them.
- **Keeps:** an extra check is one request with no conversation history. Provider retention follows your account and provider settings. The host conversation still follows Claude Code's normal storage behavior.

The checker runs inside the mod ([ADR-008](https://github.com/nordscope-fi/plain-english/blob/main/docs/architecture/adr/008-checker-runs-inside-the-mod.md)). When it needs a file or a model's answer, it hands the request back; the mod reads the file through Claude Code or asks the session's model, and the checker repeats the check with the answer. A check can ask two model questions at most. Asking through the session gave the same verdicts as a separate `claude -p` on 16 test prompts, recorded in [ADR-006](https://github.com/nordscope-fi/plain-english/blob/main/docs/architecture/adr/006-model-checks-through-the-host.md).

A failed check produces a notice rather than a clean result, and the original action proceeds. If an extra model check cannot run, the pattern checks still apply. Document model calls share a 15-second deadline, and chat model calls share 45 seconds. A check starts no program, so cancelling a turn leaves nothing running.

## For reviewers: what the plugin runs, reads, writes and sends

The plugin starts no program. Its mod runs the plain-english checker's core inside Claude Code's own process ([ADR-008](https://github.com/nordscope-fi/plain-english/blob/main/docs/architecture/adr/008-checker-runs-inside-the-mod.md)). `hooks/core/` holds that core, bundled with its dependencies, and `hooks/core/default-rules.mjs` holds the built-in ruleset. Paths are relative to the plugin folder.

### The submission statement about helper servers

A plugin can declare helper servers that Claude calls for it, through the Model Context Protocol (MCP). The submission form asks the publisher to confirm that "the plugin does not exfiltrate credentials or execute code outside its declared MCP servers." This plugin declares no MCP servers, reads no credential, starts no program and makes no network request of its own. Its only code is the mod, which Claude Code runs.

### What the mod reads

- **Session facts:** `session.cwd`, `session.id` and `session.model`.
- **The conversation:** in `tool.call`, proposed file writes, shell commands and tracker-tool calls; in `classic.Stop` and `classic.SubagentStop`, finished replies.
- **Files, through `fs.read`, `fs.stat` and `fs.list`:**
  - the project's `.plain-english.yml`, looked for in the folders above the project too, any config it `extends`, and a writing profile it names;
  - a message file a commit names with `-F`, and the current text of a file being edited, so an edit is judged in context;
  - the transcript a `Stop` event names, for your last question;
  - the files `/plain-english` checks.

  `fs.stat` resolves links, so a write that lands outside the project is skipped.

### What it sends, and where

Only the extra model checks send anything off the computer. Through `model.complete`, the session's own model and account receive the text being checked: a proposed document, a commit or issue text, or a finished reply and your last question. Nothing else leaves the computer. Set `modelChecks: false` to keep everything on it.

### Files written

One, and only after you ask for it: the project's config, `.plain-english.yml` or `.plain-english.yaml`, written through `fs.write` at that fixed path. That happens when you approve a term in the review panel and confirm it in a dialog. Before writing, the checker repeats every check. It refuses when the file changed since the check, when it is a link, or when a config in a folder above would govern the project. The mod also refuses when Claude Code's working folder is not the project root the check named. It never writes Claude Code's own settings, instruction files or build files.

### Events that see or change other content

- `tool.call`: can refuse a call or ask you about it, and never changes its input.
- `classic.Stop` and `classic.SubagentStop`: can hold a reply for a rewrite, and change nothing else.
- `prompt.context`: adds one section with your project's declared vocabulary, and leaves the existing context in place.
- `command.run`: answers `/plain-english`, which the mod registers on `session.start`, and no other command.

### Uses a credential from the user's machine

Nothing in the plugin reads a credential: no environment variable and no key file, so there is no value to ask the person for in the plugin's settings. The plugin carries no web address. In its copy of the built-in ruleset, `hooks/core/default-rules.mjs`, each finding's link to this repository's guides is a path such as `docs/writing-style.md#readability`, and the rule source credits that only the CLI's policy page shows are left out. The rules themselves are the same.

The bundled code also avoids every form the directory reads as a credential or as sending one, so a reviewer has nothing to set aside:

- No network host. The model answers the mod passes to the checker sit in a field called `answered`. The Markdown library's helper for `file:` addresses is replaced by one that accepts none, because the checker gives it paths only.
- No name in capitals shaped like an environment variable: the YAML parser's error codes are written in lower case, such as `unexpected-token`.
- No message built by dropping a key or token into a template: those messages, such as the YAML parser's "Key ... already set", are joined as plain text.
- No variable named after a command that lists the environment: the ruleset's variable is `ruleset`, the environment's is `environment`, and the YAML parser's set type is `setTag`. No line begins with such a command either.

The word `token` in the bundled code belongs to the YAML and Markdown parsers, where it means a piece of parsed text. Tests fail if any of these forms comes back.

### Bundled code

`hooks/core/` is the checker from this repository, built by `scripts/build-plugin.mjs` for a runtime without Node. These are the build's rules. Apart from the one config key named under plain data, the checker behaves as it does on the command line:

- **Stand-ins for Node-only parts.** The parts that read files, start the command-line fallback or write evaluation receipts are replaced with stand-ins that do none of those things. The mod passes its own file access to every check, and the build fails if any Node import remains.
- **Readable files.** The bundle is unminified, has no comments, and has no line over 1,000 characters. Long strings and regular expressions are split into pieces joined when the code runs, and each regular expression is checked identical as the build runs.
- **Size.** Every file is under the directory's read limit of 262,144 bytes.
- **No `eval`.** The bundled `fault` library's unused `eval` member is removed, and the `format` package is replaced with a ten-line formatter.
- **Plain data, no accessors.** The bundled libraries' getters, setters, `Object.defineProperty` calls and prototype lookups are rewritten as plain properties and methods: the YAML library's node and schema fields, the Markdown parser's splice buffer and construct list, and the file object the sentence layer needs. The tree walker no longer names its visitor function for debugging. The YAML library's node `clone`, which nothing in the checker calls, refuses instead of copying through the prototype. One input reads differently from the command-line checker: a config key named `__proto__` is refused, where the command-line checker stores it as an ordinary key.
- **No unused web addresses.** The Markdown parser's `http://` prefix for a bare `www.` link is dropped, since the checker never reads the address, and each rule's default source names the design notes by path.

Jira and Confluence HTML is read by the checker's own small reader, which decodes the entities that text uses, so no HTML library and no encoded entity table is bundled.

The same checker is published on npm with a signed record of the GitHub build that produced it.

## Configuration

The checker reads `.plain-english.yml` in the project as it does everywhere else. With no file, a finding is advisory and the mod asks before the write. To make findings refuse outright, set `failOn: error` there. Chat has its own setting and blocks errors by default. Set `chat.failOn: never` to report chat findings without holding the reply. Extra model checks follow `modelChecks`: `false` disables them, `true` enables them, and omission retains the Claude Code default. The [adoption guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/adopting.md#3-write-a-project-config) walks through the file, and the [vocabulary section](https://github.com/nordscope-fi/plain-english#configure-project-vocabulary) of the main README covers project terms.

## When it misfires

A term the ruleset flags that is ordinary in your field goes in the config under `allow`, or on the line itself as an HTML comment naming the rule and, after a colon, the reason. The [rule guide](https://github.com/nordscope-fi/plain-english/blob/main/docs/writing-style.md) shows the comment. A suppression without a reason is itself a finding. The review panel offers a one-use exception for the identical advisory attempt, approval of a term for one rule across the project, or a suppression comment copied with your reason. Paste that comment above the intended passage yourself. Inherited or linked configuration needs a manual edit. Term approval asks you to confirm: the named rule is waived on matching lines across the project. A required check must be fixed or resolved through the project config or a valid suppression comment. `plain-english doctor` prints the environment for a bug report.

Report a problem at <https://github.com/nordscope-fi/plain-english/issues>. Security concerns go to <peter@nordscope.fi>, not to the public tracker.

## Develop and test

`npm run build` at the repository root writes the checker's core and the ruleset into `hooks/core/`. The build also copies generated styles and the document skill. These files are committed, and CI fails when a build changes them and the change was not committed. Then, from this folder:

```text
claude --plugin-dir .
claude plugin validate --strict .
claude plugin test .
```

The manifest's `version` moves with each release; `npm version` does that.

## Licence

MIT, as the rest of the repository.
