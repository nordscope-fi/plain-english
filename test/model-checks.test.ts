import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../src/rules.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function config(content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-model-config-"));
  dirs.push(dir);
  const path = resolve(dir, ".plain-english.yml");
  writeFileSync(path, content);
  return path;
}

describe("model-check configuration", () => {
  it("preserves an explicit local-only choice across inherited configuration", () => {
    const path = config("version: 1\nextends: default\nmodelChecks: false\n");
    expect(loadConfig(path).modelChecks).toBe(false);
  });
});
