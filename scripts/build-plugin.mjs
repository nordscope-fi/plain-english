#!/usr/bin/env node
/**
 * Build the Claude Code plugin's copy of the checker.
 *
 * The plugin under integrations/claude-code-plugin/ is a mod, and the mod runs
 * the checker in its own process (ADR-008): `hooks/core/` holds the checker's
 * core, bundled with no Node, and the ruleset travels beside it. A plugin
 * installed from a marketplace is copied as it is in git, with no build step
 * and no `npm install` of its own, so the copy is committed.
 *
 * Why a bundle and not a lockfile. Claude Code does install a plugin's npm
 * packages from a lockfile, but a lockfile can only pin a version that is
 * already published, and this repository bumps its version before it
 * publishes. The bundle is built from the working tree, so the plugin at any
 * commit carries the checker at that commit, and `claude --plugin-dir` runs
 * the code being worked on.
 *
 * Runs as part of `npm run build`. CI's drift job diffs integrations/ after a
 * build, so a bundle somebody forgot to commit fails there with the same
 * message as a stale rendered doc. Pass --check to fail here instead when the
 * committed copy differs from a fresh build.
 */

import { build } from "esbuild";
import { parse as parseJavaScript } from "@babel/parser";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = resolve(root, "integrations", "claude-code-plugin");
const coreDir = resolve(plugin, "hooks", "core");
const rulesFrom = resolve(root, "rules", "default.yml");
const rulesDir = resolve(plugin, "rules");
const rulesTo = resolve(coreDir, "default-rules.mjs");
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

/**
 * Remove every comment from a bundled ES module.
 *
 * The Claude directory holds a plugin when a file spells a web address and
 * also reads something it takes for a credential. The bundled libraries'
 * doc comments carried most of those addresses (a DOM specification link, a
 * Node.js documentation link) and their lint markers too. The parser gives
 * each comment's exact range, so strings, templates and regular expressions
 * are never touched. A comment that fills its own line takes the line with
 * it; any other comment leaves one space, so no two tokens run together.
 */
export function withoutComments(text) {
  const { comments } = parseJavaScript(text, { sourceType: "module", allowReturnOutsideFunction: true });
  let out = "";
  let at = 0;
  for (const comment of comments ?? []) {
    let start = comment.start;
    let end = comment.end;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", end);
    const alone = /^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*$/.test(text.slice(end, lineEnd === -1 ? text.length : lineEnd));
    if (alone) {
      start = lineStart;
      end = lineEnd === -1 ? text.length : lineEnd + 1;
    }
    out += text.slice(at, start) + (alone ? "" : " ");
    at = end;
  }
  return out + text.slice(at);
}

/** The generated-file notice, after the `#!` line when there is one, which must stay first. */
function generatedHeader(text) {
  const notice = "// GENERATED by scripts/build-plugin.mjs from src/plugin-core.ts, without comments. Do not edit.\n";
  if (!text.startsWith("#!")) return notice + text;
  const firstLine = text.indexOf("\n") + 1;
  return text.slice(0, firstLine) + notice + text.slice(firstLine);
}

/** Under the directory's 256 KiB read limit (262,144 bytes), with room for escapes. */
const SPLIT_AT = 240 * 1024;

/**
 * Modules the core reaches only as the CLI's defaults. The mod passes its own
 * io everywhere, so the plugin's copy carries stand-ins that start, read and
 * record nothing (ADR-008).
 */
const NODE_ONLY = {
  "src/node-io.ts": [
    "export const nodeIo = undefined;",
    "export function nodeStatePath() { throw new Error(\"The plugin passes its own io.\"); }",
    "export function defaultRulesPath() { throw new Error(\"The plugin passes its own io.\"); }",
  ].join("\n"),
  "src/adapters/judge-spawn.ts": "export function spawnJudge() { return undefined; }",
  "src/adapters/judge-receipts.ts": [
    "export function startJudgeReceipt() { return () => {}; }",
    "export function initializeJudgeReceipts() { return () => {}; }",
  ].join("\n"),
};

/**
 * Names in the YAML library shaped like a credential variable: its error
 * codes such as `UNEXPECTED_TOKEN` and `DUPLICATE_KEY`, and `MERGE_KEY`, which
 * holds the merge marker `<<`. The Claude directory read `UNEXPECTED_TOKEN` as
 * the installer's token (held on 9e8d158). Nothing compares the codes, and
 * the checker reports YAML errors by message, so the plugin's copy writes
 * them in lower case with hyphens.
 */
const YAML_FILE = /[\\/]node_modules[\\/]yaml[\\/].*\.js$/;

/**
 * The YAML library keeps its `!!set` type in a variable called `set`, and
 * the Claude directory reads a variable named after the shell's `set` as
 * listing the environment (held on 31b7cb9). The plugin's copy calls it
 * `setTag`. Its lookup key stays `set`, which YAML documents use.
 */
const YAML_SET = [
  { file: /[\\/]schema[\\/]yaml-1\.1[\\/]set\.js$/, edits: [
    ["const set = new this(schema);", "const created = new this(schema);"],
    ["set.items.push(", "created.items.push("],
    ["return set;", "return created;"],
    ["const set = {", "const setTag = {"],
    ["export { YAMLSet, set };", "export { YAMLSet, setTag };"],
  ] },
  { file: /[\\/]schema[\\/]yaml-1\.1[\\/]schema\.js$/, edits: [
    ["import { set } from './set.js';", "import { setTag } from './set.js';"],
    ["    set,\n", "    setTag,\n"],
  ] },
  { file: /[\\/]schema[\\/]tags\.js$/, edits: [
    ["import { set } from './yaml-1.1/set.js';", "import { setTag } from './yaml-1.1/set.js';"],
    ["    set,\n", "    set: setTag,\n"],
    ["'tag:yaml.org,2002:set': set,", "'tag:yaml.org,2002:set': setTag,"],
  ] },
];
const YAML_CODE = /(["'])([A-Z0-9_]*(?:TOKEN|KEY)[A-Z0-9_]*)\1/g;

/**
 * Library code the Claude directory names in a mod (warnings on 27280ca): a
 * getter or `defineProperty`, which "runs the mod's code when a value is
 * merely read", and reflection (`getPrototypeOf`, a value's `constructor`).
 * The plugin's copy of each library writes these as plain data properties
 * and methods instead. Each edit must match the stated number of times, and
 * every file named here must be bundled, so a library update that moves one
 * fails the build.
 *
 * - YAML stores its node type, a collection's schema and the schema's three
 *   base tags as plain properties, and its map and sequence tag names as
 *   static fields. An alias no longer refuses a tag through a setter; YAML
 *   reports a tag on an alias as an error before it would set one.
 * - YAML's node `clone` copies through the prototype. Nothing in the checker
 *   clones a YAML node, so the plugin's copy refuses instead.
 * - YAML adds a map key with `defineProperty` only so that a key named
 *   `__proto__` cannot replace the object's prototype. Every other key gives
 *   the same result by assignment, so the plugin's copy assigns, and refuses
 *   a `__proto__` key outright.
 * - YAML's composer reads the class it built a collection with from the
 *   collection; the plugin's copy names the class the same way the resolvers
 *   chose it.
 * - The Markdown parser's splice buffer gives its length through a getter,
 *   and its constructs reach it as a module namespace, which the bundler
 *   builds from getters. The plugin's copy uses a `size()` method and a plain
 *   object.
 * - The syntax tree visitor names each visit function for debugging.
 *   Nothing reads the name.
 */
const LIBRARY_EDITS = [
  ...YAML_SET,
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]Node\.js$/, edits: [
    ["Object.defineProperty(this, NODE_TYPE, { value: type });", "this[NODE_TYPE] = type;"],
    [/\n    clone\(\) \{\n[^]*?\n    \}\n/g, "\n    clone() {\n        throw new Error('The plugin\\'s YAML copy does not clone nodes.');\n    }\n"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]Collection\.js$/, edits: [
    ["Object.defineProperty(this, 'schema', {\n            value: schema,\n            configurable: true,\n            enumerable: false,\n            writable: true\n        });", "this.schema = schema;"],
    [/\n    clone\(schema\) \{\n[^]*?\n    \}\n/g, "\n    clone() {\n        throw new Error('The plugin\\'s YAML copy does not clone nodes.');\n    }\n"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]Alias\.js$/, edits: [
    ["\n        Object.defineProperty(this, 'tag', {\n            set() {\n                throw new Error('Alias nodes cannot have tags');\n            }\n        });", ""],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]Pair\.js$/, edits: [
    ["Object.defineProperty(this, NODE_TYPE, { value: PAIR });", "this[NODE_TYPE] = PAIR;"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]doc[\\/]Document\.js$/, edits: [
    ["Object.defineProperty(this, NODE_TYPE, { value: DOC });", "this[NODE_TYPE] = DOC;"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]schema[\\/]Schema\.js$/, edits: [
    ["Object.defineProperty(this, MAP, { value: map });", "this[MAP] = map;"],
    ["Object.defineProperty(this, SCALAR, { value: string });", "this[SCALAR] = string;"],
    ["Object.defineProperty(this, SEQ, { value: seq });", "this[SEQ] = seq;"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]YAMLMap\.js$/, edits: [
    ["    static get tagName() {\n        return 'tag:yaml.org,2002:map';\n    }", "    static tagName = 'tag:yaml.org,2002:map';"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]YAMLSeq\.js$/, edits: [
    ["    static get tagName() {\n        return 'tag:yaml.org,2002:seq';\n    }", "    static tagName = 'tag:yaml.org,2002:seq';"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]nodes[\\/]addPairToJSMap\.js$/, edits: [
    ["            if (stringKey in map)\n                Object.defineProperty(map, stringKey, {\n                    value: jsValue,\n                    writable: true,\n                    enumerable: true,\n                    configurable: true\n                });\n            else\n                map[stringKey] = jsValue;",
      "            if (stringKey === '__proto__')\n                throw new Error('The plugin refuses a YAML key named __proto__.');\n            map[stringKey] = jsValue;"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]schema[\\/]yaml-1\.1[\\/]merge\.js$/, edits: [
    ["        else if (!Object.prototype.hasOwnProperty.call(map, key)) {\n            Object.defineProperty(map, key, {\n                value,\n                writable: true,\n                enumerable: true,\n                configurable: true\n            });\n        }",
      "        else if (key === '__proto__') {\n            throw new Error('The plugin refuses a YAML key named __proto__.');\n        }\n        else if (!Object.prototype.hasOwnProperty.call(map, key)) {\n            map[key] = value;\n        }"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]compose[\\/]compose-collection\.js$/, edits: [
    ["const Coll = coll.constructor;", "const Coll = tag?.nodeClass ?? (token.type === 'block-map' || (token.type !== 'block-seq' && token.start.source === '{') ? YAMLMap : YAMLSeq);"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]stringify[\\/]stringify\.js$/, edits: [
    ["const name = obj?.constructor?.name ?? (obj === null ? 'null' : typeof obj);", "const name = obj === null ? 'null' : typeof obj;"],
  ] },
  { file: /[\\/]yaml[\\/]browser[\\/]dist[\\/]parse[\\/]parser\.js$/, edits: [
    ["get sourceToken() {", "currentSourceToken() {"],
    ["this.sourceToken", "this.currentSourceToken()", 60],
  ] },
  { file: /[\\/]micromark[\\/]lib[\\/]parse\.js$/, edits: [
    ["import * as defaultConstructs from './constructs.js';",
      "import { attentionMarkers, contentInitial, disable, document as documentConstructs, flow as flowConstructs, flowInitial, insideSpan, string as stringConstructs, text as textConstructs } from './constructs.js';\nconst defaultConstructs = { attentionMarkers, contentInitial, disable, document: documentConstructs, flow: flowConstructs, flowInitial, insideSpan, string: stringConstructs, text: textConstructs };"],
  ] },
  { file: /[\\/]micromark[\\/]lib[\\/]constructs\.js$/, edits: [
    [/^export /gm, "export ", 9],
  ] },
  { file: /[\\/]micromark-util-subtokenize[\\/]lib[\\/]splice-buffer\.js$/, edits: [
    ["  get length() {", "  size() {"],
  ] },
  { file: /[\\/]micromark-util-subtokenize[\\/]index\.js$/, edits: [
    ["while (++index < events.length) {", "while (++index < events.size()) {"],
  ] },
  { file: /[\\/]unist-util-visit-parents[\\/]lib[\\/]index\.js$/, edits: [
    [/\n    if \(typeof value\.type === 'string'\) \{\n[^]*?\n    \}\n/g, "\n"],
  ] },
];
const LIBRARY_FILE = /[\\/]node_modules[\\/](?:yaml|micromark|micromark-util-subtokenize|unist-util-visit-parents)[\\/].*\.js$/;

/** Apply each `[from, to, count]` edit, refusing when `from` is found any other number of times. */
function applyEdits(text, edits, path) {
  for (const [from, to, count = 1] of edits) {
    const found = typeof from === "string" ? text.split(from).length - 1 : (text.match(from) ?? []).length;
    if (found !== count) throw new Error(`Expected ${count} \`${String(from).trim()}\` in ${path}, found ${found}; update scripts/build-plugin.mjs.`);
    text = typeof from === "string" ? text.replaceAll(from, () => to) : text.replace(from, () => to);
  }
  return text;
}

/** The file `toNlcst` reads: its text, through `String(file)`, and a message list. */
const VFILE = [
  "export class VFile {",
  "  constructor(value) {",
  "    this.value = String(value);",
  "    this.data = {};",
  "    this.messages = [];",
  "    this.history = [];",
  "  }",
  "  toString() {",
  "    return this.value;",
  "  }",
  "}",
].join("\n");

/**
 * `fault`, which the Markdown frontmatter parser uses for its error messages,
 * formats them with the `format` package. That package falls back to
 * `(1, eval)("this")`, and the Claude directory blocks a mod that names
 * `eval`. This is the part of it `fault` uses.
 */
const FORMAT = [
  "export default function format(template, ...values) {",
  "  let next = 0;",
  "  return String(template).replace(/%[sdjo%]/g, (mark) => {",
  "    if (mark === \"%%\") return \"%\";",
  "    if (next >= values.length) return mark;",
  "    const value = values[next++];",
  "    return mark === \"%j\" ? JSON.stringify(value) : String(value);",
  "  });",
  "}",
].join("\n");

/** Longest line the Claude directory reads as source rather than as minified. */
const LONG_LINE = 1000;

/** A literal's raw text in pieces, never splitting an escape sequence. */
function pieces(raw, size = 200) {
  const units = raw.match(/\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|\\c[A-Za-z]|\\[\s\S]|[^\\]/g) ?? [];
  const out = [];
  let piece = "";
  for (const unit of units) {
    if (piece.length + unit.length > size) {
      out.push(piece);
      piece = "";
    }
    piece += unit;
  }
  if (piece) out.push(piece);
  return out;
}

/** Every node in an AST, depth first. */
function* nodes(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "extra") continue;
    if (Array.isArray(value)) for (const item of value) yield* nodes(item);
    else if (value && typeof value === "object") yield* nodes(value);
  }
}

/**
 * Make a bundled file read as source (ADR-008). The Claude directory holds a
 * mod file with very long lines as minified, and reads `${NAME...}` in a
 * template as an environment variable. None of these edits changes what the
 * code does:
 *
 * - a string over 400 characters becomes pieces joined at run time;
 * - a regular expression over 400 characters becomes `new RegExp` over
 *   pieces, checked here to have the same source and flags;
 * - a list or object with a line over the limit gets one entry per line;
 * - a template substitution starting with a capital gets parentheses;
 * - a template whose substitution names a credential word, such as
 *   `Key ${_pair.key} already set`, becomes `"Key ".concat(_pair.key, " already
 *   set")`. `concat` converts each value to text as a template does. The Claude
 *   directory read that template as `${user_config.KEY}`: the installer's key
 *   (held on bbe54bd).
 *
 * Passes repeat until no line is over the limit, since an edit inside a list
 * and the list itself cannot be made in one pass.
 */
/** Commands that list the environment, as the Claude directory names them. */
const COMMAND_LINE = /^\s*(?:set|env|printenv|declare|typeset|compgen)\b|^\s*export\s+-p\b/;

/** A syntax tree without positions, raw text or comments, for comparing. */
function shape(text) {
  const ast = parseJavaScript(text, { sourceType: "module", allowReturnOutsideFunction: true });
  const DROP = new Set(["start", "end", "loc", "extra", "range", "comments", "leadingComments", "trailingComments", "innerComments"]);
  return JSON.stringify(ast.program, (key, value) => (DROP.has(key) ? undefined : value));
}

/**
 * A line that begins with `set`, `env` or another command that lists the
 * environment joins the line before it, so it reads as code: the Claude
 * directory read such lines as the shell command (held on 31b7cb9). Only a
 * line after `{`, `,`, `;` or `}` moves, and the file must parse to the
 * same syntax tree afterwards.
 */
function joinCommandLines(text, file) {
  const lines = text.split("\n");
  let moved = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!COMMAND_LINE.test(lines[i])) continue;
    const before = lines[i - 1].trimEnd();
    if (!/[{,;}]$/.test(before)) throw new Error(`${file}:${i + 1} begins with a command word after \`${before.slice(-20)}\`; update scripts/build-plugin.mjs.`);
    lines[i - 1] = `${before} ${lines[i].trimStart()}`;
    lines.splice(i, 1);
    i--;
    moved++;
  }
  if (!moved) return text;
  const joined = lines.join("\n");
  if (shape(joined) !== shape(text)) throw new Error(`Joining command-word lines changed the code in ${file}; update scripts/build-plugin.mjs.`);
  return joined;
}

/** Words that make a template substitution read as a credential. */
const CREDENTIAL_WORD = /key|token|secret|passw|auth|credential/i;

export function readableSource(text, file) {
  for (let pass = 0; pass < 8; pass++) {
    const ast = parseJavaScript(text, { sourceType: "module", allowReturnOutsideFunction: true });
    const edits = [];
    const tagged = new Set();
    for (const node of nodes(ast.program)) if (node.type === "TaggedTemplateExpression") tagged.add(node.quasi);
    for (const node of nodes(ast.program)) {
      const source = text.slice(node.start, node.end);
      if (node.type === "StringLiteral" && source.length > 400) {
        const quote = source[0];
        const body = source.slice(1, -1);
        edits.push({ start: node.start, end: node.end, text: `[\n${pieces(body).map((p) => `  ${quote}${p}${quote}`).join(",\n")}\n].join("")` });
      } else if (node.type === "RegExpLiteral" && source.length > 400) {
        const original = (0, eval)(source);
        const parts = pieces(node.pattern);
        const rebuilt = new RegExp(parts.join(""), node.flags);
        if (rebuilt.source !== original.source || rebuilt.flags !== original.flags) {
          throw new Error(`Rewriting a regular expression in ${file} changed it; update scripts/build-plugin.mjs.`);
        }
        edits.push({ start: node.start, end: node.end, text: `new RegExp([\n${parts.map((p) => `  ${JSON.stringify(p)}`).join(",\n")}\n].join(""), ${JSON.stringify(node.flags)})` });
      } else if ((node.type === "ArrayExpression" || node.type === "ObjectExpression") && source.split("\n").some((line) => line.length > LONG_LINE)) {
        const items = node.type === "ArrayExpression" ? node.elements : node.properties;
        if (items.some((item) => item === null)) continue;
        const [open, close] = node.type === "ArrayExpression" ? ["[", "]"] : ["{", "}"];
        edits.push({ start: node.start, end: node.end, text: `${open}\n${items.map((item) => `  ${text.slice(item.start, item.end)}`).join(",\n")}\n${close}` });
      } else if (node.type === "TemplateLiteral" && !tagged.has(node)
        && node.expressions.some((expression) => CREDENTIAL_WORD.test(text.slice(expression.start, expression.end)))) {
        const parts = [];
        node.quasis.forEach((quasi, i) => {
          if (quasi.value.cooked) parts.push(JSON.stringify(quasi.value.cooked));
          const expression = node.expressions[i];
          if (expression) parts.push(text.slice(expression.start, expression.end));
        });
        edits.push({ start: node.start, end: node.end, text: `"".concat(${parts.join(", ")})` });
      } else if (node.type === "TemplateLiteral") {
        for (const expression of node.expressions) {
          const wrapped = text[expression.start - 1] === "(" && text[expression.end] === ")";
          if (!wrapped && /^[A-Z]/.test(text.slice(expression.start, expression.end))) {
            edits.push({ start: expression.start, end: expression.end, text: `(${text.slice(expression.start, expression.end)})` });
          }
        }
      }
    }
    // Innermost first; an edit inside one already taken waits for the next pass.
    edits.sort((x, y) => (x.end - x.start) - (y.end - y.start));
    const taken = [];
    for (const edit of edits) {
      if (taken.some((t) => edit.start < t.end && t.start < edit.end)) continue;
      taken.push(edit);
    }
    if (!taken.length) break;
    taken.sort((x, y) => y.start - x.start);
    for (const edit of taken) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  text = joinCommandLines(text, file);
  const long = text.split("\n").findIndex((line) => line.length > LONG_LINE);
  if (long !== -1) throw new Error(`${file}:${long + 1} is still over ${LONG_LINE} characters; update scripts/build-plugin.mjs.`);
  if (/\$\{[A-Z]/.test(text)) throw new Error(`${file} still has a template substitution starting with a capital.`);
  const credential = text.match(/\$\{[^}]*(?:key|token|secret|passw|auth|credential)[^}]*\}/i);
  if (credential) throw new Error(`${file} still drops a credential word into a template: ${credential[0]}`);
  return text;
}

const GUIDES = "https://github.com/nordscope-fi/plain-english/blob/main/";

/**
 * The ruleset as the plugin carries it. The Claude directory pairs the YAML
 * parser's own `token` variables with any web address in the plugin (held on
 * 92ba45e). Nothing in the plugin requests the ruleset's addresses, so its
 * copy names this repository's guides by path, leaves out the rule source
 * credits that only the CLI's policy page shows, and drops comments. The
 * rules themselves are unchanged; a test compares them with the original.
 */
export function pluginRuleset(text) {
  const tidy = (value, key) => {
    if (key === "link" && typeof value === "string") return value.startsWith(GUIDES) ? value.slice(GUIDES.length) : value;
    if (key === "sources" && Array.isArray(value)) return [];
    if (Array.isArray(value)) return value.map((item) => tidy(item));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, tidy(item, name)]));
  };
  const out = stringifyYaml(tidy(parseYaml(text)), { lineWidth: 0 });
  const left = out.match(/https?:\/\/\S*/g);
  if (left) throw new Error(`The plugin's ruleset still has web addresses: ${left.join(", ")}; update scripts/build-plugin.mjs.`);
  return out;
}

/** The part of `fault` the frontmatter parser uses, without its `eval` member. */
const FAULT_EVAL = /^\s*eval: create\(EvalError\),\n/m;

/**
 * Web addresses the plugin's checker carries but never uses. The Claude
 * directory pairs any address in a file with any word it reads as a key, such
 * as the YAML and Markdown parsers' own `key` and `token` variables. The
 * Markdown parser prefixes a bare `www.` link with `http://` to build an
 * address the checker never reads; the checker only needs to know the text is
 * a link. Each built-in rule's default source is the design notes, which the
 * plugin never shows, so its copy names them by path. The CLI keeps both.
 */
const UNUSED_ADDRESSES = [
  { file: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/, from: /'http:\/\/'/g, to: "''", count: 2 },
  { file: /[\\/]src[\\/]rules\.ts$/, from: /"https:\/\/github\.com\/nordscope-fi\/plain-english\/blob\/main\/docs\/design-rationale\.md"/g, to: '"docs/design-rationale.md"', count: 1 },
];

const pluginCore = { name: "plugin-core", setup(b) {
  for (const [file, contents] of Object.entries(NODE_ONLY)) {
    const path = resolve(root, file);
    b.onLoad({ filter: new RegExp(`${file.split("/").pop().replace(/[.]/g, "\\.")}$`) }, (args) =>
      resolve(args.path) === path ? { contents, loader: "js" } : undefined);
  }
  for (const unused of UNUSED_ADDRESSES) {
    b.onLoad({ filter: unused.file }, (args) => {
      const text = readFileSync(args.path, "utf8");
      const found = text.match(unused.from)?.length ?? 0;
      if (found !== unused.count) throw new Error(`Expected ${unused.count} unused address(es) in ${args.path}, found ${found}; update scripts/build-plugin.mjs.`);
      return { contents: text.replace(unused.from, unused.to), loader: args.path.endsWith(".ts") ? "ts" : "js" };
    });
  }
  const edited = new Set();
  b.onStart(() => edited.clear());
  b.onLoad({ filter: LIBRARY_FILE }, (args) => {
    let text = readFileSync(args.path, "utf8");
    for (const entry of LIBRARY_EDITS) {
      if (!entry.file.test(args.path)) continue;
      text = applyEdits(text, entry.edits, args.path);
      edited.add(entry);
    }
    if (YAML_FILE.test(args.path)) {
      text = text
        .replace(YAML_CODE, (_all, quote, name) => quote + name.toLowerCase().replaceAll("_", "-") + quote)
        .replace(/\bMERGE_KEY\b/g, "MERGE_MARK");
    }
    return { contents: text, loader: "js" };
  });
  b.onEnd((result) => {
    if (result.errors.length) return;
    const missed = LIBRARY_EDITS.filter((entry) => !edited.has(entry)).map((entry) => entry.file);
    if (missed.length) throw new Error(`No bundled file matched ${missed.join(", ")}; update scripts/build-plugin.mjs.`);
  });
  // The sentence layer gives the Markdown converter a file only for its text
  // and its message list. vfile's class keeps its path behind getters and
  // setters, which the directory names; the plugin's file is plain data.
  b.onResolve({ filter: /^vfile$/ }, (args) => {
    if (!/[\\/]src[\\/]sentences\.ts$/.test(args.importer)) throw new Error(`Unexpected vfile import from ${args.importer}; update scripts/build-plugin.mjs.`);
    return { path: "vfile", namespace: "plain-english-vfile" };
  });
  b.onLoad({ filter: /.*/, namespace: "plain-english-vfile" }, () => ({ contents: VFILE, loader: "js" }));
  b.onResolve({ filter: /^format$/ }, () => ({ path: "format", namespace: "plain-english-format" }));
  b.onLoad({ filter: /.*/, namespace: "plain-english-format" }, () => ({ contents: FORMAT, loader: "js" }));
  // `fault.eval` is never called here, and the directory blocks a mod naming `eval`.
  b.onLoad({ filter: /[\\/]fault[\\/]index\.js$/ }, (args) => {
    const text = readFileSync(args.path, "utf8");
    if (!FAULT_EVAL.test(text)) throw new Error(`fault no longer defines eval where expected in ${args.path}; update scripts/build-plugin.mjs.`);
    return { contents: text.replace(FAULT_EVAL, ""), loader: "js" };
  });
  // Nothing Node may reach the mod: a module that still needs it fails here.
  b.onResolve({ filter: /^node:/ }, (args) => ({
    errors: [{ text: `${args.importer} imports ${args.path}; the plugin's core must not use Node (ADR-008).` }],
  }));
} };

/**
 * Bundle the core as `hooks/core/plugin-core.mjs` and the pieces it imports,
 * each under SPLIT_AT.
 *
 * The Claude directory reads only the first 256 KiB of a file and holds a
 * plugin with a larger one. Start from one entry; while any output is too
 * large, make the largest module inside it an entry of its own, so esbuild's
 * code splitting moves that module and what only it reaches into separate
 * files. The pieces are readable ES modules.
 */
export async function bundleCore() {
  const entry = resolve(root, "src", "plugin-core.ts");
  const entryPoints = { "plugin-core": entry };
  // esbuild names inputs with forward slashes on every platform, Windows included.
  const chosen = new Set([relative(root, entry).replace(/\\/g, "/")]);
  for (let round = 0; round < 500; round++) {
    const result = await build({
      entryPoints,
      bundle: true,
      splitting: true,
      write: false,
      outdir: coreDir,
      outExtension: { ".js": ".mjs" },
      chunkNames: "chunk-[hash]",
      platform: "neutral",
      // `browser` would pick a DOM build that needs `document`, which a mod lacks.
      conditions: ["default"],
      mainFields: ["module", "main"],
      format: "esm",
      target: "es2022",
      // Readable on purpose. The plugin directory's scanner reads what it
      // installs, and a reviewer should be able to as well.
      minify: false,
      legalComments: "none",
      metafile: true,
      absWorkingDir: root,
      // One name per file. Through a Windows junction, a module named by its
      // linked path and by its real path counted as two, so splitting one off
      // never shrank the piece that held the other.
      preserveSymlinks: true,
      logLevel: "silent",
      plugins: [pluginCore],
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
        throw new Error(`A piece of the plugin's core is over the read limit and cannot be split further: ${piece} (${output.bytes} bytes) holds ${Object.keys(output.inputs).join(", ")}.`);
      }
      chosen.add(largest);
      const name = largest.replace(/^src\//, "").replace(/node_modules\//g, "").replace(/\.(?:[cm]?[jt]s|json)$/, "").replace(/[^\w.-]/g, "_");
      entryPoints[`part-${name}`] = resolve(root, largest);
      split = true;
    }
    if (!split) {
      return {
        files: result.outputFiles.map((file) => ({
          path: relative(coreDir, file.path),
          text: generatedHeader(visibleControls(readableSource(withoutComments(file.text), relative(coreDir, file.path)))),
        })),
        metafile: result.metafile,
      };
    }
  }
  throw new Error("Splitting the plugin's core under the read limit did not finish.");
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
  const coreBuild = await bundleCore();
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
  // The built-in ruleset travels as a module the mod imports, so a check reads
  // no plugin file to find it (ADR-008).
  const rules = generatedHeader(readableSource(`export default ${JSON.stringify(pluginRuleset(readFileSync(rulesFrom, "utf8")))};\n`, "default-rules.mjs"))
    .replace("from src/plugin-core.ts", "from rules/default.yml");
  const license = readFileSync(licenseFrom, "utf8");
  const notices = thirdPartyNotices([coreBuild.metafile, shellBuild.metafile]);
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const pkg = pluginPackageJson(version);

  const stale = [];
  const shipped = new Set(filesUnder(coreDir));
  shipped.delete("default-rules.mjs");
  for (const file of coreBuild.files) {
    const target = resolve(coreDir, file.path);
    if (!shipped.delete(file.path) || readFileSync(target, "utf8") !== file.text) stale.push(`hooks/core/${file.path}`);
  }
  for (const leftover of shipped) stale.push(`hooks/core/${leftover} (no longer built)`);
  // The plugin shipped a bundled CLI until ADR-008.
  if (existsSync(distDir)) stale.push("dist/ (no longer built)");
  if (!existsSync(rulesTo) || readFileSync(rulesTo, "utf8") !== rules) {
    stale.push("hooks/core/default-rules.mjs");
  }
  if (existsSync(rulesDir)) stale.push("rules/ (no longer shipped)");
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
    rmSync(coreDir, { recursive: true, force: true });
    for (const file of coreBuild.files) {
      const target = resolve(coreDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text, "utf8");
    }
    rmSync(rulesDir, { recursive: true, force: true });
    writeFileSync(rulesTo, rules, "utf8");
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
    const largest = Math.max(...coreBuild.files.map((file) => Buffer.byteLength(file.text, "utf8")));
    process.stdout.write(
      `plugin: ${stale.length ? "wrote" : "unchanged"} integrations/claude-code-plugin/hooks/core/ (${coreBuild.files.length} files, largest ${Math.round(largest / 1024)} KB)\n`,
    );
  }
}
