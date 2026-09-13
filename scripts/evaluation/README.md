# Private writing evaluation

This maintainer harness asks whether a candidate instruction set produces more useful workplace writing than the released instructions. A candidate must retain correctness, requested content, protected text, grounding, audience fit, and the reader's next action.

It is deliberately not a public `plain-english` command. It changes no hook. Cases, generated outputs, reviews, and results live under the operating system's user-data directory. The repository contains only the harness, a consent-bound generation runner, two candidate instruction overlays, and synthetic tests.

## Why this comes before more rules

The current product can count observable faults. It cannot prove that a rewrite is better for its reader. Adding more terms or another open-ended judge would optimize what the tool already knows how to see.

The design borrows four tested ideas from GitHub projects:

- [`writing-eval`](https://github.com/majesticlabs-dev/writing-eval) keeps evaluation local, binds profiles to source hashes, and treats small score differences as sampling noise.
- [`WritingBench`](https://github.com/X-PLUG/WritingBench) uses criteria written for each task rather than one generic writing score.
- [`ReviewWrite`](https://github.com/songhai-dg/review-write) puts fact, citation, qualification, and protected-text preservation ahead of fluency.
- [`vale-ai-tells`](https://github.com/tbhb/vale-ai-tells) carries explicit false-positive fixtures, which is the standard the existing deterministic layer should retain.
- [FastChat's pairwise judge](https://github.com/lm-sys/FastChat/blob/main/fastchat/llm_judge/common.py) runs both answer orders and records both verdicts rather than trusting one presentation.
- [OpenAI Evals](https://github.com/openai/evals/blob/main/docs/build-eval.md) recommends human choice labels for model-graded evaluations and versions development and test datasets separately.

The harness adds two protections those examples do not provide together: every preference pair is shown twice with A and B reversed, and a frozen holdout stays unavailable until development review is complete.

## The four systems

Every case is generated four times with one model and one settings hash:

1. `unshaped`: the request without writing instructions;
2. `released`: the generated writing block from `AGENTS.md`;
3. `candidate-a`: a standalone task-contract and genre instruction set;
4. `candidate-b`: a standalone lossless-edit and reader-action instruction set.

The two candidates live in [`candidates/`](candidates/). They are hypotheses, not new product policy. Keeping them standalone prevents a candidate from inheriting a released rule it is trying to replace. A generation task stores the full instruction text and its SHA-256 hash, so later edits cannot be mistaken for the same run.

## Private storage

The default locations are:

| System | Directory |
|---|---|
| macOS | `~/Library/Application Support/plain-english/evaluation` |
| Linux | `$XDG_DATA_HOME/plain-english/evaluation`, or `~/.local/share/plain-english/evaluation` |
| Windows | `%LOCALAPPDATA%\plain-english\evaluation` |

Set `PLAIN_ENGLISH_EVAL_HOME` or pass `--store` to choose another user-data directory. The command refuses any location inside this repository. Files are created with owner-only permissions where the operating system supports them.

Nothing here grants permission to send source prose to a model. `pack` writes provider-neutral generation tasks locally. The maintainer chooses the provider and must apply its own disclosure, retention, and consent rules. The Codex runner must not be used until the data owner explicitly approves the destination model and the kinds of private text being sent.

## Case contract

Import cases as one JSON object per line, a format called JSON Lines (JSONL). Keep one conversation or document under one `group`; the stable 80/20 split assigns that whole group to development or holdout.

```json
{
  "id": "chat-001",
  "group": "conversation-001",
  "source": "chat",
  "genre": "chat",
  "prompt": "Explain the failure and state the next command.",
  "contract": {
    "audience": "A developer who has not seen the build log.",
    "desiredAction": "Run the safe retry command.",
    "required": ["Name the failed check.", "Give the retry command."],
    "protected": ["npm test", "E_SAMPLE"]
  }
}
```

Genres are `chat`, `technical-doc`, `decision`, `status`, `email`, and `repository`. Sources are `chat` and `repository`. The distinction matters: genres describe the reader's task, while sources prevent excerpts from one private conversation or document crossing the holdout boundary.

## Workflow

Create the store and import prepared cases:

```bash
node scripts/evaluate-writing.mjs init
node scripts/evaluate-writing.mjs import cases /path/to/cases.jsonl
```

With explicit permission to read local agent transcripts, collect a stable sample directly. This reads every available supported agent store, removes exact duplicate replies, limits source replies to 40 through 800 words, balances agents and genres, and keeps whole sessions on one side of the split. Transcript text is written only to the private store. Terminal output contains counts.

```bash
node scripts/evaluate-writing.mjs collect transcripts --limit 50 --min-development 40
```

Each transcript case asks the model to revise a real coding-agent reply. The frozen contract requires its result, material caveats, next action, and supported claims to survive. Code, numbers, URLs, email addresses, and paths become protected literals. Nested values are counted once, and decorative transcript separators are excluded.

Do not rewrite a case contract after seeing its outputs. When the extractor itself is wrong, create a clean store with the original split seed and rebuild the same cases there:

```bash
node scripts/evaluate-writing.mjs init --store /private/new-store --split-seed ORIGINAL_SEED
node scripts/evaluate-writing.mjs clone transcript-cases /private/old-store --store /private/new-store
```

Reusing the seed keeps every previously seen group in development. It cannot move one into holdout.

Pack a run. The JSONL file contains shuffled tasks for all four systems:

```bash
node scripts/evaluate-writing.mjs pack august-voice --seed fixed-2026-08
```

Send only `modelInput.instruction` and `modelInput.prompt` to the model. The `reviewOnly.contract` field is hidden evaluation material. Sending it during generation leaks the answer key and invalidates the case.

Generate each task with the same model and decoding settings. Import one output record per task:

```json
{
  "run": "august-voice",
  "caseId": "chat-001",
  "system": "candidate-a",
  "caseHash": "copy from the task",
  "instructionHash": "copy from the task",
  "model": "the exact model identifier",
  "settingsHash": "hash of the complete decoding settings",
  "text": "The generated response"
}
```

```bash
node scripts/evaluate-writing.mjs import outputs /path/to/outputs.jsonl
```

The importer rejects stale cases, stale instructions, duplicate outputs, and a case generated with different models or settings across systems.

After explicit approval for OpenAI and the named model, the private Codex runner can generate and checkpoint the packed tasks:

```bash
node scripts/evaluation/generate-codex.mjs august-voice \
  --model gpt-5.6-terra --reasoning low --jobs 4
```

The runner follows the [Codex CLI non-interactive interface](https://developers.openai.com/codex/cli/reference/). It uses an empty read-only workspace, ignores user configuration, creates no session transcript, captures only the final answer, and stores a hash of every fixed setting. A stopped run resumes by skipping validated outputs already present.

When one candidate changes, reuse outputs whose case and instruction hashes are identical. The next generation call then runs only the changed tasks:

```bash
node scripts/evaluate-writing.mjs pack august-voice-v2 --seed fixed-2026-08-v2
node scripts/evaluate-writing.mjs reuse outputs august-voice august-voice-v2 \
  --systems unshaped,released,candidate-a
node scripts/evaluation/generate-codex.mjs august-voice-v2 \
  --model gpt-5.6-terra --reasoning low --jobs 4
```

Before human review, inspect deterministic preservation and length signals:

```bash
node scripts/evaluate-writing.mjs audit august-voice
```

This audit does not assign correctness. A missing literal is useful triage evidence, while a preserved literal does not prove that the surrounding claim remains correct.

The experimental analysis measures three possible warning signals: repeated three-part lists, paragraphs with the same sentence-length shape, and nearly uniform confidence language. It reports aggregate activation, human-source activation, blinded preference, and every promotion check. These measurements never produce lint findings on their own.

```bash
node scripts/evaluate-writing.mjs analyze august-voice
```

## Correctness review

Preference cannot rescue a wrong answer. Review each output against six fixed gates and every required item from the case:

- `correctness`: factual claims and qualifications remain valid;
- `completeness`: the requested scope is present;
- `preservation`: protected literals are unchanged;
- `grounding`: each factual addition is supported or labeled as an assumption, judgment, or evidence gap, and material qualifications survive;
- `audience`: the intended reader can use the answer;
- `action`: the requested decision or next action is supported.

Each result is `pass`, `fail`, or `uncertain`. Only `pass` advances. The harness does not treat `uncertain` as correct.

Prepare and work through a shuffled correctness queue. The review view hides the instruction system. It includes an exact protected-text check as evidence, not as the review decision.

```bash
node scripts/evaluate-writing.mjs gate prepare august-voice --seed fixed-2026-08
node scripts/evaluate-writing.mjs gate next august-voice
node scripts/evaluate-writing.mjs gate record august-voice REVIEW_ID \
  --reviewer reviewer-1 \
  --correctness pass --completeness pass --preservation pass \
  --grounding pass --audience pass --action pass --requirements pass,pass
```

```json
{
  "run": "august-voice",
  "caseId": "chat-001",
  "system": "candidate-a",
  "reviewer": "reviewer-1",
  "checks": {
    "correctness": "pass",
    "completeness": "pass",
    "preservation": "pass",
    "grounding": "pass",
    "audience": "pass",
    "action": "pass"
  },
  "requirements": ["pass", "pass"],
  "note": "Optional evidence for the gate decision."
}
```

```bash
node scripts/evaluate-writing.mjs import gates /path/to/gates.jsonl
node scripts/evaluate-writing.mjs prepare august-voice --seed fixed-2026-08
```

## Blind preference review

`review next` prints the task contract and outputs A and B. It does not print either system name. Every system pair is scheduled twice with the order reversed.

```bash
node scripts/evaluate-writing.mjs review next august-voice
node scripts/evaluate-writing.mjs review vote august-voice COMPARISON_ID A \
  --reviewer reviewer-1 \
  --reason "A makes the next action explicit without losing the caveat."
```

Choose `A`, `B`, or `tie`. The reason is mandatory. If the reversed presentation selects the other underlying system, the pair becomes an order-sensitive tie rather than a win.

## Holdout discipline

The harness assigns 20% of whole groups to holdout when cases are imported. Holdout tasks cannot be packed, reviewed, or reported until all of these are true on development data:

- at least 40 development cases;
- at least four genres;
- all four outputs exist for every development case;
- every scheduled blind comparison has a vote.

Then unlock once:

```bash
node scripts/evaluate-writing.mjs holdout unlock august-voice
node scripts/evaluate-writing.mjs pack august-voice --split holdout --seed fixed-2026-08
```

Unlocking is recorded in the private manifest. Holdout results must not be used to edit a candidate and then reported as unseen evidence.

## Pre-registered decision rule

```bash
node scripts/evaluate-writing.mjs report august-voice
node scripts/evaluate-writing.mjs report august-voice --split holdout --format json
```

A candidate is ready only when the frozen holdout meets every condition:

- at least 50 private cases in the complete dataset and at least four genres;
- at least 65% wins over the released instructions among decisive pairs;
- the 95% Wilson lower confidence bound is above 50%;
- at least 55% wins in every measured genre, with at least four measured genres;
- at least 90% agreement under reversed A/B order;
- zero protected-text failures;
- zero grounding failures;
- no correctness-gate pass-rate loss against the release.

Ties do not enter the binomial confidence interval. They remain visible in the report. A candidate that wins stylistically after failing more task gates does not pass.

These thresholds were chosen before the first private result. Changing one after seeing holdout data starts a new run with a new name, seed, and candidate hash.

## What this phase does not do

- It does not infer approval from a user's silence.
- It does not commit transcripts or print their contents during collection and generation.
- It does not score voice from sentence length alone.
- It does not call a model judge.
- It does not rewrite files.
- It does not alter deterministic rules, generated instructions, or hooks.

Those remain later decisions. The first benchmark should show whether either candidate improves correctness-gated reader preference and in which genre. If neither does, the right result is to keep the released behavior and revise the hypothesis.

An experimental structure signal needs 50 cases across four genres, at least 20
eligible outputs, and at least 20 outputs where it fires before it can become a warning.
The output without the signal must win more than 70% of correctness-gated comparisons,
with a 95% Wilson lower bound above 50%. The signal may appear in no more than 5% of
eligible human source text. The analysis marks promotion as passed only on the frozen
holdout when every check passes.
