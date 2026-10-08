# Integration repairs, 8 October 2026

The repair branch starts from published version 1.7.0 at
`8050fa1192e474fe338937c196ea9580fc0fcce0` and carries version 1.8.0.
[Issue #98](https://github.com/nordscope-fi/plain-english/issues/98) records the
original audit and the repair order. Historical discrepancies are not a count
of outstanding bugs: nine finding groups already passed on that baseline.

Claude CLI and real model judges are excluded from this verification campaign.
Model tests use local executable stand-ins. Their command path is controlled.

## Repairs

| Issue | Result | Automated check |
|---|---|---|
| #84 | Copilot raw patches enter document checks, with file scope preserved | `agents.test.ts` raw-patch cases |
| #85 | Fresh Cursor and Gemini requests get independent checks; Cursor retries retain the active turn | `integration-audit.test.ts` native chat turn regressions |
| #86 | Gemini loads generated guidance alongside existing context files | `integration-audit.test.ts` Gemini initialization |
| #87 | A root pre-commit manifest uses a committed executable, with explicit error thresholds | `pre-commit.test.ts` Git-source installation |
| #88 | Refusal remedies fit the channel and failure threshold | `integration-audit.test.ts` refusal remedies |
| #89 | The declared self-lint command fails on blocking findings | `exit-code.test.ts` self-lint command |
| #90 | Literal printf output follows supported formatting and escape rules | `shell.test.ts` literal printf cases |
| #91 | Cursor issue matchers select native issue and comment tools | `agents.test.ts` Cursor native issue matchers |
| #92 | Gemini history applies message updates, snapshots and rewinds, and includes legacy JSON | `integration-audit.test.ts` Gemini retained conversation history |
| #93 | Cursor history uses session metadata or an exact folder match | `integration-audit.test.ts` Cursor history project scope |
| #94 | Optional SARIF output does not override the Action's failure threshold | `github-action.test.ts` threshold matrix |
| #97 | Antigravity uses native configuration, tool fields, transcript steps and hook working directories | `antigravity.test.ts` |
| #103 | Optional captures redact native argument bags, serialized arguments and rich-content descendants | `record.test.ts` native argument regressions |

Printf parsing accepts literal `%s`, `%%` and common backslash escapes. Formats
with numeric conversions, field widths, `%b`, unknown escapes or shell
expansion are skipped rather than evaluated. Output expansion is bounded.

Gemini needs a native turn ID or a readable user record to distinguish identical
questions. Without either, identical repeated questions share the temporary
retry allowance. Cursor retains a turn across generation-changing native retries.

## Retained regressions from the published baseline

[Issue #95](https://github.com/nordscope-fi/plain-english/issues/95) maps to
these assertion-based tests. Their failures make the verification command fail.

| Audit finding | Existing coverage and added controls |
|---|---|
| 3, warning-only chat | `chat.test.ts`: warning-only model refusal below an error threshold |
| 5, optional model calls and advice | `docs-judge.test.ts`: disabled, excluded and outside-project documents; `semantic-advisory.test.ts`: passing, rejecting, failed and missing executable outcomes at both warning and error thresholds, plus pre/post delivery on Cursor, Gemini and Vibe |
| 6, Git command forms | `command-coverage.test.ts`: attached flags, global options and effective message-file directories; `shell.test.ts`: quoted arguments |
| 7, patch moves | `context.test.ts`: destination-based checks and newly Markdown destinations |
| 8, project scope | `context.test.ts`: relative traversal and symlinks outside the project |
| 9, document and publishing waivers | `command-coverage.test.ts`: document waiver on shell-written Markdown; `decision.test.ts`: channel separation |
| 11, hook ownership | `init.test.ts`: foreign commands, compound commands and unmanaged paths survive replacement; `integration-audit.test.ts`: separately owned package-named hooks survive repeated initialization on Cursor, Gemini, Qwen and Codex |
| 14, commit-message boundaries | `command-coverage.test.ts`: later message flags remain outside a clean commit |
| 15, directory changes and exclusions | `context.test.ts`: shell patch after directory change; `command-coverage.test.ts`: effective tool directories |

## Fresh verification of the repaired build

The full non-Claude plugin suite, adapter probes, repository lint, generated
files, private-reference checks and package validators pass. Dedicated Claude
plugin tests and live Claude calls were not run.

Pre-commit 4.6.2 installed a disposable Git-source checkout. It used the real
Node environment installer. The checkout had no top-level build output.
No global linter was available. Both document and commit-message stages
accepted clean prose and rejected a banned term. The project configuration
was advisory.

Gemini CLI 0.63.0's installed context loader discovered the generated guidance.
Its conversation loader and the repaired reader agreed on a synthetic stream
containing a message update and a rewind. These are native loader checks.
No model session ran.

| CLI and context | Fresh observation | Remaining gap |
|---|---|---|
| Cursor 2026.10.01-e373342, print mode | The generated issue hook denied `MCP:save_issue`; the local mock received no write. A clean native file write succeeded. | Earlier no-tool print controls emitted no Stop. Imported user hooks prevent attributing advisory refusals to this package alone. |
| Antigravity 1.3.1 | The generated edit hook denied the bad replacement and left the file unchanged. Stop requested a rewrite and the next Stop allowed it. | Print output includes both the original reply and its rewrite. Multiple replacement was an unknown native tool in the earlier campaign. |
| Gemini 0.63.0 | Context discovery and retained-history reconstruction match the native loaders. | The measured individual account completed OAuth but the service rejected CLI access. Migration uses Antigravity. |
| Copilot, Codex, Vibe and Qwen | Protocol regressions pass; earlier live observations are retained in `agents.md`. | A complete fresh release matrix remains open. |

Windows, concurrent state writes, linked worktrees, subagents, desktop events,
remote issue writes and hosted CI have not been verified live in this repair
campaign. [Issue #96](https://github.com/nordscope-fi/plain-english/issues/96)
remains open for that campaign and isolated advisory controls.

## Repeatable verification

Build before running the tests, because hook integration tests execute the built
CLI. Disable real model calls for the campaign:

```bash
npm run build
PLAIN_ENGLISH_CHAT_JUDGE=1 npx vitest run --exclude test/claude-code-plugin.test.ts
npm run probe
npm run lint:self
npm run render
npm run policy:check
npm run check:refs
npm run check:refs:history
npx --yes publint
npx --yes @arethetypeswrong/cli --pack --ignore-rules cjs-resolves-to-esm
```

For live checks, use a disposable repository with a local dependency on this
build. Run `plain-english init --agent <id>` there and invoke the generated
commands without changing their matchers. Register a tracer on every event to
separate absent events from checks that read clean text. Test bad, clean,
excluded, strict and advisory writes, then two identical user requests and a
hook-induced rewrite. Use a local mock for issue tools. Separate Cursor print
and interactive runs, and isolate imported settings before claiming advisory
behavior. Record the exact CLI build and account availability. The detailed
capture procedure is in [verifying an adapter](verifying-an-adapter.md).
