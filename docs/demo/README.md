# Recorded writing check

This demo shows a coding agent whose first save was refused by the writing check.
It added an explanation and tried again. The [animation](demo.gif) replays text captured
from a live Claude Code run. It shows excerpts; the [record](run.json) contains the
full task, drafts, returned finding, and saved result.

## What happened

Claude drafted a pull request description about a format for exchanging code-analysis
findings, called Static Analysis Results Interchange Format (SARIF). Its first draft
used the abbreviation without explaining it. The plain-english plugin refused the save
and returned this finding:

```text
line 1: "SARIF" (unglossed-term) "SARIF" is not explained. Say what it does, then name it.
```

Claude added the full name and explained what the format does. Its next save succeeded.
An independent scan of the saved file returned:

```text
clean (1 file)
```

No user message was sent between the refused save and the corrected one. The animation
shortens the wait and replays the recorded text on four screens; it is not a screen
capture of the terminal.

## The settings

The capture used Claude Code 2.1.293, Claude Opus 5.5, and plain-english 1.5.0. Only
reading and writing files were available to the agent. Custom writing instructions,
skills, and external tools were not loaded. Both runs used the same task and system
instructions. The checked run loaded an isolated copy of the plugin and this config:

```yaml
version: 1
extends: default
failOn: warn
```

This setting blocks warnings as well as errors. Without project config, findings are
advisory. The run without the plugin had `failOn: error`, which did nothing because no
plugin was loaded. That run also produced an unexplained abbreviation.

The record includes hashes of the plugin files used for the capture. Later releases
may report different findings. Absolute working-directory paths were replaced with the
filename in the published tool results.

## The earlier result

The first task asked Claude to announce the plugin using supplied project facts. Both
the run without the plugin and the checked run passed the file checks on their first
draft. Neither needed a rewrite. Both drafts are recorded.

The displayed example was selected because it produced a finding and a correction.
It establishes that this save was refused and retried. It does not measure average
writing quality, how often the rules are right, or performance against another tool.

## Try the same task

Install the plugin using the [main README](../../README.md#install-in-claude-code).
In a disposable project, add the config above and ask Claude:

```text
Draft a short pull request description for adding SARIF output to plain-english. Save it as announcement.md in the working directory, then return the description.

The change has these facts:
- plain-english is a prose linter for Markdown and plain text.
- The command npx plain-english lint docs --format sarif writes SARIF 2.1.0 output to standard output.
- Every finding includes its rule ID, severity, file, line, column, and rewrite hint.
- Blocking findings become error results; warnings become warning results.
- An incomplete scan is marked as unsuccessful instead of being reported as a complete check.
- The output can be uploaded to GitHub code scanning.
- The normal scan runs locally and sends no text to a model.

Use only these facts. Include the command unchanged. Write for developers reviewing the change. Do not invent test results or performance claims.
```

A new run may produce a draft that already passes. To inspect the saved result yourself:

```bash
npx plain-english lint announcement.md --fail-on warn
```
