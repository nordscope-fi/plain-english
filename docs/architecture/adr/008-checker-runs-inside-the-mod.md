# ADR-008: The Claude Code plugin runs the checker inside its mod

**Status:** Accepted
**Date:** 2026-10-09

## Context

The Claude Code plugin's mod starts `node hooks/run-checker.mjs`, which runs the bundled CLI in `dist/` for every check, approval, guidance read and `/plain-english` lint. The Claude directory's validation of `d4ae2c6` held the plugin with seven policy holds. Four are mod findings, each anchored at the first `$.process.run` and each naming `process.run` as its cause:

- the mod starts other programs;
- it starts a program with a command the directory could not read in full;
- it can read local data and can also send data out;
- it can read the conversation and can also send data out.

The fifth, "Uses a credential from the user's machine", has three findings, all inside the bundled CLI. Three rounds of README answers changed none of the four. Only code changes moved the report: holds went from 9 to 8 to 7.

Two probes on branch `probe/in-mod-holds` settled the alternative:

| Probe | What the mod did | Directory result |
|---|---|---|
| `016ad99` | read `tool.call`, `session.cwd` and `.plain-english.yml` through `fs.read`, asked the session's model through `model.complete`; no program | none of the four mod findings |
| `112c640` | ran the real checker core (rules, Markdown parsing, `lintText`) bundled into `hooks/core/`, wrote `.plain-english.yml` at a fixed path, read the transcript path a `Stop` event names | none of the four mod findings, and no finding for the write or the transcript read |

The second probe raised three new findings, each with a concrete cause:

| Finding | Result | Cause |
|---|---|---|
| Mod uses `eval` | Blocks | the `format` package, reached through `fault`, falls back to `(1, eval)("this")` |
| A file looks minified or bundled | Policy hold | `parse-latin`'s Unicode regular expressions, single lines of up to 4,786 characters |
| Uses a credential | Policy hold, 2 findings | error messages built as `` `${KINDS.join(...)}` `` and `` `${JSON.stringify(...)}` `` beside this repository's address and the Markdown parser's `http://` prefix |

A live session confirmed the core runs in a mod: it loaded, found three phrases and refused the write in 37 ms. One build setting matters. The `browser` export condition pulls the build of `decode-named-character-reference` that uses a web page's `document`, and the mod fails with `document is not defined`. The `default` condition works.

## Decision

The mod runs the checker in its own process. It starts no program, and the plugin ships no CLI.

The checker's command logic moves into functions that do no I/O of their own. Each takes an `io` object:

```ts
interface CheckerIo {
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  now(): number
  read(path: string): string | undefined        // undefined: the file does not exist
  stat(path: string): FileFacts | undefined     // kind, mtime, real path
  list(dir: string): string[]
  state: { get(key: string): string | undefined; set(key: string, value: string): void }
}
```

The CLI passes an `io` backed by `node:fs`, so its behaviour does not change. The mod passes an `io` backed by what it has already fetched through `$.fs`. When a function reads a path the mod has not fetched, the `io` records the path and answers as if it were missing. At the end of the run the function throws `NeedFiles` with every recorded path. The mod fetches them all in one round and runs the function again. A config's `extends` chain needs one round per level, and four rounds bound a run.

This is the ADR-006 replay, extended from model answers to files. Model questions keep working as they do now: the function throws `ModelRequest`, the mod asks `$.model.complete`, and the next run finds the answer. The key becomes the prompt's SHA-256 from a small pure implementation, so the CLI's keys do not change.

The four entry points match the CLI commands the mod uses today, with the same outputs:

| Function | CLI command it serves |
|---|---|
| `hookCheck(channel, payload, io)` | `hook docs|github|issue|chat --agent claude-code` |
| `approveTerm(request, io)` | `approve` |
| `projectGuidance(io)` | `guidance` |
| `lintPaths(paths, io)` | `lint --paths-from-stdin` |

Approval's write moves into the mod as two literal calls, `$.fs.write('.plain-english.yml', text)` and the same for `.yaml`. The second probe raised no finding for it. The write step repeats every check against fresh file answers, so a link, a changed file or a governing parent config still refuses. A fixed path lands in Claude Code's own working folder, so the mod also refuses unless `$.fs.stat('.')` resolves to the project root the check named.

The chat channel's once-per-turn block state moves from temporary files to `io.state`. The mod keeps it in memory for the session, and saves what a run set only when that run is the one that finishes. A run that lacked a file still records a block; kept, it made the finishing run read the turn as already held, which the plugin tests caught.

Modules on these paths import nothing from `node:`. `src/node-io.ts` holds the Node `io`, and the CLI is its only user. A pure `src/paths.ts` replaces `node:path` on these paths and handles both `/` and `\` separators.

The plugin build bundles the four functions into `hooks/core/` with `platform: "neutral"` and `conditions: ["default"]`. It splits files under 240 kibibytes (the directory reads 256) and strips comments. It also does the following:

- replaces `format` with a ten-line `%s`/`%d`/`%j` formatter;
- rewrites each regular expression literal longer than 400 characters in `parse-latin/lib/expressions.js` as `new RegExp` over joined lines, checked to have the same `source` and `flags`;
- embeds the built-in ruleset as `hooks/core/default-rules.mjs`, which the mod imports, so no check reads a plugin file to find it;
- builds no CLI. `dist/`, `rules/` and `hooks/run-checker.mjs` leave the plugin.

## Consequences

- All four mod holds and the CLI-bundle credential findings go, if the probes hold for the full plugin. The directory's validation of main is the check.
- A plugin check no longer starts Node. The CLI start-up, about 0.18 s per run, disappears from every write and reply.
- The `claude -p` fallback leaves the plugin. When `$.model.complete` cannot be made, the extra model check is reported unavailable and the pattern result stands, as it already does for a provider error.
- The Claude writing benchmark loses its receipts for the checks mode, which the bundled CLI wrote. It now reports that the plugin implements none, rather than a cost. Restoring them is #136.
- The probe that checked cancellation stopped the launcher and its children is removed, with its CI steps. There is no program to stop.
- Approval loses the `O_NOFOLLOW` and `wx` opens of ADR-007. It checks with `stat` immediately before `$.fs.write`, which leaves a short window. The write path is fixed text inside the session's working folder.
- The core modules gain an `io` parameter. Tests drive them with an in-memory `io`, which also tests the missing-file rounds.
- New tests guard the bundle: no `eval` or `Function(`, no `node:` import, no `process.`, no line over 1,000 characters, and no `${` followed by an all-capitals name.

## Alternatives considered

- **Answer the holds in the README.** Done three times; no hold moved. A policy hold is cleared by a reviewer, and the report raises it again on every version.
- **Port the command logic to async code in the mod.** It would duplicate about 500 lines of `cmdHook`, `hookChat` and approval logic in a second implementation. The replay keeps one implementation.
- **Keep starting the CLI, and submit with the holds.** This is the current state. The maintainer rejected it: every hold is a review round trip.

## Re-evaluation triggers

- The directory's validation of the finished plugin still shows a mod or credential hold.
- Claude Code gives mods a synchronous file read, which would make the `NeedFiles` rounds unnecessary.
- A future check needs a file path the core cannot name before it runs.
