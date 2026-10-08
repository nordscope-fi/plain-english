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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = resolve(root, "integrations", "claude-code-plugin");
const entry = resolve(root, "dist", "cli.js");
const rulesFrom = resolve(root, "rules", "default.yml");
const rulesTo = resolve(plugin, "rules", "default.yml");
const packageTo = resolve(plugin, "package.json");
const shellTo = resolve(plugin, "hooks/shell.mjs");
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

/**
 * Write each raw control character as a `\u00XX` escape.
 *
 * esbuild copies a dependency's string constants byte for byte, and the YAML
 * library keeps three of its lexer markers as raw control characters. The
 * Claude directory holds a mod with invisible characters in a string, so a
 * reader must be able to see them. In JavaScript source a raw control
 * character can only stand inside a string, template, regular expression or
 * comment, and the escape means the same character in all four.
 */
export function visibleControls(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
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
  "// One piece of the plain-english CLI, split so every file stays under the",
  "// Claude directory's 256 KiB read limit. dist/cli.mjs is the entry.",
  "import { createRequire as __createRequire } from 'node:module';",
  "const require = __createRequire(import.meta.url);",
].join("\n");

/** Under the directory's 256 KiB read limit (262,144 bytes), with room for escapes. */
const SPLIT_AT = 240 * 1024;

/**
 * The plugin's checker never parses JavaScript. Only `lint --source-prose`
 * does, and neither the mod nor the pre-commit hooks run it. `@babel/parser`
 * is one 573 KB module, which no split can bring under the read limit, so the
 * plugin's copy carries this stand-in and the npm package keeps the feature.
 */
const SOURCE_PARSER_STUB = "export function parse() { throw new Error(" + JSON.stringify(
  "--source-prose needs the plain-english npm package. The Claude Code plugin's checker leaves the JavaScript parser out to keep every file readable. Run `npx plain-english lint --source-prose` instead.",
) + "); }";

const noSourceParser = { name: "no-source-parser", setup(b) {
  b.onResolve({ filter: /^@babel\/parser$/ }, () => ({ path: "@babel/parser", namespace: "plain-english-stub" }));
  b.onLoad({ filter: /.*/, namespace: "plain-english-stub" }, () => ({ contents: SOURCE_PARSER_STUB, loader: "js" }));
} };

/**
 * Bundle the CLI as `dist/cli.mjs` and the pieces it imports, each under
 * SPLIT_AT.
 *
 * The Claude directory reads only the first 256 KiB of a file and holds a
 * plugin with a larger one. The CLI is about 1.1 MB without the parser, so it
 * ships in pieces. Start from one entry; while any output is too large, make
 * the largest module inside it an entry of its own, so esbuild's code splitting
 * moves that module and what only it reaches into separate files. The largest
 * single module is about 61 KB, so this always ends, with far fewer files than
 * one per module. The pieces are readable ES modules like the single bundle was.
 */
export async function bundleCli() {
  if (!existsSync(entry)) {
    throw new Error("dist/cli.js is missing. Run `tsc -p tsconfig.json` first.");
  }
  const entryPoints = { cli: entry };
  // esbuild names inputs with forward slashes on every platform, Windows included.
  const chosen = new Set([relative(root, entry).replace(/\\/g, "/")]);
  for (let round = 0; round < 500; round++) {
    const result = await build({
      entryPoints,
      bundle: true,
      splitting: true,
      write: false,
      outdir: resolve(plugin, "dist"),
      outExtension: { ".js": ".mjs" },
      chunkNames: "chunks/[name]-[hash]",
      platform: "node",
      format: "esm",
      target: "node20",
      // Readable on purpose. The plugin directory's scanner reads what it
      // installs, and a reviewer should be able to as well.
      minify: false,
      legalComments: "none",
      metafile: true,
      banner: { js: BANNER },
      absWorkingDir: root,
      // One name per file. Through a Windows junction, a module named by its
      // linked path and by its real path counted as two, so splitting one off
      // never shrank the piece that held the other.
      preserveSymlinks: true,
      logLevel: "silent",
      plugins: [noSourceParser],
    });
    let split = false;
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.bytes <= SPLIT_AT) continue;
      const [largest] = Object.entries(output.inputs)
        .filter(([input]) => !input.includes(":") && !chosen.has(input))
        .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
        .map(([input]) => input);
      if (!largest) {
        const [piece] = Object.entries(result.metafile.outputs).filter(([, o]) => o === output).map(([path]) => path);
        throw new Error(`A piece of the bundled CLI is over the read limit and cannot be split further: ${piece} (${output.bytes} bytes) holds ${Object.keys(output.inputs).join(", ")}.`);
      }
      chosen.add(largest);
      const name = largest.replace(/^dist\//, "").replace(/node_modules\//g, "").replace(/\.(?:[cm]?js|json)$/, "").replace(/[^\w/.-]/g, "_");
      entryPoints[`parts/${name}`] = resolve(root, largest);
      split = true;
    }
    if (!split) {
      return {
        files: result.outputFiles.map((file) => ({ path: relative(resolve(plugin, "dist"), file.path), text: visibleControls(file.text) })),
        metafile: result.metafile,
      };
    }
  }
  throw new Error("Splitting the bundled CLI under the read limit did not finish.");
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => relative(dir, resolve(item.parentPath, item.name)));
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const check = process.argv.includes("--check");
  const cliBuild = await bundleCli();
  const distDir = resolve(plugin, "dist");
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
  const shell = visibleControls(shellBuild.outputFiles[0].text);
  const issueBuild = await build({
    stdin: { contents: "export { ISSUE_TOOLS } from './src/agents/issue-tools.ts';", resolveDir: root, sourcefile: "plugin-issue-entry.ts", loader: "ts" },
    bundle: true, write: false, platform: "neutral", format: "esm", target: "es2022",
    legalComments: "none", logLevel: "silent", absWorkingDir: root,
    banner: { js: "// GENERATED by scripts/build-plugin.mjs from src/agents/issue-tools.ts. Do not edit." },
  });
  const issueTools = visibleControls(issueBuild.outputFiles[0].text);
  const rules = readFileSync(rulesFrom, "utf8");
  const license = readFileSync(licenseFrom, "utf8");
  const notices = thirdPartyNotices([cliBuild.metafile, shellBuild.metafile]);
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const pkg = pluginPackageJson(version);

  const stale = [];
  const shipped = new Set(filesUnder(distDir));
  for (const file of cliBuild.files) {
    const target = resolve(distDir, file.path);
    if (!shipped.delete(file.path) || readFileSync(target, "utf8") !== file.text) stale.push(`dist/${file.path}`);
  }
  for (const leftover of shipped) stale.push(`dist/${leftover} (no longer built)`);
  if (!existsSync(rulesTo) || readFileSync(rulesTo, "utf8") !== rules) {
    stale.push("rules/default.yml");
  }
  if (!existsSync(packageTo) || readFileSync(packageTo, "utf8") !== pkg) stale.push("package.json");
  if (!existsSync(shellTo) || readFileSync(shellTo, "utf8") !== shell) stale.push("hooks/shell.mjs");
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
    // Written whole, so a piece the split no longer produces does not linger.
    rmSync(distDir, { recursive: true, force: true });
    for (const file of cliBuild.files) {
      const target = resolve(distDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text, "utf8");
    }
    mkdirSync(dirname(rulesTo), { recursive: true });
    copyFileSync(rulesFrom, rulesTo);
    writeFileSync(packageTo, pkg, "utf8");
    writeFileSync(shellTo, shell, "utf8");
    writeFileSync(issueTo, issueTools, "utf8");
    copyFileSync(licenseFrom, licenseTo);
    writeFileSync(noticesTo, notices, "utf8");
    for (const path of guidancePaths) {
      const target = resolve(plugin, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, "integrations/claude-code", path), target);
    }
    const largest = Math.max(...cliBuild.files.map((file) => Buffer.byteLength(file.text, "utf8")));
    process.stdout.write(
      `plugin: ${stale.length ? "wrote" : "unchanged"} integrations/claude-code-plugin/dist/ (${cliBuild.files.length} files, largest ${Math.round(largest / 1024)} KB)\n`,
    );
  }
}
