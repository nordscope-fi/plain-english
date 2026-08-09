#!/usr/bin/env node
/**
 * Print one release's changelog entry, for `gh release create --notes-file -`.
 *
 * Thirteen tags had produced zero GitHub Releases, so the Releases page was
 * empty while the changelog held a written entry for every one of them. The
 * entry was always the release note; nothing was carrying it across.
 *
 * Takes a version or a tag (`0.7.2` and `v0.7.2` both work), and defaults to
 * whatever package.json says, which is what the tag build wants.
 *
 *   node scripts/changelog-section.mjs v0.7.2
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sectionBody } from "./date-changelog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asked = (process.argv[2] ?? "").replace(/^v/, "");
const version = asked || JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

try {
  const text = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  process.stdout.write(`${sectionBody(text, version)}\n`);
} catch (e) {
  process.stderr.write(`plain-english: ${e.message}\n`);
  process.exit(1);
}
