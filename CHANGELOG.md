# Changelog

Notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Fixed

- **The Claude Code `Stop` hook was installed in a shape that fails validation, which silently voided the user's whole settings file.** The documentation shows `Stop` as a bare `{ type, command }` in the event array, and 0.9.0 wrote it that way. Against Claude Code 2.1.234 that entry fails validation, and `claude --help` gives the consequence: in print mode a settings file that fails validation is "silently ignored (no error dialog is shown)". So one bad entry stopped every other hook in the file, including hooks nothing to do with this package. Both stop events now install nested as `{ matcher, hooks }`, which is what every event in a working settings file uses, and a test pins the shape.
- The once-per-turn block key read `prompt_id` and fell back to the session. Codex names a turn `turn_id`, so on Codex one block would have silenced the rest of the session rather than the rest of the turn.
- The Copilot chat reader asked the session store for the current reply. Copilot's `Stop` payload names something better and more timely: `transcriptPath` points at `session-state/<id>/events.jsonl`, where an `assistant.message` record carries the reply under `data.content`, present at the moment the hook runs. The store is now the fallback rather than the first choice.
- A Claude Code `SubagentStop` finding named the parent's transcript. That event carries `agent_transcript_path`, the subagent's own file, which is where the reply actually is.

### Changed

- **Every per-agent chat claim moved from `docs` tier to `observed`.** A tracer was registered on every event each of the four agents has and run against the live binaries: Claude Code 2.1.234, Codex 0.147.0, Copilot 1.0.78, Cursor 2026.08.04. [`docs/agents.md`](docs/agents.md#the-chat-channel) carries the table and what the pass changed. Four results were not what the documentation implied.
- **Claude Code does not act on a `Stop` block in print mode.** The hook runs and the block is emitted and read, and the turn ends anyway. Isolated with a minimal always-block hook that has nothing to do with this package, so it is not something in this adapter. Under `claude -p` the chat channel is advisory whatever `failOn` says. Interactive sessions are untested; driving one needs a terminal this pass did not have.
- **Claude Code's transcript really does lag**, at both `Stop` and `SubagentStop`. That confirms the documented warning and the design it forced: take `last_assistant_message` off the payload and never read the transcript for the turn being judged. Codex's transcript, by contrast, was already written.
- **Cursor dispatches neither `stop` nor `afterAgentResponse`.** With twelve events registered, only `sessionStart` and `sessionEnd` fired. Chat there is ungated, which the generated policy already said, and now it is measured rather than reported.
- Copilot's `Stop` carries no reply text, exactly as documented. Registering both `Stop` and `agentStop` runs the hook twice, so pick one casing.
### Added

- **The chat channel.** The one channel this tool could not reach. It is now covered three ways, and `init` installs all of them. An output style at three levels, generated from the ruleset; a hook on the stop events, which reads the finished reply and can hand a finding back to the model; and `plain-english lint --chat`, which reads what was already said.
- **Three output-style levels**, `brief`, `standard` and `full`, all generated from one new `chat:` section in `rules/default.yml`. They are strictly nested and a test proves it, so switching up never loses a rule. `init` writes all three and selects `standard` by setting `outputStyle` in `.claude/settings.local.json`, the file Claude Code's own picker writes, and prints what it replaced when it replaces one. Switching level is a menu choice under `/config` rather than a re-install. A project moves a section between levels, or drops one, with a `chat.guidance` override, the same field-by-field idiom the word rules already use.
- The chat guidance used to be a hand-written TypeScript string in `src/render.ts`. Only the number 35 came from the ruleset, while the README said the whole thing did. It is data now, which is the point of the file it should always have lived in.
- **`plain-english lint --chat`**, reading the session transcripts all four agents write to local disk. Findings arrive in the same shape a document produces, so every existing formatter works on them unchanged. `--summary` reports findings per 1,000 words split by main loop against subagent, which is the split that matters: an output style never reaches a subagent, so one number across both hides the only gap it cannot close. Local only, never a CI step, and the GitHub Action takes no `--chat` input.
- **A `chat` hook channel**, on `Stop` and `SubagentStop`. Under the default `failOn: never` it reports through `systemMessage` and holds up nothing; under `failOn: error` it blocks and the findings become the model's next prompt. Blocking is guarded three ways, because a blocked turn produces a new reply that can trip a different rule: the agent's own `stop_hook_active`, one block per turn recorded beside the ack file on the same self-expiring clock, and `.plain-english-ack-chat`.
- Five chat-only tells, held as phrases rather than regexes so the words shown to a model and the pattern matched by the linter cannot drift: `affirmation-opener`, `announced-structure`, `closing-pleasantry` block, and `concession-formula` and `error-theatre` warn. The last two have real uses that no pattern can separate from the tell, which is the same reason `silently` and `holistic` warn.
- `Decision.replacement`, unset. Copilot's `subagentStop` accepts a `modifiedResponse` that replaces a subagent's output outright. Using it means generating prose and nothing here does, but `Decision` is the contract all four profiles implement, so the field lands now rather than as a later change to a type four profiles depend on.

### Fixed

- **A large report was truncated at about 64 KB through a pipe.** `process.exit()` discards whatever stdout has buffered, which is invisible writing to a terminal and silent writing to a pipe. Found on `lint --chat --format json`, where 514 KB of valid JSON became 65 KB of invalid JSON, and always reachable by `lint` over a big enough tree.

### Changed

- **Two claims in the documentation were wrong, and one was out of date.** A chat reply is no longer unreachable: three of the four agents document an event carrying the assistant's final message. A style does not reach a subagent, which was said, and does reach a fork, which inherits the parent's system prompt, which was not. And `MessageDisplay` is documented as display-only with fields `role`, `content` and `is_partial`, not as something that can replace on-screen text through `displayContent`. The conclusion that it is unsuitable survives; every reason given for it did not.
- The generated policy's "what nothing here can reach" section is a per-agent table instead of one flat claim, built from which chat hooks are actually installed.
- `init` no longer asks anyone to `mkdir`, `cp` out of `node_modules`, and find a menu. It writes the styles and selects one. `render` emits eight files rather than six.

## [0.9.0] - 2026-08-15
### Changed

- `worth-noting` covers the rest of its family. It caught `it is worth noting` and `it is important to note`, and missed `it is important to understand`, `it's important to remember` and `it is worth mentioning`, which are the same stall with a different verb. The verb list is closed and every entry is a verb of noticing, so `It is important to test the migration before you run it` stays legal: that sentence says what to do, and the blocked ones say only that something is about to be said.

### Added

- Ten padding rules, all `warn`: `the fact that`, `in order to`, `in terms of`, `is able to` and `has the ability to`, `a number of`, `in a ... manner`, `as to whether`, `not un...`, `prior to`, `with respect to`. This is Strunk's rule 13, omit needless words. It is the part of a general style guide that fits a tool scoped to AI tells. The phrases are a closed set, so they can be checked exactly, and a model reaches for them far more often than a person does. Each one was measured against this project's own hand-edited docs before it was written, and each scored zero hits there. They warn instead of blocking because none of them is wrong, only long, and a gate that fires on a phrase this ordinary is one people learn to route around.
- Two of Strunk's rules were tested and left out. Passive voice and the `there is` opener both fired on correct sentences here (`are covered by`, `is accepted by`, `There is no config needed`), and both need a reader to tell a weak use from a right one. Those stay with a general prose linter such as Vale, which the README already points at.
- The generated rules table can now describe a rule that matches a word shape. A repeated character class renders as `...`, so `in a ... manner` reads as a rule instead of as a regex. The test guarding that table checked only for backslashes and the quantifier characters, which let `not un[a-z]{3,}` through on the first attempt; it now rejects brace quantifiers and class ranges too.

## [0.8.0] - 2026-08-10
### Added

- Suppression directives take a reason after a colon, and `unexplained-suppression` warns on one that does not. `<!-- plain-english-disable leverage: finance sense -->`. A waiver used to record that somebody silenced a rule and nothing about why, so the next reader could not tell a considered exception from a rule somebody found annoying. The rule is the one rule an in-file directive cannot silence: `disable-file` covers the whole document, so a reasonless `disable-file` would be the single waiver nothing could report. It is turned off in config, or by an `allow` pattern on the line, and by nothing else.
- `reason:` on a rule or readability override in `.plain-english.yml`. A config override silences a rule in every file, which is broader than any comment, and until now recorded even less about why. Nothing validates the text; `plain-english policy` prints it next to the change.
- `plain-english policy` writes `docs/ai-writing-policy.md` from the merged config: what the project's `failOn` actually does, which agent hooks are on disk, the rules at the configured severities, what the project changed and why, and every waiver in the tree with its stated reason. Waivers with no reason get their own heading. The last section is what nothing in the setup reaches, which is the part a hand-written policy always omits. `--check` exits 1 when the document no longer matches the config and names the sections that moved. This repository generates its own and checks it in CI.

### Fixed

- A `readability` override in a project config demanded `kind`, so the example printed in the README was a hard error and a repository that added its own vocabulary could not lint at all. `rules` never had this problem: a missing `match` is an error only when the id is new to the base. `readability` now behaves the same way, and `rules/schema.json` had described it correctly since it was written.


## [0.7.3] - 2026-08-10
### Fixed

- One Codex fact was stated in five files and corrected in one. Three releases in a day moved the advice from "approve the hooks with `/hooks`" to "two separate approvals, one for the folder and one for the hooks, and an interactive session offers both", and only `docs/agents.md` was updated each time. README, `adopting.md`, `limitations.md` and `post-edit-lint.md` kept the old sentence, so the repository contradicted itself in public. They now carry one line and a link, and `agents.md` is the only place the detail lives.
- The README said Codex and Cursor "parse and discard" an advisory. True of Cursor. Codex reports the hook run as Failed, which is why 0.7.0 moved the advisory to `additionalContext` in the first place.
- `docs/agents.md` opened two consecutive sentences with the same eleven words, and their second halves disagreed about which channel sees a shell write. One was left over from before 0.6.0.
- Five copy-paste examples pinned `v0.4.0` or `v0.2.0`. Both `rev:` and `@vX.Y.Z` name a git tag, so anyone who copied one got the ruleset from three releases ago.
- `[0.7.0]` in this file had two `### Fixed` headings, with the `init --user` work filed under the second of them instead of `### Added`.

### Added

- A tag now produces a GitHub Release. Thirteen tags had shipped and the Releases page was empty for every one of them, while this file held a written entry for each. `scripts/changelog-section.mjs` pulls one version's section out, and the last step of the publish job posts it as the release body. It runs after `npm publish`, so a failure there cannot cost a publish that already succeeded. v0.7.0, v0.7.1 and v0.7.2 were backfilled by hand; the ten before them stay bare.
- `npm version` moves the version pins as well as dating the changelog, in the same commit and by the same script. A test asserts every pin in `README.md` and `docs/*.md` matches `package.json`, which only keeps passing because the script updates them. A version mentioned in prose is left where it is.
- `lint:self` covers `CONTRIBUTING.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md`. It had only ever read `docs/` and the README, and pointing it at the rest found a 49-word sentence in the security policy.

### Changed

- The README explains a term before naming it, which is the rule this package enforces on everyone else. It described itself as something that "hooks into Claude Code" in its second sentence and never said what a hook is, used SARIF sixty lines before glossing it, and left `linter`, `glob` and `pre-commit` to the reader. Its own `unglossed-term` rule cannot catch any of those, since it fires on acronyms and camel-cased names alone.
- The README says Node 20 or newer is required, carries version, build and licence badges, and names the Copilot trap on the front page: `init --agent copilot` alone leaves the command-line tool with no hook, because it does not read the repository file. That was in `agents.md` and nowhere a new user would look.

## [0.7.2] - 2026-08-09
### Fixed

- The Codex install note on `codex exec` is now a measurement rather than a caution. 0.7.1 said the trusted case was untested here, because hook trust looked reachable only through a keyboard. It is reachable: one approval by hand showed where Codex keeps the answer, `[hooks.state."<key>"] trusted_hash = "sha256:…"`, and both halves come out of `hooks/list`. With trust persisted and no bypass flag, `codex exec` on 0.147.0 dispatched both `PreToolUse` and `UserPromptSubmit`, so openai/codex#32491 does not reproduce there. The note now says to trust the hooks once before any scripted run, which an interactive session offers at startup.
- The same run corrected a claim in the other direction. `docs/agents.md` said hook trust is skipped with nothing shown; that is true of `codex exec`, which has nobody to ask, and false of an interactive session, which offers "Trust all and continue" at startup.

## [0.7.1] - 2026-08-09
### Fixed

- 0.7.0 overstated what a live run had shown about `codex exec`. The install note and `docs/agents.md` said it runs no hooks "even when the project is trusted and the hooks are", citing openai/codex#32491. What was actually observed is narrower: an untrusted hook is skipped in `codex exec` with nothing printed, which is documented behaviour arriving in the least visible way. The trusted case that issue reports was never reached, because hook trust cannot be persisted outside the interactive `/hooks` flow, and two guesses at its config shape did not take. The note now says trust the hooks in a session or pass `--dangerously-bypass-hook-trust`, and marks the trusted case as untested here.

## [0.7.0] - 2026-08-09
### Changed

- Codex is told about a finding on the `PreToolUse` event, not on a second `PostToolUse` hook, and `init --agent codex` writes one hook event instead of two. A live session on codex-cli 0.147.0 settled both halves of this. `permissionDecision: "ask"` does not merely go unhonoured as its old reference implied: the run is reported as `PreToolUse Failed` and the reason reaches neither the model nor the user. `additionalContext` on the same event does arrive, as a developer message, before the write rather than after it. Closes #10.
- `init` can now retire a hook event, and Codex's `PostToolUse` entry is the first thing to go. `init` only visits the places the current plan names, so a location this package has stopped writing to used to survive every re-install: the retired hook kept spawning a process per tool call to say nothing. Somebody else's hook in the same place is left alone, and the key is dropped only once nothing is left in it. Upgrading without re-running `init` is harmless either way, because the post event now returns nothing.

### Added

- `doctor` names the two ways a Codex hook can be installed correctly and never run. Its repository hook file is read only when `~/.codex/config.toml` marks the project `trust_level = "trusted"`, and until then Codex finds no hooks, prints no warning and logs no error. Inside a git worktree it reads the main working tree's file and ignores the worktree's own copy, which is openai/codex#27133 seen on 0.147.0. Both were measured through Codex's own `hooks/list` call, with five controls separating folder trust from the mere presence of a config file.
- The Codex install notes cover those two gates, and a third: `codex exec` runs no hooks at all without `--dangerously-bypass-hook-trust`, even when the project and the hooks are both trusted (openai/codex#32491). The stale note telling people to set `[features] hooks = true` is gone, since hooks have been on by default for some versions.
- Three captured Codex payloads in the regression corpus, including the shell command it reached for after two refused patches: `perl -0pi -e '$_ = "…"' notes.md`. The scanner does not read an in-place rewrite through an interpreter and is not going to start guessing, so that write goes unjudged. It is written down in `docs/agents.md` rather than papered over.

- `init --agent copilot --user` writes `~/.copilot/hooks/plain-english.json`, which is the location Copilot's CLI actually reads. Its own `copilot help config` documents `.github/hooks/*.json` for repository hooks, and 1.0.78 does not load it: a controlled run with the same `sessionStart` hook in all three documented locations fires only the user-level one. Reported as github/copilot-cli#1730, where the newest comment had concluded the fault was the `sessionStart` event rather than the location; the same run shows `preToolUse` behaving identically.
- `--user` is the only thing that makes `init` write outside the project, and it is opt-in for that reason. Everything else `init` writes is committed, reviewed and removed with the checkout, and a file in somebody's home directory is none of those. A test asserts a default `init` for every agent leaves the home directory alone, and the dry run prints a user-scoped path in full rather than as a run of `../`.

### Fixed

- Verified rather than fixed, but worth recording: `PreToolUse` does fire for `apply_patch`, with `tool_name: "apply_patch"` and the envelope under `tool_input.command`, and `timeout` is the config key although Codex reports the value back as `timeoutSec`. A widely-linked third-party reference says the event intercepts the shell tool alone. It names no version, shows no run, and is wrong on 0.147.0.
- The Copilot install note no longer says a shell redirect goes unchecked. That has been false since 0.6.0.

## [0.6.0] - 2026-08-09
### Added

- A shell write into a markdown file is checked. Agents write prose that way: asked to edit a markdown file, GitHub Copilot CLI 1.0.78 ran `printf '%s\\n' "..." > notes.md && echo 'WROTE'` rather than using a write tool, so the `Write|Edit|MultiEdit` matcher never saw it and the file landed unjudged. The command is now scanned for a trailing redirect whose content the command itself carries, and the file goes through the same markdown, project-scope and `exclude` filters a write through a tool call gets. Closes #7.
- The scanner is a character scanner, not a regular expression, for two reasons. Quoting cannot be done with a pattern: `echo "see > README.md" >> log.txt` redirects to a log file, and reading the first `>` targets the wrong one. And the last hand-written pattern in this path went quadratic and hung a blocking hook for 200 seconds, so a scanner that is linear by construction earns its place. There is a test asserting the linearity rather than assuming it.
- It gives up rather than guesses, because the costs are not symmetric. Missing a write costs a finding; inventing one refuses somebody's edit under `failOn: error`. So no `sed -i`, `cp` or `mv`, no path or content the shell would expand, nothing when two plain redirects make the target ambiguous, and nothing from an unterminated quote. `tee file <<EOF` is read, since it writes through an argument rather than a redirect.

## [0.5.0] - 2026-08-09
### Fixed

- Codex reads the patch. `apply_patch` carries its text in `tool_input.command`, confirmed in `codex-rs/core/src/tools/handlers/apply_patch.rs`, and the adapter looked for `input`, `patch`, `patch_text` and `content`. Those were guesses made when the schema was unpublished, so it read an empty string and allowed every Codex file write. `command` goes first now; the guesses stay, because a wrong one costs nothing and a missing one costs everything.
- Codex file edits run at the shell are judged. `shell.rs` calls `intercept_apply_patch`, so a model writing `apply_patch <<PATCH` gets a real file write through a call reporting `tool_name: "Bash"`. That landed on the github channel, which reads commit and `gh` message text and found none. A heredoc opening `*** Begin Patch` is now parsed into files and put through the same markdown, project-scope and `exclude` filters a plain write gets. No shell-redirection parser: an earlier draft was going to write one on the strength of a claim that turned out to describe a bug fixed months earlier.
- Copilot's camelCase payload is read. It sends `toolArgs` as an escaped JSON string, which its own tutorial states and `copilot-cli#3349` exists because of, and `asRecord` turned a string into `{}`. Its PascalCase mode sends `tool_input` already parsed, so both shapes are live at once. Choosing between them with `??` was also wrong: it falls through on null and undefined only, so a payload carrying an empty `tool_input` beside a populated `toolArgs` stopped at the empty object.
- A unified diff is parsed as one. `parseApplyPatch` keyed on `*** Add File:` alone, so a real `--- a/x` / `+++ b/x` diff produced nothing. The two formats now get separate parsers, because one loop obeying both rules has to treat `+++` as a header in one and as content in the other.
- `failOn: warn` no longer behaves exactly like `failOn: error` in a hook. Only error-severity findings reached the decision, so a project asking for warnings to matter got nothing from any agent while `lint` honoured the same setting.
- `init` can install two hook events into one file. It re-read the document from disk per entry, so the second write started from the same bytes as the first and overwrote it. Nothing shipped in that shape, but the advisory tier below needs it.
- Renaming a matcher no longer leaves a stale hook behind. `mergeNested` stripped our entries only from groups it was about to write, so a changed matcher string left the old group carrying our old command and the hook fired twice on every matching call. Idempotence within a version hid it.

### Added

- An advisory tier that exists on all four agents. Codex parses `permissionDecision: "ask"` and then allows, which its reference says outright, and Cursor says the same of `preToolUse`. So under the default `failOn: never` both looked installed and reported nothing. The finding is now fed back to the model as text: `additionalContext` on a `PostToolUse` hook for Codex, `additional_context` alongside an allow on `preToolUse` for Cursor, which Cursor staff confirmed in July 2026 and which avoids their `postToolUse` equivalent, broken since March. Claude Code and Copilot are unchanged, because a hook that fires before the text exists is better than one that fires after. A `touch`ed ack file silences the advisory as well as the refusal.
- `hook --event pre|post`, and `init --agent codex` writes both. The pre hook still emits the `ask` Codex discards, deliberately: upgrading without re-running `init` leaves a config with pre entries only, and going quiet there would switch Codex off with no error.
- `PLAIN_ENGLISH_RECORD=<dir>` captures what an agent actually sent. Three of the four adapters were written from vendor documentation and it was wrong twice, so a real payload settles what reading harder cannot. Captures are safe to attach to an issue: paths become `{{TMP}}` and `~`, prose becomes a length and a hash, and a capture still holding a home directory after that is not written. It runs after the decision has been written, in its own try/catch, because a debugging aid must not be able to swallow the verdict.
- A drift canary. A write-shaped call that yields no path and no text is what a renamed field looks like from inside, and it now says so on stderr instead of passing as a clean file. A committed fixture cannot catch this: the recording still names the old field and the replay still passes.
- `doctor` reports agents. Which config files exist, which carry our entry, and whether `npx --no-install plain-english` resolves from the project root. A global install with no local one makes every hook do nothing while the config still reads correctly, and `docs/agents.md` has been telling people to attach `doctor` to hook bug reports.
- Cursor is verified against a live agent. `cursor-agent 2026.08.04-aaa8809`, one session, captured with the recorder. `preToolUse` does fire for a `Write` in the CLI, which no published source settled either way; the `Write` arguments are `file_path` and `content`, which nobody had published at all; the shell tool is `Shell` with `command`, `cwd` and `timeout`. Three real payloads are now corpus cases, so a change breaks a test.
- Cursor's project scope comes from `workspace_roots`. There is no `cwd` on its envelope, so the scope had been falling back to wherever the hook process started. Right by accident in the common case and wrong as soon as it is not.
- A capture redacts identity. Cursor puts `user_email` in every payload, and an email anywhere else in a payload is caught too. Found by capturing one and reading it, having listed the risk in the plan and then not handled it.
- `docs/agents.md` marks each claim with what backs it: observed against a running agent, read from vendor source, or taken from vendor prose. It also lists the vendor bugs that look like this package being broken.

## [0.4.1] - 2026-08-08
### Security

- The hook no longer hangs on a malformed heredoc. `heredocBodies` had `\s*` in front of its back-reference, overlapping the lazy `[\s\S]*?` before it, so an unterminated heredoc whose body was blank lines backtracked quadratically. Measured at 3.1s for 50KB of it, 12.5s for 100KB, 49.7s for 200KB and 200s for 400KB. This ran inside a pre-tool-call hook that holds up the agent's write, reachable from any `git commit` or `gh` command, which is text an agent produces constantly. Narrowing to `[ \t]*` takes 200KB to 1.4ms and loses nothing: a heredoc terminator may be indented with tabs, and only under `<<-`.
- Extraction stops at 256KB of command text. One payload is one tool call, and past that it is not a commit message.
- The adapter's own patterns now get the same `findUnsafe` screen a project's config gets, plus a timing test on the shapes that would expose backtracking. Nothing had ever looked at them. The load-time screen runs on patterns from configuration, and the match deadline is handed to `lintText` and covers no part of extraction, so a regex written in TypeScript was checked by less than one written in YAML. `INLINE_FLAG` is measured rather than screened: it holds the standard unrolled loop for a quoted string, whose two alternatives are disjoint, and `findUnsafe` cannot compute the first-set of a negated class so it errs towards rejecting.
- `SECURITY.md` no longer claims every pattern is screened and every match carries a deadline. That was true of configuration and never of the extraction path.

## [0.4.0] - 2026-08-08

### Added

- Hooks for GitHub Copilot, OpenAI Codex CLI and Cursor, alongside Claude Code. `init --agent <id>` writes that agent's config, `--agent all` writes every one, and the default stays Claude Code so the published command keeps working. Each agent gets a translation table in `src/agents/`: payload in, wire format out, nothing about deciding. That was affordable because Claude Code's hook contract became the shape the others copied. Copilot ships an explicit compatibility mode for it, Codex reuses the same reply vocabulary, and Cursor uses the same event with different field names.
- `AGENTS.md`, generated from the same ruleset and spliced into the repo's own file between markers. It shares its body with the Claude Code output style, so the two cannot drift, and it is the one instructions artifact roughly twenty agents read. Per-agent rule files were considered and rejected: they fit each host better and are a file per host per release to keep true.
- `--format sarif`, validated against the official SARIF 2.1.0 tooling with no warnings. It feeds GitHub code scanning, and a SARIF file also renders into the VS Code Problems list, which is where Cursor, Cline and Copilot agent mode read diagnostics from. So one serializer reaches agents this package has no adapter for. The GitHub Action takes a `sarif-file` input; the upload step stays with the caller, because it needs `security-events: write`.
- `--format unix`, one finding per line as `path:line:col: level: message`. The default `text` format groups findings under a filename heading, which reads better and parses worse. `docs/editors.md` uses it for an `efm-langserver` config covering Neovim, Helix and Emacs, and a VS Code problem matcher.
- `docs/agents.md`, `docs/post-edit-lint.md` and `docs/editors.md`. The first records which per-agent claims were verified against a running agent and which came from a vendor's documentation, because three of the four are still the latter.
- `npm test` now builds first and runs the adapter probe afterwards. The probe imports from `dist/`, so it catches a build that compiled but does not run; it had never been wired into anything.
- `npm version` dates the changelog. The `version` lifecycle script retitles `## [Unreleased]`, adds its link definition, repoints the Unreleased compare link and leaves a fresh heading for next time, all staged into the release commit. It refuses when the section is missing or empty, so a release with no entry fails before anything is tagged. `ALLOW_EMPTY_CHANGELOG=1` overrides. This was a manual checklist item missed on two consecutive releases, both times by someone who had just read the checklist naming it.
- A test asserting this repository's own changelog has an Unreleased heading, a link definition for every dated release, and either a dated section or a pending entry for the version in `package.json`. It failed on the first run, which is how the missing heading left behind by the 0.3.1 retitle was found.

### Changed

- The acknowledgement file moved to `.plain-english-ack-<channel>` at the repository root, from `.claude/.<channel>-plain-english-ack`. The refusal message tells a human to `touch` it and `touch` will not create a missing parent, so the old path worked only because Claude Code had already made that directory. The old location is still honoured.
- `src/adapters/claude-hook.ts` is now `src/adapters/hook.ts` and knows nothing about any agent. `decide()` takes a normalised event. Not public API: `exports` publishes `dist/lint.js` only.
- `initClaudeCode` is now `init`, taking the agents to wire up. The old name is a deprecated re-export for one minor version.

### Fixed

- The install instructions named a command that no longer exists. Claude Code deprecated `/output-style` in v2.1.73 and removed it in v2.1.91; the replacement is `/config`, or the `outputStyle` setting. The README and `docs/adopting.md` had been telling people to run it.
- `NotebookEdit` is out of the docs channel. It was in the extractor and in the settings matcher while `decide` accepted only `.md`, `.markdown` and `.mdx`, so the branch could never be reached.
- SARIF rule descriptors omit `name`. The spec requires it to differ from `id` when both are present, and the official validator warns on every rule otherwise.

## [0.3.1] - 2026-08-07

### Security

- `findUnsafe` sees through a character class when deciding whether the alternatives of a quantified group overlap. `^(?:[ab]|ab)+$` passed the screen and hangs the linter: `skeleton` blanked `[ab]` down to `[]`, so the check compared a `[` against an `a` and concluded the alternatives were disjoint. Measured at 207ms against a 49-character document, and each additional pair of characters doubles it. Every pattern in the shipped ruleset still passes.
- The engine calls `matchAllWithDeadline`. It had been exported, tested and described in comments as the runtime backstop since 0.1.0 while `lintText` called `rule.re.exec` directly, so no document-wide bound existed. `lintText` now takes `budgetMs`, defaulting to two seconds and shared across all rules, and returns `timedOut` naming any rule it abandoned. The Claude Code hook uses a 500ms budget and reports an incomplete scan rather than an empty one.
- Recorded what the deadline cannot do, in place of the claim that it was the backstop. A JavaScript regex match is atomic, so a check between matches bounds a pattern returning many matches and cannot interrupt one match that backtracks exponentially. Refusing that pattern at load is the only defence.

### Fixed

- `src/safe-regex.ts` contained a raw NUL byte in a string literal, so git classified the file as binary and a security-critical screen has had unreviewable diffs since it was written. Replaced with the `\0` escape, which is the same value.
- The release workflow runs the CI matrix before publishing. Its verify job was a single `ubuntu-latest`, node 22 run while CI covers five combinations, so the publish gate was weaker than the gate on an ordinary pull request. `v0.2.0` released green while its CI run was red on Windows.
- `lintText` tolerates a ruleset assembled without `readability`. It is the package's public entry point, and a pre-0.2.0 ruleset from a consumer threw instead of linting.

## [0.3.0] - 2026-08-07

### Added

- `explain` reaches every rule in the ruleset. It listed the 30 word and punctuation rules only, so the nine sentence shapes and the two readability rules had no way to be inspected from the command line while the README said they were listed. `explain unglossed-term` and `explain binary-contrast` now work, and the listing is grouped by kind.
- A Readability section in the generated `docs/writing-style.md`. Both readability rules ship `link: ...writing-style.md#readability`, an anchor that did not exist, so every readability finding printed a dead link.
- The acknowledgement file the refusal message advertises is now read. `touch .claude/.docs-plain-english-ack` waives that channel for ten minutes and then expires. It had been named in the message for three releases with nothing checking for it, so the advice was inert and the only real escape from a false positive was editing config.

### Changed

- The README is rewritten. It described the tool as it stood before 0.1.0: it did not mention the readability rules or the output style, it pinned `v0.1.0` in the pre-commit and Action snippets (a tag that was never pushed), it said `explain` listed the sentence shapes, and it said every channel blocks the write when the default has been advisory since 0.1.0. It now separates rule severity, the printed label and `failOn`, which are three vocabularies for two ideas and the main reason the old text was hard to follow.
- `--claude-code` is out of the usage text. `init` has always written the hooks unconditionally and never read the flag, so listing it implied a second mode that never existed. The flag is still accepted, so the command published in earlier READMEs keeps working.
- The "what is never scanned" list in the generated guide is accurate and complete. It appeared in three places with three different contents; the two hand-written copies now link to the generated one.

### Fixed

- `rules/schema.json` accepts the configuration the loader accepts. It was missing `failOn`, `readability`, `perThousandWords` and `link` while declaring `additionalProperties: false`, so an editor validating against it would have rejected this repo's own config. A test now holds the schema and the loader together.
- `docs/adopting.md` no longer says a project config is all `init` writes, no longer pins the missing `v0.1.0` tag, and no longer claims chat enforcement rests on a `CLAUDE.md` note alone.

## [0.2.0] - 2026-08-07

### Added

- Readability rules, a new rule kind measured over sentence structure rather than matched at a point. `unglossed-term` reports an acronym or camel-cased name on first use when nothing has explained it. `long-sentence` reports past 35 words. Both are warnings.
- A term introduced together with its explanation is not reported. "The identity check is called OIDC", "known as SLSA", "OIDC stands for OpenID Connect" and a parenthetical expansion all count as glosses.
- A `known` list of names a reader already has, so the rule does not fire on GitHub, TypeScript, JSON or MIT. A project's own `known` entries add to the defaults instead of replacing them, and are separate from `allow`, which suppresses every rule on a matching line.
- `integrations/claude-code/output-styles/plain-english.md`, generated from the same ruleset and covered by the drift check. This is the first artifact that reaches chat replies.
- `.plain-english.yml` at the repo root, so linting this repo no longer depends on whatever config sits in a developer's home directory.

### Changed

- Sentence segmentation comes from `retext-english` through `mdast-util-to-nlcst`, so a sentence never splits on `e.g.` or a version number, and code, tables, link destinations and blockquotes never reach the readability layer.
- `docs/limitations.md` and the README no longer claim that nothing can reach chat output. The `MessageDisplay` hook can, and the entry now records what it does, what it cannot do, and that its documented input schema disagrees with the shipped binary.

## [0.1.2] - 2026-08-06

Supersedes 0.1.1, which was tagged but never published.

### Fixed

- `init` no longer writes an absolute filesystem path into `.claude/settings.json`. That file is usually committed, so the machine's own directory layout was breaking the file for every other contributor and leaking a local path into what may be a public repo. The prompt never needed it: the command hook scopes by path and its `if` rule scopes by file type, both before the prompt runs. Two people running `init` on the same project now get byte-identical settings.

## [0.1.1] - 2026-08-06

### Fixed

- The generated semantic prompts now state that a pass is the normal answer, forbid returning a failure whose own reason says the content is acceptable, and report only the single clearest problem. Without these, a prompt asked to find patterns finds patterns: one document was refused twelve times in a row, twice on wording the model had proposed a turn earlier, and once after reasoning that no violation existed.
- The prompts no longer restate the banned word list. The deterministic layer has already checked every term by the time a prompt runs, so the prompt judges sentence shapes, which is the part a regex cannot reach.
- `workflow_dispatch` on the release workflow could never reach the publish job, because the tag check compared `main` against the package version. The check now runs only on a tag push.
- CI cancels superseded runs instead of queueing them.

## [0.1.0] - 2026-08-06

### Added

- Markdown parsing with mdast. Code blocks, inline code, tables and link destinations are structurally excluded, so a banned term inside any of them is not a finding.
- Rate-based rules via `perThousandWords`, and an `em-dash-density` rule shipped at `severity: off`.
- Range suppression (`<!-- plain-english-disable -->` and `enable`), completing the three tiers alongside next-line and whole-file.
- Per-rule `link` field, shown with findings and rendered into the generated guide.
- `--version` and a `doctor` subcommand for bug reports.
- `docs/limitations.md`, covering the published false-positive rate against non-native English writers, dialect exposure in the word list, English-only scope, signal decay, and the semantic layer's false-positive floor.
- Packaging gate in CI: `publint`, `@arethetypeswrong/cli`, and a tarball installed into a clean project and run.
- Windows and macOS in the test matrix.

### Changed

- Findings are warnings by default and the run exits 0. Blocking is opt-in via `failOn: error` or `--fail-on error`.
- The Claude Code adapter emits `permissionDecision: "ask"` for style findings, reserving `deny` for strict mode.
- `init` emits `if: "Write(*.md)"` permission-rule scoping.
- Package renamed to the unscoped `plain-english`.
- Minimum Node is 20.

### Fixed

- Configuration patterns are screened for catastrophic backtracking at load, and matching carries a deadline. A rule of `(a+)+$` against 30 characters previously ran for 142 seconds.
- `allow` matches the surrounding line. It was tested against the matched term alone, so a project vocabulary list suppressed nothing and the shipped example config was inert.
- Unknown configuration keys error with a suggestion instead of being ignored.
- HTML `<pre>` and `<code>` blocks, TOML frontmatter, footnote definitions, and four-space-indented list continuation prose are all handled correctly.
- Em dash variants are caught: HTML entities, the fullwidth dash, the horizontal bar, and a zero-width space inside a word.
- Suppression directives are read from a view with code fences blanked, so an example directive in the documentation is no longer live. The generated style guide was disabling itself.
- CI jobs build before running the CLI.

[Unreleased]: https://github.com/nordscope-fi/plain-english/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.9.0
[0.8.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.8.0
[0.7.3]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.7.3
[0.7.2]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.7.2
[0.7.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.7.1
[0.7.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.7.0
[0.6.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.6.0
[0.5.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.5.0
[0.4.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.4.1
[0.4.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.4.0
[0.3.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.1
[0.3.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.0
[0.2.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.2.0
[0.1.2]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.2
[0.1.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/plain-english/v/0.1.0
