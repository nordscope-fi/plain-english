# Antigravity migration, 8 October 2026

> **Status:** this report records the state on the day it was written, before
> the repairs. [Integration repairs](../integration-repairs.md) records how each
> finding was resolved and which test now guards it.

## Machine setup

The official installer downloaded Antigravity CLI version `1.3.1`, verified its
SHA-512 checksum against the release manifest, and installed `~/.local/bin/agy`.
It added that directory to the user's Zsh profiles. The CLI help command works.

Google OAuth accepted the one-time authorization code. The user explicitly chose
to opt out of interaction-data collection for product improvement. Before
submitting setup, the refreshed terminal showed the consent checkbox unchecked
and the Done button selected. Onboarding completed with that setting.

The earlier automatic approval rejection was resolved by the user's choice and
by checking the full screen before submitting. No further consent is pending.
The personal Google account completed a real no-tool prompt:

```json
{"status":"SUCCESS","response":"OK\n"}
```

The legacy global Gemini configuration contains only authentication settings.
There are no Gemini global skills, extensions, or external tool servers
(MCP servers) to move. Running
`agy plugin import gemini` returned:

```text
No gemini extensions found.
```

This repository has Gemini project hooks, but no Gemini project skills or MCP
servers. Existing project instructions stay in `AGENTS.md`. Antigravity reads
that file directly. [Official migration guide](https://antigravity.google/docs/cli/gcli-migration/).

## Repository integration

The `antigravity` profile translates native hook fields and tool arguments into
the input the existing linter expects. Hook fields capitalize words after the
first (camelCase); tool arguments also capitalize the first word (PascalCase).
Initialization writes
named hooks to `.agents/hooks.json` and a launcher beside them. Gemini's existing
settings are retained because they serve a separate CLI.
The native host runs these commands from `.agents`; the generated command uses
`hooks/plain-english.mjs`, and the launcher starts the linter at the workspace root.
The live follow-up found and corrected an earlier command that repeated `.agents`.
The original protocol checks missed that installation error. It is now repaired.

The adapter handles file creation, single edits, multiple replacement chunks,
shell commands, and issue fields. It uses the shell tool's working directory
when provided. Advisory tool findings return `ask`; strict findings return
`deny`. Named hooks belonging to other tools survive installation.
Native MCP calls use `call_mcp_tool`, with the tool name and arguments nested in
that relay. The follow-up found that the initial issue matcher missed the relay.
The corrected hook checks its arguments only for issue or comment saves. A live
local mock confirmed the initial bypass and the repaired refusal.
[Official hook contract](https://antigravity.google/docs/hooks/).

The Stop hook reads the transcript path supplied by the actual event, which
names `transcript_full.jsonl` on CLI `1.3.1`. Completed `PLANNER_RESPONSE` records
from `MODEL` supply the reply. An explicit user-input record identifies the turn,
so hook-generated retry feedback does not disable checks on later user turns.
Incomplete records, tool results, system messages, and reasoning records are
excluded. Later records with the same step index replace earlier versions.

History scanning uses the native conversation database to map workspace paths
and identify subagent sessions. It opens a temporary copy with its recent-write
log, preserving the live database. History needs Node `22.5` or newer; the Stop
hook does not need the database. The override
`PLAIN_ENGLISH_ANTIGRAVITY_HOME` affects this linter's reader only.

Antigravity's local checks do not start a shared Claude judge. An executable
stand-in confirmed that neither a clean document check nor a long reply invoked
it. The adapter's native approval prompt supplies advisory tool feedback.

The generated hooks are installed in this repository. Antigravity's interactive
workspace trust was accepted for this repository, and `/hooks` displayed three
pre-tool hooks and one Stop hook. A second initialization dry run has no changes.

## Verification

- TypeScript compilation passed.
- Twenty-five test files passed, containing 877 tests. The dedicated Claude plugin
  suites were excluded, and no live Claude judge was called.
- All adapter probes passed, including Antigravity's native write envelope.
- New tests check both edit tools, actual shell working directory, commit text,
  advisory and strict replies, issue fields, preservation of unrelated hooks,
  and repeated installation.
- Both the repository's prose check and an explicit blocking threshold passed
  on 25 files. The edited public guides also passed the warning threshold.
- Generated files and the repository policy match their sources. Whitespace
  checks passed for staged and unstaged changes.
- Package inspection includes the new profile and reader, with their type
  declarations. The bundled CLI was rebuilt as required by the release workflow.
- The required minor release bump is prepared as `1.6.0`. Nothing was published.

An earlier `npx plain-english lint` invocation exhausted the Node heap. The
equivalent built CLI command completed successfully. This failure has not been
attributed to the package or to npm's executable resolution.

Live fixture results:

| Check | Observed result |
|---|---|
| Authentication | Fixed prompt returned `OK`, exit 0 |
| Strict native write | Hook returned `deny`; the proposed file was not created |
| Strict native single edit, follow-up | Generated launcher returned `deny`; the existing file stayed unchanged |
| Strict shell write, follow-up | Generated launcher returned `deny`; the proposed file was not created |
| Strict mock issue save, follow-up | Corrected MCP relay hook returned `deny`; the local mock did not execute |
| Advisory native write | Hook returned `ask`; the UI displayed the linter's reason and requested approval; one-time approval created the expected fixture file |
| Strict chat, first turn | Stop returned `continue`; Antigravity produced a corrected reply |
| Strict chat, second turn in the same conversation | Stop returned `continue` again; Antigravity produced another corrected reply |
| Chat history | Native database and synthetic transcripts were read successfully |
| Repository setup | Native hooks menu showed three pre-tool hooks and one Stop hook |

The fixtures contain only fixed test text. The first advisory prompt did not
supply an absolute target path, and the model tried to discover its location.
An attempted read of the user's shell profile was denied. The run was interrupted,
then repeated with an explicit fixture path; the native approval test succeeded.
No personal file contents, model reasoning, or authorization code were retained
in the migration evidence.

## Limits

Print mode combines the initial reply with its rewrite. A Stop hook cannot
retract text already printed. Advisory chat findings cannot inject context through
Stop and therefore do not interrupt the reply; local history linting reports them.

The second-turn print invocation took about 122 seconds despite a requested
45-second CLI timeout. It completed successfully. This is a host timing observation,
not evidence that the package imposes that delay.

Native file creation and chat continuation were verified live. Single edits,
shell writes, and local mock issue saves were also verified live through the
generated launcher after the follow-up repairs. The native CLI rejected a multiple
replacement call with `unknown tool: "multi_replace_file_content"`; its parser is
covered by local protocol tests, but this CLI build cannot execute that tool.
Commit text, updated transcript records, database-log handling, and path scoping
have local protocol or regression checks.
No remote issue or comment was sent, no subagent was spawned, and desktop or
Windows behavior was not tested live. Existing shared shell-parser limits from
the earlier integration audit still apply.

The machine migration and this repository's setup are complete. The code change
is prepared locally as version `1.6.0`; it has not been committed or published.
[Sanitized live evidence](../../scripts/investigation/antigravity-migration-evidence-2026-10-08.json)
records event fields, decisions, and verification results without credentials.
The [live follow-up](2026-10-08-live-followup.md) and its separate evidence record
the installation repairs and expanded native coverage.

The Codex hook launchers changed concurrently during final verification. Those
separate edits were preserved and are outside the Antigravity migration.
