/**
 * `checkDraft`, the function the plain-english skill's script calls on a
 * draft in Claude chat and Cowork (ADR-009). Every test runs it with an io
 * that holds only the bundled rules and throws on any other use, which is
 * what proves it reads no file and keeps no state.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDraft } from "../src/draft-check.ts";
import type { CheckerIo } from "../src/io.ts";
import { pathsFor } from "../src/paths.ts";

const RULES = readFileSync(resolve(import.meta.dirname, "../rules/default.yml"), "utf8");

function rulesOnlyIo(): CheckerIo {
  const refuse = (what: string) => (): never => {
    throw new Error(`checkDraft used io.${what}`);
  };
  return {
    cwd: "/",
    path: pathsFor("/"),
    env: {},
    home: undefined,
    now: () => 0,
    notice: refuse("notice"),
    read: refuse("read"),
    stat: refuse("stat"),
    list: refuse("list"),
    state: { get: refuse("state.get"), set: refuse("state.set") },
    defaultRules: () => RULES,
  };
}

const LONG = Array(60).fill("The build takes two minutes.").join(" ");
const ids = (report: { findings: { ruleId: string }[] }) => report.findings.map((f) => f.ruleId);

describe("checkDraft on a reply", () => {
  it("reports a stock opener and a banned word, quoting each", () => {
    const report = checkDraft({ text: "Great question. We leverage this approach.", kind: "reply" }, rulesOnlyIo());
    expect(report.status).toBe("checked");
    expect(report.kind).toBe("reply");
    expect(ids(report)).toEqual(expect.arrayContaining(["affirmation-opener", "leverage"]));
    const leverage = report.findings.find((f) => f.ruleId === "leverage");
    expect(leverage).toMatchObject({ severity: "error", line: 1, quote: "leverage" });
    expect(leverage?.message.length).toBeGreaterThan(0);
  });

  it("passes a clean reply", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "reply" }, rulesOnlyIo());
    expect(report).toMatchObject({ status: "checked", findings: [], notes: [] });
  });

  it("marks a length finding as one the person's request can justify", () => {
    const report = checkDraft({ text: LONG, kind: "reply" }, rulesOnlyIo());
    const length = report.findings.find((f) => f.ruleId === "reply-length");
    expect(length?.mayStand).toBe(true);
    for (const f of report.findings.filter((x) => x.mayStand)) {
      expect(["reply-length", "reader-load", "reply-pace"]).toContain(f.ruleId);
    }
  });

  it("returns the reply judge's checks as questions", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "reply" }, rulesOnlyIo());
    expect(report.review.map((q) => q.split(":")[0])).toEqual([
      "unexplained-terms",
      "no-let-up",
      "answers-a-question-nobody-asked",
    ]);
  });

  it("ignores a banned phrase quoted inside a code block", () => {
    const report = checkDraft({ text: "The rule flags this:\n\n```text\nWe leverage this.\n```", kind: "reply" }, rulesOnlyIo());
    expect(ids(report)).not.toContain("leverage");
  });

  it("does not let a suppression comment hide a finding", () => {
    const text = "<!-- plain-english-disable-next-line leverage: quoted -->\nWe leverage this.";
    expect(ids(checkDraft({ text, kind: "reply" }, rulesOnlyIo()))).toContain("leverage");
    expect(ids(checkDraft({ text, kind: "document" }, rulesOnlyIo()))).toContain("leverage");
  });
});

describe("checkDraft on a document", () => {
  it("reports a banned word and applies no reply limit", () => {
    expect(ids(checkDraft({ text: "We leverage this approach.", kind: "document" }, rulesOnlyIo()))).toContain("leverage");
    expect(ids(checkDraft({ text: LONG, kind: "document" }, rulesOnlyIo()))).not.toContain("reply-length");
  });

  it("returns the document judge's faults of shape as questions", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "document" }, rulesOnlyIo());
    expect(report.review).toHaveLength(8);
    for (const question of report.review) expect(question).toMatch(/^[a-z0-9-]+: \S/);
  });
});

describe("checkDraft on input it cannot check", () => {
  it.each([
    [null, "object"],
    ["We leverage this.", "object"],
    [{ text: "x", kind: "email" }, "email"],
    [{ text: "x" }, "kind"],
  ])("refuses %j as invalid", (request, named) => {
    const report = checkDraft(request, rulesOnlyIo());
    expect(report.status).toBe("invalid");
    expect(report.findings).toEqual([]);
    expect(report.notes.join(" ")).toContain(named);
  });

  it("refuses empty text as invalid and keeps the kind", () => {
    const report = checkDraft({ text: "  \n", kind: "reply" }, rulesOnlyIo());
    expect(report).toMatchObject({ status: "invalid", kind: "reply" });
  });

  it("reports a run that ran out of time as incomplete, never as checked", () => {
    const report = checkDraft({ text: "We leverage this. ".repeat(20000), kind: "document" }, rulesOnlyIo(), { budgetMs: 0 });
    expect(report.status).toBe("incomplete");
    expect(report.notes[0]).toContain("ran out of time");
  });
});
