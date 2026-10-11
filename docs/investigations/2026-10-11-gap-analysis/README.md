# Gap analysis and UX review, October 2026

This page is for anyone running or reading the 2026-10-11 review of plain-english
against its alternatives. By the end you will know what was measured, on what
material, and how a claim in any strand report earned its place. The ranked result
lives in `findings.md` next to this file once the strands have reported.

The review answers one question. Where does this tool lose to an alternative, or
lose a new user, when its job is to stop a coding agent writing badly on every
surface the agent writes through?

## What "best" means, as five numbers

Every strand reports against these. A gap is a measured shortfall on one of them,
with a cause named.

| # | Measure | How it is counted |
|---|---|---|
| 1 | Findings the human sees | Per hundred agent writes, by surface and setting. The ideal is zero: draft, check, rewrite, pass, with no human action. |
| 2 | Rewrite quality | Whether the agent fixed the sentence or swapped a synonym that keeps the shape, and how many check rounds it took to come out clean. |
| 3 | False positives on good human writing | Findings per thousand words on set B, including the non-native professional English subset. |
| 4 | Misses on real tells | Labelled tells in set A that no rule fired on, by kind: word, punctuation, sentence shape, document shape. |
| 5 | Cost of presence | Added latency per write, minutes from install to first finding, and the amount of text an agent must read to comply. |

## The corpus every strand shares

Built once, in the scratch directory, before the measuring strands start. Four sets,
each file paired with a label file of the same name and a `.labels.json` suffix.

| Set | Contents | Labels |
|---|---|---|
| A | Agent drafts with tells: this repo's test corpus, prose agents wrote in the past 14 days of local sessions, and fresh drafts asked of an agent with no checker installed | Each tell as a span with its kind (word, punctuation, sentence shape, document shape) and the rule expected to catch it, or `none` when no rule exists |
| B | Good human prose written before 2022: reference documentation, standards text, and a subset from projects whose authors write English as a second language | Asserted clean; any finding is a false positive unless a reviewer agrees it is a genuine fault |
| C | This repository's own docs and its last 200 commit messages | None; the measure is the raw finding rate, read with the knowledge that the tool's own authors wrote them |
| D | Gamed rewrites: set A passages rewritten by an agent told to do the least that satisfies the rule | Each passage marked as a gamed fix; a rule that passes it has been gamed |

Set B is the one that needs care. Text written after 2022 may itself be
machine-assisted, and a corpus of native English only would hide the false-positive
rate that the limitations page already warns about.

## The hypotheses under test

1. **One setting serves two populations.** A hook on an agent's write knows an
   agent wrote the text, so block-and-rewrite can be the default there, and asking
   the human is friction left over from treating agents and people as one
   population. Measure 1 by surface and setting tests this.
2. **For chat, rewriting beats bouncing.** When a reply fails the check, the tool
   could rewrite it through the host model instead of returning the finding to
   the agent for another round. Measures 1, 2 and 5 on the chat surface test this.
3. **Rules are gameable.** Set D tests whether a synonym swap satisfies the rules.
4. **The misses are in shape, not words.** Set A's `none` labels show which kinds
   of tell no rule reaches.

## The strands and who runs them

| Strand | Produces | Depends on |
|---|---|---|
| History | Every finding this tool raised in every agent's local sessions over 14 days, with counts, categories, and how the person reacted | Nothing |
| Corpus | Sets A to D with labels | Nothing |
| Newcomer | Install-to-first-finding on each surface, every confusing message logged | Nothing |
| Positioning | Front page against rivals' front pages; what people complain about in rivals' issue trackers and forums; prose plugins already listed in agent directories | Nothing |
| Rivals | Each alternative run on the corpus, with measures 3, 4 and 5, and whether an agent could act on its output | Corpus |
| Rules | Every rule's message as the agent receives it; measures 2, 3 and 4 on the corpus | Corpus |
| Live loop | Agent drafts under the checker on the chat and write surfaces; measures 1, 2 and 5 | Corpus |
| Synthesis | `findings.md`: ranked gaps, each with its evidence line, split into now and later | All |

## How a claim earns its place

Every claim in a strand report carries one of three tags, and synthesis ranks them
in this order:

- `ran-it`: the author ran the command and quotes its output.
- `read-docs`: the author read the vendor's page or source and quotes it.
- `inferred`: the author reasoned from the two above. Say from what.

A vendor page is a claim about the tool, and the review has found such pages wrong
before. When a page and a run disagree, the disagreement is the finding.

Nothing in this repository changes during the review except this folder. Every
install goes into the scratch directory. A strand that needs to read private
material (session transcripts) reports counts and anonymised examples only.

## The report template

Each strand writes one markdown file in the scratch directory with these sections,
in this order, so synthesis can read seven reports the same way:

1. **What was run**, as commands, with versions.
2. **Numbers against the five measures**, only those the strand covers.
3. **Gaps found**, one per heading: the shortfall, the evidence line with its tag,
   the probable cause, and which hypothesis it bears on if any.
4. **What the strand could not establish**, and why.
