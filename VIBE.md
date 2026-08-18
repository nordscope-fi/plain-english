# VIBE.md: plain-english (Mistral Vibe adapter)

@AGENTS.md

## Mistral Vibe interpretation

- Vibe uses the same slash form for project skills as Claude Code
  (`/pe-tdd`, `/pe-verify`, `/pe-ship`).
- Vibe has no path-scoped rule auto-loading. Domain rules are read on
  demand via `AGENTS.md` references.
- Vibe lifecycle hooks are configured through `.vibe/hooks.toml`
  (project-local) and `~/.vibe/hooks.toml` (user-global).
- The servers that give Vibe extra tools, which are called MCP servers,
  are configured through `.vibe/config.toml`. This
  repository does not ship a project-local MCP server list. Vibe reads
  its user-global config plus whatever project overrides the operator
  adds locally.
- Vibe tool names map to the shared contract: `bash` = `Bash`,
  `read_file` = `Read`, `write_file` / `edit` = `Write` / `Edit`,
  `web_fetch` = `WebFetch`, `grep` = `Grep` / `Glob`.
- Vibe has no `SessionStart` or `SessionEnd` hook events. Session-level
  reminders in `.claude/settings.json` do not fire under Vibe.
- Vibe blocks via stdout JSON `{"decision":"deny","reason":"..."}` with
  exit 0, not via exit code 2.

## Public-repo constraint

Same as `CLAUDE.md`: nothing committed under `.vibe/` may reference
personal paths, credential vaults, or private hosts. Per-operator MCP
server registrations go in `~/.vibe/config.toml`, never in a committed
project file.
