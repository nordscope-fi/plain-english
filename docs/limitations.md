<!-- plain-english-disable-file: quotes the register this tool flags, at length -->

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

## What reaches chat, and what it costs

This section used to say that a chat reply is not a tool call, so no hook sees one. That was true when it was written and it is no longer true for three of the four agents. What reaches chat is now three things with different strengths, and it is worth being precise about which is which.

**An output style** shapes the reply before it exists. Claude Code appends it to the system prompt and restates it each turn, which makes it the strongest lever on wording and still an instruction that can be ignored. Three levels ship, at `integrations/claude-code/output-styles/`, and `plain-english init` installs all three and selects one. Everywhere else the same guidance arrives through the `AGENTS.md` section, which is loaded once at session start rather than restated per turn, and is weaker again.

Two mechanics catch people out. A style is part of the system prompt, which Claude Code reads once at session start, so installing one changes nothing until `/clear` or a new session. And project styles load from every `.claude/output-styles/` between the working directory and the repository root, with the one closest to the working directory winning, which decides behaviour in a monorepo.

A style reaches the main conversation and a **fork**, which inherits the parent's full system prompt. It does not reach a **subagent**, which runs its own. This document previously said only the second half.

**A stop hook** reads the finished reply and can hand a finding back to the model, which then writes again. That is weaker than a refused write, since the words already exist, and much stronger than a prompt, since something measures them. `plain-english init` installs it on the events below. Under the default `failOn: never` it reports and holds up nothing; `failOn: error` makes a finding block the turn.

| Agent | Event carrying the reply | Main loop | Subagents |
|---|---|---|---|
| Claude Code | `Stop`, `SubagentStop` (`last_assistant_message`) | yes | yes |
| Codex | `Stop`, `SubagentStop` (`last_assistant_message`, documented as "if available") | yes | yes |
| GitHub Copilot | `SubagentStop` only (`response`); `Stop` documents that it does not carry the text | from the session store | yes |
| Cursor | documents `stop` and `afterAgentResponse`; its CLI is reported to dispatch neither | **no** | **no** |

Every row there is `docs` tier by the ranking in [`verifying-an-adapter.md`](verifying-an-adapter.md), which is the weakest evidence this project accepts. Treat the table as what the vendors say, not as what was watched happening.

Blocking a reply can loop: the model rewrites, the rewrite trips another rule, and it blocks again. Three guards stop that. `stop_hook_active`, which Claude Code and Copilot both document and which says the current turn already exists because a hook blocked the last one. A once-per-turn state file beside the ack file, keyed on the prompt id and expiring on the same ten-minute clock. And `.plain-english-ack-chat`, which waives the channel like any other.

**`plain-english lint --chat`** reads what was already said. Every agent writes its sessions to local disk, so this is the one thing here that measures rather than instructs, and the number it produces is the reason the stop hook exists at all. It splits findings by main loop against subagent, because an output style never reaches a subagent and a single number across both hides exactly the gap worth knowing about.

It is local only, and that is not squeamishness. A transcript holds whatever passed through a tool: file contents, command output, pasted text, and, per Claude Code's own documentation, a credential that an environment file or a command happened to print. Copilot's documentation adds that its sessions sync to the user's GitHub account by default. Nothing here belongs in CI, and the GitHub Action takes no `--chat` input. How far back a scan can see is bounded by each agent's own retention, which for Claude Code is the `cleanupPeriodDays` setting.

### `MessageDisplay` is not the answer, for different reasons than before

An earlier version of this document said Claude Code's `MessageDisplay` hook could replace on-screen text through `displayContent`, and that the shipped binary used `delta` and `final` against a documented `message_text` and `is_final_chunk`. The current documentation says none of that. The event is display-only, hook output does not modify the displayed text, blocking with exit 2 has no effect, its fields are `role`, `content` and `is_partial`, and its timeout is ten seconds rather than the usual default.

So the conclusion survives and the reasoning does not: it is a monitoring event, and a monitoring event that fires per streamed chunk is a worse place to judge a reply than a stop event that fires once with the whole thing.

## What each agent cannot reach

The deterministic rules run identically everywhere. The rest does not.

The semantic layer, which judges the nine sentence shapes a regex cannot, rides on a prompt hook. Claude Code has one. Copilot documents an equivalent this package does not yet use. Codex and Cursor have none, so on those two the sentence shapes are covered by the prompt in `AGENTS.md` and by nothing that runs.

Chat is covered on three of the four, per the table above. Cursor is the exception, and the word for that is ungated: `lint --chat` reports what it said afterwards and gates nothing.

Two vendor behaviours are worth knowing before you rely on a refusal. Copilot's cloud coding agent treats `ask` as `deny`, so the advisory default is blocking there. And Codex needs two separate approvals before it runs a hook at all, one for the folder and one for the hook itself; [`agents.md`](agents.md#openai-codex-cli) says what each does and how to grant them. That file also records which claims here were verified against a running agent and which were taken from a vendor's documentation.

## The semantic layer has a false-positive floor

The optional prompt-based layer asks a model to find sentence shapes. Asked to find something, it will find something. While this repository was being written, that layer refused one README twelve times, twice flagging wording it had itself proposed one turn earlier, and once concluding in writing that no violation existed before refusing anyway.

Three mitigations are built into the generated prompts: they state that a clean verdict is the common case, they require the offending substring to be quoted verbatim and the finding dropped when it cannot be located, and they put the scope check first. None of them reduces the floor to zero. Anything catchable deterministically belongs in `rules/default.yml`, where it is testable.
