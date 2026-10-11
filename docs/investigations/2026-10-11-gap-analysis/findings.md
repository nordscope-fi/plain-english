# Findings: where plain-english loses, and what the evidence says to do first

This page is for the maintainer deciding what to build next. By the end you will have
the five measures filled in, a verdict on each of the four hypotheses, and a ranked list
of gaps, each tied to the line of evidence it rests on. The method and the corpus are in
`README.md` beside this file. The seven strand reports (history, corpus, newcomer,
positioning, rivals, rules, liveloop) and the corpus stayed in the session's scratch
directory under `gap/reports/` and `gap/corpus/`. Two of them derive from the owner's
private session transcripts and name private projects, so they need the owner's review
before any copy enters this public repository. Every number below was produced
by running something on 2026-10-11 unless it is tagged `read-docs` or `inferred`.

The question was: where does this tool lose to an alternative, or lose a new user, when
its job is to stop a coding agent writing badly on every surface the agent writes
through?

## The short answer

The tool wins on precision and loses on reach. On 34,766 words of good human
documentation it raised 0.26 blocking findings per thousand words; every rival measured
raised more at its lowest setting, and the Google style pack for Vale raised 91.5. But
the tells it catches are words and punctuation (96% and 100% of labelled cases). The
tells that remain in agent prose today are shapes, and it caught 0% of document-shape
labels and 19% of sentence-shape labels. A synonym swap defeats 26 of 30 word rules.

Two costs were larger than any gap in the ruleset. First, in twelve days of the owner's
own sessions the chat hook started 6,659 model-judge runs, about eleven hours of wall
time, and the judge's own replies were policed by the hook they serve. Second, on Claude
Code the plugin's presence multiplied the time of a natural write by 2.3 to 2.7, with the
hook never firing. The agent ran the linter itself because a skill told it to, then
explained the linter to the person.

On natural tasks, no run on any arm produced a blocking finding in a landed file. The
current frontier models avoid the classic word tells on their own, helped by their own
harness instructions. What they still produce is unexplained acronyms, long sentences,
bold-lead bullets, lists of three, closing offer questions, and, on Codex, em dashes.

## The scorecard

| # | Measure | Result | Source |
|---|---|---|---|
| 1 | Findings the human sees, per hundred agent writes | Real sessions: 0.16 to 0.88 chat holds per 100 replies, 0 to 2 per 100 Markdown writes, 0 to 1.8 per 100 GitHub commands. The human plausibly saw 12 to 25 of 101 finding chains, and only the 2 ask dialogs for certain. Live runs: 0 blocking findings in 48 natural writes and replies across four arms; the hook fired once in 24 chat runs. | history §2, liveloop §2 |
| 2 | Rewrite quality and rounds | Real sessions: 90 of 101 chains clean after one rewrite, 11 took two, none three. Six of the eleven were a length rule failing twice. Gaming: 26 of 30 synonym-swap rewrites pass the rule they dodge; 23 of 30 pass everything. | history §2, corpus §2, rules §2 |
| 3 | False positives on good human writing | 0.26 blocking per 1,000 words, all 9 in the non-native subset (0.63 there, 0.00 native). Warnings 6.5 per 1,000, of which two readability rules are 178 of 225. Of 72 unexplained-term findings, about 6 were genuine. | rules §2, rivals §2 |
| 4 | Misses on real tells | Word 96%, punctuation 100%, sentence-shape 19%, document-shape 0%. 78 of 89 misses expect a shape check that exists only in the model-backed layer, which the CLI cannot run and which reports one flag per write. 47 labelled tells have no rule at all. | rules §2, corpus §2, rivals §2 |
| 5 | Cost of presence | Lint of a 1,595-word file: 0.19 s direct, 0.36 s via npx; 3x Vale's Google pack on a single file. Install from tarball: 2 s. Agent setup writes a 1,098-word `AGENTS.md`. Claude Code write with the plugin: 76 s and 9.3 turns against 29 s and 4.5 without. Judge runs: median 6.0 s each, 6,659 in twelve days. | newcomer §2, rivals §2, liveloop §2, history §2 |

## The four hypotheses, judged

**1. One setting serves two populations.** Supported, with a correction. The chat
surface already blocks and rewrites by default, and in 101 real chains nobody objected,
used an escape hatch, or mentioned the finding. On Markdown writes the default is to ask
the human, and that dialog has nowhere to go under `claude -p` or in auto mode, so the
write is refused and the agent receives the full reason. The correction: removing the
human-facing options from the agent's text did not produce rewrites. On a dictated
paragraph the agent still handed back a menu in one of two runs, and in the other it
edited the project config itself and wrote the tells. The line "the human's call, not
yours" is doing protective work. What the human sees is not the options text; it is the
agent's narration and, in interactive sessions, the dialog.

**2. For chat, rewriting beats bouncing.** Supported for span rules, refuted for
length. A direct rewrite of the flagged spans fixed em dashes in one round at half the
time and a third of the cost of bouncing the finding back. Neither method moved a tell
into a code span or blockquote. A direct rewrite cannot act on a length rule, and the
bounce on length made replies longer (226 to 275 to 327 words in one probe) because the
judge's prose reason replaces the word count.

**3. Rules are gameable.** Supported. 26 of 30 rewrites that swapped one word for a
synonym and kept the sentence pass the rule they were written against. Only four rules
whose patterns enumerate synonyms resisted. No rival does better in substance.

**4. The misses are in shape, not words.** Supported. 118 of 131 hand-added labels are
sentence or document shape. The single largest class, bold-lead bullets and bold
pseudo-headings, has 46 labels, appears in all 22 session passages and 15 of 30 fresh
drafts, and matches a regular pattern. No rival has a rule for any of it either.

## Ranked gaps: now

Ranked by effect on the five measures, weighted by how strong the evidence is. Each
gap names the shortfall, the evidence line, the probable cause, and a direction. A
direction is a candidate for the owner's decision, not a plan.

### 1. The chat hook's model judge costs hours and polices itself

Shortfall: measure 5. 6,659 judge sessions in twelve days, median 6.0 s, about 11 hours
of wall time; 5,143 of them in one project. 33 judge sessions were themselves held by
the project's Stop hook with an empty finding list:

```
"Stop hook feedback:\nThis reply contains writing that reads as machine-generated:\n\n\n\nRewrite the quoted text..."
```

and `lint --chat` counted the judge's JSON answers as agent speech: 6,538 of 10,599 Claude
Code replies in the window, 423 findings raised on JSON. (history gaps 1, 2, 6; `ran-it`)

Cause: the judge runs as `claude -p` in the project directory, so the project's own
hooks load inside it; `isJudge()` guards the model check but not the settings-level
Stop hook (`src/cli.ts:872`, `read-docs`); the chat reader has no judge filter
(`src/chat/claude-code.ts`, `ran-it` grep).

Direction: the judge session must carry a marker every hook and the chat reader
recognise, or run with hooks off. Then measure the plugin's host-model route (ADR-006)
against `claude -p` on the same replies. The plugin README says that route already avoids
the second process.

### 2. Shape tells go uncaught, and the one layer that could catch them reports one flag per write

Shortfall: measure 4. 0 of 49 document-shape and 8 of 42 sentence-shape labels caught;
78 of 89 misses expect a structure id that exists only in the model-backed layer. When
that layer was run on ten files with unlabelled shape tells it refused 3 and passed 7,
including every list of three, every bold pseudo-heading, and the horizontal rules. Its
prompt's rule allows one flag per write. (rules §2 and job 4, corpus §3, rivals §2;
`ran-it`)

Cause: the deterministic layer is word and punctuation patterns; shape was assigned to
the model, and the model is asked for one finding.

Direction: a deterministic rule for the regular shapes first. Bold-lead bullets match
`^\s*[-*\d.]+\s*\*\*[^*]+[:.]\*\*` (corpus §3, `inferred` from the labels). Then let the
judge return every shape it sees, and expose the model checks to `lint` behind a flag so
they can be measured on a corpus. This is the ruleset schema, a foundational area, so it
takes the Large workflow.

### 3. A synonym swap satisfies the word rules

Shortfall: measures 2 and 4. 26 of 30 gamed rewrites pass the original rule: `delve` to
`look into`, `game-changer` to `big improvement`, `pivotal moment` to `defining moment`,
`Leverage` to `Harness`. 15 of the 30 kept the exact sentence shape. (corpus §2, rules
§2, rivals §2; `ran-it`)

Cause: each word rule matches one surface form. The four that resisted enumerate
synonyms in the pattern.

Direction: the public record agrees with the corpus. Rivals that started as word lists
now lead with structure, and word lists age in months (one forum thread names a new
"biggest tell of Q3 2026"). Demote word rules that a swap defeats, or widen them to
classes, and move the error budget toward shape and jargon. Changing severities is a
ruleset change, so it is the same Large workflow as gap 2.

### 4. The plugin makes Claude Code slower without the hook ever firing

Shortfall: measure 5. Natural writes: 76.2 s, 9.3 turns, $0.61 with the plugin against
28.7 s, 4.5 turns, $0.45 without; chat 21.7 s against 11.6 s. The hook fired zero times
in 24 writes. In 11 of 12 plugin writes the agent ran `npx plain-english lint` itself,
22 commands in all, one of them a network fetch. The reply then explained the linter to
the person in 12 of 69 sentences, against 3 of 51 without the plugin. (liveloop gaps 2
and 3, newcomer §3.5; `ran-it`)

Cause: the plugin's `writing-a-document` skill says to run the linter after writing, while
its `plain-english` skill says not to in Claude Code; the two disagree and the agent
follows the first. Nothing tells the agent to keep the check out of its reply.

Direction: one instruction. The hook checks the write; the skill should say so and say
nothing about running the command. Add a line that the check is not something to report
to the person unless it changed the outcome.

### 5. The default on a Markdown write is a question nobody can answer

Shortfall: measure 1 and hypothesis 1. With no project config the plugin asks before an
advisory write. Under `claude -p` and in auto mode the question is refused and the agent
receives "The user was asked and refused this write." plus the full reason. With the
settings-hook install from `init`, the same default is a no-op: the file landed with 11
blocking findings and nobody saw a finding. The same `failOn: never` produced three
behaviours across agents: Qwen wrote the tells and called the checker "a reviewer, not a
gate", Copilot wrote them and then edited them out, Claude Code asked. (newcomer §3.2,
liveloop gap 5, rules gap 8; `ran-it`)

Meanwhile the chat surface blocks by default, and 101 real chains drew zero objections.
The README's first screen shows a refusal and a revision, and a fresh reader concluded
"the Claude Code plugin does this automatically". The sentence that says blocking was
switched on for the recording sits below the fold. (positioning gap 1; `ran-it` for the
reader, `read-docs` for the README)

Direction: for an agent's write, refuse and let the agent rewrite, as chat already does.
Keep the human-facing options in the dialog and the docs. Keep the "human's call, not
yours" line, which stopped the agent from editing the config. Keep the CLI advisory for
humans. This changes the meaning of the three settings, a foundational area.

### 6. The agent-facing reason carries text meant for the human, and the wrong remedies for the surface

Shortfall: measures 2 and 5. On the chat surface 121 of 137 real reasons offered
`<!-- plain-english-disable-next-line <rule> -->` as the first remedy, a Markdown-file
device, and one Codex reply shipped that comment to the person inside a table. On Codex
the comment arrives HTML-escaped. On Qwen, Cursor, Vibe and Copilot the reason is injected
as a user message with no self-identifying first line; a Qwen subagent wrote "The user is
flagging that my previous reply violated the plain-english rules". Every reason cites
`docs/writing-style.md`, which does not exist in a user's project. (history gaps 3 and 4,
liveloop gap 11; `ran-it`)

Cause: one `formatReason` in `src/adapters/hook.ts` serves every surface and both
readers (`read-docs`). The installed hooks in two projects were older than the source
during the window, so part of this is already fixed in the repo and not yet in the
field.

Direction: the first line names the source ("plain-english chat check:"), remedies are
chosen per channel, and the ruleset link points at a published address or the installed
package.

### 7. The length rule is the one rewrites fail, and the judge drops the number

Shortfall: measure 2. Six of eleven two-round chains were `reply-length` twice, with the
second run advisory, so the long reply went out. The deterministic message carries the
count ("312 words of prose, over 225") but on the judge path the model's prose reason
replaces it, and bounced rewrites grew. The judge's length verdict is not deterministic:
it passed 290 and 339 words elsewhere. The once-per-turn rule let a still-failing reply
through in two of six chat runs. (history gap 5, liveloop gaps 8 and 9; `ran-it`)

Direction: a numeric rule keeps its number on every path and states the size of the
cut. A length finding is the one case where a direct rewrite cannot help, so the bounce
needs the target.

### 8. The unexplained-term rule is the most frequent finding and mostly wrong on good prose

Shortfall: measure 3. It is the top finding in 1.02M words of real agent replies (2.26
per 1,000) and the one tell the frontier models still produce (`SARIF`, `DevOps` in live
runs). On good documentation 6 of 72 findings were terms a reader would not know. 15 were
garbage spans from an offset bug and 17 were shouted man-page headings. The rest were
SQL keywords (14), product names (10) and class names (7). `**RDB** (Redis Database)` was
not seen as explained because the bold closes before the bracket. (rules §2 and §3; `ran-it`)

Direction: fix the offset drift (gap 9), exempt headings and code-like tokens, accept a
bold-wrapped term, and ship a small list of acronyms nobody explains (API, HTTP, JSON).

### 9. Five reproducible bugs

All `ran-it` with probes in `reports/rules.md`:

1. Finding offsets drift on paragraphs with indented continuation lines; a four-line probe
   reports `an ` and ` ter` instead of the acronym. Flush-left, the same text is right.
2. `lint --show-suppressed` on a single file reports clean and drops every finding; with
   two files the first vanishes.
3. `allow` entries reject a `reason` key while in-file waivers must carry one, so the
   project-wide waiver is the one that cannot be reviewed.
4. `unexplained-suppression` fires on a directive quoted inside a code span.
5. `reader-load` quoted a JSON object as the flagged text in ten judge sessions.

Also recorded: `...and N more` truncation hid findings in 7 long-reply chains, and the
`init` launcher fell back to a stale global 1.7.0 without saying so. A settings Stop
block does hold a turn under `claude -p` on 2.1.296, contrary to the comment in
`register.ts`.

## Ranked gaps: later

Each of these is real and measured. They rank below the list above because they bear on
adoption or on one surface rather than on the loop itself. A line says why not now.

### 10. The first screen promises what the default does not do, names no rival, and shows no number

A fresh reader of the top 40 lines concluded the plugin refuses automatically; the
default asks. `grep -iE "vale|harper|proselint|humanizer"` over the README returns
nothing. Meanwhile Vale ships an official Claude Code plugin with an edit-time hook and
five skills, and its front page says "Setting up with an agent? Open in Claude". A
55,445-star rewrite skill installs on 77 agents with one command. Rivals put a measured number on the
first screen; this README has one anecdote. The README pins `@v1.15.1` while the registry
is at 1.17.5. (positioning gaps 1, 2, 4; newcomer §3.9; `ran-it`, `read-docs`)

Why not now: the numbers to put on the first screen come from this review and from gaps
2 to 5; write the page after the default changes, not before.

### 11. Nobody can find it where agent users look

The official marketplace lists 315 plugins and none for prose, writing, grammar or slop;
plain-english is not among them. Nor is it in the registry of tool servers agents connect
to over the Model Context Protocol (MCP), which lists about 25 prose servers, nor on
Smithery (11). The directory submission is pending (issue 77). (positioning gap 3;
`ran-it`)

Why not now: the submission is already open; what remains is a skills.sh and registry
listing, which should follow the default change too.

### 12. Four surfaces do not close the loop the way Claude Code and Codex do

Copilot's chat hook appends a rewrite after the original has already printed, so the
person reads both. Vibe's chat reply kept the tells with a note "Since you asked for them,
I kept them". Qwen on advisory wrote the tells and on block mode spent 235 s to refuse
once and ask. Gemini CLI refuses individual accounts with a migration notice and is still
a listed surface; the history strand found 0 Gemini sessions and 68 Antigravity sessions.
(newcomer §2 and §3.4, §3.8; `ran-it`)

Why not now: each is a per-adapter fix behind the shared reason change in gap 6, and the
Gemini row is a one-line docs change that can ride along with gap 10.

### 13. A mention is treated as a use, and a blockquote hides a use

A reply that quoted the four blocked words in quotation marks was flagged four times; a
reply that put the paragraph in a `>` block passed with `seamless` in it. Two set A seeds
were quoted mentions. (newcomer §3.3, corpus §3; `ran-it`)

Why not now: it touches the scanner's masking, which is shared by every rule; do it with
gap 2's ruleset work rather than as a patch.

### 14. The single-file latency is Node start-up

0.17 s per write against 0.05 s for Vale's Google pack; `user` time 0.20 s on a 397-word
file says the cost is start-up and rule loading, not matching. (rivals §2; `ran-it`)

Why not now: 0.17 s is under any human threshold on a hook; it matters only if the hook
is called many times per turn, which gap 4 reduces.

### 15. The non-native cost is measurable and confined to three rules

All 9 blocking findings on good prose fell in the non-native subset. They were 4 em
dashes in a definition list, 3 `Moreover` in the Lua manual, and 2 `utilizes` in the
documentation of a database product (named in `reports/rules.md`). The rule that asks for
a term to be explained also flagged that product's name in this sentence until the name
was removed, which is gap 8 in one line. The warning
rate was 6.2 against 7.1 for native text, so the readability rules do not discriminate;
the word rules do. (rules §2, corpus §3; `ran-it`)

Why not now: it is the same decision as gap 3 (what the word rules are for), with the
limitations page already making the argument.

## What people say on Reddit and in Cursor's directory

Added after the first draft. Reddit thread bodies were unreachable by four routes: the
scraping service calls the site unsupported, the Reddit tool and the public JSON endpoint
return 403, and the browser extension refuses the domain. Every Reddit line below is
therefore a web-search snippet attributed to its thread, tagged `read-docs (snippet)`. The
Cursor directory was read in full (`ran-it`).

- **Prompt-only em dash bans fail**, which is the case for a hook over a prompt. "I created
  a No Em Dash skill, have it inside my Preferences and memories and Claude still uses it
  wrong" (Reddit's claudexplorers forum). "Claude reads your rule, finds em-dash blocked,
  and reaches for what looks 'like' an em-dash to keep the prose rhythm" (Reddit's Claude
  AI forum). The second quote is the case for the existing en-dash rule.
- **Writers contest the em dash as a tell.** Two threads on the Claude AI forum: "the
  em-dash is a perfectly fine punctuation mark used in professional writing" and "do not
  surrender the em dash to the bots". Same false-positive cost the forum quotes in the
  positioning report raised; bears on gaps 3 and 15.
- **Agent-written pull request text is a known irritant**: "Does anyone else despise AI
  generated PR descriptions?" (the careers forum); "we actually have our agents write
  detailed PR descriptions now" (the Claude Code forum). Demand exists on the GitHub
  channel.
- **The rival category on Reddit is rewrite skills.** Their named failures are flattened
  voice and damaged output: "I got tired of the humanizer skill making everyone sound
  identical" and "it just screwed with the output" (the Claude skills forum). One rival
  leads with a number on its first line ("67 to 3"), as the positioning report found
  elsewhere.
- **Cursor's directory lists 103 plugins and no prose linter.** The two writing entries are
  a house-style skill pack (`technical-writer`, 11 skills) and a wrapper around text
  detection services (`AI Humanizer`), both showing 0 stars. The slot gap 11 describes is
  open there too.

The ranking does not change. The addendum with every snippet and URL is
`reports/positioning-addendum.txt` in the scratch directory.

## Decisions only the owner can make

1. **Agent writes: refuse-and-rewrite by default, or keep the question?** The chat
   surface has run that way for 101 real chains with no objection. The cost is that a
   project with no config starts refusing writes that today it asks about, and the README
   must say so on the first screen.
2. **Word rules: keep as errors, demote to warnings, or widen to classes?** They are what
   a synonym swap defeats and what the public backlash is about, and they are also the
   one place the tool is quieter than every rival. Demoting them lowers measure 3 further
   and makes the tool's name harder to justify.
3. **Judge route: keep `claude -p`, or require the host-model route?** Eleven hours in
   twelve days is the current price; the plugin README says the host route avoids the
   second process, and this review did not measure it.
4. **Direct rewrite for span rules?** Half the time and a third of the cost in the probe,
   with no gaming seen. It changes what the person receives from "the agent's second
   draft" to "the agent's draft with spans replaced", which is a different promise.
5. **Gemini CLI: drop the surface or document it as retired?**

## What this review could not establish

- Whether an interactive human session sees the "Prose check" dialog in a way that
  changes any of the above; all live runs were non-interactive.
- The host-model judge route's cost and verdicts, against `claude -p`.
- Antigravity live behaviour; its only non-interactive mode skips every permission
  prompt and was not run.
- What the person thought of any rewrite: 80 of 83 next messages ignored the finding, so
  satisfaction is unmeasured, not high.
- Set B judgments are one reader's; the corpus labels are one labeller's.
- Reddit thread bodies, by any route; only search snippets were read. Cursor's directory
  was read in full.
