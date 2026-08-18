---
name: pe-ship
description: The ONLY way to commit and push. Runs verification, dogfoods the linter, updates the CHANGELOG, commits, pushes, opens or updates the PR. Use after finishing any implementation work.
user-invocable: true
---

# pe-ship: commit + push + PR, with gates

The single terminal action. If a gate fails, ship refuses and points at
what to fix. No `--no-verify`. No skipping.

## Prerequisites

- Work is complete (or a clear checkpoint)
- On a feature branch, not `main`
- `git status` shows the intended changes

## Step 1: verify

```
npm test
npm run render -- --check
npm run policy:check
```

`npm test` runs `pretest` (check:refs + build), then vitest, then
`posttest` (probe). The other two are what the "Generated docs match
rules" job checks, and neither is part of `npm test`. Running them here
is the difference between finding drift now and finding it on a red pull
request. Note the `--` before `--check`: without it npm reads the flag
itself and the script runs in write mode.

If any of the three fails, fix before continuing. Do not `--no-verify`.

## Step 2: dogfood the linter

```
npm run lint:self
```

It reads `docs/`, the root markdown files and everything under
`.claude/`, and exits non-zero on a blocking finding.

This step used to build a file list with `git diff --name-only` and pass
it unquoted. That relies on the shell splitting a variable on
whitespace, which bash does and zsh does not. Under zsh the whole
newline-joined list arrived as a single path, and the step exited 2,
"bad path", without reading anything. Linting a fixed set has no such
failure mode and covers more.

The four generated files under `integrations/` sit outside this scope.
Editing one by hand is already forbidden, and step 1's
`render -- --check` catches a stale one.

If the linter flags something, fix the copy. This repository's own
writing is a test corpus.

## Step 3: CHANGELOG entry

Every user-visible change needs a CHANGELOG entry. Non-user-visible
changes (refactor, docs, CI) do not. Commit them as `chore:` / `docs:`
/ `test:` and skip the entry.

Format (matches existing CHANGELOG style):

```
## [Unreleased]

### Added / Changed / Fixed / Removed
- Short user-visible sentence. (#PR)
```

## Step 4: commit

Small commits are fine, one logical change each. Long branches with
many small commits get squashed at merge; the PR title is the shipped
summary.

Commit message shape:

```
type(scope): short imperative sentence

Longer body explaining the WHY, not the WHAT. The diff shows what.
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`.

Never `--no-verify`. If pre-commit hooks fail, fix the underlying
problem.

## Step 5: push + PR

```
git push -u origin $(git branch --show-current)
```

If the PR does not exist, open one:

```
gh pr create --title "..." --body "$(cat <<'EOF'
## Summary
<1-3 bullets>

## Test plan
- [ ] Tests pass locally
- [ ] check:refs green
- [ ] Dogfood lint on changed docs green

EOF
)"
```

If it exists, update the body if the scope changed. Do **not** force-push.

## Step 6: gate on CI

```
gh pr checks --watch
```

If checks fail, fix and re-push. Do not merge on a red PR.

## Step 7: merge

For most changes: squash-merge. Preserve branch (do not `--delete-branch`
in the merge call. The branch stays for reference; delete manually if
you want).

```
gh pr merge --squash --auto
```

## Do not

- Do not commit anything that trips `npm run check:refs`
- Do not skip the tests
- Do not `--no-verify`
- Do not merge on a red PR
- Do not bundle unrelated changes
- Do not force-push to a shared branch
