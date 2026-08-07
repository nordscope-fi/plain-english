#!/usr/bin/env node
/**
 * Turn `## [Unreleased]` into a dated release section.
 *
 * Wired to the `version` lifecycle script, so `npm version` does it. That hook
 * runs after package.json is bumped and before the release commit is made, and
 * anything this script `git add`s lands in that commit.
 *
 * It exists because the manual step was missed on two consecutive releases,
 * both times by someone who had just read the checklist that names it.
 * docs/releasing.md then described a repository state that did not exist.
 *
 * Refusing is the point. A release with nothing under Unreleased is either a
 * changelog somebody forgot to write or a version bump nobody needed, and both
 * are worth stopping for. `ALLOW_EMPTY_CHANGELOG=1` overrides.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = resolve(root, "CHANGELOG.md");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const REPO = "https://github.com/nordscope-fi/plain-english";

/** Today, as YYYY-MM-DD in local time. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Rewrite the changelog for `version`.
 *
 * Returns the new text. Throws when there is nothing to release, so the caller
 * decides whether that is fatal.
 */
export function dateChangelog(text, version, date, { allowEmpty = false } = {}) {
  const heading = /^## \[Unreleased\]\s*$/m;
  if (!heading.test(text)) {
    throw new Error(
      "no '## [Unreleased]' section. Add one before releasing, or this " +
        "release goes out undocumented.",
    );
  }

  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(text)) {
    throw new Error(`CHANGELOG already has a section for ${version}`);
  }

  // Everything between the Unreleased heading and the next release heading.
  const start = text.search(heading);
  const after = text.slice(start + text.match(heading)[0].length);
  const nextHeading = after.search(/^## \[/m);
  const body = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
  if (!body && !allowEmpty) {
    throw new Error(
      "'## [Unreleased]' is empty. Write the entry, or set " +
        "ALLOW_EMPTY_CHANGELOG=1 if this release genuinely has no user-visible change.",
    );
  }

  // A fresh Unreleased stays at the top so the next change has somewhere to go
  // and docs/releasing.md keeps describing a real file.
  let out = text.replace(heading, `## [Unreleased]\n\n## [${version}] - ${date}`);

  const unreleasedLink = new RegExp(`^\\[Unreleased\\]:.*$`, "m");
  const newLinks =
    `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n` +
    `[${version}]: ${REPO}/releases/tag/v${version}`;
  if (unreleasedLink.test(out)) {
    out = out.replace(unreleasedLink, newLinks);
  } else {
    out = out.trimEnd() + "\n\n" + newLinks + "\n";
  }
  return out;
}

// Only act when run directly, so the tests can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const text = readFileSync(changelogPath, "utf8");
  let out;
  try {
    out = dateChangelog(text, pkg.version, today(), {
      allowEmpty: process.env["ALLOW_EMPTY_CHANGELOG"] === "1",
    });
  } catch (e) {
    process.stderr.write(`\nplain-english: cannot release ${pkg.version}.\n  ${e.message}\n\n`);
    process.exit(1);
  }
  writeFileSync(changelogPath, out, "utf8");
  // Staged here so it becomes part of the commit `npm version` is about to make.
  execFileSync("git", ["add", changelogPath], { cwd: root });
  process.stdout.write(`CHANGELOG: [Unreleased] is now [${pkg.version}] - ${today()}\n`);
}
