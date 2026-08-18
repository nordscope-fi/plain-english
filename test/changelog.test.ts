import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error plain .mjs helper, no types
import { dateChangelog, pinnedFiles, readPins, retargetPins, today } from "../scripts/date-changelog.mjs";

/**
 * `npm version` dates the changelog now.
 *
 * The manual step was missed on two consecutive releases, both times right
 * after reading the checklist naming it, which is the signal that it belonged
 * in a script rather than in a person's memory.
 */
const HEAD = `# Changelog

Notable changes.

## [Unreleased]

### Fixed

- Something real.

## [0.3.1] - 2026-08-07

### Added

- Older thing.

[Unreleased]: https://github.com/nordscope-fi/plain-english/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.1
`;

describe("dating the changelog", () => {
  const out = dateChangelog(HEAD, "0.4.0", "2026-08-08");

  it("dates the section under the new version", () => {
    expect(out).toContain("## [0.4.0] - 2026-08-08");
  });

  it("keeps the entries that were under Unreleased", () => {
    const section = out.slice(out.indexOf("## [0.4.0]"), out.indexOf("## [0.3.1]"));
    expect(section).toContain("Something real.");
  });

  it("leaves a fresh Unreleased for the next change", () => {
    // docs/releasing.md assumes this heading exists. It has to survive.
    expect(out).toMatch(/^## \[Unreleased\]\s*$/m);
    const unreleased = out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [0.4.0]"));
    expect(unreleased.replace("## [Unreleased]", "").trim()).toBe("");
  });

  it("adds the release link and repoints Unreleased", () => {
    expect(out).toContain(
      "[0.4.0]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.4.0",
    );
    expect(out).toContain(
      "[Unreleased]: https://github.com/nordscope-fi/plain-english/compare/v0.4.0...HEAD",
    );
    // The old one is replaced, not duplicated.
    expect(out.match(/^\[Unreleased\]:/gm)).toHaveLength(1);
  });

  it("does not disturb earlier releases", () => {
    expect(out).toContain("## [0.3.1] - 2026-08-07");
    expect(out).toContain(
      "[0.3.1]: https://github.com/nordscope-fi/plain-english/releases/tag/v0.3.1",
    );
  });

  it("refuses when there is nothing under Unreleased", () => {
    const empty = HEAD.replace("### Fixed\n\n- Something real.\n\n", "");
    expect(() => dateChangelog(empty, "0.4.0", "2026-08-08")).toThrow(/empty/);
  });

  it("allows an empty section only when asked explicitly", () => {
    const empty = HEAD.replace("### Fixed\n\n- Something real.\n\n", "");
    expect(() => dateChangelog(empty, "0.4.0", "2026-08-08", { allowEmpty: true })).not.toThrow();
  });

  it("refuses when the heading is missing entirely", () => {
    expect(() => dateChangelog("# Changelog\n\n## [0.3.1] - x\n", "0.4.0", "2026-08-08")).toThrow(
      /no '## \[Unreleased\]'/,
    );
  });

  it("refuses to date a version that already has a section", () => {
    expect(() => dateChangelog(HEAD, "0.3.1", "2026-08-08")).toThrow(/already has a section/);
  });

  it("names two Unreleased headings rather than calling the section empty", () => {
    // How it happens: this script leaves a fresh empty Unreleased behind after
    // every release, and a branch then writes its own. The entry sits under the
    // second while every check reads the first.
    //
    // Live on 0.12.1. The release refused with "is empty" over a file that had
    // the entry written and waiting, which sent the reader looking in the wrong
    // place. A refusal that names the wrong cause is worse than none.
    const doubled =
      "# Changelog\n\n## [Unreleased]\n\n## [Unreleased]\n### Fixed\n\n- A real entry.\n\n## [0.3.1] - 2026-01-01\n";
    expect(() => dateChangelog(doubled, "0.4.0", "2026-08-08")).toThrow(/2 '## \[Unreleased\]' headings/);
    // And not the wrong diagnosis it used to give.
    expect(() => dateChangelog(doubled, "0.4.0", "2026-08-08")).not.toThrow(/empty/);
  });

  it("formats today as YYYY-MM-DD", () => {
    expect(today(new Date(2026, 7, 8))).toBe("2026-08-08");
    expect(today(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("moving the version pins", () => {
  const DOC = [
    "```yaml",
    "repos:",
    "  - repo: https://github.com/nordscope-fi/plain-english",
    "    rev: v0.4.0",
    "```",
    "",
    "- uses: nordscope-fi/plain-english/integrations/github-action@v0.2.0",
    "",
    "Released v0.4.0 on a Tuesday.",
  ].join("\n");

  it("moves both pin shapes to the new version", () => {
    const out = retargetPins(DOC, "0.9.1") as string;
    expect(out).toContain("    rev: v0.9.1");
    expect(out).toContain("github-action@v0.9.1");
  });

  it("leaves a version that is prose alone", () => {
    // Only a pin gets moved. A sentence about v0.4.0 is history and stays true.
    expect(retargetPins(DOC, "0.9.1")).toContain("Released v0.4.0 on a Tuesday.");
  });

  it("reads back what it wrote", () => {
    expect(readPins(retargetPins(DOC, "0.9.1"))).toEqual(["v0.9.1", "v0.9.1"]);
  });

  it("changes nothing on a second pass", () => {
    const once = retargetPins(DOC, "0.9.1") as string;
    expect(retargetPins(once, "0.9.1")).toBe(once);
  });
});

describe("this repository's changelog", () => {
  const text = readFileSync(resolve(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");

  it("has an Unreleased heading for the script to find", () => {
    expect(text).toMatch(/^## \[Unreleased\]\s*$/m);
  });

  it("has a link definition for every dated release", () => {
    const versions = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(text, `no link definition for ${v}`).toMatch(
        new RegExp(`^\\[${v.replace(/\./g, "\\.")}\\]:`, "m"),
      );
    }
  });

  it("names a version in every pin, matching the one in package.json", () => {
    // A `rev:` or `@v` in a copy-paste example freezes the ruleset at that tag.
    // Five of them sat three releases behind before anyone looked, so the
    // release script moves them now and this is what keeps it honest. It stays
    // green through a release because the pins and the bump land in one commit.
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    const root = resolve(import.meta.dirname, "..");
    let total = 0;
    for (const path of pinnedFiles(root) as string[]) {
      for (const pin of readPins(readFileSync(path, "utf8")) as string[]) {
        expect(pin, `${path.slice(root.length + 1)} pins ${pin}`).toBe(`v${pkg.version}`);
        total += 1;
      }
    }
    expect(total, "no pins found at all, so this test proves nothing").toBeGreaterThan(0);
  });

  it("documents the version that is about to ship", () => {
    // The check that would have caught both misses: package.json is at a
    // version, so the changelog must either name it or have it under
    // Unreleased waiting to be dated.
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    const dated = text.includes(`## [${pkg.version}]`);
    const pending = /^## \[Unreleased\]\s*\n\s*\n\s*###/m.test(text);
    expect(dated || pending, `${pkg.version} is neither dated nor pending`).toBe(true);
  });
});
