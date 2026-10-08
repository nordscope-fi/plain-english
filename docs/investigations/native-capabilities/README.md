# Native CLI capabilities, measured 8 October 2026

This report records generated-hook behavior on macOS arm64. The measured
build is version 1.12.1 at commit `f50a52d00d934867fe3a3181120d781c212da7f7`.
That identifies the local build, rather than establishing npm publication.
The release workflow verifies publication separately.

[Observations](observations.json) contain decisions, event names, payload key
names, hashes, exit codes and file outcomes. They contain no raw replies,
credentials, session identifiers or tool arguments. Pattern checks ran locally;
optional model judges were disabled. The native agents still made model calls.

## Write controls

Strict mode used `failOn: error`; advisory mode used `failOn: never`. A bad
sentence was submitted unchanged. The excluded control used the same sentence
in an excluded path. The clean control replaced it with ordinary prose.

| CLI build | Strict bad text | Clean text | Excluded path | Advisory bad text |
|---|---|---|---|---|
| Copilot 1.0.80 | Denied; file unchanged | Written | Written | Written; post-event context |
| Codex 0.161.0 | Denied; file unchanged | Written | Written | Written; pre-event context |
| Cursor 2026.10.01-e373342, print | Denied; file unchanged | Written | Written | Written; post-event context |
| Vibe 2.24.1 | Denied; file absent; turn limit reached | Written | Written; turn limit reached | Written; post-event context |
| Qwen 0.25.0 | Denied; file absent; session timed out | Written; session timed out | Written | Written; explicit allow and context |
| Antigravity 1.3.1 | Denied; file unchanged | Written | Written | Written; advisory ask accepted with fixture permissions |
| Gemini CLI 0.63.0 | Unavailable for this account | Unavailable | Unavailable | Unavailable |

A successful write does not prove successful session completion. The Vibe
budget was three turns. Qwen's external limit was 90 seconds, followed by up to
five seconds for termination. The Qwen model/provider declarations and managed
npm version were held fixed. Its timeout cause remains unassigned.

Antigravity advisory delivery used its native `ask` response with tool
permissions approved for the disposable fixture. This proves the write could
proceed in that mode; it does not establish behavior under every permission
policy. Multiple replacement remains protocol-only: the measured build did
not expose that tool in the earlier native attempt.

Gemini completed browser OAuth but the service rejected its individual-account
client and required migration. Antigravity is the tested migration path. No
claim is made about Gemini under a different account or API-key configuration.

## Chat turns and configuration discovery

Two fresh user requests in one Codex session each produced a generated Stop
block followed by an accepted rewrite. This records both a retry and a reset
between explicit user turns. The observation file includes the four Stop
outcomes for each request. A bad-write refusal also caused a Stop rewrite.

Codex's `--ignore-user-config` skipped project hooks on this build. Supplying
folder trust and bypassing the separate hook-review check did not change that.
The measured controls instead passed the generated definitions through session
configuration. Thus they establish native protocol behavior, while project
file discovery remains a separate requirement. This agrees with the upstream
[configuration report](https://github.com/openai/codex/issues/49333).
Use `--repeat-codex-chat` with the Codex procedure below to repeat two
explicit user turns in one session. It stores hashes and hook decisions,
without storing the session identifier.

Canonical fixture paths are required on macOS so folder trust matches the
actual working directory. The repeatable procedure resolves them first.

Cursor print mode ran write events but produced no Stop event in these four
controls. The fresh isolated interactive probe produced two follow-up messages and
an accepted Stop on its first request, then one follow-up and an accepted
Stop on its second request. Both explicit user turns ran in one terminal
session. These are separate observations, rather than evidence of print-mode
support. The metadata records each Stop response without its prose.

Cursor imports both its own user hooks and Claude user hooks. The isolated
controls used a Node preload that returns an empty object for reads of those
two files. It changes this process's reads, never the files. Authentication
and other configuration remain available. This is an instrumented runtime;
no claim is made that the CLI itself offers complete hook isolation.

## Repeating the write controls

Build the checkout, install the native CLI and authenticate it first. The
procedure needs Python 3.11 or newer. Vibe also needs `python-dotenv`; its own
Python environment normally supplies it. Run one CLI at a time:

```sh
npm run build
python3 scripts/investigation/verify-native-hooks.py \
  --agent cursor --output /tmp/cursor-observations.json
```

Choose `codex`, `cursor`, `copilot`, `vibe`, `qwen` or `antigravity`. Each run
creates new disposable Git repositories, initializes the generated hooks and
adds metadata tracers without changing their replies. It runs all four write
controls; `--case clean` selects one. Results are measurements, so a timeout
or an unexpected file outcome is retained rather than treated as a
pass. An unexpected write outcome or absent hook decision exits with code 2.
A timeout or native turn limit remains a separate session result.
Check both the file outcome and the recorded hook decision.

Codex definitions are supplied as session configuration to avoid the discovery
problem above. Cursor uses the checked-in read-isolation preload. The other
CLIs retain their native project hook discovery. Existing unrelated hooks or
managed policies can still affect a run; inspect event metadata and native
errors before attributing a result to this package.

The Vibe fixture copies only provider/model declarations, without inline
credentials, and passes dotenv values in child memory. Qwen's fixture supports
an environment-backed OpenAI-compatible provider and rejects inline credentials.
To reproduce its measured version, add `--qwen-managed-version 0.25.0` and
`--qwen-bootstrap` with the installed bootstrap path. It copies no OAuth cache.

Raw output is discarded by default. `--keep-private-output` saves it inside
an owned fixture directory for debugging; it can contain personal data and
must not be committed. The fixture code does not edit global hook registrations or copy/link
authentication files. Native CLIs retain their ordinary account and session
behavior: Codex added trust entries for disposable directories to its user
configuration despite `--ignore-user-config`. Treat the flag as neither a
project-hook isolation guarantee nor a promise of no configuration writes.
The eight trust-only entries created by this campaign were removed afterward;
all other parsed configuration values were preserved.

## Limits

Windows CI checks parsing and packaging; it does not run these native CLIs.
Desktop events, linked worktrees, concurrent sessions and remote writes are
unverified. Earlier issue checks used local mock tools, with no real tracker
writes. Claude and real model judges remain outside this campaign.
