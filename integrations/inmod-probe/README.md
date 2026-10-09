# In-mod probe

This plugin is a test for the Claude directory's validation, never meant for submission. It has the shape a writing checker would have if it ran entirely inside its mod. It starts no program.

## What it reads, writes and sends

It runs the plain-english checker's rules and Markdown parser, bundled under `hooks/core/`, inside the mod. It starts no program.

- **Reads:** the content of a proposed `Write` through `tool.call`; the session's working folder through `session.cwd`; the bundled ruleset `rules/default.yml` through `fs.read`; and, when a reply ends, the transcript file Claude Code names in the `classic.Stop` event.
- **Writes:** only `.plain-english.yml` in the session's working folder, through `fs.write`, when a proposed write contains the marker `APPROVE-PROBE`.
- **Sends:** a flagged write's content to the session's own model through `model.complete`, using the session's own account. Nothing else leaves the computer, and it makes no other network request.
