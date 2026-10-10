# ADR-009: The checker ships inside a writing skill for Claude chat and Cowork

**Status:** Accepted
**Date:** 2026-10-10

## Context

The plugin did its job only in Claude Code. In Claude chat and Cowork, output
styles and mods do not load; skills do. Anthropic's platform page lists skills
as "Loads" on every surface, and output styles as "Ignored" outside Claude
Code.

A live test on 10 October ran the bundled checker from an uploaded skill in
chat on the web and in the phone app. Both printed `/opt/node22/bin/node` and
`v22.22.0`, found the three planted phrases, and passed the clean draft, with
nothing downloaded. No Anthropic page promises Node in chat; the docs say a
script runs in "what the code-execution environment provides". The test
covers one account.

Chat copies a skill's own folder and nothing else: "In chat on claude.ai, the
skill's whole folder, scripts included, is copied into the code execution
sandbox". The checker's core lived in `hooks/core/`, outside any skill.

The directory portal lists the existing plugin for Claude Code, Cowork and
the Claude apps, noting for the last two "Not used here: output styles. The
directory lists mods for Claude Code only."

## Decision

The checker's core moves into the writing skill, and the mod imports it from
there.

- The build writes the core to `skills/plain-english/scripts/core/`. The mod's
  two imports in `hooks/register.ts` point there, so one copy serves both.
- `scripts/check.mjs` in the skill reads a draft on standard input and calls
  `checkDraft`, a new core function. It returns `checked`, `incomplete` or
  `invalid`; the script adds `unavailable` when the core will not load. The
  script gives up after 10 seconds if its input never closes.
- `checkDraft` reads no file, keeps no state and makes no model call. The
  checks a judge makes in Claude Code come back as questions for Claude to
  answer about its own draft.
- `plain-english render` generates the skill's `SKILL.md` from the ruleset,
  with the same reply rules as the output style. Claude saves the draft to a
  file and the shell redirects it in, so no text in the draft can run as a
  command.

## Consequences

- One copy of the core. The directory scans it once per version.
- The mod's imports reach into the skill's folder. A probe of this layout on
  Claude Code 2.1.296 passed `claude plugin validate --strict` and the mod's
  36 tests.
- In Claude Code the skill's instructions say not to run the script, because
  the mod already checks there.
- Replies are checked only when the skill loads, and a skill loads only when a
  request fits its description. The plugin README offers a sentence a person
  adds to their profile instructions.
- The plugin's listing text now says what each app gets.

## Alternatives considered

- **Faking a Claude Code hook event.** The script could have wrapped each
  draft in a fake event for the existing hook path. It needs no core change,
  but it couples the skill to that event format, and a failed check looks the
  same as a clean draft.
- **The pre-commit integration's single-file CLI.** It is about 1.6 MB, over
  the directory's 262,144-byte limit per file.
- **A second copy of the core in the skill.** It leaves the mod untouched, but
  the directory rescans every version, so the same code would go through the
  scan twice, and a test would have to keep the copies equal.
- **A separate plugin for chat and Cowork.** Two listings and two reviews. The
  portal showed one plugin can be listed everywhere.

## Re-evaluation triggers

- Chat stops providing Node 20 or later, or another plan type turns out not to
  have it.
- The directory flags the mod importing from a skill's folder.
- The portal stops listing the plugin outside Claude Code.
