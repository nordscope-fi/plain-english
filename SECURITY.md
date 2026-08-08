# Security policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues or pull requests.

Use [GitHub private vulnerability reporting](https://github.com/nordscope-fi/plain-english/security/advisories/new). You should get an acknowledgement within a week.

## Scope

This package reads files you point it at, runs regular expressions against them, and writes hook configuration for your coding agent when you run `init`. Things worth reporting:

- A configuration that causes the linter to hang or exhaust memory. Patterns **from your configuration** are screened for catastrophic backtracking at load, and matching a document carries a deadline, so a case that gets past both is a bug.
- A hook payload that causes the same. This is a separate path and a weaker one: the patterns the adapter uses to read a tool call are written into the package rather than loaded from config, so the load-time screen never sees them, and the match deadline covers linting a document and no part of extraction. A test screens them and measures the shapes that matter, which is a check rather than a guarantee. Extraction is capped at 256KB of command text. One such hang shipped in 0.4.0 and was fixed in 0.4.1.
- A path in `exclude`, `--root` or a hook payload that reads or writes outside the project directory.
- Anything that makes `init` clobber hooks it did not add.

Out of scope: false positives and false negatives in the rules themselves. Those are ordinary bugs, so please open a normal issue.
