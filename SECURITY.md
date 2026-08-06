# Security policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues or pull requests.

Use [GitHub private vulnerability reporting](https://github.com/nordscope-fi/plain-english/security/advisories/new). You should get an acknowledgement within a week.

## Scope

This package reads files you point it at, runs regular expressions from your configuration against them, and writes to `.claude/settings.json` when you run `init`. Things worth reporting:

- A configuration that causes the linter to hang or exhaust memory. Patterns are screened for catastrophic backtracking at load and matching carries a deadline, so a case that gets past both is a bug.
- A path in `exclude`, `--root` or a hook payload that reads or writes outside the project directory.
- Anything that makes `init` clobber hooks it did not add.

Out of scope: false positives and false negatives in the rules themselves. Those are ordinary bugs, so please open a normal issue.
