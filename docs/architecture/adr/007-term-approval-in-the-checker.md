# ADR-007: Term approval reads and writes files in the checker, not the mod

**Status:** Accepted
**Date:** 2026-10-08

## Context

The Claude Code plugin's review panel lets a person approve one term as project vocabulary. The mod did the whole job itself. It found the project's config, refused an inherited or linked one, ran `explain` to check the rule, asked the person, checked again that nothing had changed, and wrote the file with `$.fs.write`. It bundled the `yaml` library into `hooks/approval.mjs` to edit the file without losing comments.

Validating the plugin in the Claude directory on 2026-10-08 held four findings on that code:

- the mod reads local files (`fs.read`) and can also send data out;
- the mod writes a file other tools obey, at a path that is not fixed text;
- a credential read paired with a way out, where the "credential" was the YAML library's parser tokens;
- two warnings on the library's own `defineProperty` and `getPrototypeOf` calls.

## Decision

The mod asks the person, and the checker does every file read and write. A new command, `plain-english approve`, takes its request as JSON on standard input and works in two steps:

1. `check` resolves the config, refuses an inherited or linked one, and refuses a rule that is unknown or a sentence shape. It runs the term through the same edit, writes nothing, and returns the config's name, whether it exists, and a hash of its contents.
2. `write` repeats every check and writes only when the project root, config name, existence and hash all match what `check` returned.

A refusal is an answer, `{"ok": false, "message": ...}` with exit 0. Only a malformed request exits 2. The command line is fixed text, `node dist/cli.mjs approve`, with no arguments.

## Consequences

- The mod reads and writes no files and no longer bundles `yaml`. `hooks/approval.mjs` and `scripts/approve-term.mjs` are gone, and `approveTerm` lives in `src/approve.ts`.
- The time-of-check guarantee holds. The write step compares a hash of the file against the check step's, which catches the same changes the mod's byte comparison did.
- The CLI gains a command. It is listed in the help text as used by the Claude Code plugin. Its request and answer shapes are part of the CLI's contract from 1.14.0.

## Alternatives considered

- **Keep the mod's file work and explain it in the README.** The holds stay, and the mod keeps a 200 KB bundled library for one config edit.
- **Write the config with plain string edits in the mod.** It removes the library, but a hand-written YAML edit can corrupt a config or drop comments. The two file holds would also stay.

## Re-evaluation triggers

- The directory stops holding mod file access, or gains a way to declare it.
- A second host needs term approval, which would reuse this command.
