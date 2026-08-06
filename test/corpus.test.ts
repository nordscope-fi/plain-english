import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { lintText } from "../src/lint.ts";
import { compile, loadDefault } from "../src/rules.ts";

interface Case {
  name: string;
  expect: "pass" | "block";
  rule?: string;
  warns?: string[];
  text: string;
}

const HERE = resolve(import.meta.dirname);
const cases: Case[] = parseYaml(
  readFileSync(resolve(HERE, "corpus", "cases.yml"), "utf8"),
).cases;

const ruleSet = compile(loadDefault());

function describeFindings(r: ReturnType<typeof lintText>): string {
  if (!r.findings.length) return "(no findings)";
  return r.findings
    .map((f) => `${f.severity} ${f.ruleId} @${f.line}:${f.column} ${JSON.stringify(f.match)}`)
    .join("\n");
}

describe("corpus", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  for (const c of cases) {
    it(`${c.expect}: ${c.name}`, () => {
      const result = lintText(c.text, ruleSet);
      const errors = result.findings.filter((f) => f.severity === "error");
      const warns = result.findings.filter((f) => f.severity === "warn");

      if (c.expect === "pass") {
        expect(errors.map((f) => f.ruleId), describeFindings(result)).toEqual([]);
      } else {
        expect(errors.length, describeFindings(result)).toBeGreaterThan(0);
        if (c.rule) {
          expect(errors.map((f) => f.ruleId), describeFindings(result)).toContain(c.rule);
        }
      }

      // Warnings are asserted exactly, and an omitted `warns` means none. That
      // is what makes an `unless` clause on a warn-severity rule testable: drop
      // the clause and the case goes red instead of degrading to a silent warn.
      const expectedWarns = c.warns ?? [];
      expect(
        [...new Set(warns.map((f) => f.ruleId))].sort(),
        describeFindings(result),
      ).toEqual([...expectedWarns].sort());
    });
  }
});

describe("every rule is exercised", () => {
  it("has at least one case naming each error rule", () => {
    const named = new Set(cases.flatMap((c) => (c.rule ? [c.rule] : [])));
    const warned = new Set(cases.flatMap((c) => c.warns ?? []));
    const uncovered = ruleSet.rules
      .filter((r) => r.severity !== "off")
      .filter((r) => !named.has(r.id) && !warned.has(r.id))
      .map((r) => r.id);
    expect(uncovered, `rules with no corpus case: ${uncovered.join(", ")}`).toEqual([]);
  });
});
