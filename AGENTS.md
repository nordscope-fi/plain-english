# AGENTS.md: plain-english

Host-neutral contract for AI coding agents working in this repository.
Adapter files (`CLAUDE.md`, `VIBE.md`, `.codex/`, `.cursor/`) point back
here rather than duplicating rules.

## What this repository is

`plain-english` is a linter that catches AI-writing tells and unglossed
jargon in prose before it lands in commits, docs, or issues. It ships as
an npm CLI plus adapters for Claude Code, Codex, Copilot, and Cursor.

This repository is **public**. Do not commit anything that references
absolute home-directory paths, machine-specific hostnames, private
services, paths to the local servers an agent uses for extra tools (that
protocol is called MCP), or credential vault URIs. Use relative paths or
environment variables instead. `npm run check:refs`
enforces this against a curated denylist; CI blocks the merge if it
fires.

## Write less, simpler code (loaded first, non-negotiable)

Default to the smallest change that fully solves the request.

- If you wrote 200 lines and 50 would do, rewrite it as 50.
- No features, abstractions, config, or flexibility the user did not ask for.
- No error handling for impossible states.
- No new dependency without asking first. Prefer standard library and installed packages.
- No new files unless strictly required. Inline first, abstract only at 3+ real call sites.
- No refactoring, renaming, or reformatting adjacent to what you were asked to touch.

Read the request as a three-layer prompt:

1. Layer 1: what the user wants (positive scope).
2. Layer 2: what the user does **not** want (negative constraints, which matter **more**).
3. Layer 3: scope limit (which file, which function, and nothing else).

Every changed line must trace to the request. Anything that does not, delete
before submitting.

## Dogfood the linter

This repository ships `plain-english`. Its own prose is a test corpus.

- `.plain-english.yml` at the repo root pins the ruleset so results are
  deterministic across machines and CI.
- `npm run lint:self` runs the linter on the repository's own docs. If
  you edit a doc, run this before opening a PR.
- The Claude Code hook adapter in `src/adapters/` demonstrates the shape
  a host adapter takes; when adding a new adapter, use it as the template.

## Host contract

Tool names differ by host; the meaning is the same. Skills, rules, and
hooks written here name the shared concept.

| Concept | Claude Code | Vibe | Codex |
|---|---|---|---|
| Shell | `Bash` | `bash` | `bash` |
| Read file | `Read` | `read_file` | `read_file` |
| Write/patch | `Write` / `Edit` | `write_file` / `edit` | `apply_patch` |
| Web fetch | `WebFetch` | `web_fetch` | `web_search` |
| Find in files | `Grep` / `Glob` | `grep` | `grep` |

Field names (`command`, `file_path`, `url`, `old_string`, `new_string`)
are compatible across the three hosts. Adapter scripts translate host
events to the same guard scripts so behavior stays consistent.

## Task shape

Classify before you start.

- **Trivial**: under 20 lines, one file, no public API change. Ship directly.
- **Medium**: 3+ files, or touches the linter's rule engine, adapter
  contracts, or the shipped CLI. Requires a short plan before code and a
  changelog entry.
- **Large**: 5+ files, or changes any of: the ruleset schema (`rules/`),
  the adapter contract, the CLI's shipped commands, the on-disk format
  of `.plain-english.yml`, or the CI enforcement layer. Requires an
  approved brief + spec + design before code.

The `write-plans` skill in this repo (added alongside the base rules)
covers Medium and Large tasks. Trivial tasks skip it.

## Foundational areas (cannot be deferred; changes cost 10× to retrofit)

Small diffs in these areas need the Large workflow:

| Area | Why foundational |
|---|---|
| `src/rules.ts` and the JSON ruleset shape | Every consumer's config depends on the schema; a rename breaks their `.plain-english.yml` silently |
| `src/adapters/**` contract | Host adapters ship as vendored code in downstream repos; contract drift breaks them across every user |
| The three settings surfaces (`never`, `ask`, `block`) | Behavior contract; changing what a setting does is a breaking change even if the name stays |
| CLI command names + exit codes | Consumers script against them; treated as a public API |
| `.plain-english.yml` on-disk format | Users hand-edit this; schema drift breaks their files |
| Policy generation (`policy.ts` + `docs/ai-writing-policy.md`) | Human-facing artifact people quote in their own projects |

## Verification (before claiming completion)

```
npm test
```

`pretest` runs `npm run check:refs && npm run build`; `posttest` runs
`npm run probe`. A green `npm test` means: no private references, TypeScript
compiles clean, all unit tests pass, and the probe adapter still works.

Do not claim work is complete without running this.

## Where things live

```
src/                    CLI, linter, adapters, rules
test/                   vitest specs; corpus/ holds the AI-tell test corpus
docs/                   contributor docs (adopting, editors, releasing, agents, policy)
integrations/           downstream integration examples
scripts/                check-refs, changelog, probe-adapter
rules/                  the shipped ruleset
.claude/                Claude Code project config (see CLAUDE.md)
.codex/                 Codex project config (see docs/agents.md)
.vibe/                  Vibe project config (see VIBE.md)
docs/architecture/adr/  Architecture Decision Records (see ADR-001+)
```

## Detailed rules (loaded on-demand)

Domain rules live in `.claude/rules/` and load when the described paths
are touched. They are host-neutral by content; the auto-loading is
Claude-specific but the rules apply to every host.

- `accuracy.md`: anti-hallucination discipline (admit uncertainty, quote
  before analysing, self-verify claims)
- `decision-accountability.md`: falsification gate for deferrals and
  foundational-vs-additive classification
- `right-sizing.md`: counterpart to above; gates over-engineering
- `context7.md`: mandate to fetch current library docs via Context7 MCP
  when working with third-party APIs, rather than relying on training data
- `code-conventions.md`: TypeScript, testing, reuse-before-write

## Never

- Never commit personal paths, credentials, private hosts, or vault URIs.
  `npm run check:refs` enforces this.
- Never break the ruleset schema, adapter contract, CLI names, or
  `.plain-english.yml` format without a Large workflow and a semver-major
  version bump.
- Never `git commit --no-verify`. Pre-commit hooks catch real problems.
- Never mark work complete without a fresh `npm test` in the current
  message.
