import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { parseCommands } from "../src/shell.ts";

const REPO = resolve(import.meta.dirname, "..");
const CLI = resolve(REPO, "dist/cli.js");
const action = parse(readFileSync(resolve(REPO, "integrations/github-action/action.yml"), "utf8"));
let root: string;
beforeAll(() => { root = mkdtempSync(resolve(tmpdir(), "pe-action-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(step: string, input: string, cwd: string) {
  const template = action.runs.steps.find((entry: { name: string }) => entry.name === step).run as string;
  const command = template.replaceAll("${{ inputs.version }}", "latest")
    .replaceAll("${{ inputs.paths }}", "notes.md").replaceAll("${{ inputs.sarif-file }}", "findings.sarif")
    .replaceAll("${{ inputs.fail-on }}", input);
  const words = parseCommands(command)[0]!.words.map((word) => word.text);
  const at = words.indexOf("lint"); expect(at).toBeGreaterThan(0);
  return spawnSync(process.execPath, [CLI, ...words.slice(at)], { cwd, encoding: "utf8" });
}

describe("declared GitHub Action thresholds", () => {
  it.each(["never", "error", "warn"])("artifact generation cannot override input %s", (input) => {
    for (const local of ["never", "error", "warn"]) {
      const cwd = resolve(root, `${input}-${local}`); mkdirSync(cwd);
      writeFileSync(resolve(cwd, ".plain-english.yml"), `version: 1\nextends: default\nfailOn: ${local}\n`);
      for (const [text, severity] of [["We leverage this approach.", "error"], ["The cache silently expires.", "warn"], ["The cache expires hourly.", "none"]]) {
        writeFileSync(resolve(cwd, "notes.md"), text!);
        const artifact = run("Write SARIF", input, cwd);
        expect(artifact.status, artifact.stderr).toBe(0);
        expect(JSON.parse(artifact.stdout).runs[0].results.length).toBe(severity === "none" ? 0 : 1);
        const gate = run("Lint files", input, cwd);
        const expected = input === "never" || severity === "none" || (input === "error" && severity === "warn") ? 0 : 1;
        expect(gate.status, gate.stdout + gate.stderr).toBe(expected);
      }
    }
  });
});
