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

Settings, Environments, new environment named `npm`. Add yourself as a required reviewer so each publish waits for an explicit approval.

## Every release after that

```bash
npm version patch      # or minor, or major
git push --follow-tags
```

`npm version` dates the changelog for you. The `version` lifecycle script runs `scripts/date-changelog.mjs`, which retitles `## [Unreleased]` to the new version, adds its link definition, repoints the Unreleased compare link and leaves a fresh empty heading for next time. The result is staged into the release commit.

It refuses to run when `## [Unreleased]` is missing or empty, which fails the whole `npm version` command before anything is tagged. That is deliberate: a release with no changelog entry is either an entry somebody forgot or a bump nobody needed. `ALLOW_EMPTY_CHANGELOG=1` overrides it for a genuinely invisible change.

This used to be a manual step on the checklist below. It was missed on two consecutive releases, both times by someone who had just read the checklist, so it moved into the script.

`npm version` creates an **annotated** tag, which matters: `git push --follow-tags` pushes annotated tags and silently ignores lightweight ones. Tagging by hand with `git tag v0.1.1` produces a lightweight tag, the push reports "Everything up-to-date", and nothing triggers. Use `git tag -a` if you tag manually.

The tag triggers `release.yml`, which verifies before it publishes: build, tests, the private-reference check over tree and history, the dogfood lint, the generated-file drift check, `publint`, `arethetypeswrong`, and a check that the tag matches `package.json`. It also runs the full CI matrix across Linux, Windows and macOS on Node 20, 22 and 24, because a publish gate weaker than the pull-request gate let `v0.2.0` ship with a red Windows job. Then it waits for your approval on the `npm` environment and publishes.

## Version numbering

Semver against the CLI and the rules together. A rule change that produces new findings on text that previously passed is a **minor** bump at least, since it can turn somebody's CI red.

| Bump | For |
|---|---|
| major | A config file that used to work stops working. Removing a rule id. Changing a default severity upward. |
| minor | New rules. New CLI flags. A new output format. |
| patch | Fixes to an existing rule's regex or exceptions. Documentation. Dependencies. |

## Checklist before tagging

- `CHANGELOG.md` has an entry under `## [Unreleased]`. Dating it is automatic, and `npm version` fails if the section is empty.
- `npm run render` produced no diff.
- New or changed rules have corpus cases.
