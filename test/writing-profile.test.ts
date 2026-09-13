import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWritingProfile, writingProfileGuidance, writingProfileYaml } from "../src/writing-profile.ts";
import { loadConfig } from "../src/rules.ts";
import { renderAgentsFragment } from "../src/render.ts";

const roots: string[] = [];
const CLI = resolve(import.meta.dirname, "../dist/cli.js");

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), "plain-english-profile-"));
  roots.push(root);
  mkdirSync(resolve(root, "docs"));
  writeFileSync(resolve(root, ".plain-english.yml"), [
    "version: 1", "extends: default", "profile:", "  file: .plain-english-profile.yml",
    "  samples:", "    technical-doc:", "      - 'docs/**/*.md'", "",
  ].join("\n"));
  return root;
}

describe("project writing profiles", () => {
  it("is deterministic, stores no prose, and preserves manual preferences", () => {
    const root = project();
    for (let i = 0; i < 20; i++) {
      const sentence = "You can organize the color setting before the service starts safely.";
      writeFileSync(resolve(root, "docs", `guide-${i}.md`), `# Configure Color\n\n${Array(12).fill(sentence).join(" ")}\n`);
    }
    const config = loadConfig(resolve(root, ".plain-english.yml")).profile!;
    const prior = "version: 1\npreferences:\n  voice: direct\n";
    const first = buildWritingProfile(root, config, prior);
    const second = buildWritingProfile(root, config, writingProfileYaml(first));
    expect(second).toEqual(first);
    expect(first.preferences).toEqual({ voice: "direct" });
    expect(JSON.stringify(first)).not.toContain("service starts safely");
    expect(first.genres["technical-doc"].status).toBe("stable");
    expect(writingProfileGuidance(first).join(" ")).toContain("technical-doc");
    writeFileSync(resolve(root, ".plain-english-profile.yml"), writingProfileYaml(first));
    const rendered = renderAgentsFragment(loadConfig(resolve(root, ".plain-english.yml")));
    expect(rendered).toContain("This project's observed style");
    expect(rendered).toContain("technical-doc:");
  });

  it("marks a small sample insufficient", () => {
    const root = project();
    writeFileSync(resolve(root, "docs/one.md"), "One short sentence.");
    const config = loadConfig(resolve(root, ".plain-english.yml")).profile!;
    expect(buildWritingProfile(root, config).genres["technical-doc"].status).toBe("insufficient");
  });

  it("writes a profile and detects stale source files", () => {
    const root = project();
    writeFileSync(resolve(root, "docs/one.md"), "One short sentence.");
    execFileSync(process.execPath, [CLI, "profile", "--root", root]);
    expect(spawnSync(process.execPath, [CLI, "profile", "--check", "--root", root]).status).toBe(0);
    writeFileSync(resolve(root, "docs/one.md"), "One changed sentence.");
    const stale = spawnSync(process.execPath, [CLI, "profile", "--check", "--root", root], { encoding: "utf8" });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stale");
  });

  it("rejects unknown genres", () => {
    const root = project();
    writeFileSync(resolve(root, ".plain-english.yml"), "version: 1\nprofile:\n  file: profile.yml\n  samples:\n    essay: ['docs/**']\n");
    expect(() => loadConfig(resolve(root, ".plain-english.yml"))).toThrow(/unknown genre/);
  });
});
