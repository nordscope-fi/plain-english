# CLAUDE.md: plain-english (Claude Code adapter)

@AGENTS.md

## Claude Code interpretation

- Project skills use the legacy slash form (`/pe-tdd`, `/pe-verify`,
  `/pe-ship`). They live under `.claude/skills/<name>/SKILL.md`.
- Path-scoped rules under `.claude/rules/` auto-load from their
  frontmatter globs.
- Lifecycle hooks and permissions live in `.claude/settings.json`
  (committed, project-wide) and `.claude/settings.local.json`
  (per-operator, not committed).
- The `reuse-guard.sh` hook runs before a tool call, on the event called
  `PreToolUse`. It fires once per new file created under `src/` in a
  session and reminds you to check for an existing helper first. Fail-open; escape with `PE_REUSE_GUARD_MODE=observe`.

## Public-repo constraint

This project is public. Nothing in `.claude/settings.json` may reference
personal paths, credential vaults, or private hosts. If you need a
personal tool server or hook path, put it in `.claude/settings.local.json`
(gitignored) or in your user-global `~/.claude/settings.json`, never in
the committed file.

## Model + effort

`.claude/settings.json` does not pin a model. Contributors on different
Claude tiers can all work here. The default your account
provides is fine. Escalate manually with `/effort high` for the
foundational areas listed in `AGENTS.md`.
