---
description: Anti-hallucination rules. Auto-loads on any file edit.
globs: "**/*"
---

# Accuracy & Anti-Hallucination Rules (Mandatory)

## Rule 1: Admit uncertainty, never guess

If you are not sure about something, say so instead of guessing:

- API signatures, hook shapes, third-party library behavior → verify with a
  live docs lookup (see `context7.md`), not from training memory
- Whether a helper, module, or pattern already exists in this codebase →
  verify with grep/read, not from assumption
- User intent or requirements → ask, do not infer

The phrase "I do not have enough information to answer this confidently"
is always acceptable.

## Rule 2: Quote before analysing

When analysing documents longer than ~500 lines (specs, briefs, policies):

1. Extract the relevant quotes verbatim first
2. Reference those quotes in your analysis
3. If you cannot find a quote for a claim, state "no supporting text found"

## Rule 3: Restrict claims to observable evidence

When making claims about:

- **This project's behavior** → only claim what the code actually does
- **Library APIs** → only claim what current docs confirm
- **User requirements** → only claim what the user actually stated

Do not fill gaps with general knowledge. Flag the gap explicitly.

## Rule 4: Self-verify and retract

After drafting any user-facing claim, ADR, or CHANGELOG entry:

- Confirm each claim has a supporting source (code, doc, tool output)
- If a claim has no source, retract it or mark it `[unverified — needs confirmation]`

This matters most for the shipped ruleset schema, the adapter contract,
the CLI's public API, and the on-disk `.plain-english.yml` format —
consumers script against those and a wrong claim about them is a broken
integration downstream.
