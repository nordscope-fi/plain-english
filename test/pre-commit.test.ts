import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const REPO = resolve(import.meta.dirname, "..");
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pre-commit Git-source installation", () => {
  it("ships a discoverable manifest and runs both stages without a build or global executable", () => {
    const manifest = readFileSync(resolve(REPO, ".pre-commit-hooks.yaml"), "utf8");
    expect(readFileSync(resolve(REPO, "integrations/pre-commit/.pre-commit-hooks.yaml"), "utf8")).toBe(manifest);
    const hooks = parse(manifest) as { id: string; entry: string; language: string; stages?: string[] }[];
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8"));
    const root = mkdtempSync(resolve(tmpdir(), "pe-pre-commit-")); fixtures.push(root);
    // Copy only the committed, self-contained executable and its runtime data.
    // There is no top-level dist, dependency installation, or PATH fallback.
    // The executable imports the other pieces of the bundled CLI beside it.
    const pieces = readdirSync(resolve(REPO, "integrations/claude-code-plugin/dist"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(REPO, resolve(entry.parentPath, entry.name)));
    for (const path of [...pieces, "integrations/claude-code-plugin/rules/default.yml", "integrations/claude-code-plugin/package.json"]) {
      const target = resolve(root, "package", path); mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(REPO, path), target);
    }
    expect(existsSync(resolve(root, "package/dist"))).toBe(false);
    expect(existsSync(resolve(root, "package/node_modules"))).toBe(false);
    const project = resolve(root, "project"); mkdirSync(resolve(project, ".git"), { recursive: true });
    writeFileSync(resolve(project, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: never\nmodelChecks: false\n");
    expect(hooks.map((hook) => hook.id)).toEqual(["plain-english", "plain-english-commit-msg"]);
    for (const hook of hooks) {
      expect(hook.language).toBe("node");
      const [command, ...args] = hook.entry.split(/\s+/);
      expect(command).toBe("plain-english-pre-commit");
      const path = hook.stages?.includes("commit-msg") ? ".git/COMMIT_EDITMSG" : "notes.md";
      for (const [text, status] of [["We leverage this approach.", 1], ["The cache expires hourly.", 0]] as const) {
        writeFileSync(resolve(project, path), text);
        const out = spawnSync(process.execPath, [resolve(root, "package", pkg.bin[command!]), ...args, path], {
          cwd: project, encoding: "utf8", env: { ...process.env, PLAIN_ENGLISH_CHAT_JUDGE: "1" },
        });
        expect(out.status, out.stdout + out.stderr).toBe(status);
      }
    }
  });
});
