/**
 * The Claude Code plugin under `integrations/claude-code-plugin/` and the
 * marketplace file that publishes it.
 *
 * Three things must agree or an install breaks without a word from anyone:
 * the marketplace entry's name is the install key and the manifest's name is
 * what the mod's components are namespaced under; the manifest's version is
 * what tells an install that a new release exists; and the bundled CLI and
 * ruleset the hooks module shells to must be the working tree's own. The
 * release script moves the version, `npm run build` writes the bundle, and
 * CI's drift job fails on a bundle nobody committed.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuleSet } from "../src/rules.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGIN = resolve(ROOT, "integrations/claude-code-plugin");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * What the Claude directory's validator held on 2026-10-08 (main @ 608bae2):
 * invisible characters in a string, a hook file that looks minified, and a
 * web address in a hook file read together with a key-looking read. The hook
 * files are the code a reviewer reads, so they stay plain text a person can.
 */
describe("the plugin's hook files as the directory reads them", () => {
  // Control characters, zero-width and direction marks, line and paragraph separators, byte-order mark.
  const INVISIBLE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\uFEFF]");
  const HOOK_FILES = ["hooks/register.ts", "hooks/wire.ts", "hooks/run-checker.mjs", "hooks/shell.mjs", "hooks/issue-tools.mjs"];

  it("contain no invisible or control characters", () => {
    for (const file of HOOK_FILES) {
      const lines = readFileSync(resolve(PLUGIN, file), "utf8").split("\n");
      const found = lines.flatMap((line, index) =>
        INVISIBLE.test(line) ? [`${file}:${index + 1}`] : []);
      expect(found, file).toEqual([]);
    }
  });

  it("have no line long enough to read as minified", () => {
    for (const file of HOOK_FILES) {
      const longest = Math.max(...readFileSync(resolve(PLUGIN, file), "utf8").split("\n").map((line) => line.length));
      expect(longest, file).toBeLessThanOrEqual(1000);
    }
  });

  it("keep invisible and control characters out of the bundled checker too", () => {
    const dist = resolve(PLUGIN, "dist");
    for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())) {
      const path = resolve(entry.parentPath, entry.name);
      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines.flatMap((line, index) => INVISIBLE.test(line) ? [index + 1] : []), path).toEqual([]);
    }
  });

  // The pre-submission checklist: "Keep every file that isn't an image or font
  // under 256 KiB" and "Keep the plugin to 512 files or fewer", both held as
  // "Files or downloads the validator couldn't inspect".
  it("keep every file under the directory's 256 KiB read limit, and the plugin under 512 files", () => {
    const all = readdirSync(PLUGIN, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !resolve(entry.parentPath).includes(`${resolve(PLUGIN, ".claude-plugin", "types")}`));
    expect(all.length).toBeLessThanOrEqual(512);
    for (const file of all) {
      const path = resolve(file.parentPath, file.name);
      if (/\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(file.name)) continue;
      expect(statSync(path).size, path).toBeLessThan(256 * 1024);
    }
  });

  // The directory's "Uses a credential" hold pairs any web address in a file
  // with any read it takes for a credential. Library comments carried most of
  // them, so the bundles ship without comments. Every address left must come
  // from this project's own source: agent documentation links, this
  // repository's pages and the SARIF schema identifier.
  it("carry no web address that this project's own source does not", () => {
    const pattern = /https?:\/\/[^\s"'`)<>\]]+/g;
    const own = new Set<string>();
    for (const entry of readdirSync(resolve(ROOT, "src"), { recursive: true, withFileTypes: true }).filter((item) => item.isFile()))
      for (const address of readFileSync(resolve(entry.parentPath, entry.name), "utf8").match(pattern) ?? []) own.add(address);
    for (const address of readFileSync(resolve(ROOT, "rules/default.yml"), "utf8").match(pattern) ?? []) own.add(address);
    for (const entry of readdirSync(resolve(PLUGIN, "dist"), { recursive: true, withFileTypes: true }).filter((item) => item.isFile())) {
      const path = resolve(entry.parentPath, entry.name);
      const foreign = (readFileSync(path, "utf8").match(pattern) ?? []).filter((address) => !own.has(address));
      expect(foreign, path).toEqual([]);
    }
  });

  // Windows CI, 2026-10-08: a path compared with backslashes let the split
  // move the CLI's own entry module out of cli.mjs.
  it("keep the CLI's entry module in dist/cli.mjs when the bundle is split", () => {
    expect(readFileSync(resolve(PLUGIN, "dist/cli.mjs"), "utf8")).toContain("catch AI writing tells before they land");
  });

  // Held as "Mod starts a program with a command the directory couldn't read
  // in full": every program the mod starts is written as fixed text.
  it("start every program with a command written as fixed text", () => {
    const source = readFileSync(resolve(PLUGIN, "hooks/register.ts"), "utf8");
    const commands = [...source.matchAll(/\$\.process\.(?:run\(|spawn\(\{\s*argv:\s*)(\[[^\]]*\])/g)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const command of commands) {
      expect(command, command).toMatch(/^\[\s*'[^'$`]*'(?:\s*,\s*'[^'$`]*')*\s*\]$/);
    }
    // The settings each run gets are fixed text too; anything computed goes in
    // the request on standard input.
    const settings = [...source.matchAll(/\benv:\s*(\{[^}]*\})/g)].map((match) => match[1]!);
    expect(settings.length).toBeGreaterThanOrEqual(7);
    for (const env of settings) {
      expect(env, env).toMatch(/^\{\s*[A-Z_]+:\s*'[^'$`]*'(?:\s*,\s*[A-Z_]+:\s*'[^'$`]*')*\s*\}$/);
    }
  });

  it("run the checker from the plugin folder in the project folder the mod names", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-wrapper-"));
    try {
      writeFileSync(resolve(dir, "notes.md"), "Furthermore, it works.\n");
      const ran = spawnSync(process.execPath, ["hooks/run-checker.mjs", "lint"], {
        cwd: PLUGIN,
        encoding: "utf8",
        input: JSON.stringify({ cwd: dir, paths: ["notes.md"] }),
        env: { ...process.env, PLAIN_ENGLISH_CHECK_TIMEOUT_MS: "20000" },
      });
      expect(ran.stdout + ran.stderr).toContain("furthermore");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explain that source prose needs the npm package, since the plugin leaves the parser out", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-plugin-source-"));
    try {
      writeFileSync(resolve(dir, "a.ts"), 'const greeting = "Hello there.";\n');
      const ran = spawnSync(process.execPath, [resolve(PLUGIN, "dist/cli.mjs"), "lint", "--source-prose", resolve(dir, "a.ts")], { cwd: dir, encoding: "utf8" });
      expect(ran.status).toBe(2);
      expect(ran.stderr).toContain("npm package");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ship the issue-tool name pattern without an HTML library or a web address", () => {
    const issueTools = readFileSync(resolve(PLUGIN, "hooks/issue-tools.mjs"), "utf8");
    expect(issueTools).not.toMatch(/htmlparser2|node_modules/);
    expect(issueTools).not.toMatch(/https?:\/\//);
    // Revalidated on b6d97f1: the directory read `${WRITE_NAMES}` as "a
    // command assembled at run time", so the pattern is one fixed string.
    expect(issueTools).not.toContain("${");
    expect(issueTools).toContain("ISSUE_TOOLS");
  });
});

/**
 * The directory's icon rule, read on 2026-10-08: a square PNG at
 * `.claude-plugin/icon.png`, 512 to 2048 px a side, under 2 MB. It keeps the
 * first icon it sees, so a wrong file here cannot be corrected later.
 */
describe("the plugin's directory icon", () => {
  it("is a square PNG of 512 to 2048 px, under 2 MB, where the directory looks", () => {
    const icon = readFileSync(resolve(PLUGIN, ".claude-plugin/icon.png"));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(icon.length).toBeLessThan(2 * 1024 * 1024);
  });
});

/**
 * The directory's listing reads these fields from plugin.json, and guesses
 * from the README when they are missing. On 2026-10-08 it guessed the setup
 * guide as the terms of service and the rule list as the support page.
 */
describe("the plugin's directory listing fields", () => {
  const manifest = JSON.parse(readFileSync(resolve(PLUGIN, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
  const BLOB = "https://github.com/nordscope-fi/plain-english/blob/main/";

  it("sets every listing link and points each at a file that exists here", () => {
    for (const field of ["privacyPolicyUrl", "supportUrl", "documentationUrl", "termsOfServiceUrl"]) {
      const url = manifest[field];
      expect(typeof url, field).toBe("string");
      if (String(url).startsWith(BLOB)) {
        const path = String(url).slice(BLOB.length).split("#")[0]!;
        expect(existsSync(resolve(ROOT, path)), `${field}: ${path}`).toBe(true);
      }
    }
  });

  it("describes the default behaviour: advice on files, a hold on clear faults in replies", () => {
    expect(String(manifest["description"])).not.toMatch(/\brefuses\b/);
  });
});

describe("the Claude Code plugin", () => {
  it("creates approved vocabulary in a configuration the checker can actually load", async () => {
    const { approveTerm } = await import("../src/approve.ts");
    const directory = mkdtempSync(resolve(tmpdir(), "pe-approved-term-"));
    const path = resolve(directory, ".plain-english.yml");
    try {
      writeFileSync(path, approveTerm("", "BuildKit", "unglossed-term", "Our readers know this tool"));
      const rules = resolveRuleSet(directory);
      expect(rules.allowRe?.[0]?.re.test("BuildKit")).toBe(true);
      expect(rules.allowRe?.[0]?.re.test("BuildKitExtra")).toBe(false);
      expect(rules.allowRe?.[0]?.rules?.has("unglossed-term")).toBe(true);
      expect(rules.allowRe?.[0]?.rules?.has("leverage")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const own = json(resolve(ROOT, "package.json"));
  const manifest = json(resolve(PLUGIN, ".claude-plugin/plugin.json"));
  const marketplace = json(resolve(ROOT, ".claude-plugin/marketplace.json"));
  const entries = marketplace["plugins"] as { name: string; source: string }[];

  it("is listed in the repository's own marketplace under its manifest name", () => {
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe(manifest["name"]);
    expect(resolve(ROOT, entries[0]?.source ?? "")).toBe(PLUGIN);
  });

  it("names one hooks module that exists", () => {
    const hooks = json(resolve(PLUGIN, "hooks/hooks.json"));
    const modules = hooks["modules"] as string[];
    expect(modules).toHaveLength(1);
    expect(existsSync(resolve(PLUGIN, "hooks", modules[0] ?? ""))).toBe(true);
  });

  it("carries the repository's version, so a release reaches installs", () => {
    // A manifest that pins `version` keeps every install on the cached copy
    // until the string changes. Equal to the package version, it changes on
    // every release and never between, which is when the bundled CLI changes.
    expect(manifest["version"]).toBe(own["version"]);
  });

  it("ships the bundled CLI and the ruleset it reads", () => {
    // `pretest` runs `npm run build`, which writes both, so this reads what a
    // marketplace install would get once the build is committed.
    const bundle = readFileSync(resolve(PLUGIN, "dist/cli.mjs"), "utf8");
    expect(bundle.slice(0, 200)).toContain("// GENERATED by scripts/build-plugin.mjs");
    expect(bundle).not.toContain("from \"mdast-util-from-markdown\"");
    expect(readFileSync(resolve(PLUGIN, "rules/default.yml"), "utf8")).toBe(
      readFileSync(resolve(ROOT, "rules/default.yml"), "utf8"),
    );
  });

  it("ships the existing writing guidance without changing it", () => {
    for (const path of [
      "output-styles/plain-english.md",
      "output-styles/plain-english-brief.md",
      "output-styles/plain-english-full.md",
      "skills/writing-a-document/SKILL.md",
    ]) {
      expect(readFileSync(resolve(PLUGIN, path), "utf8")).toBe(
        readFileSync(resolve(ROOT, "integrations/claude-code", path), "utf8"),
      );
    }
  });

  it("approves an exact term for one rule without erasing existing config comments", async () => {
    const { approveTerm } = await import("../src/approve.ts");
    const config = "# Team choices\nextends: default\nchat:\n  failOn: never\nallow:\n  - pattern: Existing\n    rules: [unglossed-term]\n";
    const updated = approveTerm(config, "BuildKit", "unglossed-term", "Our readers know this tool");
    expect(updated).toContain("# Team choices");
    expect(updated).toContain("failOn: never");
    expect(updated).toContain("pattern: Existing");
    expect(updated).toContain("Our readers know this tool");
    expect(updated).toContain("BuildKit");
    expect(updated).toContain("unglossed-term");
    expect(updated).toContain("semantic: true");
  });

  it("has a README and a licence, as the directory requires", () => {
    const readme = readFileSync(resolve(PLUGIN, "README.md"), "utf8");
    expect(readme.split(/\s+/).length).toBeGreaterThan(40);
    expect(manifest["license"]).toBe("MIT");
  });
  it("includes the project copyright and permission notice in standalone installs", () => {
    expect(readFileSync(resolve(PLUGIN, "LICENSE"), "utf8")).toBe(
      readFileSync(resolve(ROOT, "LICENSE"), "utf8"),
    );
  });
  it("ships full notices for bundled dependencies, including the legacy format package", () => {
    const notices = readFileSync(resolve(PLUGIN, "THIRD-PARTY-NOTICES.txt"), "utf8");
    expect(notices).toContain("format@0.2.2");
    expect(notices).toContain("Copyright 2010 - 2013 Sami Samhuri <sami@samhuri.net>");
    expect(notices).toContain("Copyright 2010 - 2014 Sami Samhuri sami@samhuri.net");
    expect(notices).toContain("yaml@");
    expect(notices).toContain("Permission to use, copy, modify, and/or distribute this software");
    expect(notices).not.toContain("vitest@");
    expect(notices).not.toContain("esbuild@");
    expect(notices).not.toContain(ROOT);
  });
  it("fails on an unreviewed missing license but excludes code omitted from the bundle", async () => {
    const { thirdPartyNotices } = await import("../scripts/build-plugin.mjs");
    const directory = mkdtempSync(resolve(tmpdir(), "pe-license-graph-"));
    try {
      const packageRoot = resolve(directory, "node_modules/unlicensed");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(resolve(packageRoot, "package.json"), JSON.stringify({ name: "unlicensed", version: "1.0.0", license: "MIT" }));
      writeFileSync(resolve(packageRoot, "NOTICE"), "Copyright Fixture Author\n");
      const metafile = { outputs: { bundle: { inputs: { "node_modules/unlicensed/index.js": { bytesInOutput: 5 } } } } };
      expect(() => thirdPartyNotices([metafile], directory)).toThrow("No license text for bundled unlicensed@1.0.0");
      metafile.outputs.bundle.inputs["node_modules/unlicensed/index.js"].bytesInOutput = 0;
      expect(thirdPartyNotices([metafile], directory)).not.toContain("unlicensed@");
      writeFileSync(resolve(packageRoot, "COPYING.txt"), "Permission is granted.\n");
      metafile.outputs.bundle.inputs["node_modules/unlicensed/index.js"].bytesInOutput = 5;
      const notices = thirdPartyNotices([metafile], directory);
      expect(notices).toContain("--- COPYING.txt ---\nPermission is granted.");
      expect(notices).toContain("--- NOTICE ---\nCopyright Fixture Author");
      expect(notices).not.toContain(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("checks stale project and dependency notices without changing the artifacts", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "pe-license-drift-"));
    try {
      for (const path of ["dist", "src", "rules", "integrations/claude-code", "integrations/claude-code-plugin", "scripts/licenses"]) {
        cpSync(resolve(ROOT, path), resolve(directory, path), { recursive: true });
      }
      for (const path of ["scripts/build-plugin.mjs", "package.json", "LICENSE"]) cpSync(resolve(ROOT, path), resolve(directory, path));
      symlinkSync(resolve(ROOT, "node_modules"), resolve(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const generated = spawnSync(process.execPath, ["scripts/build-plugin.mjs"], { cwd: directory, encoding: "utf8", timeout: 15_000 });
      expect(generated.status, generated.stderr).toBe(0);
      const run = () => spawnSync(process.execPath, ["scripts/build-plugin.mjs", "--check"], { cwd: directory, encoding: "utf8", timeout: 15_000 });
      const initial = run();
      expect(initial.status, initial.stderr).toBe(0);
      for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
        const path = resolve(directory, "integrations/claude-code-plugin", name);
        const original = readFileSync(path, "utf8");
        const tampered = original + "stale artifact\n";
        writeFileSync(path, tampered);
        const checked = run();
        expect(checked.status, checked.stderr).toBe(1);
        expect(checked.stderr).toContain(name);
        expect(readFileSync(path, "utf8")).toBe(tampered);
        writeFileSync(path, original);
      }
      expect(run().status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
