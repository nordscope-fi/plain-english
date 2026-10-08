import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { extractSourceProse, lintSourceText } from "../src/source-prose.ts";
import { compile, loadDefault } from "../src/rules.ts";
import { toSarif } from "../src/format/sarif.ts";

const rules = compile(loadDefault());
const ids = (source: string, filename = "copy.tsx") => lintSourceText(source, rules, { filename }).findings.map(f => f.ruleId);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("source prose extraction", () => {
  it("checks strings and JSX while excluding identifiers, keys, imports and types", () => {
    const source = `import leverage from 'leverage'; export { leverage } from 'leverage';
type Label = 'leverage'; interface Shape { 'leverage': string }
const obj = { 'leverage': 'The cache expires.' }; obj['leverage']; require('leverage'); import('leverage');
const view = <div className="leverage" data-kind={'leverage'}><p title="We leverage this.">We leverage this.</p></div>;
const copy = { help: 'We leverage this.' };`;
    expect(ids(source).filter(id => id === "leverage")).toHaveLength(3);
  });

  it("excludes comments, code elements, tagged templates and regular expressions", () => {
    const source = "// We leverage this.\nconst regex = /leverage/; const css = css`We leverage this.`; const view = <><code>We leverage this.</code><pre>We leverage this.</pre><blockquote>We leverage this.</blockquote></>;";
    expect(ids(source)).toEqual([]);
  });

  it("checks template fragments without running or inventing substitutions", () => {
    const source = 'const copy = `We leverage ${throwIfExecuted()} this.`; const split = `lever${value}age`;';
    expect(ids(source).filter(id => id === "leverage")).toHaveLength(1);
    expect(extractSourceProse(source).map(p => p.text)).toEqual(["We leverage ", " this.", "lever", "age"]);
  });

  it("accepts TypeScript assertions, generic arrow functions, enums and namespaces", () => {
    const source = `const cast = <string>'We leverage this.'; const fn = <T>(arg:T) => 'We leverage this.'; enum Labels { Help = 'We leverage this.' } namespace Copy { export const help = 'We leverage this.'; }`;
    expect(ids(source, "copy.ts").filter(id => id === "leverage")).toHaveLength(4);
  });

  it("maps escaped words and punctuation to the exact raw source", () => {
    const source = String.raw`const copy = "We lev\u0065rage this. A\u2014B.";`;
    const result = lintSourceText(source, rules);
    const word = result.findings.find(f => f.ruleId === "leverage")!;
    const dash = result.findings.find(f => f.ruleId === "em-dash")!;
    expect(word).toMatchObject({ line: 1, column: source.indexOf("lev") + 1, match: String.raw`lev\u0065rage` });
    expect(dash).toMatchObject({ line: 1, column: source.indexOf(String.raw`\u2014`) + 1, match: String.raw`\u2014`, endColumn: source.indexOf(String.raw`\u2014`) + 7 });
  });

  it("decodes ordinary escapes, code points and line continuations", () => {
    const source = String.raw`const a = "We lev\x65rage this."; const b = "We lev\u{65}rage this."; const c = "We lev\145rage this.";`;
    expect(ids(source).filter(id => id === "leverage")).toHaveLength(3);
    const continued = "const copy = 'We lev\\\n erage this.';";
    expect(extractSourceProse(continued)[0]!.text).toBe("We lev erage this.");
  });

  it("decodes JSX entities with source positions", () => {
    const source = 'const view = <p title="A &#x2014; B">We leverage &amp; share.</p>;';
    const findings = lintSourceText(source, rules).findings;
    expect(findings.find(f => f.ruleId === "em-dash")).toMatchObject({ match: "&#x2014;", column: source.indexOf("&#x2014;") + 1 });
    expect(extractSourceProse(source).map(p => p.text)).toEqual(["A \u2014 B", "We leverage & share."]);
  });

  it("checks indented JSX text and maps findings after rendered newlines", () => {
    const source = "const view = <p>\n    The cache expires.\n    We leverage this.\n</p>;";
    const finding = lintSourceText(source, rules).findings.find(f => f.ruleId === "leverage")!;
    expect(finding).toMatchObject({ line: 3, column: 8, match: "leverage", lineText: "    We leverage this." });
    expect(extractSourceProse(source)[0]!.text).toBe("The cache expires. We leverage this.");
  });

  it("retains the source end after trailing JSX indentation is removed", () => {
    const source = "const view = <p>\n    leverage\n</p>;";
    expect(lintSourceText(source, rules).findings[0]).toMatchObject({ match: "leverage", line: 2, column: 5, endLine: 2, endColumn: 13 });
  });

  it("emits exact SARIF regions for escaped source", () => {
    const source = String.raw`const copy = "A\u2014B";`;
    const findings = lintSourceText(source, rules).findings;
    const log = toSarif([{ file: resolve("copy.ts"), findings }], rules, { root: resolve("."), version: "test" }) as any;
    expect(log.runs[0].results[0].locations[0].physicalLocation.region).toMatchObject({ startLine: 1, startColumn: source.indexOf(String.raw`\u2014`) + 1, endLine: 1, endColumn: source.indexOf(String.raw`\u2014`) + 7 });
  });

  it("reports invalid syntax rather than returning a clean result", () => {
    expect(() => lintSourceText("const copy = 'unterminated", rules)).toThrow();
  });
});

describe("opt-in source prose CLI", () => {
  const cli = resolve("dist/cli.js");
  const fixture = () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-source-")); dirs.push(dir);
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: error\nexclude:\n  - ignored.ts\n");
    writeFileSync(resolve(dir, "clean.md"), "The cache expires.");
    writeFileSync(resolve(dir, "copy.ts"), "const leverage = 1; const help = 'We leverage this.';");
    writeFileSync(resolve(dir, "ignored.ts"), "const help = 'We leverage this.';");
    return dir;
  };
  const run = (dir: string, args: string[], input?: string) => spawnSync(process.execPath, [cli, "lint", ...args], { cwd: dir, encoding: "utf8", input });

  it("keeps directory scans Markdown-only until the flag is set", () => {
    const dir = fixture();
    expect(run(dir, ["."]).status).toBe(0);
    const checked = run(dir, ["--source-prose", ".", "--format", "json"]);
    expect(checked.status).toBe(1);
    const result = JSON.parse(checked.stdout);
    expect(JSON.stringify(result)).toContain("copy.ts");
    expect(JSON.stringify(result)).not.toContain("ignored.ts");
    expect(JSON.stringify(result)).toContain("leverage");
  });

  it("accepts stdin and preserves the advisory threshold", () => {
    const dir = fixture();
    const result = run(dir, ["-", "--source-prose", "--fail-on", "never", "--format", "json"], "const help = 'We leverage this.';");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files[0].findings[0].column).toBe(18);
  });

  it("returns an input error for a syntax error", () => {
    const dir = fixture();
    writeFileSync(resolve(dir, "broken.ts"), "const help = 'unterminated");
    const result = run(dir, ["broken.ts", "--source-prose"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unterminated");
    expect(result.stdout).not.toContain("clean");
  });
});
