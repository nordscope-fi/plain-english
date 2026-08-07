<!-- plain-english-disable-file -->

# Limitations

What this tool gets wrong, and who it gets wrong for. Read this before turning on blocking.

## It checks English only

Every rule is an English word or an English sentence shape. A contributor writing in a second language gets no help from it and carries all of its friction.

## It penalises the register non-native speakers are trained into

This is the sharpest criticism of the whole category, and it is quantified.

Liang, Yuksekgonul, Mao, Wu and Zou tested seven widely used AI-text detectors against 91 TOEFL essays written by non-native English speakers and 88 essays by US eighth-graders ([*Patterns*, 2023](https://arxiv.org/pdf/2304.02819)). The US essays were classified accurately. The TOEFL essays drew a **61.3% average false-positive rate**. All seven detectors unanimously misflagged 19.8% of them, and at least one detector flagged 97.8%.

The mechanism matters: detectors key on restricted lexical diversity and simpler word choice, which is what both non-native writers and language models produce. Enriching the same TOEFL essays with ChatGPT dropped the false-positive rate to 11.6%, so the tools rewarded using the thing they claimed to detect.

This tool is a word-list linter and not a statistical detector, so the numbers do not transfer directly. The exposure is the same in kind. Formal, structured, high-register English is what many non-native professional writers are taught, and it is also what reads as machine-written to these rules.

**What we do about it:** findings are warnings by default, and the run exits 0. Blocking is something a project opts into for itself. If you turn blocking on in a repo with contributors writing in a second language, you have made a decision on their behalf.

## "delve" is somebody's ordinary vocabulary

`delve` is the most-cited AI tell, and it is also ordinary Nigerian business English. The annotation workforce that shaped the current generation of models is substantially Nigerian, which is a leading explanation for why the word turns up so often in model output ([Racism and Technology Center](https://racismandtechnology.center/2024/04/29/racist-technology-in-action-outsourced-labour-in-nigeria-is-shaping-ai-english/), [BusinessDay NG](https://businessday.ng/technology/article/online-uproar-over-nigerian-english-flagged-as-chatgpt-ish/)).

Flagging it means flagging a regional dialect feature. That is worth knowing about the rule you are running.

## The em dash rule

The shipped default blocks every em dash. This is a deliberate choice, and the argument against it is weaker than it first appears.

The case for a rate-based rule instead of a ban runs like this. Some published comparisons put GPT-4.1 at roughly 10.6 em dashes per 1,000 words against a cited human baseline of 3.23, and conclude that the gap is in the density and not the presence. On that reading, a rule that blocks at one has a false-positive rate on genuine human prose.

The problem is the baseline. 3.23 per 1,000 words comes from professionally edited writing: books, journalism, long-form essays, where the em dash is a normal typographic device that copy editors keep and typesetters render properly. That is not the register this tool runs against. In ordinary workplace writing, commit messages, internal docs, tickets and technical documentation, the base rate is near zero. Most people writing that material have never reached for an em dash in their lives, partly because no common keyboard layout has one. A baseline measured on published prose does not describe the population a repository linter sees.

Two further points support the ban in that setting:

- The character usually cannot be typed by accident. Getting a true em dash into a commit message takes a deliberate keystroke sequence, an editor that does smart substitution, or a paste. In a corpus where the human rate is near zero, presence carries most of the signal a rate would.
- A threshold adds a way to miss. Three em dashes in a 500-word internal doc is well under any per-thousand threshold and still reads as machine-written to anyone who knows the register.

The honest caveats, so this is not overstated:

- Wikipedia's editors have walked the signal back in their own talk archive ("that was one model at one particular point in time"), and model vendors now suppress em dashes, so the discriminating power of this rule falls over time even as its false-positive rate stays flat.
- Some people do use em dashes heavily by hand, and this rule will annoy them. Anyone editing published-register prose should switch to the rate-based rule.

**If your writing sits in a register where em dashes are genuinely common**, switch the rules in your config:

```yaml
rules:
  - id: em-dash
    severity: off
  - id: em-dash-density
    severity: warn
```

## A word list is descriptive, not prescriptive

The canonical source for these patterns says so directly:

> The list is descriptive, not prescriptive; it consists of observations, not rules.

> None of these signs prove AI authorship on their own. They're most useful as a combined signal, not a single tripwire.

A tool that fires on a single token match is the single-tripwire application that source warns against. Treat a finding as a prompt to reread the sentence.

## Words with a real technical sense

Several rules match words that are ordinary vocabulary in some field: `leverage` in finance, `mechanical` in engineering, `silently` in systems programming, `holistic` in medicine. Each carries exceptions, and the ones with the widest legitimate use are warnings rather than blocks. Exceptions cannot be exhaustive. If a rule is wrong for your domain, lower it in config and open an issue with the sentence.

## The signal is a moving target

These rules describe how models wrote in 2024 and 2025. Vendors actively suppress known tells, so a rule keyed to a specific tic decays. Expect maintenance.

## What no hook can reach

A chat reply is not a tool call, so none of the linting hooks see it. What reaches chat instead is the output style at `integrations/claude-code/output-styles/plain-english.md`, generated from the same ruleset. Three things are worth knowing about it.

It is a prompt, not a gate. Claude Code appends it to the end of the system prompt and reminds the model of it each turn, which makes it the strongest lever available here, and it is still an instruction that can be ignored. Nothing measures compliance.

It does not apply to subagents. A subagent runs its own system prompt, so any research or exploration agent keeps writing the old way.

One hook does reach chat text, and this document previously claimed none did. `MessageDisplay` fires while a reply renders and can replace what appears on screen through `displayContent`. Two limits make it unsuitable for this ruleset today. It is display-only, so the transcript and the model's own view keep the original text. And it fires per batch of completed lines with a ten second budget, so it can substitute a word and cannot restructure a reply. Its input schema is also currently contested: the docs describe `message_text` and `is_final_chunk`, neither of which appears in the shipped 2.1.224 binary, which uses `delta` and `final`. Anything built on it needs a stdin log first.

## The semantic layer has a false-positive floor

The optional prompt-based layer asks a model to find sentence shapes. Asked to find something, it will find something. While this repository was being written, that layer refused one README twelve times, twice flagging wording it had itself proposed one turn earlier, and once concluding in writing that no violation existed before refusing anyway.

Three mitigations are built into the generated prompts: they state that a clean verdict is the common case, they require the offending substring to be quoted verbatim and the finding dropped when it cannot be located, and they put the scope check first. None of them reduces the floor to zero. Anything catchable deterministically belongs in `rules/default.yml`, where it is testable.
