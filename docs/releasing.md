# Releasing

## Why the first release is different

npm revoked all classic tokens on 2025-12-09, so there is no `NPM_TOKEN` to store. Instead, npm verifies the GitHub workflow's identity directly and attaches a signed record of where the package was built. The identity check is called OIDC trusted publishing, and the signed record is called provenance.

Trusted publishing has an ordering constraint that catches people out: **a trusted publisher cannot be configured for a package name that does not exist on npm yet.** The first release therefore has to go out by hand, and every release after that runs from CI.

## One-time setup

Do these in order.

**1. Publish `0.1.0` from a terminal.**

```bash
npm login
npm publish        # prepublishOnly runs the private-refs check, build and tests
```

Requires npm >= 11.5.1 and Node >= 22.14.0.

**2. Register the trusted publisher.**

npmjs.com, package settings, Trusted Publisher:

| Field | Value |
|---|---|
| Organization or user | `nordscope-fi` |
| Repository | `plain-english` |
| Workflow filename | `release.yml` (filename only, no path) |
| Environment | `npm` |

The workflow *filename* is what npm matches on. If publishing ever moves into a reusable workflow, register the caller, not the reusable one.

**3. Lock the package down.**

npmjs.com, package settings, Publishing access: **Require two-factor authentication and disallow tokens.** From this point a token cannot publish even if one leaks.

**4. Create the `npm` environment on GitHub.**

Settings, Environments, new environment named `npm`. Leave it empty. It exists because the trusted publisher registration names it, and a job that runs outside it is refused by npm.

It used to carry a required reviewer. That was removed on 2026-08-19, along with the separate tagging step, because between them they meant a merged fix sat unreleased until somebody remembered it.

## Every release after that

A release is a merge. Put the bump in the pull request:

```bash
npm version minor --no-git-tag-version    # or patch, or major
git commit -am "chore(release): 0.14.0"
```

`--no-git-tag-version` matters. It bumps `package.json` and runs the changelog and pin script, and it makes no commit and no tag, so the release commit is yours and the tag is CI's.

Merging that pull request is the whole release. `release.yml` runs on the push to `main`, sees a version no tag points at, runs both gates, tags it, publishes, and writes the GitHub Release.

A merge carrying no bump releases nothing, which is how a documentation change lands without shipping. Two pull requests that bump to the same version are the case to watch: the second one merges, finds its version already tagged, and releases nothing, so its changes wait for the next bump.

The by-hand path still works when you want it:

```bash
npm version patch      # commits and tags locally
git push --follow-tags
```

`npm version` dates the changelog for you. The `version` lifecycle script runs `scripts/date-changelog.mjs`, which retitles `## [Unreleased]` to the new version, adds its link definition, repoints the Unreleased compare link and leaves a fresh empty heading for next time. The result is staged into the release commit.

It refuses to run when `## [Unreleased]` is missing or empty, which fails the whole `npm version` command before anything is tagged. That is deliberate: a release with no changelog entry is either an entry somebody forgot or a bump nobody needed. `ALLOW_EMPTY_CHANGELOG=1` overrides it for a genuinely invisible change.

This used to be a manual step on the checklist below. It was missed on two consecutive releases, both times by someone who had just read the checklist, so it moved into the script.

`npm version` creates an **annotated** tag, which matters: `git push --follow-tags` pushes annotated tags and silently ignores lightweight ones. Tagging by hand with `git tag v0.1.1` produces a lightweight tag, the push reports "Everything up-to-date", and nothing triggers. Use `git tag -a` if you tag manually.

`npm version` also moves the version pins in the copy-paste examples. `rev:` in a pre-commit block and `@vX.Y.Z` on the GitHub Action both name a tag. A stale one hands a new reader the ruleset from three releases ago, and five of them had gone stale that way. The script rewrites every pin in `README.md` and `docs/*.md` and stages those files into the same commit. A test asserts each pin matches `package.json`. A version mentioned in prose is left alone.

`release.yml` verifies before it publishes: build, tests, the private-reference check over tree and history, the dogfood lint, the generated-file drift check, `publint` and `arethetypeswrong`. A tag push is checked against `package.json` first, because a tag that disagrees would publish something other than what it claims to be. It also runs the full CI matrix across Linux, Windows and macOS on Node 20, 22 and 24, because a publish gate weaker than the pull-request gate let `v0.2.0` ship with a red Windows job. Then it tags and publishes.

The tag is made after the gates rather than before them, so it means "this passed" rather than "somebody pushed it". A tag pushed with the Actions token raises no workflow run, which is what stops a release from starting a second one of itself.

## The GitHub Release

The last step of the publish job creates it, titled with the tag. Its body is that version's changelog section, pulled out by `scripts/changelog-section.mjs`. Read what a release note will say before tagging:

```bash
node scripts/changelog-section.mjs v0.7.3
```

It runs after `npm publish` on purpose, so a failure creating the release cannot cost a publish that already went out. Releases before v0.7.0 have no notes: this step did not exist, and backfilling ten thin entries was not worth it.

## Version numbering

Semver against the CLI and the rules together. A rule change that produces new findings on text that previously passed is a **minor** bump at least, since it can turn somebody's CI red.

| Bump | For |
|---|---|
| major | A config file that used to work stops working. Removing a rule id. Changing a default severity upward. |
| minor | New rules. New CLI flags. A new output format. |
| patch | Fixes to an existing rule's regex or exceptions. Documentation. Dependencies. |

## Checklist before merging a release

- `CHANGELOG.md` has an entry under `## [Unreleased]`. Dating it is automatic, and `npm version` fails if the section is empty.
- `npm run render` produced no diff.
- New or changed rules have corpus cases.
