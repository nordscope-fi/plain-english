# ADR-006: Model checks run through the Claude Code mod when it can make the call

**Status:** Proposed
**Date:** 2026-10-08

## Context

The linter asks a model for a second opinion in two places. A reply that fails
only a length limit gets up to two questions: can it be read, then has the
length been earned. A file write, commit message or issue that passes the
pattern checks gets one question about its prose. For Claude Code these checks
are on by default:

```ts
return ruleSet.modelChecks ?? (agent === "claude-code" || ...
```

Each question starts a new `claude -p` process (`runJudge` in
`src/adapters/judge.ts`). The Claude Code mod reaches the linter the same way
the shell hooks do: it starts the CLI, and the CLI starts `claude -p`.

A mod can ask the model directly. `$.model.complete` sends one request through
the session's own client and credentials. Two measurements, both from
8 October 2026 on Claude Code 2.1.294 with `haiku` and a prompt asking for one
word:

| Route | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `claude -p` with the judge's flags, whole process | 5.7 s | 5.5 s | 6.5 s |
| the same call's own model time (`duration_api_ms`) | 0.6 s | 0.7 s | 0.7 s |
| `$.model.complete` inside a mod | 0.7 s | 0.7 s | 0.7 s |

So about 5 seconds of every check goes to starting a second copy of Claude
Code. The docs check has a 15 second budget (`DOCS_JUDGE_CALL_MS`), and a
clean Markdown write waits for it before the file is saved.

The answers do not change with the route. On 2026-10-08, 16 judge prompts
went through both routes with `haiku` (twice each) and `sonnet` (once), and
every prompt got one verdict across both routes and every repeat. The method
and table are in issue #72.

The time a mod spends inside a `$` call does not count against its hook
budget, so the route does not change any timeout. The gain is the startup
time alone.

## Decision

When the Claude Code mod starts the CLI, the CLI hands each model question back
to the mod instead of starting `claude -p`, and the mod answers it with
`$.model.complete`.

The CLI's decision code is synchronous and asks its questions in the middle
of a decision. It stays that way. The hand-back works by replay:

1. The mod starts the CLI with `PLAIN_ENGLISH_MODEL_ROUTE=host`. The variable
   is set only by the mod, so every other agent and the shell hooks keep the
   `claude -p` route unchanged.
2. When the CLI reaches a model question in that mode, it looks the question up
   in the answers it was given. The key is a hash of the filled prompt, so an
   answer can only ever match the question it was asked for.
3. If the answer is missing, the CLI stops the decision and prints one request
   instead of a decision: the filled prompt, the model, and the time left. Its
   exit code stays 0.
4. The mod sends that prompt through `$.model.complete`, with the mod's own
   cancellation signal and the time left as `timeoutMs`. It then starts the CLI
   again with the same payload plus the answers so far.
5. The CLI replays the decision from the start. Earlier questions now find their
   answers, and it either reaches a decision or asks the next question.

A reply needs at most three CLI runs: one per question and one to finish. A CLI
run costs a Node start, not a Claude Code start.

The details that keep behaviour the same:

- **Deadline.** The first run fixes the deadline and returns it with the
  request. Later runs receive it back, so two questions share one budget as
  they do now (`CHAT_JUDGE_PIPELINE_MS`).
- **Failures.** An API error, an empty reply or a timeout comes back as an
  unavailable answer. The CLI treats it exactly as a failed `claude -p` today:
  the pattern result stands and the same notice is printed.
- **Model.** Today the judge runs with the person's default model unless the
  hook passes `--model`. The mod uses `--model` when given, and otherwise the
  session's model from `$.session.model()`.
- **Usage records.** The mod returns the reply's token usage with the answer, so
  `judgeMeasurement` keeps recording each call. A replay sees every earlier
  answer again, so the CLI records usage only for the newest answer in the
  list. Each answer is the newest exactly once.
- **Older Claude Code.** A mod cannot test whether `$.model` exists: the engine
  refuses a module that reads a `$` noun as a value. The plugin already
  requires Claude Code 2.1.293, whose types include `$.model.complete`. Where
  the call cannot be made at all, because an engine lacks it or refuses the
  request, the mod runs the check once more without the variable, so it
  behaves as it does today.

### Build order

Each step is test first, and each ends green.

1. CLI: an answer source for `runJudge`, the request output and the replay.
   Unit tests for a missing answer, a found answer, a mismatched key, an
   unavailable answer and the shared deadline. Two more pin the replay:
   usage is recorded once per answer, and a run that stops for an answer
   leaves no turn state behind.
2. Mod: the request loop in `adapter()` in `register.ts`, with
   `$.model.complete` stubbed in `tests/register.test.ts`. Tests for one
   question, two questions in a row, an API error, a cancelled turn and a run
   limit of three.
3. Live check in an interactive session: a clean Markdown write and a long
   reply each show the expected verdict, and the write no longer waits
   5 seconds.
4. Update the mod's README and `docs/agents.md` with the new route and the
   measured times.

## Consequences

- A checked write or reply saves about 5 seconds for each model question.
- The CLI gains a second output shape, a model request. Only the mod asks for
  it. It is internal to the plugin and is not part of the hook contract other
  agents use.
- The CLI's decision code may now run up to three times per check, so a run that
  stops for an answer must have written nothing. Today that holds: the chat
  decision asks its question (`src/adapters/chat.ts`, line 237) before it saves
  the turn's block state (line 307), and the record written under
  `PLAIN_ENGLISH_RECORD` comes after the decision is printed. A test pins the
  order so a later change cannot break it unnoticed.
- The judge's recursion marker is not needed on this route, since
  `$.model.complete` starts no hooks. It stays for the `claude -p` route.
- A person who changes `/model` during a session now gets that model for the
  checks, where `claude -p` used the default from their settings.

## Alternatives considered

- **Do nothing.** Every clean Markdown write keeps waiting about 6 seconds, and
  a long reply up to about 12.
- **Move the decision code into the mod.** Two copies of the rules for when to
  ask and what to do with the answer, which then drift apart.
- **Keep one CLI process and talk to it while it runs.** The decision code calls
  the judge synchronously. Making it wait on a reply from the mod means turning
  `decideChat` and the write path asynchronous throughout, for no gain over a
  Node restart that takes a fraction of a second.

## Re-evaluation triggers

- `$.model.complete` changes shape, or stops using the session's credentials.
- Startup of `claude -p` falls under one second, which removes the gain.
- A second host offers an in-process model call, which would reuse the request
  shape.
