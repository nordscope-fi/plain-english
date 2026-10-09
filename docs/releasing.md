# Releasing

## The one-time publisher setup is already complete

npm revoked all classic tokens on 2025-12-09, so there is no `NPM_TOKEN` to store. Instead, npm verifies the GitHub workflow's identity directly and attaches a signed record of where the package was built. The identity check is called OIDC trusted publishing, and the signed record is called provenance.

Trusted publishing has an ordering constraint that mattered during bootstrap: **a trusted publisher cannot be configured for a package name that does not exist on npm yet.** Version 0.1.0 was therefore published by hand. Do not repeat that step for a normal release; current releases run from CI.

### Bootstrap record

These steps record the setup already applied to npm and GitHub. They are recovery notes,
not the current release procedure.

**1. The package was created with `0.1.0` from a terminal.**

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
git commit -am "chore(release): bump package version"
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

The same script moves the `version` in the Claude Code plugin's manifest, `integrations/claude-code-plugin/.claude-plugin/plugin.json`. A plugin installed from the marketplace stays on its cached copy until that string changes, so it is held equal to `package.json`. Every release makes an update available. Own-marketplace automatic updates are off by default; users run `claude plugin update plain-english@plain-english` or enable automatic updates. The plugin's bundled copy of the CLI is written by `npm run build` and committed; CI's drift job fails when a build changes it and the change was not committed.

The release also creates the native plugin tag `plain-english--vX.Y.Z` at the same commit as `vX.Y.Z`. The GitHub Release carries a standalone compressed mod archive (ZIP) and its SHA-256 checksum. CI validates the repository marketplace and plugin, tests cancellation, and extracts the archive to check that its bundled CLI matches the package version.

The repository marketplace and Anthropic's directory are separate publication routes. Publishing this repository makes its marketplace available to Claude Code; it does not create a directory listing. The directory requires an initial submission from the account owner. Its listing can then follow `main` and scan new commits. By default a person publishes each passing version; automatic publication depends on Anthropic's assigned setting. A version held for review still needs a person. The bundled CLI exceeds the directory's individual-file review threshold of 256 kibibytes (KiB), so later versions can require review too. See [Anthropic's submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).

### Submit the directory listing

Use the signed-in account owner's [developer portal](https://claude.ai/directory/manage). Continue an existing submission if one exists; do not create a duplicate.

| Field | Prepared value |
|---|---|
| Name | Plain English |
| Source repository | `nordscope-fi/plain-english` |
| Plugin directory | `integrations/claude-code-plugin` |
| Tracked branch | `main` |
| Description | Checks prose in document writes, messages and replies in Claude Code. Findings quote the passage and explain how to fix it. |
| Licence | MIT |
| Support | <https://github.com/nordscope-fi/plain-english/issues> |

For the data-handling disclosure: pattern checks run locally. Optional model checks send the proposed document, or a reply and the user's last question, through the configured Claude service and account. Code and quotes inside a document can be included. Excluded paths are skipped. Model checks can be disabled. Local model sessions are not persisted; provider retention follows the account's settings. Temporary control files contain identifiers and counters, and recent findings stay in session memory. Optional maintainer measurements retain usage and reported price estimates, without source prose. The [plugin README](../integrations/claude-code-plugin/README.md#what-it-reads-writes-and-sends) describes these controls.

The owner must review the portal's account permissions and compliance acknowledgments. Do not pre-answer them from this checklist. The current event-checking mod targets Claude Code; do not promise equivalent enforcement in Claude chat or Cowork. The directory is also separate from the official Claude Code marketplace. These distinctions follow [Anthropic's publishing guide](https://code.claude.com/docs/en/plugins/publish), [submission guide](https://claude.com/docs/plugins/submit) and [platform support table](https://claude.com/docs/plugins/platform-support).

`release.yml` verifies before it publishes: build, tests, the private-reference check over tree and history, the dogfood lint, the generated-file drift check, `publint` and `arethetypeswrong`. A tag push is checked against `package.json` first, because a tag that disagrees would publish something other than what it claims to be. It also runs the full CI matrix across Linux, Windows and macOS on Node 20, 22 and 24, because a publish gate weaker than the pull-request gate let `v0.2.0` ship with a red Windows job. Then it tags and publishes.

The tag is made after the gates rather than before them, so it means "this passed" rather than "somebody pushed it". A tag pushed with the Actions token raises no workflow run, which is what stops a release from starting a second one of itself.

## The GitHub Release

The last step of the publish job creates it, titled with the tag. Its body is that version's changelog section, pulled out by `scripts/changelog-section.mjs`. Its attachments are `plain-english-mod-vX.Y.Z.zip` and the matching `.sha256` file. The archive contains the plugin directory, ready to extract and validate with `claude plugin validate --strict`. Read what a release note will say before tagging:

```bash
node scripts/changelog-section.mjs v0.24.0
```

It runs after `npm publish` on purpose, so a failure creating the release cannot cost a publish that already went out. Releases before v0.7.0 have no notes: this step did not exist, and backfilling ten thin entries was not worth it.

For a partial release, rerun its original workflow run. The npm step accepts an already published version only when npm's provenance names this repository, release workflow and exact commit, and its artifact digest matches the registry's package integrity. The GitHub step uploads the archive and checksum into an existing release. Retrying from a later commit is refused.

## Version numbering

Semver against the CLI and the rules together. A rule change that produces new findings on text that previously passed is a **minor** bump at least, since it can turn somebody's CI red.

| Bump | For |
|---|---|
| major | A config file that used to work stops working. Removing a rule id. Changing a default severity upward. |
| minor | New rules. New CLI flags. A new output format. |
| patch | Fixes to an existing rule's regex or exceptions. Documentation. Dependencies. |

## Checklist before merging a release

### Dependency runtime compatibility

The package supports Node 20.0.0 and newer. A dependency update must preserve
that minimum, including its transitive dependencies. Both pull-request and
release checks install the built tarball with strict engine checking on Node
20.0.0, then exercise Markdown, visible source text and HTML issue hooks.
Testing only the latest Node 20 release cannot establish this minimum.

The following updates were deferred after strict installation rejected each
on Node 20.0.0:

| Dependency | Deferred version | Declared Node requirement |
|---|---|---|
| JavaScript source parser, `@babel/parser` | 8.0.6 | `^22.18.0 || >=24.11.0` |
| Character decoder, `entities` | 8.1.0 | `>=20.19.0` |

The dependency bot skips those incompatible major versions while still
proposing compatible updates.
Revisit the exclusions when changing the package's supported runtime range.
The declared requirements come from the
[published JavaScript parser manifest](https://registry.npmjs.org/@babel%2fparser/8.0.6) and
[character decoder manifest](https://registry.npmjs.org/entities/8.1.0).

### Release contents

- `CHANGELOG.md` has an entry under `## [Unreleased]`. Dating it is automatic, and `npm version` fails if the section is empty.
- `npm run render` produced no diff.
- New or changed rules have corpus cases.
