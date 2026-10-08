import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * `plain-english approve`, the term approval the Claude Code plugin used to
 * do inside its mod (ADR-007). The mod now asks the person and leaves every
 * file read and write to this command, which takes its request on standard
 * input so the command line is fixed text.
 */
const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");

let outer: string;
let project: string;

function approve(request: Record<string, unknown>, cwd = project): Record<string, unknown> {
  const ran = spawnSync(process.execPath, [CLI, "approve"], { cwd, input: JSON.stringify(request), encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  return JSON.parse(ran.stdout) as Record<string, unknown>;
}

const REQUEST = { term: "BuildKit", rule: "unglossed-term", reason: "Our readers know this tool" };

beforeEach(() => {
  outer = realpathSync(mkdtempSync(resolve(tmpdir(), "pe-approve-")));
  project = resolve(outer, "project");
  mkdirSync(project);
});
afterEach(() => rmSync(outer, { recursive: true, force: true }));

describe("plain-english approve", () => {
  it("checks without writing, then writes only what the check described", () => {
    const checked = approve({ ...REQUEST, phase: "check" });
    expect(checked).toMatchObject({ ok: true, config: ".plain-english.yml", exists: false, modelVocabulary: true });
    expect(existsSync(resolve(project, ".plain-english.yml"))).toBe(false);
    const written = approve({ ...REQUEST, phase: "write", expect: checked });
    expect(written).toMatchObject({ ok: true, config: ".plain-english.yml" });
    const text = readFileSync(resolve(project, ".plain-english.yml"), "utf8");
    expect(text).toContain("BuildKit");
    expect(text).toContain("unglossed-term");
    expect(text).toContain("Approved in Plain English review: Our readers know this tool");
  });

  it("refuses to write when the configuration changed after the check", () => {
    writeFileSync(resolve(project, ".plain-english.yml"), "version: 1\nextends: default\n");
    const checked = approve({ ...REQUEST, phase: "check" });
    writeFileSync(resolve(project, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: error\n");
    const written = approve({ ...REQUEST, phase: "write", expect: checked });
    expect(written).toMatchObject({ ok: false });
    expect(String(written["message"])).toMatch(/changed/);
    expect(readFileSync(resolve(project, ".plain-english.yml"), "utf8")).not.toContain("BuildKit");
  });

  it("refuses a write with no check to compare against", () => {
    expect(approve({ ...REQUEST, phase: "write" })).toMatchObject({ ok: false });
    expect(existsSync(resolve(project, ".plain-english.yml"))).toBe(false);
  });

  it("refuses to shadow an inherited configuration", () => {
    writeFileSync(resolve(outer, ".plain-english.yml"), "version: 1\nextends: default\n");
    const checked = approve({ ...REQUEST, phase: "check" });
    expect(checked).toMatchObject({ ok: false });
    expect(String(checked["message"])).toMatch(/inherited configuration/);
    expect(existsSync(resolve(project, ".plain-english.yml"))).toBe(false);
  });

  it("refuses a linked configuration", () => {
    writeFileSync(resolve(outer, "elsewhere.yml"), "version: 1\nextends: default\n");
    symlinkSync(resolve(outer, "elsewhere.yml"), resolve(project, ".plain-english.yml"));
    expect(approve({ ...REQUEST, phase: "check" })).toMatchObject({ ok: false });
  });

  // Security review of 83ad212: a link to a missing file reads as "no config"
  // to a check that follows links, and the write then created its target.
  it("refuses a link at the config path that points to a missing file, and creates nothing", () => {
    const target = resolve(outer, "planted.yml");
    symlinkSync(target, resolve(project, ".plain-english.yml"));
    expect(approve({ ...REQUEST, phase: "check" })).toMatchObject({ ok: false });
    const forged = { ok: true, root: project, config: ".plain-english.yml", exists: false, hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
    expect(approve({ ...REQUEST, phase: "write", expect: forged })).toMatchObject({ ok: false });
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a sentence-shape rule and a rule that does not exist", () => {
    expect(approve({ ...REQUEST, rule: "binary-contrast", phase: "check" })).toMatchObject({ ok: false });
    const unknown = approve({ ...REQUEST, rule: "no-such-rule", phase: "check" });
    expect(unknown).toMatchObject({ ok: false });
    expect(String(unknown["message"])).toMatch(/no-such-rule/);
  });

  it("refuses a passage where a single term belongs", () => {
    // Multi-word names are allowed, as before the move; punctuation marks a passage.
    expect(approve({ ...REQUEST, term: "We use it, always.", phase: "check" })).toMatchObject({ ok: false });
  });
});
