import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { decide, type Channel, type HookPayload } from "../src/adapters/claude-hook.ts";
import { compile, loadDefault } from "../src/rules.ts";

interface RegressionCase {
  name: string;
  channel: Channel;
  expect: "deny" | "allow";
  rule?: string;
  why?: string;
  files?: Record<string, string>;
  payload: HookPayload;
}

const HERE = resolve(import.meta.dirname);
const cases: RegressionCase[] = parseYaml(
  readFileSync(resolve(HERE, "corpus", "regressions.yml"), "utf8"),
).cases;

const ruleSet = compile(loadDefault());
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "plain-english-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Replace {{TMP}} throughout a payload with the real temp dir. */
function hydrate<T>(value: T, dir: string): T {
  if (typeof value === "string") return value.replaceAll("{{TMP}}", dir) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => hydrate(v, dir)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = hydrate(v, dir);
    return out as T;
  }
  return value;
}

describe("regressions", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  for (const c of cases) {
    it(`${c.expect}: ${c.name}`, () => {
      for (const [name, content] of Object.entries(c.files ?? {})) {
        const path = resolve(tmp, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
      }

      const payload = hydrate(c.payload, tmp);
      const decision = decide(payload, c.channel, { projectDir: tmp, ruleSet });
      const detail =
        decision.findings
          .map((f) => `${f.severity} ${f.ruleId} ${JSON.stringify(f.match)}`)
          .join("; ") || "(no findings)";

      if (c.expect === "deny") {
        expect(decision.allow, detail).toBe(false);
        expect(decision.reason, detail).toBeTruthy();
        if (c.rule) {
          expect(decision.findings.map((f) => f.ruleId), detail).toContain(c.rule);
        }
      } else {
        expect(decision.allow, detail).toBe(true);
      }
    });
  }
});

describe("deny messages are actionable", () => {
  it("quotes the offending text and offers the narrow escape hatches first", () => {
    const d = decide(
      {
        tool_name: "Write",
        tool_input: { file_path: resolve(tmp, "x.md"), content: "The build failed — badly." },
      },
      "docs",
      { projectDir: tmp, ruleSet },
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('"—"');
    expect(d.reason).toContain("plain-english-disable-next-line");
    // The ack file is mentioned, but last, and marked as not the agent's call.
    const reason = d.reason!;
    expect(reason.indexOf("disable-next-line")).toBeLessThan(reason.indexOf("ack"));
    expect(reason).toContain("the human's call");
  });
});
