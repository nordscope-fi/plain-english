# Design rationale

Why this works the way it does, for anyone adapting it.

This is the narrative version. Each decision below also has a record of its own under [`architecture/adr/`](architecture/adr/README.md), which carries the status, the alternatives that lost, and what would make it worth revisiting. When the two disagree, the record wins.

## The problem

AI-generated writing has predictable tells: a small set of overused words, plus a handful of sentence shapes (a contrast cliche, a throat-clearing opener, an unnamed-authority claim, a fake-strong verb dressing up a plain fact). New AI-written text keeps arriving. The check has to run at write time, in every channel where text gets produced.

## Why two layers

[ADR-001](architecture/adr/001-two-layer-detection.md)

A word list matches exact terms in about a millisecond and is fully testable. It cannot see a rephrased cliche or a sentence shape.

A model can see those, and costs a network round trip. It is also the layer that gets calibration wrong, in a specific and repeatable way documented below.

Running both means the cheap layer carries the load it can carry, and the expensive layer is the only thing that can be wrong in an unbounded way.

## Why block before the write

[ADR-002](architecture/adr/002-block-before-the-write.md)

A fix applied afterwards cannot un-push a commit, un-save an issue, or un-show a doc that a reader already opened. The check has to sit in front of the write.

The corollary is that a false positive is expensive. Somebody is stuck, mid-task, arguing with a gate. That is why the severity split and the graduated escape scopes exist.

## Severity, and why some words only warn

[ADR-003](architecture/adr/003-severity-gradient.md)

The first version of this ruleset blocked on `silently`, `quietly`, `mechanical`, `underscores`, `holistic` and `dive into`. Every one of those has an ordinary technical or domain sense:

```
The parser fails silently when the file is missing.
Use a mechanical keyboard for this.
The filename underscores are significant.
A holistic medicine startup, our client.
```

All four were blocked. Thirteen such strings were collected and every one now sits in `test/corpus/cases.yml`. They are the reason for three mechanisms: warn-level severity, per-rule `unless` clauses, and the masking pass.

## Masking

Nothing outside prose is scanned. The document is parsed, and everything that is not prose text is replaced with spaces of equal length. Offsets stay aligned, so a finding still reports the right line and column. The exact list lives in the generated guide, [`docs/writing-style.md`](writing-style.md#what-is-never-scanned), so that it cannot drift from the code the way a hand-copied list does.

Blockquotes are excluded because a quote is someone else's words. Blocking a customer email that says `leverage` helps nobody.

Two bugs came out of getting this wrong:

- Suppression directives were read from raw source, so the generated style guide disabled itself. It documents the whole-file directive inside a fenced block as an example, and the engine treated the example as live. Every finding in the file disappeared with no message. Directives are now read from a view with fences already blanked, and examples inside fences are inert.
- HTML comments were being scanned, so the rule named in a directive was reported as a finding on the directive line. Comments are never rendered, so they are now masked for matching.

The generated style guide also carries its own whole-file directive, since it lists every banned term as reference material. Without it, it reports about thirty findings against itself.

## The semantic layer gets calibrated wrong by default

This is the failure mode to design against, and it was reproduced while writing this repo.

The README was submitted to a semantic gate whose prompt asked it to find a list of sentence shapes and reply with pass or fail. It refused the file twelve times. During that run it:

- proposed a replacement sentence, then flagged that exact sentence on the next attempt, then flagged its own replacement for that one, oscillating between two forms it had authored itself;
- reasoned through the content, concluded "No live em dash character exists in prose outside code fences. Plain rewrite: none needed", and returned a refusal anyway;
- judged a `.txt` file after being instructed to pass any file that is not markdown.

An open-ended "find these shapes" instruction with no calibration toward a clean verdict has a false-positive floor above zero. It will always find something, because finding something is what it was asked to do.

Three mitigations are built into the generated prompts:

1. State that a clean verdict is the common case and a finding must be exceptional.
2. Require the exact offending substring to be quoted, and require the judge to drop the finding when it cannot locate that substring verbatim.
3. Keep the scope check first and absolute, so a file that is out of scope is never read at all.

A fourth mitigation is structural: the semantic layer never gets to be the only gate. Anything it can be trusted to catch deterministically belongs in `rules/default.yml` instead, where it is testable.

## Why the ruleset is data

[ADR-004](architecture/adr/004-ruleset-is-data.md)

The version this replaces maintained the same word list in five places: a regex pasted into three shell scripts, a prose list inside three prompt bodies, and a table in a markdown file. Nothing checked that they agreed, and they did not.

The same argument decided how coding agents are supported. Each agent gets a translation
table in `src/agents/`, mapping its payload onto one canonical event and one decision back
onto its wire format. Nothing about deciding lives in a profile. Some contracts descend
from Claude Code's shape; Vibe, Gemini and Cursor use different names and reply fields.
One linter per agent would have drifted the way five word lists did.

Per-agent instruction files were the alternative and were rejected. Generating `.cursor/rules/*.mdc`, `.github/instructions/*.instructions.md`, `GEMINI.md` and the rest fits each host better than one shared file does. It is also a file per host per release to keep true. `AGENTS.md` is read by roughly twenty agents, and is worse at none of them by enough to matter.

Here, `rules/default.yml` is the only hand-written source. The docs and the prompt bodies are generated from it, and CI fails when the working tree changes after a render. Four restatements cannot disagree when three of them are outputs.

## Why the escape hatch is graduated

[ADR-005](architecture/adr/005-graduated-escape-hatch.md)

A ten-minute acknowledgement file that disables an entire guard is a blunt instrument. On its own it gets used for cases that deserve a one-line suppression instead.

Five scopes now exist, narrowest first: one rule on one line, one rule across a range, a whole file, a path glob in config, and a severity downgrade in config. The refusal message lists them in that order and names the specific rule id to suppress, so the cheapest correct fix is the one presented first.

The acknowledgement file survives as the sixth and last, still ten minutes and still expiring on its own. It lives at the repository root rather than inside `.claude/`, because the message tells a human to `touch` it and `touch` will not create a missing parent. Under an agent that keeps no `.claude/` directory, the advice would be impossible to follow. It stays because the five above all need a decision about what the right permanent fix is, and somebody mid-task does not always have one. What it should never be is the first thing reached for, which is why the message puts it last and marks it as the human's call.

## What to watch for when adapting this

- Word lists need occasional expansion. A near-synonym slips through when only the original term is listed.
- Any file that quotes the banned list as reference material needs a directive or an exclude. This includes your own style guide and often your CHANGELOG.
- Scope the file-path check to the target repo. An unscoped check fires on unrelated files elsewhere on disk that the same session happens to touch.
- Put standard domain vocabulary on the `allow` list from the start, scoped to the rule you mean and marked `semantic: true`. The semantic layer otherwise flags normal working vocabulary as unexplained jargon, and an unscoped entry hides everything else on the line while it is at it.
- Watch the escape hatches. If people reach for the whole-file directive routinely, a rule is miscalibrated and should be a warning.

## Prior art

Two rules in the shipped set are ported rather than invented, and one dataset was looked at and left alone.

[`tbhb/vale-ai-tells`](https://github.com/tbhb/vale-ai-tells) is a Vale package under the MIT licence covering the same ground. It carries 111 prose rules, 15 for commit messages, and 18 experimental rules that measure a document rather than matching a word. `figurative-placement` and `mic-drop` here take alternatives from its `FigurativeHolds`, `FigurativeSits` and `MicDrop` rules.

Its finding, tested over a large Go and Python corpus, is that a figurative verb has to be gated on what follows it. Gating on the verb alone floods, because literal sitting and holding are everywhere.

Its experimental package measures what no word list reaches. Sentence lengths in machine-written prose cluster near one value where human prose swings widely, and the same holds for paragraph sizes and for how often a sentence starts with the same word. That is unfinished business here. `reply-pace` measures the average sentence length, and its own comment records that the number was calibrated on four replies.

[`amperser/proselint`](https://github.com/amperser/proselint) is BSD-3 and much older. Its mixed-metaphor check turned out to be a short list of malapropisms and was not worth taking. Its cliche and pretension word lists are worth reading against `puffery-nouns` at some point.

The Brysbaert concreteness norms rate 37,058 English words for how concrete they are, which is the missing piece for any rule that wants to ask whether a sentence names a real object. Every copy found carries no licence, so nothing here uses it.

## A rule that was measured and not built

The first theory about machine-written prose here was rhetorical position. A paragraph ends on a general truth where the specific fact belongs, and the last sentence is the one a reader keeps. The proposed test was a paragraph-final sentence carrying no proper noun, no number and no concrete object.

It was measured on 2026-08-24 before anything was built, and the numbers point the wrong way.

Across `docs/`, `README.md` and `CONTRIBUTING.md`, 362 paragraphs hold more than one sentence, and 172 of them end on a sentence matching that test. That is 47.5%. The machine-written cover letter the rule was designed around scored 10.0%.

The examples show why. "Open an issue with the sentence, since that is a complete bug report." carries no name and no figure, and there is nothing wrong with it. Ending a paragraph on a plain sentence is what ordinary prose does. The test measures a property of English, not a property of generated text.

Position may still be a real signal. This way of reading it is not, and a rule shipped on the theory alone would have fired on nearly half of this repository's own paragraphs.
