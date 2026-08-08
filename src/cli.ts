#!/usr/bin/env node
/**
 * plain-english CLI.
 *
 * The point of having a CLI at all: the value of this ruleset should not depend
 * on using one particular editor. The same engine runs from a git hook, from
 * CI, from a terminal, and from a Claude Code hook.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { extname, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintText, type Finding } from "./lint.ts";
import { resolveRuleSet, compile, loadDefault, RuleError, type RuleSet } from "./rules.ts";
import { renderAll, writeTargets } from "./render.ts";
import {
  decide,
  isChannel,
  projectDirFor,
  CHANNELS,
  HOOK_BUDGET_MS,
  POST_BUDGET_MS,
  type Channel,
} from "./adapters/hook.ts";
import type { HookEvent } from "./agents/profile.ts";
import { init, allAgents } from "./init.ts";
import { byId, agentIds, resolveProfile, PROFILES } from "./agents/registry.ts";
import { toSarif } from "./format/sarif.ts";
import { record } from "./record.ts";
import { matchesAny } from "./glob.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
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
    if (f.link) process.stdout.write(dim(`         ${f.link}\n`));
  }
  process.stdout.write("\n");
}

async function cmdLint(args: Args): Promise<number> {
  const root = process.cwd();
  const ruleSet = resolveRuleSet(root);
  const format = String(args.flags["format"] ?? "text");
  const failOn = String(args.flags["fail-on"] ?? ruleSet.failOn);

  const all: { file: string; findings: Finding[] }[] = [];
  // Rules that ran out of match budget. Reported on stderr at the end: a rule
  // that stopped working is not a finding about the writing, but it must not
  // pass unmentioned either, or a clean run means two different things.
  const stalled = new Map<string, Set<string>>();
  const noteStalled = (file: string, ids: string[]) => {
    if (ids.length) stalled.set(file, new Set(ids));
  };

  if (!args.positionals.length || args.positionals[0] === "-") {
    const text = await readStdin();
    const res = lintText(text, ruleSet);
    noteStalled("<stdin>", res.timedOut);
    all.push({ file: "<stdin>", findings: res.findings });
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
        const res = lintText(text, ruleSet);
        noteStalled(file, res.timedOut);
        all.push({ file, findings: res.findings });
      }
    }
  }

  const errors = all.reduce((n, f) => n + f.findings.filter((x) => x.severity === "error").length, 0);
  const warns = all.reduce((n, f) => n + f.findings.filter((x) => x.severity === "warn").length, 0);

  if (format === "sarif") {
    process.stdout.write(
      JSON.stringify(
        toSarif(
          all.filter((f) => f.findings.length),
          ruleSet,
          { root, version: packageVersion() },
        ),
        null,
        2,
      ) + "\n",
    );
  } else if (format === "json") {
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
  } else if (format === "unix") {
    // `path:line:col: level: message` is the shape every editor already knows
    // how to parse, from vim's errorformat through ALE and nvim-lint to
    // efm-langserver. The default `text` format groups findings under a
    // filename heading, which reads better and parses worse.
    for (const { file, findings } of all) {
      for (const f of findings) {
        const level = f.severity === "error" ? "error" : "warning";
        process.stdout.write(
          `${relative(root, file) || file}:${f.line}:${f.column}: ${level}: ` +
            `${f.match} (${f.ruleId})${f.message ? " " + f.message : ""}\n`,
        );
      }
    }
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

  // Never suppressed by --format: a partial scan reported as a whole one is
  // worse than noise in a pipeline, and this goes to stderr so it cannot
  // corrupt the JSON or annotation output on stdout.
  for (const [file, ids] of stalled) {
    process.stderr.write(
      `plain-english: match budget exhausted on ${relative(root, file)}; ` +
        `these rules did not run: ${[...ids].sort().join(", ")}\n`,
    );
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

/**
 * `explain` covers all three collections.
 *
 * It used to iterate `set.rules` alone, which left the nine sentence shapes and
 * the two readability rules unreachable from the CLI even though the README
 * said otherwise. Anything with an id is explainable here.
 */
function cmdExplain(args: Args): number {
  const set: RuleSet = resolveRuleSet(process.cwd());
  const id = args.positionals[0];
  if (!id) {
    process.stdout.write(`${bold("Words and punctuation")}\n`);
    for (const r of set.rules) {
      process.stdout.write(`  ${r.severity.padEnd(5)} ${r.id}\n`);
    }
    if (set.readability.length) {
      process.stdout.write(`\n${bold("Readability")}\n`);
      for (const r of set.readability) {
        process.stdout.write(`  ${r.severity.padEnd(5)} ${r.id}\n`);
      }
    }
    if (set.structures.length) {
      // Structures carry no severity: the semantic layer reports them or it
      // does not. Padding them into the severity column would invent one.
      process.stdout.write(`\n${bold("Sentence shapes")}${dim(" (semantic layer)")}\n`);
      for (const s of set.structures) {
        process.stdout.write(`  ${s.id.padEnd(22)} ${dim(s.name)}\n`);
      }
    }
    return 0;
  }

  const rule = set.rules.find((r) => r.id === id);
  if (rule) {
    process.stdout.write(`${bold(rule.id)}  (${rule.severity})\n\n`);
    process.stdout.write(`  match:   ${rule.match}\n`);
    if (rule.unless?.length) {
      process.stdout.write(`  unless:  ${rule.unless.join("\n           ")}\n`);
    }
    if (rule.message) process.stdout.write(`  instead: ${rule.message}\n`);
    if (rule.link) process.stdout.write(`  more:    ${rule.link}\n`);
    return 0;
  }

  const read = set.readability.find((r) => r.id === id);
  if (read) {
    process.stdout.write(`${bold(read.id)}  (${read.severity})\n\n`);
    process.stdout.write(`  kind:    ${read.kind}\n`);
    if (read.maxWords !== undefined) {
      process.stdout.write(`  over:    ${read.maxWords} words\n`);
    }
    if (read.known?.length) {
      // The default list runs to roughly ninety entries, so print the size and
      // point at the file rather than filling the terminal.
      process.stdout.write(
        `  known:   ${read.known.length} names the rule already accepts (see rules/default.yml)\n`,
      );
    }
    if (read.message) process.stdout.write(`  instead: ${read.message}\n`);
    if (read.link) process.stdout.write(`  more:    ${read.link}\n`);
    return 0;
  }

  const structure = set.structures.find((s) => s.id === id);
  if (structure) {
    process.stdout.write(`${bold(structure.id)}  ${dim("(sentence shape)")}\n\n`);
    process.stdout.write(`  name:    ${structure.name}\n`);
    process.stdout.write(`  what:    ${structure.description.replace(/\s+/g, " ").trim()}\n`);
    if (structure.bad) process.stdout.write(`  bad:     ${structure.bad}\n`);
    if (structure.good) process.stdout.write(`  good:    ${structure.good}\n`);
    return 0;
  }

  process.stderr.write(`plain-english: no rule '${id}'\n`);
  return 2;
}

async function cmdHook(args: Args): Promise<number> {
  try {
    const name = args.positionals[0] ?? String(args.flags["channel"] ?? "docs");
    if (!isChannel(name)) {
      process.stderr.write(
        `plain-english: unknown channel '${name}'. Known channels: ${CHANNELS.join(", ")}\n`,
      );
      return 0;
    }
    const channel: Channel = name;

    const raw = await readStdin();
    if (!raw.trim()) return 0;
    const payload = JSON.parse(raw) as Record<string, unknown>;

    const agentFlag = args.flags["agent"] === undefined ? undefined : String(args.flags["agent"]);
    let profile;
    try {
      profile = resolveProfile(agentFlag, payload);
    } catch (e) {
      // A typo in a shim's --agent is worth saying out loud, and worth saying
      // once per call rather than never. It is not worth refusing a write over,
      // so detection carries on without the flag.
      process.stderr.write(`plain-english: ${e instanceof Error ? e.message : String(e)}\n`);
      profile = resolveProfile(undefined, payload);
    }

    // `post` runs after the tool did, so it can only tell the model something.
    // Only agents that discard `ask` install one, and only `init` writes the
    // flag; an unrecognised value is read as `pre`, which is the safe reading.
    const event: HookEvent = args.flags["event"] === "post" ? "post" : "pre";

    // The post event is not holding up a write, so the tight budget buys
    // nothing there but an incomplete scan.
    const budgetMs = event === "post" ? POST_BUDGET_MS : HOOK_BUDGET_MS;
    const parsed = profile.parse(payload);
    const decision = decide(parsed, channel, { budgetMs });
    const out = profile.emit(decision, event);
    if (out.stdout) process.stdout.write(out.stdout);

    // After the decision is out, and in its own try/catch. Three of the four
    // adapters were written from vendor documentation that was wrong twice, so
    // a real payload is worth having; a debugging aid that could swallow the
    // verdict is not.
    const dir = process.env["PLAIN_ENGLISH_RECORD"];
    if (dir) {
      try {
        record(payload, parsed, decision, out.stdout, {
          dir: resolve(dir),
          agent: profile.id,
          channel,
          event,
          projectDir: projectDirFor(parsed),
          version: packageVersion(),
          verbatim: args.flags["record-verbatim"] === true,
        });
      } catch {
        /* a capture is never worth a degraded decision */
      }
    }

    return out.exitCode;
  } catch {
    // Fail-open, and this is the contract the whole design rests on: a linter
    // must never be the reason a write cannot happen. Copilot is the one agent
    // that reads a non-zero exit here as a refusal, so 0 is also the only safe
    // answer, not merely the polite one.
    return 0;
  }
}

const USAGE = `plain-english - catch AI writing tells before they land

USAGE
  plain-english lint [PATH...]       lint files or directories (default: stdin)
  plain-english render               regenerate docs/ and prompt templates
  plain-english explain [RULE]       show a rule, or list them all
  plain-english doctor               environment dump for bug reports
  plain-english init                 wire this repo up
  plain-english hook <CHANNEL>       pre-tool-call adapter (docs|github|issue)

LINT OPTIONS
  --format text|json|unix|github|sarif
                                     output shape (default: text).
                                     unix is path:line:col for editors.
  --fail-on never|error|warn         exit-code threshold (default: never)

RENDER OPTIONS
  --check                            exit 1 if generated files are stale
  --root PATH                        repo root (default: cwd)

INIT OPTIONS
  --agent ID                         claude-code (default), copilot, codex,
                                     cursor, or all
  --dry-run                          print what would change
  --root PATH                        repo root (default: cwd)

HOOK OPTIONS
  --agent ID                         which agent's protocol to speak.
                                     Detected from the payload when omitted.
  --event pre|post                   pre refuses before the write, post tells
                                     the model after it (default: pre)

  --version                          print the version and exit

Set PLAIN_ENGLISH_RECORD=<dir> to write each hook payload there, redacted, for
reporting an adapter bug. Add --record-verbatim only for a payload you wrote
yourself.

Config: .plain-english.yml at the repo root, "extends: default".
Docs:   docs/writing-style.md
`;

function packageVersion(): string {
  for (const p of [
    resolve(HERE, "..", "package.json"),
    resolve(HERE, "..", "..", "package.json"),
  ]) {
    try {
      return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}

/**
 * Environment dump for bug reports. The issue template asks for this output,
 * which is the difference between a reproducible report and a guess.
 */
function cmdDoctor(): number {
  const root = process.cwd();
  let configPath = "(built-in defaults)";
  for (let dir = root; ; ) {
    const hit = [".plain-english.yml", ".plain-english.yaml"]
      .map((n) => resolve(dir, n))
      .find((p) => existsSync(p));
    if (hit) {
      configPath = relative(root, hit) || hit;
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  let ruleSummary = "(failed to load)";
  try {
    const set = resolveRuleSet(root);
    const active = set.rules.filter((r) => r.severity !== "off");
    ruleSummary =
      `${active.length} active ` +
      `(${active.filter((r) => r.severity === "error").length} error, ` +
      `${active.filter((r) => r.severity === "warn").length} warn), ` +
      `${set.rules.length - active.length} off`;
  } catch (e) {
    ruleSummary = `(error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
  }

  process.stdout.write(
    [
      `plain-english ${packageVersion()}`,
      `node          ${process.version}`,
      `platform      ${process.platform} ${process.arch}`,
      `cwd           ${root}`,
      `config        ${configPath}`,
      `rules         ${ruleSummary}`,
      `structures    ${resolveRuleSetSafe(root)}`,
      `resolves      ${resolvesLocally(root)}`,
      "",
      "agents",
      ...agentReport(root),
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Which agent configs exist here, and whether they are ours.
 *
 * `docs/agents.md` tells people to attach `doctor` to a hook bug report, and
 * until now it said nothing about agents at all. The common failure it should
 * catch is a config that looks perfect while nothing runs.
 */
function agentReport(root: string): string[] {
  const lines: string[] = [];
  for (const profile of PROFILES) {
    const seen: string[] = [];
    for (const file of profile.plan({ prompts: {}, model: "" }).config) {
      const path = resolve(root, file.path);
      if (!existsSync(path)) continue;
      let ours = false;
      try {
        ours = readFileSync(path, "utf8").includes("--agent " + profile.id);
      } catch {
        /* unreadable counts as not ours */
      }
      seen.push(`${file.path} ${file.at.join(".")}${ours ? "" : " (no plain-english entry)"}`);
    }
    lines.push(`  ${profile.id.padEnd(12)} ${seen.length ? seen.join("; ") : "not installed"}`);
  }
  return lines;
}

/**
 * Whether the command every installed hook runs would find anything.
 *
 * Each hook is `npx --no-install plain-english …`, which resolves from the
 * project's own `node_modules`. A global install with no local one makes every
 * one of them a silent no-op while the config still reads correctly, and that
 * is indistinguishable from a linter that found nothing to say.
 */
function resolvesLocally(root: string): string {
  const local = resolve(root, "node_modules", "plain-english", "package.json");
  if (existsSync(local)) return "npx --no-install finds a local install";
  return "NO local install; `npx --no-install plain-english` will do nothing in hooks";
}

function resolveRuleSetSafe(root: string): string {
  try {
    return String(resolveRuleSet(root).structures.length);
  } catch {
    return "(unavailable)";
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags["version"] || args.command === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

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
      case "doctor":
        return cmdDoctor();
      case "hook":
        return await cmdHook(args);
      case "init": {
        // `--claude-code` is still accepted and still does nothing: init wrote
        // the Claude Code hooks unconditionally long before there was a second
        // agent to choose between. Unknown flags are ignored by parseArgs, so
        // the command published in earlier READMEs keeps working, and it now
        // means the same thing as the `--agent claude-code` default.
        const requested = args.flags["agent"] === undefined ? undefined : String(args.flags["agent"]);
        let agents;
        if (requested === "all") {
          agents = allAgents();
        } else if (requested !== undefined) {
          const found = byId(requested);
          if (!found) {
            process.stderr.write(
              `plain-english: unknown agent '${requested}'.\n` +
                `  Known agents: ${agentIds().join(", ")}, all\n`,
            );
            return 2;
          }
          agents = [found];
        }
        return init({
          root: resolve(String(args.flags["root"] ?? process.cwd())),
          dryRun: Boolean(args.flags["dry-run"]),
          ...(agents ? { agents } : {}),
        });
      }
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
