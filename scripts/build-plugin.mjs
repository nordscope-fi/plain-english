#!/usr/bin/env node
/**
 * Build the Claude Code plugin's copy of the CLI.
 *
 * The plugin under integrations/claude-code-plugin/ is a mod: its hooks module
 * shells to this package's CLI for every decision, so the CLI has to travel
 * with the plugin. A plugin installed from a marketplace is copied as it is
 * in git, with no build step and no `npm install` of its own, so the copy is
 * committed: one bundled file with every dependency inlined, and the ruleset
 * beside it where `rules.ts` looks for it (`../rules/default.yml`).
 *
 * Why a bundle and not a lockfile. Claude Code does install a plugin's npm
 * packages from a lockfile, but a lockfile can only pin a version that is
 * already published, and this repository bumps its version before it
 * publishes. The bundle is built from the working tree, so the plugin at any
 * commit carries the linter at that commit, and `claude --plugin-dir` runs
 * the code being worked on.
 *
 * Runs as part of `npm run build`. CI's drift job diffs integrations/ after a
 * build, so a bundle somebody forgot to commit fails there with the same
 * message as a stale rendered doc. Pass --check to fail here instead when the
 * committed copy differs from a fresh build.
 */

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = resolve(root, "integrations", "claude-code-plugin");
const entry = resolve(root, "dist", "cli.js");
const outFile = resolve(plugin, "dist", "cli.mjs");
const rulesFrom = resolve(root, "rules", "default.yml");
const rulesTo = resolve(plugin, "rules", "default.yml");
const packageTo = resolve(plugin, "package.json");
const shellTo = resolve(plugin, "hooks/shell.mjs");
const approvalTo = resolve(plugin, "hooks/approval.mjs");
const issueTo = resolve(plugin, "hooks/issue-tools.mjs");
const licenseFrom = resolve(root, "LICENSE");
const licenseTo = resolve(plugin, "LICENSE");
const noticesTo = resolve(plugin, "THIRD-PARTY-NOTICES.txt");
const guidancePaths = [
  "output-styles/plain-english.md",
  "output-styles/plain-english-brief.md",
  "output-styles/plain-english-full.md",
  "skills/writing-a-document/SKILL.md",
];

/**
 * The package.json the bundled CLI reads its own version from (`--version`,
 * `doctor`). Nothing else: no dependencies and no lockfile, so Claude Code
 * runs no install when it copies the plugin in. The version is the
 * repository's at build time, which the drift check holds in step.
 */
export function pluginPackageJson(version) {
  return (
    JSON.stringify(
      {
        name: "plain-english-claude-code-plugin",
        version,
        private: true,
        type: "module",
        description:
          "Carries the version the bundled plain-english CLI reports. Written by scripts/build-plugin.mjs.",
      },
      null,
      2,
    ) + "\n"
  );
}

/** Preserve licenses only for package inputs that contribute shipped bytes. */
export function thirdPartyNotices(metafiles, base = root) {
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, contribution] of Object.entries(output.inputs)) {
        if (contribution.bytesInOutput <= 0 || !input.split(/[\\/]/).includes("node_modules")) continue;
        let directory = dirname(resolve(base, input));
        let found = false;
        while (directory !== dirname(directory)) {
          const manifest = resolve(directory, "package.json");
          if (existsSync(manifest)) {
            const pkg = JSON.parse(readFileSync(manifest, "utf8"));
            if (typeof pkg.name === "string" && typeof pkg.version === "string") {
              const key = `${pkg.name}@${pkg.version}`;
              const files = readdirSync(directory, { withFileTypes: true })
                .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name))
                .map(entry => entry.name).sort();
              let texts = files.map(file => ({ file, text: readFileSync(resolve(directory, file), "utf8") }));
              if (!files.some(file => /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(file))) {
                // This exact legacy release refers to MIT by URL but omits its
                // license file. Its reviewed notice preserves both copyrights.
                if (key === "format@0.2.2" && pkg.licenses?.some(license => license.type === "MIT" && license.url === "http://sjs.mit-license.org")) {
                  texts.push({ file: "reviewed format@0.2.2 notice", text: readFileSync(resolve(root, "scripts/licenses/format-0.2.2.txt"), "utf8") });
                } else {
                  throw new Error(`No license text for bundled ${key}. Add a reviewed notice before distributing this package.`);
                }
              }
              if (texts.some(notice => notice.text.trim() === "")) throw new Error(`Empty license or notice text for bundled ${key}.`);
              const declared = typeof pkg.license === "string" ? pkg.license : pkg.licenses?.map(license => license.type).join(", ") ?? "See license text below";
              const section = [`${key}\nDeclared license: ${declared}\n`, ...texts.map(({ file, text }) => `--- ${file} ---\n${text.replace(/\r\n/g, "\n").trimEnd()}\n`)].join("\n");
              if (packages.has(key) && packages.get(key) !== section) throw new Error(`Conflicting license notices for bundled ${key}.`);
              packages.set(key, section);
              found = true;
              break;
            }
          }
          directory = dirname(directory);
        }
        if (!found) throw new Error("A bundled dependency input has no package name and version.");
      }
    }
  }
  const sections = [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, section]) => section);
  return "GENERATED by scripts/build-plugin.mjs. Do not edit.\n\n" +
    "Third-party code included in the plugin's bundled JavaScript.\n" +
    "Package versions and full license notices follow.\n\n" + sections.join("\n".concat("=".repeat(72), "\n\n"));
}

const BANNER = [
  "// GENERATED by scripts/build-plugin.mjs from dist/cli.js. Do not edit.",
  "// The plain-english CLI with every dependency inlined, so the Claude Code",
  "// plugin runs it with nothing installed beside it.",
  "import { createRequire as __createRequire } from 'node:module';",
  "const require = __createRequire(import.meta.url);",
].join("\n");

/** Bundle the CLI into one ES module and return its text. */
export async function bundleCli({ includeMetafile = false } = {}) {
  if (!existsSync(entry)) {
    throw new Error("dist/cli.js is missing. Run `tsc -p tsconfig.json` first.");
  }
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    // Readable on purpose. The plugin directory's scanner reads what it
    // installs, and a reviewer should be able to as well.
    minify: false,
    legalComments: "none",
    metafile: includeMetafile,
    banner: { js: BANNER },
    absWorkingDir: root,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output");
  return includeMetafile ? { text: file.text, metafile: result.metafile } : file.text;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const check = process.argv.includes("--check");
  const cliBuild = await bundleCli({ includeMetafile: true });
  const fresh = cliBuild.text;
  const shellBuild = await build({
    stdin: {
      contents: "export { classifyShellCommand } from './src/shell.ts';",
      resolveDir: root,
      sourcefile: "plugin-shell-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    legalComments: "none",
    metafile: true,
    absWorkingDir: root,
    banner: { js: "// GENERATED by scripts/build-plugin.mjs from src/shell.ts. Do not edit." },
    logLevel: "silent",
    plugins: [{ name: "unused-node-path", setup(build) {
      build.onResolve({ filter: /^node:path$/ }, args => ({ path: args.path, external: true, sideEffects: false }));
    } }],
  });
  const shell = shellBuild.outputFiles[0].text;
  const approvalBuild = await build({
    entryPoints: [resolve(root, "scripts/approve-term.mjs")],
    bundle: true, write: false, platform: "neutral", format: "esm", target: "es2022",
    legalComments: "none", logLevel: "silent", metafile: true, absWorkingDir: root,
    banner: { js: "// GENERATED by scripts/build-plugin.mjs from scripts/approve-term.mjs. Do not edit." },
  });
  const approval = approvalBuild.outputFiles[0].text;
  const issueBuild = await build({
    stdin: { contents: "export { ISSUE_TOOLS } from './src/agents/issue.ts';", resolveDir: root, sourcefile: "plugin-issue-entry.ts", loader: "ts" },
    bundle: true, write: false, platform: "neutral", format: "esm", target: "es2022",
    legalComments: "none", logLevel: "silent", absWorkingDir: root,
    banner: { js: "// GENERATED by scripts/build-plugin.mjs from src/agents/issue.ts. Do not edit." },
  });
  const issueTools = issueBuild.outputFiles[0].text;
  const rules = readFileSync(rulesFrom, "utf8");
  const license = readFileSync(licenseFrom, "utf8");
  const notices = thirdPartyNotices([cliBuild.metafile, shellBuild.metafile, approvalBuild.metafile]);
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const pkg = pluginPackageJson(version);

  const stale = [];
  if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== fresh) stale.push("dist/cli.mjs");
  if (!existsSync(rulesTo) || readFileSync(rulesTo, "utf8") !== rules) {
    stale.push("rules/default.yml");
  }
  if (!existsSync(packageTo) || readFileSync(packageTo, "utf8") !== pkg) stale.push("package.json");
  if (!existsSync(shellTo) || readFileSync(shellTo, "utf8") !== shell) stale.push("hooks/shell.mjs");
  if (!existsSync(approvalTo) || readFileSync(approvalTo, "utf8") !== approval) stale.push("hooks/approval.mjs");
  if (!existsSync(issueTo) || readFileSync(issueTo, "utf8") !== issueTools) stale.push("hooks/issue-tools.mjs");
  if (!existsSync(licenseTo) || readFileSync(licenseTo, "utf8") !== license) stale.push("LICENSE");
  if (!existsSync(noticesTo) || readFileSync(noticesTo, "utf8") !== notices) stale.push("THIRD-PARTY-NOTICES.txt");
  for (const path of guidancePaths) {
    const source = resolve(root, "integrations/claude-code", path);
    const target = resolve(plugin, path);
    if (!existsSync(target) || readFileSync(target, "utf8") !== readFileSync(source, "utf8")) {
      stale.push(path);
    }
  }

  if (check) {
    if (stale.length) {
      process.stderr.write(
        `plain-english: the Claude Code plugin's copy is stale: ${stale.join(", ")}. ` +
          "Run `npm run build` and commit integrations/claude-code-plugin/.\n",
      );
      process.exit(1);
    }
    process.stdout.write("plugin: bundle and ruleset match the working tree\n");
  } else {
    mkdirSync(dirname(outFile), { recursive: true });
    mkdirSync(dirname(rulesTo), { recursive: true });
    writeFileSync(outFile, fresh, "utf8");
    copyFileSync(rulesFrom, rulesTo);
    writeFileSync(packageTo, pkg, "utf8");
    writeFileSync(shellTo, shell, "utf8");
    writeFileSync(approvalTo, approval, "utf8");
    writeFileSync(issueTo, issueTools, "utf8");
    copyFileSync(licenseFrom, licenseTo);
    writeFileSync(noticesTo, notices, "utf8");
    for (const path of guidancePaths) {
      const target = resolve(plugin, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, "integrations/claude-code", path), target);
    }
    const kb = Math.round(Buffer.byteLength(fresh, "utf8") / 1024);
    process.stdout.write(
      `plugin: ${stale.length ? "wrote" : "unchanged"} integrations/claude-code-plugin/dist/cli.mjs (${kb} KB)\n`,
    );
  }
}
