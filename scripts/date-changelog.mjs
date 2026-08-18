#!/usr/bin/env node
/**
 * Prepare the documentation for a release: date the changelog, and move the
 * version pins in the copy-paste examples.
 *
 * Wired to the `version` lifecycle script, so `npm version` does it. That hook
 * runs after package.json is bumped and before the release commit is made, and
 * anything this script `git add`s lands in that commit.
 *
 * The changelog half exists because the manual step was missed on two
 * consecutive releases, both times by someone who had just read the checklist
 * that names it. docs/releasing.md then described a repository state that did
 * not exist.
 *
 * Refusing is the point. A release with nothing under Unreleased is either a
 * changelog somebody forgot to write or a version bump nobody needed, and both
 * are worth stopping for. `ALLOW_EMPTY_CHANGELOG=1` overrides.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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

  // Two Unreleased headings, which is easier to produce than it sounds. This
  // script leaves a fresh empty one behind after every release, so a branch
  // that writes its own ends up with both. The entry is then under the second
  // and every check here reads the first.
  //
  // Caught on 0.12.1, where the release refused with "'## [Unreleased]' is
  // empty" over a file that had the entry written and waiting. A refusal that
  // names the wrong cause costs more than no refusal, because it sends whoever
  // reads it looking in the wrong place.
  const headings = text.match(/^## \[Unreleased\]\s*$/gm) ?? [];
  if (headings.length > 1) {
    throw new Error(
      `${headings.length} '## [Unreleased]' headings. Every check here reads the ` +
        "first, so an entry written under a later one is invisible. Collapse them into one.",
    );
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

/**
 * The body of one release's section, heading stripped.
 *
 * Stops at the next release heading or at the link-definition block, whichever
 * comes first. Without the second stop the oldest release would carry every
 * `[0.x.y]: https://…` line in the file into its release note.
 */
export function sectionBody(text, version) {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\].*$`, "m");
  const match = text.match(heading);
  if (!match) throw new Error(`CHANGELOG has no section for ${version}`);
  const after = text.slice(text.search(heading) + match[0].length);
  const stops = [after.search(/^## \[/m), after.search(/^\[[^\]]+\]:\s*http/m)].filter(
    (i) => i !== -1,
  );
  return after.slice(0, stops.length ? Math.min(...stops) : after.length).trim();
}

/**
 * The two ways a document pins a version of this package.
 *
 * `rev:` is pre-commit's, `@v` is the GitHub Action's, and both name a git tag.
 * A reader who copies one gets the ruleset as it was at that tag, so a pin left
 * behind hands new users an old linter. Five of them had gone three releases
 * stale before anyone noticed, which is what moved them in here.
 */
const PIN_PATTERNS = [
  /^([ \t]*rev:[ \t]*)v\d+\.\d+\.\d+[ \t]*$/gm,
  /(nordscope-fi\/plain-english\/integrations\/github-action@)v\d+\.\d+\.\d+/g,
];

/** Every file a pin is allowed to live in. A new doc is covered by being a doc. */
export function pinnedFiles(root) {
  const docs = readdirSync(resolve(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => resolve(root, "docs", f));
  return [resolve(root, "README.md"), ...docs];
}

/** Point every pin in `text` at `version`. */
export function retargetPins(text, version) {
  let out = text;
  for (const pattern of PIN_PATTERNS) out = out.replace(pattern, `$1v${version}`);
  return out;
}

/** Every version a pin in `text` currently names, in order. */
export function readPins(text) {
  const found = [];
  for (const pattern of PIN_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.push(m[0].slice(m[1].length).trim());
  }
  return found;
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

  const moved = [];
  for (const path of pinnedFiles(root)) {
    const before = readFileSync(path, "utf8");
    const after = retargetPins(before, pkg.version);
    if (after === before) continue;
    writeFileSync(path, after, "utf8");
    execFileSync("git", ["add", path], { cwd: root });
    moved.push(path.slice(root.length + 1));
  }
  if (moved.length) {
    process.stdout.write(`pins: now v${pkg.version} in ${moved.join(", ")}\n`);
  }
}
