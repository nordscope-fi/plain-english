import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error plain .mjs helper, no types
import { dateChangelog, today } from "../scripts/date-changelog.mjs";

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

  it("formats today as YYYY-MM-DD", () => {
    expect(today(new Date(2026, 7, 8))).toBe("2026-08-08");
    expect(today(new Date(2026, 0, 1))).toBe("2026-01-01");
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
