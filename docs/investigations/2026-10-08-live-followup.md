# Live integration follow-up, 8 October 2026

> **Status:** this report records the state on the day it was written, before
> the repairs. [Integration repairs](../integration-repairs.md) records how each
> finding was resolved and which test now guards it.

The follow-up found two defects in the new Antigravity migration and repaired
both before release. Native Cursor calls also confirmed the issue-matcher defect
from the earlier audit. Qwen's strict retry completed with isolated settings;
the original timeout remains a context-dependent observation.

This supplements the [six-agent audit](2026-10-08-integrations.md) and the
[Antigravity migration report](2026-10-08-antigravity-migration.md). The original
twenty finding groups remain documented. This follow-up repaired the two new
migration defects, not the original backlog.
The new fixes are verified. The remaining defects have not been repaired.

## Scope and controls

The checkout is the unreleased `1.6.0` migration. Fresh disposable Git repositories
used its built CLI and generated launchers. Capture scripts recorded the real
hook payload and output without replacing the adapter's decision. Native hook
working directories were retained. Target paths used their canonical `/private/tmp`
spelling after an initial `/tmp` alias affected the path-scope check.

Claude CLI and shared Claude judges remained excluded. The dedicated Claude plugin
tests were excluded. Cursor automatically imported other user hooks, including
prompt hooks; those imports are described below and are not Claude CLI tests.
No remote issue, comment, or message was created. A local mock server that exposes
tools to coding agents (MCP) recorded
only synthetic issue fields. No subagent was requested.

## Antigravity: generated commands used the wrong directory

The earlier migration fixtures invoked an absolute CLI command. They verified the
adapter protocol but missed the generated launcher's native working directory.
CLI `1.3.1` started the hook beside `.agents/hooks.json`, so the generated command
resolved `.agents/hooks/plain-english.mjs` relative to `.agents` a second time.

The live single-edit run returned:

```text
Cannot find module '.../.agents/.agents/hooks/plain-english.mjs'
```

The generated command now uses `hooks/plain-english.mjs`. The existing runner
anchors itself to the workspace and starts the linter there. A regression starts
the actual generated document and chat commands from `.agents`, through a local
package dependency, and verifies `deny` and `continue` respectively.

The repaired live single-edit run returned `deny` with the `leverage` finding;
`edit.md` retained its original sentence. The repaired shell-write run also
returned `deny`, and `shell.md` was not created. A native Stop event running through
the same launcher returned `continue`, followed by a corrected reply.

## Antigravity: native MCP calls bypassed the issue matcher

The initial issue matcher expected a tool name containing `save_issue` or
`save_comment`. The actual native event wrapped the underlying tool:

```json
{
  "toolCall": {
    "name": "call_mcp_tool",
    "args": {
      "ServerName": "audit",
      "ToolName": "save_issue",
      "Arguments": {
        "title": "We leverage this approach.",
        "description": "This is a synthetic test issue."
      }
    }
  }
}
```

The generated issue hook did not run, and the local mock accepted the prohibited
title. A catch-all tracer confirmed the relay name and argument structure.

The matcher now selects `call_mcp_tool`. Its parser unwraps `Arguments` only when
`ToolName` identifies an issue or comment save. Search and unrelated file-saving
tools remain outside the issue check. Regression controls cover issue titles,
descriptions, comment bodies, namespaced tool names, and unrelated calls.

The same live mock call after repair returned `deny` with the title finding.
The mock's call count did not increase. Headless mode initially refused the mock
for lack of MCP permission, which was not counted as lint enforcement. The
permission restriction was lifted only for the disposable mock invocation;
the strict hook still refused the tool.

The corrected hooks are installed in this repository. Both repairs are included
in the prepared `1.6.0` change, which remains uncommitted and unpublished.
The actual repository launcher was also invoked from `.agents` with a synthetic
proposed write. It returned `ask` with the finding under this repository's advisory
policy. No file was written. A fresh initialization dry run proposed no changes.

## Antigravity: multiple replacements are unavailable on this CLI

Two direct prompts asking for `multi_replace_file_content` timed out before the
tool reached the hook. A third control allowed a read of the exact fixture file.
It reached native tool validation, which returned:

```text
Encountered error in tool validation: unknown tool: "multi_replace_file_content"
```

The adapter's multiple-replacement parser remains covered by local protocol tests.
This live CLI build does not provide that tool. The public documentation lists
the format, but the observed CLI result takes precedence for capability claims.
[Antigravity's tool reference](https://antigravity.google/docs/hooks/).

## Cursor: native issue selection confirmed

Cursor emitted `MCP:save_issue`. The generated issue matcher did not select the
repository hook. Changing only the disposable fixture's matcher to that native
name selected the hook, which returned an explicit `deny` with the title finding.
This confirms finding 17 in the original audit against a live dispatcher.

An imported user prompt hook also refused the original call. The original mock
therefore did not execute. This is evidence of failed selection by this package,
not a demonstrated live end-to-end bypass under the user's combined configuration.
[Cursor's matcher reference](https://cursor.com/docs/hooks).

Native strict file creation returned the repository's `deny`, and the target file
was absent. In the advisory fixture, the repository's pre-tool check returned no
refusal, but an imported prompt hook denied the write. Even the clean write control
was denied by that other hook. These runs do not establish this package's advisory
post-tool delivery. Disabling imported plugins in the fixture did not remove
separately configured user hooks, and the user's global settings were preserved.
[Cursor's import reference](https://cursor.com/docs/reference/third-party-hooks).

The account required automatic model selection. An explicit named model returned:

```text
Named models unavailable Free plans can only use Auto.
```

The first native tool checks used `2026.08.25-3e8eec8`. A later invocation selected
`2026.10.01-e373342` automatically; the audit did not request an update. Print-mode
no-tool replies completed on both builds without a captured Stop event. A real
terminal session on the later build did dispatch Stop and accepted a clean reply.
Headless chat enforcement therefore remains unverified on this machine.

The terminal session then received a fixed prohibited reply request twice. The
first response contained an em dash, and the repository hook returned
`followup_message`; the model rewrote the sentence with full stops. The same
request on a later user turn produced the prohibited sentence again. Its Stop
event carried a different `generation_id`, but the repository hook returned
empty output and the bad reply remained. The transcript contains the exact
sequence `OK`, bad sentence, corrected sentence, bad sentence.

This confirms Cursor's part of finding 2 live on `2026.10.01-e373342`. The package
still ignores its native generation identifier. The model's follow-up rewrite
also received another generation identifier, so a repair must distinguish native
retry activity from a fresh explicit user turn rather than resetting on every
generation change without checking the event.

## Qwen: strict retry completed with isolated settings

The managed CLI is `0.25.0`; its bootstrap installation is `0.24.0`. Changing
`QWEN_HOME` without preserving the managed-version pin selected the older
build, which rejected the newer `--advisor` flag. Those startup failures were
excluded from the retry result.

The successful controls used the launcher's existing managed-version pin, the
same `qwen3.8-max` model, and a temporary settings directory. Only the existing
authentication and model settings were copied. Managed memory was disabled,
automatic skill levels were disabled, and the memory-file name selected a
nonexistent fixture file. No global hooks, extensions, or MCP servers were copied.
The repository's generated Stop hooks remained active. The temporary copied
authentication settings were deleted after the tests.

The original strict no-tool prompt completed in **16.86 seconds**. The first Stop
returned `block` for the punctuation finding, and the retry returned a clean final
sentence. A prompt explicitly permitting the requested punctuation correction
also completed in **16.21 seconds**. The isolated clean control completed in
**5.17 seconds**.

The non-isolated strict run again exceeded the outer deadline while the clean
control completed. That run progressed through a refusal and later tool attempts.
The earlier timeout is not an unavoidable strict-retry failure. The individual
customization or timing condition responsible has not been identified, so it is
not classified as a confirmed package defect.
No claim identifies the individual setting. That remains unknown.

## Verification and evidence

The built CLI passed compilation, all adapter probes, and **877 tests in 25 files**.
Two new regressions cover the generated Antigravity launcher and native MCP relay.
The dedicated Claude plugin suites were excluded.

The [sanitized evidence](../../scripts/investigation/live-followup-evidence-2026-10-08.json)
retains fixed prompts, native field names, decisions, expected file results, CLI
versions, and timings. It omits authentication data, user email, private
conversations, and model reasoning.

The original audit's shell-parser, Copilot patch, installation, severity, and chat
findings remain outstanding. Gemini's personal-account service refusal remains
unchanged; the authorized migration uses Antigravity instead. Desktop behavior,
Windows, hosted CI execution, and remote issue creation remain outside live scope.
