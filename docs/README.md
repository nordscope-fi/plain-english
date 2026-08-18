# Documentation

Start with the [README](../README.md). These go deeper.

## Using it

| Doc | Read it when |
|---|---|
| [adopting.md](adopting.md) | Putting this in front of a repo that already has writing in it. An eight-step rollout that does not annoy everyone on day one. |
| [agents.md](agents.md) | Wiring up Claude Code, Copilot, Codex or Cursor, or working out why a hook is not firing. Per-agent detail, and which claims were checked against a running binary. |
| [post-edit-lint.md](post-edit-lint.md) | Your agent has no adapter here. Tell it to run the linter after it edits instead. |
| [editors.md](editors.md) | Getting findings into your editor's Problems list, as plain text or as a findings file GitHub can read. |
| [writing-style.md](writing-style.md) | You want the full rule list. Generated from `rules/default.yml`; never edited by hand. |
| [ai-writing-policy.md](ai-writing-policy.md) | An example of what `plain-english policy` writes. This one is this repository's own. |

## Before you turn on blocking

| Doc | Read it when |
|---|---|
| [limitations.md](limitations.md) | Always, before setting `failOn: error`. What this gets wrong, who it gets wrong for, what reaches a chat reply, and why the signal decays. |

## Working on it

| Doc | Read it when |
|---|---|
| [design-rationale.md](design-rationale.md) | You are adapting the idea, or want the reasoning behind the shape. |
| [architecture/adr/](architecture/adr/README.md) | You want one decision, its status, the alternatives that lost, and what would make it worth revisiting. |
| [verifying-an-adapter.md](verifying-an-adapter.md) | Adding a fifth agent, or checking an existing one against a live binary. Read it first: four adapters were written from vendor documentation and four defects were later found in them. |
| [releasing.md](releasing.md) | Maintainers, cutting a release. |

Contributor rules live in [`AGENTS.md`](../AGENTS.md) at the repository root, with
per-host notes in [`CLAUDE.md`](../CLAUDE.md) and [`VIBE.md`](../VIBE.md).
