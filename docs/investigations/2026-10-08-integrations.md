# Integration gap analysis, 8 October 2026, second pass

> **Status:** this report records the state on the day it was written, before
> the repairs. [Integration repairs](../integration-repairs.md) records how each
> finding was resolved and which test now guards it.

The integrations have confirmed defects. Passing the existing tests does not establish
that every supported agent checks every supported write. The most direct failure is a
live Copilot edit whose patch text was never parsed. Other defects affect chat retries,
severity thresholds, startup instructions, commit messages, and installation.

This records the investigation before the requested Antigravity migration. The audit
itself did not change runtime code, rules, versions, user settings, or credentials.
The later migration adds a native adapter; its results are recorded in
[the migration report](2026-10-08-antigravity-migration.md). Claude Code and its
plugin are excluded from the integration review. Real Claude judge calls were suppressed;
the dependency on that executable was tested with a local stand-in.
Later authenticated Cursor and isolated Qwen results are recorded in
[the live follow-up](2026-10-08-live-followup.md). That follow-up also found and
repaired two installation and routing defects in the new Antigravity adapter.

The second pass challenged each of the original thirteen finding groups. None was
retracted, but evidence and wording changed: the four-host chat claim now distinguishes
live confirmation from replay, path scope is described as false refusal, and judge
configuration is a product choice. Seven further groups were found, numbered 14–20.
Several groups contain related defects; twenty is not a count of independent bugs.

## Scope and evidence

The checkout reports package version `1.5.1`. Checks ran on macOS with Node `26.10.0`.
The package was built and packed, then its generated hooks were installed into six
disposable Git repositories. The packed package used dependencies already installed
in this checkout; this did not test a fresh dependency download.

Hook wrappers captured inputs and replies around the actual generated launchers. Test
prompts asked for a fixed prohibited sentence in a Markdown file and an em dash in the
final reply. Project guidance was removed from these particular fixtures so the model
would reach the hook. Strict fixtures used `failOn: error`; advisory fixtures used
`failOn: never`. Both explicitly set the corresponding chat threshold.

| Tool | Installed version | Evidence obtained | Limits |
|---|---|---|---|
| Copilot | `1.0.80` | Live strict native write refusal, live raw-patch edit bypass, strict replay, stop feedback | Automatic model selection was needed; two explicit model names were unavailable |
| Codex | `0.161.0` | Live patch refusal, advisory context, stop feedback and continuation | Project trust was supplied for the fixture and reviewed hook trust bypassed for that invocation |
| Cursor CLI | `2026.08.25-3e8eec8`; later `2026.10.01-e373342` | Live strict write refusal, native issue-selection control, interactive first-turn rewrite and later-turn bypass | Other loaded hooks prevented isolated advisory verification; print-mode Stop dispatch was not observed |
| Vibe | `2.24.5` | Live write refusal, post-tool advisory, chat retry, native configuration validation | Optional Vibe judge and shared Claude judge were suppressed |
| Gemini CLI | `0.54.4`; authentication follow-up on `0.63.0` | Native hook registry accepted ten instrumented hooks; native memory discovery and local adapter checks | Initial calls rejected an API key; a later Google login succeeded but the service refused personal-account access |
| Qwen Code | `0.25.0` | Live write refusal, explicit advisory allow with context, stop feedback, successful advisory and clean control runs; later isolated strict retries completed | Earlier runs timed out; the timeout did not reproduce with isolated settings; the individual cause remains unresolved |

Existing checks returned:

```text
Test Files  24 passed (24)
Tests       860 passed (860)
generated files are up to date
docs/ai-writing-policy.md is up to date
clean (23 files)
```

The dedicated Claude plugin suites were excluded. Shared suites still include
synthetic Claude-shaped fixtures; no live Claude integration was exercised.

The second pass reran the same 860 tests successfully. The expanded audit contains
110 probes: 37 original probes and 73 wider probes, including optional comparisons
against installed Gemini code. There are 55 passing controls and 55 mismatches.
Counts describe probes, not defects. The audit also executed real Git commits and
shell writes in temporary directories, full initialization on four hosts, patch
moves, and a fresh pre-commit installation. These checks make no publishing requests.

The report also checks the advertised pre-commit setup and the repository's own
continuous integration command. Hosted Copilot, Cursor's desktop app, Windows,
remote issue creation, and GitHub Actions execution were not exercised live.

## Findings to repair first

### 1. Copilot can write a Markdown patch without a check (high priority)

**Observed live and confirmed by replay.** Copilot dispatched this shape:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": "*** Begin Patch\n*** Add File: notes.md\n+We leverage this approach.\n*** End Patch\n"
}
```

The file was created in advisory mode with no finding returned for this edit.
Replaying the same input with strict configuration returned empty stdout and exit 0:

```text
plain-english: read nothing from a edit call, so this write was not checked.
```

[The Copilot parser](../../src/agents/copilot.ts) sends input through an object or
JSON-object parser, then treats `Edit` and `apply_patch` as string-replacement edits.
The native patch string becomes an empty object. The file path and new text disappear.
This affects strict mode too: the replay emitted no denial.

**Repair:** Recognize raw patch strings and patch-bearing objects before the ordinary
edit branch. Reuse the existing parser that keeps added text separate for each file.
Pin the captured shape, plus mixed Markdown and source-file edits, as regressions.

### 2. Four chat integrations lose the distinction between user turns (high priority)

**Live confirmation for Copilot and, in the follow-up, Cursor; transcript-changing
replay for Vibe; schema-based replay for Gemini.** A first bad reply blocks. Another bad reply with the
same session identity does not. Replays append a distinct user message and reply for
Copilot and Vibe. Codex and Qwen controls block both turns when their identifiers change.

A live Copilot prompt and its resumed session each ended with the required prohibited
sentence. The first turn returned `decision: block`; the second turn returned only
`systemMessage`, despite `stop_hook_active: false`. Both commands completed normally.
Vibe's resumed live turn produced clean text, so that run cannot prove enforcement
of a second bad reply. The replay and state-key source establish the Vibe defect.

[The shared chat command](../../src/cli.ts) chooses a prompt identifier from prompt,
turn, or session fields. [The retry state](../../src/adapters/chat.ts) uses that value
as its entire turn identity. The source itself describes the risk:

> one block would silence the rest of the session instead of the rest of the turn.

Copilot's captured stop input has only a session identifier; Vibe's native stop
schema does too. Gemini's documented input provides no identifier from the accepted
list. Cursor provides `generation_id`, but the command never reads it. Cursor also
lacks a session fallback accepted here, so separate conversations in the same project
can share the empty identity for the ten-minute state window.

**Repair:** Use Cursor's generation identifier. For hosts without a native turn
identifier, derive one from the latest actual user message in the transcript. Include
session and agent identity in state storage, and preserve the retry identity across
hook-generated continuations. Test two user turns and two conversations, including
identical repeated user requests. Cursor documents a generation as changing with each
user message. [Cursor hooks reference](https://cursor.com/docs/hooks).
The live follow-up also changed the generation identifier for the hook-triggered
rewrite, with `loop_count: 1`. A repair must preserve the active retry identity
for that event while opening a fresh identity for the next explicit user turn.

### 3. A warning can refuse chat at the error-only threshold (high priority)

**Reproduced in the shared decision engine.** A 180-word reply containing twelve
15-word sentences produces exactly one finding:

```json
[{ "id": "reply-pace", "severity": "warn" }]
```

With `chat.failOn: error` and no usable judge verdict, the result is `deny`.
The refusal contains no finding and proposes a suppression for the placeholder
`rule-id`. This contradicts the threshold and gives the reader no useful diagnosis.

[The decision engine](../../src/adapters/chat.ts) collects warnings for optional model
review, then falls through to refusal even when the collection of blocking findings
is empty. This occurs when the judge is absent, suppressed, times out, or returns
an unusable answer.

**Repair:** After optional review, return an advisory result when there are no
findings at the configured blocking threshold. Cover absent, failed, successful,
and rejecting judge outcomes, and both warning and error thresholds.

### 4. Gemini does not load the generated writing instructions by default (high priority)

**Confirmed against installed vendor code.** `init --agent gemini` writes the shared
instructions to `AGENTS.md`. It writes no `GEMINI.md` and does not configure Gemini
to read `AGENTS.md`.

Gemini's own memory discovery returned:

```text
default filenames: [ 'GEMINI.md' ]
AGENTS-only project: []
after configuring AGENTS.md: [ '<fixture>/AGENTS.md' ]
```

[The Gemini profile](../../src/agents/gemini.ts) installs hooks, but nothing that loads
the shared guidance. The deterministic hooks can still work; the promised project
writing guidance is absent in a default Gemini installation. This matters especially
for sentence shapes that hooks do not cover.

**Repair:** Merge `AGENTS.md` into Gemini's configured context filenames while
preserving existing filenames, or provide an instruction import in its native
project file. Verify with the vendor's memory loader. Gemini documents `GEMINI.md`
as the default and a setting for alternative filenames.
[Gemini context guide](https://geminicli.com/docs/cli/gemini-md/).

### 5. Every host has an undocumented Claude judge dependency (high priority)

**Confirmed with a local stand-in, without invoking Claude.** A clean document write
started the stand-in on all six integrations. [The shared command](../../src/cli.ts)
invokes `claude` directly after an allowed document decision. Some chat measurements
also start that executable. The document pass has no check for the selected host.

The generated policy says:

> For Copilot, Codex, Cursor, Gemini and Qwen they are guidance in `AGENTS.md`; no runtime model judge is installed.

That claim does not match execution. Vibe also has a separate judge advertised as
opt-in, but the shared document judge starts independently of that opt-in.

There is a second defect: advisory semantic findings disappear on Cursor, Vibe, and
Gemini. Their pre-tool emitters discard advisory decisions in anticipation of a
post-tool event. The post-tool command recomputes deterministic findings and never
reruns or recovers the earlier semantic result. A semantic-only rejection therefore
produces no advice on either event in advisory mode.

The shared judge also accepts a refusal for a document excluded by project config.
The deterministic decision returns an allow, which starts the judge; its prompt
does not contain project exclusions. A stand-in refusal for `excluded.md` was
honored in strict mode. This confirms the missing protection around the judge;
it does not establish which verdict a real model would give.

The changelog describes moving the **Claude Code** docs judge into the shared command.
That supports an accidental extension to other hosts, rather than a documented
host-neutral feature. The stand-in probes now use Codex's native `apply_patch`,
rather than the compatibility `Write` shape. Full pre/post CLI runs confirm loss
of semantic-only advice on Cursor, Vibe, and Gemini; deterministic post advice survives.

**Repair:** Define explicit judge configuration, host support, and the intended
model-call cost. Apply it consistently to documents and chat. Preserve semantic
feedback for the appropriate post-tool event or use a supported pre-tool context
path. Update generated policy and capability claims from the resulting behavior.

## Further reproduced gaps

### 6. Common Git command forms bypass message checks

**High priority; shared by all shell integrations.** These strict-mode probes allowed
the prohibited message:

```bash
git -C sub commit -m "We leverage this approach."
git commit -mWe\ leverage\ this\ approach.
cd sub && git commit -F msg.txt
```

An ordinary `git commit -m "..."` control was denied. A separate probe set the
hook process directory differently from the event directory. `git commit -F msg.txt`
then passed, although the event directory contained the prohibited message file.

[Message extraction](../../src/adapters/hook.ts) expects `git commit` without intervening
Git options and expects a separator after short message flags. It opens message
files relative to the hook process, ignoring the tool directory and preceding `cd`.

**Repair:** Parse arguments and directory changes for supported commands. Resolve
message files against the command's effective directory. Retain controls for
read-only commands and unknown shell expressions. Other publishing command forms
need the same review; this report does not claim exhaustive shell parsing.

**Second-pass confirmation:** Real Git accepted and committed the prohibited message
in the first three forms. It also accepted leading whitespace before `git` and
adjacent quoted fragments in a message argument; both escaped the hook. A plain
commit control was denied. These are executable command forms, not invalid fixtures.

### 7. Patch renames use the old filename

**Medium priority; shared patch parser, directly relevant to Codex.** Moving
`source.txt` to `notes.md` while adding prohibited prose is allowed. Moving
`notes.md` to `source.ts` with the same addition is denied.

[The patch parser](../../src/agents/fields.ts) ignores `*** Move to:`. It keeps the
original name when classifying the added text and applying exclusions.

The second pass applied both moves with the actual patch tool in a temporary
directory. Both patches succeeded and their destination files contained the
prohibited text. This validates the envelope syntax used in the reproductions.

**Repair:** Track the destination path for moves. Test both directions and moved
files whose destination is excluded or outside the project.

### 8. Relative outside paths cause false refusals

**Medium priority; all file integrations.** `../other.md` is denied when it contains
prohibited prose, while the absolute spelling of the same outside file is allowed.

[File filtering](../../src/adapters/hook.ts) checks containment only for absolute
paths. Relative paths automatically pass the project-boundary filter.

This is over-enforcement of another project's prose, not a bypass permitting bad
prose in the current project. Both spellings point outside the intended scope.

**Repair:** Resolve both path forms against the effective tool directory before
checking containment and exclusions. Cover parent traversal and sibling projects.

### 9. A GitHub acknowledgement also waives shell-written documents

**Medium priority; all shell integrations.** A fresh `.plain-english-ack-github`
allows a prohibited Markdown write made through `printf ... > notes.md`. The
same content written with a native file tool still belongs to the document channel.

The shell pipeline groups file text with publishing text, then checks only the
GitHub acknowledgement. Its diagnostic changes the label to a file, but its waiver
and suggested acknowledgement remain tied to GitHub.

The reverse check also differs: a document acknowledgement does not waive the shell
write. Controls show it does not waive a commit, and the GitHub acknowledgement
does waive a commit. Existing tests require independent native-document and
publishing channels, but do not define waiver policy for mixed shell writes.
The route-dependent behavior is confirmed. Treating shell-written documents as
document-channel content is the recommended policy; that part is a judgment.

**Repair:** Apply the document acknowledgement to extracted document writes and
the GitHub acknowledgement to publishing text. A command carrying both needs
independent decisions for both sets of text.

### 10. The advertised pre-commit installation cannot discover its manifest

**High priority; now confirmed by the actual installer.** The README points pre-commit at
this repository. The only manifest is under
[the integration subdirectory](../../integrations/pre-commit/.pre-commit-hooks.yaml).
There is no `.pre-commit-hooks.yaml` at the repository root, where pre-commit
discovers hook definitions. A temporary installation of pre-commit `4.6.2` cloned
the Git revision and failed with:

```text
InvalidManifestError: .../.pre-commit-hooks.yaml is not a file
```

[pre-commit documentation](https://pre-commit.com/).

**The second installation failure is confirmed too.** The manifest was copied to the
root only in a disposable clone and committed there. Installation succeeded, but
the installed package contained no `dist/cli.js` and exposed no executable.
With the machine's global copy removed from the test's search path, execution failed:

```text
Executable `plain-english` not found
```

Leaving the global copy visible initially produced a misleading pass: pre-commit
ran that copy. Its Node installer installs the Git source; no install or prepare
script builds the missing executable. The npm tarball built in the first pass
does not share this defect. [Native Node installer](https://github.com/pre-commit/pre-commit/blob/main/pre_commit/languages/node.py).

**Repair:** Put the manifest at the discoverable location and test a fresh
pre-commit environment from the Git revision, including commit-message stage
installation. Verify the build path rather than relying on the existing `dist`.

### 11. Reinstallation can remove an unrelated hook

**Medium priority; shared installer.** A fixture command named
`node scripts/plain-english-summary.mjs` disappears when the installer merges
entries. It is a separately owned hook in the reproduction.

The second pass ran the public initialization command with existing hooks on
Cursor, Gemini, Qwen, and Codex. All four lost that command. An ordinary unrelated
command survived, and subsequent initialization was idempotent. The defect is
ownership detection, not general inability to merge settings.

[Ownership detection](../../src/init.ts) identifies every command containing the
substring `plain-english` as an entry it owns. This conflicts with the promise
to preserve unrelated hooks.

**Repair:** Recognize generated launcher commands or an explicit owned identifier.
Preserve commands that merely mention the package. Include nested configurations
and retirement of old owned commands in the tests.

### 12. Refusal advice can fail the rules it asks the reader to follow

**Medium priority; shared diagnostics.** The suggested inline suppression omits
the required reason. Copying it causes `unexplained-suppression`:

```markdown
<!-- plain-english-disable-next-line leverage -->
We leverage this approach.
```

The same generic advice is returned for chat, even though chat explicitly disables
inline suppression and a file exclusion cannot exclude an in-memory reply.
Lowering a rule to a warning also does not waive it under `failOn: warn`.

Qualification: the reasonless document directive still suppresses the original
term. It adds a warning, which blocks at the warning threshold but permits the
write at the error threshold. The example is defective advice, not a universal
failure to waive the original finding.

**Repair:** Give channel-specific remedies, include the required reason in document
examples, and make severity advice depend on the configured threshold.

### 13. The self-lint job reports errors but does not fail on them

**Medium priority; reproduced with a disposable copy of the npm script.** A README
containing prohibited prose returned:

```text
1 blocking, 0 warnings across 5 files
exit: 0
```

[The npm script](../../package.json) does not pass an error threshold, and this
repository's config specifies `failOn: never`. The config comment claims the
script overrides that default, but it does not. The CI dogfood job therefore
cannot reject these findings. The real checkout currently lints clean; that
does not prove the job would refuse a future error.

**Repair:** Set the threshold explicitly in the self-lint command and verify a
deliberate blocking finding in a fixture. Review the publishing action separately:
it already supplies its threshold for the main lint step.

The changelog supplies an explicit promise: “`npm run lint:self` now gates.”
The declared script no longer contains the override that entry describes.

## New findings from the wider pass

### 14. Other commands can make a clean commit fail

**Medium priority; actual shell execution and shared extraction.** This command
committed the clean message but the hook denied it:

```bash
git commit --allow-empty -m "The cache holds results." && printf "%s\n" -m "We leverage this approach."
```

Git's recorded message was `The cache holds results.` The prohibited text was
terminal output. Once the extractor sees any publishing command, it reads message
flags from the entire command string, including later unrelated commands.

**Repair:** Associate each flag with its parsed command. Test multiple publishing
commands separately and quoted examples that never execute Git.

### 15. Shell directory changes defeat file exclusions

**Medium priority; actual shell execution.** With `ignored/**` excluded, this write
was refused even though its destination was `ignored/notes.md`:

```bash
cd ignored && printf "%s\n" "We leverage this approach." > notes.md
```

The [shell scanner](../../src/shell.ts) reports `notes.md`; filtering resolves it against the project root.
It never tracks the preceding directory change. This is a false refusal of an
excluded file. The same path error can prevent checking the correct boundary.

**Repair:** Carry an effective directory per simple command, or decline to infer
destinations when directory changes cannot be resolved. Share directory handling
with commit-message file extraction.

### 16. The shell scanner does not reproduce printf output

**Medium priority; actual output compared with hook decisions.** This command writes
the prohibited sentence but passes:

```bash
printf "We lever%s this approach.\n" age > formatted.md
```

This command writes only clean text but is refused:

```bash
printf "The cache holds results.\n" "We leverage this approach." > clean.md
```

The [shell scanner](../../src/shell.ts) concatenates arguments instead of applying the format string. It
therefore sees text that is never written and misses text constructed by ordinary
formatting. These examples contain no variables or interpreter rewrite.

**Repair:** Interpret a narrow, explicit subset of literal formats correctly.
For unsupported formats, report incomplete coverage or skip instead of treating
argument concatenation as actual file content.

### 17. Cursor's issue matcher misses native issue calls

**High priority; installed dispatcher source, vendor reference, and a later native
selection control.** The installed
Cursor CLI constructs its pre-tool name with:

```javascript
const f = `MCP:${t.toolName}`;
```

The configured issue matcher is `mcp__linear__save_issue|mcp__linear__save_comment`.
It does not match `MCP:save_issue` or `MCP:save_comment`. The generic issue parser
can read the arguments when invoked directly, but the native dispatcher never
selects this hook for those names. The current reference describes the same
`MCP:<tool_name>` vocabulary. [Cursor matcher reference](https://cursor.com/docs/hooks).
The live local mock emitted `MCP:save_issue`; the generated issue hook did not
run. Changing only the fixture matcher to that native name selected the hook,
which returned `deny`. A separate imported prompt hook also refused the original
call, so this proves a selection failure rather than a live end-to-end bypass.

**Repair:** Generate a matcher for native issue names and retain compatible names
where needed. Validate selection with the installed dispatcher, then a local fake
issue tool. No remote issue creation was attempted.

### 18. Gemini history diverges from its native session format

**Medium priority; compared with Gemini's installed loader.** A fixture contains
two versions of one message, another response, and a rewind removing that response.
Gemini's loader returns only `The corrected response.` This package returns all
three texts, including `We leverage this approach.` from the abandoned response.
Its fallback stop reader also selects that abandoned response.

Gemini replaces records with the same message identifier and honors rewind markers.
[This package's reader](../../src/chat/gemini.ts) treats every text-bearing line as a separate reply. It also skips
retained legacy JSON sessions that Gemini's loader still reads. History statistics
can be inflated and include replies the user removed. The direct stop-message path
remains correct when Gemini supplies `prompt_response`; the faulty fallback only
matters when that direct text is missing.

An additional path defect affects custom homes: when the override itself ends in
`.gemini`, this package removes a directory level that native storage still appends.
Both paths were compared with installed code. Ordinary home overrides are unaffected.

**Repair:** Reconstruct logical sessions using identifiers, updates, and rewinds;
retain the supported legacy format; match native home semantics. Check compatibility
against the native loader. [Gemini rewind behavior](https://geminicli.com/docs/cli/rewind/).

### 19. Cursor history includes neighbouring repositories

**Medium priority; generated transcripts and public reader.** Scanning a directory
named `repo` also reads a sibling named `repo-other`. The scoped scan returned:

```json
["From the neighbouring repository.", "Inside the requested repository."]
```

The [directory-name hint](../../src/chat/cursor.ts) uses substring matching. No exact project identity is
required before replies are included. The source promises a scan limited to the
requested repository, so findings and statistics from another project are incorrect.

**Repair:** Use exact metadata when available. Treat flattened names as an exact
identity or an explicitly delimited descendant, not an arbitrary substring.

### 20. The optional findings-file step can override the Action's requested threshold

**Medium priority; composite-step command reproduction.** In a project configured
to fail on errors, the findings-file step returned exit 1. The main step with
the Action input set to advisory returned exit 0 for the same document:

```text
SARIF command without explicit threshold: exit 1, one finding
main command with --fail-on never: exit 0
```

The [optional findings-file step](../../integrations/github-action/action.yml) runs first without the Action's threshold. A
failure there stops the composite action before the requested advisory gate runs.
An error-only input can similarly be overridden by a local warning threshold.
The report file exists, but the requested action behavior is still wrong.

**Repair:** Give the artifact-production step an explicit advisory threshold and
let the main gate own the caller's threshold. Exercise local configuration and
Action input combinations. Hosted workflow execution remains untested.

## Reproduce and complete verification

Run the persistent local probes:

```bash
npm run build
node scripts/investigation/integration-gaps.mjs
node scripts/investigation/integration-wider.mjs
```

[The probe script](../../scripts/investigation/integration-gaps.mjs) prints controls,
gaps, and structured synthetic evidence. It calls no real model. Its `GAP` lines
describe unmet expected behavior; it is an audit script rather than a passing
regression suite. The Claude stand-in requires macOS or Linux.

The wider script runs without vendor dependencies. Its optional
`--gemini-core=/absolute/path/to/installed/core-bundle.js` argument compares history,
instruction discovery, and home paths with Gemini's own implementation. With that
comparison enabled, the combined run has 55 passing controls and 55 mismatches
across 110 probes. Both scripts exit successfully after recording mismatches;
they are investigations, not regression gates. A failed probe setup throws instead
of being counted as a gap.

[The retained evidence](../../scripts/investigation/evidence-2026-10-08.json) records
expected and actual results, safe native event summaries, vendor versions, and
verification output. It contains only synthetic fixtures and generated session
identities. It contains no credentials, user conversations, or model reasoning.

Follow-up live verification should include native edits, shell writes, excluded
files, repeated user turns, and advisory feedback visible in the next model turn.
Issue parsing should be exercised against a local fake server so no real issue or
comment is created. No remote messages were sent during this investigation.

The initial Cursor prompt failed before hooks dispatched. After the user signed in,
a fresh prompt returned `OK` with exit code 0. This verifies authentication, but
that prompt alone does not establish that the live hook scenarios pass. Subsequent
strict write and issue-selection checks are recorded in the live follow-up.

The Gemini authentication follow-up used version `0.63.0`, cached Google credentials,
and an invocation with both inherited API key variables removed. It exited with
code 1 and reported:

> This client is no longer supported for Gemini Code Assist for individuals.

The browser's successful login confirms Google accepted the account. The later
service check refuses that account access to Gemini CLI. Google ended access for
personal free, Google AI Pro, and Google AI Ultra accounts on June 18, 2026.
The earlier advice to repair this by signing in with Google was incorrect for
personal accounts. [Official deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).

API key authentication and licensed Code Assist enterprise accounts remain supported.
A valid API key can retain the current Gemini test target; personal Google sign-in
requires migration to Antigravity CLI. At this authentication follow-up, the
repository had no dedicated adapter for that separate integration. The subsequent
requested migration adds one and verifies native write refusal, approval, and
chat rewrites. See [the migration report](2026-10-08-antigravity-migration.md).
[Official transition announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

Qwen's repeat strict check again timed out, while clean runs with and without
customizations completed. That narrows the failure to the tested refusal/retry
scenario without establishing whether package code or the host causes it.
The live model used global memory in that scenario, so it was not a fully isolated
model context. The timeout remains an unresolved observation, not a numbered bug.
The later isolated follow-up used the same managed CLI version and model. The
original strict prompt completed in about 17 seconds, and a clean control in
about 5 seconds. This narrows the outstanding question to the original context
or run conditions rather than proving a permanent strict-retry failure.

For Codex, keep project trust and hook trust separate. Its current reference
documents both pre-tool enforcement and stop continuation, consistent with the
events observed here. [Official OpenAI hooks reference](https://learn.chatgpt.com/docs/hooks).

Repair findings 1–5 first, then the installation failures and Cursor issue matcher.
Turn each confirmed defect into a focused regression before changing its runtime
behavior. Update capability documentation after live checks, keeping observed,
vendor-source, and documentation-only evidence distinct.

## Coverage that passed and limits that remain

Each of the six adapters correctly classified a native prohibited Markdown write,
a clean Markdown write, a source-file write, and an excluded document when the
shared judge was suppressed. Four full initialization tests preserved ordinary
unrelated hooks and were idempotent. Deterministic post advice reached Cursor,
Gemini, and Vibe. Codex and Qwen's distinct turn identifiers survived the replay.
These controls show which paths work, which narrows where each fault can be.

The review does not classify documented omissions as defects: interpreter-based
rewrites, content supplied through variables, and pure renames with no inserted
text remain limits of added-text inspection. Windows process resolution, linked
worktrees, concurrent hook state writes, hosted agents, and desktop-only events
were not verified live. Native issue dispatch was inspected for Cursor, but no
vendor was asked to send a real issue or comment. This is broad evidence of specific
failures, not proof that every untested path works.
