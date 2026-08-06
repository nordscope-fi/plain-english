#!/usr/bin/env node
/**
 * plain-english CLI.
 *
 * The point of having a CLI at all: the value of this ruleset should not depend
 * on using one particular editor. The same engine runs from a git hook, from
 * CI, from a terminal, and from a Claude Code hook.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { lintText, type Finding } from "./lint.ts";
import { resolveRuleSet, compile, loadDefault, RuleError, type RuleSet } from "./rules.ts";
import { renderAll, writeTargets } from "./render.ts";
import { decide, toHookOutput, type Channel } from "./adapters/claude-hook.ts";
import { initClaudeCode } from "./init.ts";
import { matchesAny } from "./glob.ts";

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);

interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[a.slice(2)] = next;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else if (!command) command = a;
    else positionals.push(a);
  }
  return { command, positionals, flags };
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    if (process.stdin.isTTY) res("");
  });
}

function walk(target: string, out: string[] = []): string[] {
  const st = statSync(target);
  if (st.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = resolve(target, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (MARKDOWN.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const COLOUR = process.stdout.isTTY && !process.env["NO_COLOR"];
const red = (s: string) => (COLOUR ? `\u001b[31m${s}\u001b[0m` : s);
const yellow = (s: string) => (COLOUR ? `\u001b[33m${s}\u001b[0m` : s);
const dim = (s: string) => (COLOUR ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s: string) => (COLOUR ? `\u001b[1m${s}\u001b[0m` : s);

function printText(file: string, findings: Finding[], root: string): void {
  if (!findings.length) return;
  process.stdout.write(bold(relative(root, file) || file) + "\n");
  for (const f of findings) {
    const tag = f.severity === "error" ? red("block") : yellow(" warn");
    const hint = f.message ? dim(`  ${f.message}`) : "";
    process.stdout.write(
      `  ${String(f.line).padStart(4)}:${String(f.column).padEnd(3)} ${tag}  ` +
        `${JSON.stringify(f.match)} ${dim(`(${f.ruleId})`)}${hint}\n`,
    );
  }
  process.stdout.write("\n");
}

async function cmdLint(args: Args): Promise<number> {
  const root = process.cwd();
  const ruleSet = resolveRuleSet(root);
  const format = String(args.flags["format"] ?? "text");
  const failOn = String(args.flags["fail-on"] ?? "error");

  const all: { file: string; findings: Finding[] }[] = [];

  if (!args.positionals.length || args.positionals[0] === "-") {
    const text = await readStdin();
    all.push({ file: "<stdin>", findings: lintText(text, ruleSet).findings });
  } else {
    for (const target of args.positionals) {
      const abs = resolve(root, target);
      if (!existsSync(abs)) {
        process.stderr.write(`plain-english: no such path: ${target}\n`);
        return 2;
      }
      for (const file of walk(abs)) {
        const rel = relative(root, file);
        if (matchesAny(rel, ruleSet.exclude)) continue;
        const text = readFileSync(file, "utf8");
        all.push({ file, findings: lintText(text, ruleSet).findings });
      }
    }
  }

  const errors = all.reduce((n, f) => n + f.findings.filter((x) => x.severity === "error").length, 0);
  const warns = all.reduce((n, f) => n + f.findings.filter((x) => x.severity === "warn").length, 0);

  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          errorCount: errors,
          warnCount: warns,
          files: all
            .filter((f) => f.findings.length)
            .map((f) => ({ file: relative(root, f.file) || f.file, findings: f.findings })),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (format === "github") {
    // GitHub Actions annotations.
    for (const { file, findings } of all) {
      for (const f of findings) {
        const level = f.severity === "error" ? "error" : "warning";
        process.stdout.write(
          `::${level} file=${relative(root, file)},line=${f.line},col=${f.column}::` +
            `${f.match} (${f.ruleId})${f.message ? " " + f.message : ""}\n`,
        );
      }
    }
  } else {
    for (const { file, findings } of all) printText(file, findings, root);
    const scanned = all.length;
    if (errors || warns) {
      process.stdout.write(
        `${errors} blocking, ${warns} warning${warns === 1 ? "" : "s"} across ${scanned} file${scanned === 1 ? "" : "s"}\n`,
      );
    } else {
      process.stdout.write(dim(`clean (${scanned} file${scanned === 1 ? "" : "s"})\n`));
    }
  }

  if (failOn === "warn") return errors + warns > 0 ? 1 : 0;
  if (failOn === "never") return 0;
  return errors > 0 ? 1 : 0;
}

function cmdRender(args: Args): number {
  const root = resolve(String(args.flags["root"] ?? process.cwd()));
  const set = compile(loadDefault());
  const targets = renderAll(set, root);

  if (args.flags["check"]) {
    const stale = targets.filter(
      (t) => !existsSync(t.path) || readFileSync(t.path, "utf8") !== t.content,
    );
    if (stale.length) {
      process.stderr.write(
        "plain-english: generated files are stale. Run `plain-english render`.\n" +
          stale.map((t) => `  ${relative(root, t.path)}\n`).join(""),
      );
      return 1;
    }
    process.stdout.write("generated files are up to date\n");
    return 0;
  }

  const changed = writeTargets(targets);
  if (changed.length) {
    for (const p of changed) process.stdout.write(`wrote ${relative(root, p)}\n`);
  } else {
    process.stdout.write("no changes\n");
  }
  return 0;
}

function cmdExplain(args: Args): number {
  const set: RuleSet = resolveRuleSet(process.cwd());
  const id = args.positionals[0];
  if (!id) {
    for (const r of set.rules) {
      process.stdout.write(`${r.severity.padEnd(5)} ${r.id}\n`);
    }
    return 0;
  }
  const rule = set.rules.find((r) => r.id === id);
  if (!rule) {
    process.stderr.write(`plain-english: no rule '${id}'\n`);
    return 2;
  }
  process.stdout.write(`${bold(rule.id)}  (${rule.severity})\n\n`);
  process.stdout.write(`  match:   ${rule.match}\n`);
  if (rule.unless?.length) {
    process.stdout.write(`  unless:  ${rule.unless.join("\n           ")}\n`);
  }
  if (rule.message) process.stdout.write(`  instead: ${rule.message}\n`);
  return 0;
}

async function cmdHook(args: Args): Promise<number> {
  // Fail-open is the whole contract here. A crash must never block a write.
  try {
    const channel = (args.positionals[0] ?? args.flags["channel"] ?? "docs") as Channel;
    const raw = await readStdin();
    if (!raw.trim()) return 0;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const decision = decide(payload, channel);
    const out = toHookOutput(decision);
    if (out) process.stdout.write(out);
    return 0;
  } catch {
    return 0;
  }
}

const USAGE = `plain-english - catch AI writing tells before they land

USAGE
  plain-english lint [PATH...]        lint files or directories (default: stdin)
  plain-english render               regenerate docs/ and prompt templates
  plain-english explain [RULE]       show a rule, or list them all
  plain-english init                 wire this repo up
  plain-english hook <CHANNEL>       PreToolUse adapter (docs|github|issue)

LINT OPTIONS
  --format text|json|github          output shape (default: text)
  --fail-on error|warn|never         exit-code threshold (default: error)

RENDER OPTIONS
  --check                            exit 1 if generated files are stale
  --root PATH                        repo root (default: cwd)

INIT OPTIONS
  --claude-code                      merge hooks into .claude/settings.json
  --dry-run                          print what would change

Config: .plain-english.yml at the repo root, "extends: default".
Docs:   docs/writing-style.md
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.flags["help"] || args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (args.command) {
      case "lint":
        return await cmdLint(args);
      case "render":
        return cmdRender(args);
      case "explain":
        return cmdExplain(args);
      case "hook":
        return await cmdHook(args);
      case "init":
        return initClaudeCode({
          root: resolve(String(args.flags["root"] ?? process.cwd())),
          dryRun: Boolean(args.flags["dry-run"]),
        });
      default:
        process.stderr.write(`plain-english: unknown command '${args.command}'\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof RuleError) {
      process.stderr.write(`plain-english: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`plain-english: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(2);
  },
);
