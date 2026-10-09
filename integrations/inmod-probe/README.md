# In-mod probe

This plugin is a test for the Claude directory's validation, never meant for submission. It has the shape a writing checker would have if it ran entirely inside its mod. It starts no program.

## What it reads, writes and sends

It reads the content of a proposed `Write` through `tool.call`, the session's working folder through `session.cwd`, and the project's `.plain-english.yml` through `fs.read`. It writes nothing.

When the content contains one of three words, it sends that content and the word to the session's own model through `model.complete`, using the session's own account, and asks whether the word is filler. Nothing else leaves the computer, and it makes no other network request.
