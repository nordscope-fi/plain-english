#!/usr/bin/env node
/**
 * plain-english CLI.
 *
 * The point of having a CLI at all: the value of this ruleset should not depend
 * on using one particular editor. The same engine runs from a git hook, from
 * CI, from a terminal, and from a Claude Code hook.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintText, type Finding } from "./lint.ts";
import { resolveRuleSet, compile, chatRuleSet, loadDefault, RuleError, type RuleSet } from "./rules.ts";
import { READERS, readAll, readerFor, readerIds, type ReaderResult } from "./chat/registry.ts";
import { renderAll, writeTargets } from "./render.ts";
import { renderPolicy, scanRepo, toPosix } from "./policy.ts";
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
import { decideChat } from "./adapters/chat.ts";
import type { Decision } from "./adapters/hook.ts";
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

/**
 * Print findings in whichever shape was asked for, and count them.
 *
 * Shared by the file scan and the chat scan. A chat reply arrives as the same
 * `{ file, findings }` pair a document does, with the transcript as the file,
 * so every formatter here works on both without knowing which it has. That is
 * the reason `lint --chat` needed no new output code.
 */
function emitFindings(
  all: { file: string; findings: Finding[] }[],
  ruleSet: RuleSet,
  root: string,
  format: string,
  unit: string,
): { errors: number; warns: number } {
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
        `${errors} blocking, ${warns} warning${warns === 1 ? "" : "s"} across ${scanned} ${unit}${scanned === 1 ? "" : "s"}\n`,
      );
    } else {
      process.stdout.write(dim(`clean (${scanned} ${unit}${scanned === 1 ? "" : "s"})\n`));
    }
  }
  return { errors, warns };
}

async function cmdLint(args: Args): Promise<number> {
  const root = process.cwd();
  const ruleSet = resolveRuleSet(root);
  const format = String(args.flags["format"] ?? "text");
  const failOn = String(args.flags["fail-on"] ?? ruleSet.failOn);

  if (args.flags["chat"]) return cmdLintChat(args, root, ruleSet, format, failOn);

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

  const { errors, warns } = emitFindings(all, ruleSet, root, format, "file");

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

/**
 * `plain-english lint --chat`
 *
 * The other half of the chat channel. The hook judges a reply as it is made;
 * this reads what was already said. Both take their text from the same
 * `ChatReader`, and every reply arrives here as the `{ file, findings }` pair
 * a document produces, so the formatters need no chat-specific code.
 *
 * Local only, deliberately, and the reason is not squeamishness. A transcript
 * holds whatever passed through a tool: file contents, command output, pasted
 * text, and, per Claude Code's own documentation, a credential that an
 * environment file or a command happened to print. Copilot's documentation
 * adds that its sessions sync to the user's GitHub account by default. Nothing
 * here belongs in CI, and the GitHub Action takes no `--chat` input.
 */
async function cmdLintChat(
  args: Args,
  root: string,
  base: RuleSet,
  format: string,
  failOn: string,
): Promise<number> {
  const ruleSet = chatRuleSet(base);

  const agent = args.flags["agent"];
  const readers =
    typeof agent === "string" && agent !== "all"
      ? [readerFor(agent)].filter((r): r is NonNullable<typeof r> => Boolean(r))
      : READERS;
  if (typeof agent === "string" && agent !== "all" && !readers.length) {
    process.stderr.write(
      `plain-english: unknown agent '${agent}'. Known: ${readerIds().join(", ")}, all\n`,
    );
    return 2;
  }

  const sinceRaw = args.flags["since"];
  const sinceDays = sinceRaw === undefined || sinceRaw === true ? 30 : Number(sinceRaw);
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
    process.stderr.write("plain-english: --since takes a number of days\n");
    return 2;
  }

  const results = readAll(readers, {
    sinceDays,
    // Default scope is this repository. A linter run inside a project that
    // reported on every project on the machine answers a question nobody asked.
    ...(args.flags["all-projects"] ? {} : { cwd: root }),
  });

  const all: { file: string; findings: Finding[] }[] = [];
  const arms = { main: { replies: 0, words: 0 }, subagent: { replies: 0, words: 0 } };
  const perRule = new Map<string, { main: number; subagent: number }>();

  for (const result of results) {
    for (const reply of result.replies) {
      const arm = reply.isSubagent ? arms.subagent : arms.main;
      arm.replies += 1;
      arm.words += (reply.text.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;

      // Inline suppression is off: a chat reply carries no waivers, and a
      // reply that happens to quote the directive syntax is not one.
      const res = lintText(reply.text, ruleSet, { allowInlineSuppression: false });
      if (!res.findings.length) continue;
      for (const f of res.findings) {
        const row = perRule.get(f.ruleId) ?? { main: 0, subagent: 0 };
        row[reply.isSubagent ? "subagent" : "main"] += 1;
        perRule.set(f.ruleId, row);
      }
      all.push({
        // The transcript, so a finding names something a person can open.
        file: reply.source || `<${result.id}>`,
        findings: res.findings.map((f) => ({ ...f, line: reply.line || f.line })),
      });
    }
  }

  const unavailable = results.filter((r) => r.unavailable);

  if (args.flags["summary"]) {
    printChatSummary(results, arms, perRule);
  } else {
    emitFindings(all, ruleSet, root, format, "reply");
  }

  // Never suppressed by --format, and never folded into "clean". A reader that
  // could not run and a reader that found nothing print identically otherwise,
  // which is the failure docs/verifying-an-adapter.md opens by naming.
  for (const r of unavailable) {
    process.stderr.write(`plain-english: ${r.label} not scanned: ${r.unavailable}\n`);
  }

  const errors = all.reduce(
    (n, f) => n + f.findings.filter((x) => x.severity === "error").length,
    0,
  );
  const warns = all.reduce(
    (n, f) => n + f.findings.filter((x) => x.severity === "warn").length,
    0,
  );
  if (failOn === "warn") return errors + warns > 0 ? 1 : 0;
  if (failOn === "never") return 0;
  return errors > 0 ? 1 : 0;
}

/**
 * The report only this channel can produce.
 *
 * A rate per 1,000 words, split main loop against subagent. The split is the
 * point: an output style never reaches a subagent, so a single number across
 * both hides the one gap the style cannot close.
 */
function printChatSummary(
  results: ReaderResult[],
  arms: { main: { replies: number; words: number }; subagent: { replies: number; words: number } },
  perRule: Map<string, { main: number; subagent: number }>,
): void {
  const scanned = results.filter((r) => !r.unavailable);
  process.stdout.write(
    bold("scanned ") +
      `${scanned.map((r) => r.label).join(", ") || "nothing"}\n` +
      dim(
        `  main loop  ${arms.main.replies.toLocaleString()} replies, ` +
          `${arms.main.words.toLocaleString()} words\n` +
          `  subagents  ${arms.subagent.replies.toLocaleString()} replies, ` +
          `${arms.subagent.words.toLocaleString()} words\n`,
      ) +
      "\n",
  );

  if (!perRule.size) {
    process.stdout.write(dim("no findings\n"));
    return;
  }

  const rate = (n: number, words: number) => (words ? (n / words) * 1000 : 0);
  const rows = [...perRule.entries()]
    .map(([id, n]) => ({
      id,
      main: rate(n.main, arms.main.words),
      sub: rate(n.subagent, arms.subagent.words),
      total: n.main + n.subagent,
    }))
    .sort((a, b) => b.total - a.total);

  process.stdout.write(
    `${"rule".padEnd(24)}${"main /1k".padStart(10)}${"subagent /1k".padStart(14)}${"total".padStart(8)}\n`,
  );
  for (const r of rows) {
    // A subagent rate above the main-loop rate is the shape to look for: it is
    // what a prompt that cannot reach subagents looks like from the outside.
    const worse = r.sub > r.main && arms.subagent.words > 0;
    const sub = r.sub.toFixed(2).padStart(14);
    process.stdout.write(
      r.id.padEnd(24) +
        r.main.toFixed(2).padStart(10) +
        (worse ? red(sub) : sub) +
        String(r.total).padStart(8) +
        "\n",
    );
  }
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
 * The policy document for the repository this runs in.
 *
 * Distinct from `render`, which regenerates this package's own artifacts from
 * the shipped ruleset. `policy` describes a consumer's *effective* config,
 * including what they changed and every waiver in their tree, so it reads the
 * merged ruleset and the working directory rather than `rules/default.yml`.
 *
 * `--check` exists for the same reason `render --check` does: a policy that no
 * longer matches the config is worse than none, because people trust it.
 */
function cmdPolicy(args: Args): number {
  const root = resolve(String(args.flags["root"] ?? process.cwd()));
  const out = resolve(root, String(args.flags["out"] ?? "docs/ai-writing-policy.md"));
  const set = resolveRuleSet(root);
  const where = relative(root, out) || out;
  // The document waives every rule, so counting it would grow the report by one
  // waiver on every run and `--check` would never settle. `scanRepo` keys on
  // forward slashes, and `relative` gives backslashes on Windows, so the skip
  // has to be normalised or it matches nothing there.
  const content = renderPolicy(set, scanRepo(root, set, { skip: [toPosix(where)] }));

  if (args.flags["check"]) {
    if (!existsSync(out)) {
      process.stderr.write(
        `plain-english: ${where} does not exist. Run \`plain-english policy\`.\n`,
      );
      return 1;
    }
    const current = readFileSync(out, "utf8");
    if (current !== content) {
      process.stderr.write(
        `plain-english: ${where} is stale. Run \`plain-english policy\`.\n` +
          summariseDrift(current, content),
      );
      return 1;
    }
    process.stdout.write(`${where} is up to date\n`);
    return 0;
  }

  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out) && readFileSync(out, "utf8") === content) {
    process.stdout.write("no changes\n");
    return 0;
  }
  writeFileSync(out, content);
  process.stdout.write(`wrote ${where}\n`);
  return 0;
}

/**
 * Which headed sections differ, so `--check` says what moved.
 *
 * A whole-file diff in a build log is unreadable and a bare "stale" tells the
 * reader nothing about whether a rule changed or a waiver was added.
 */
function summariseDrift(current: string, fresh: string): string {
  const sections = (text: string): Map<string, string> => {
    const map = new Map<string, string>();
    let heading = "(header)";
    let body: string[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) {
        map.set(heading, body.join("\n"));
        heading = line.slice(3);
        body = [];
      } else body.push(line);
    }
    map.set(heading, body.join("\n"));
    return map;
  };

  const a = sections(current);
  const b = sections(fresh);
  const names = [...new Set([...a.keys(), ...b.keys()])];
  const moved = names.filter((n) => a.get(n) !== b.get(n));
  if (!moved.length) return "";
  return moved.map((n) => `  changed: ${n}\n`).join("");
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

/**
 * The chat gate, on a stop event.
 *
 * Fails open in the strongest sense available here: an agent with no reader,
 * no `emitChat`, or a payload carrying no reply gets silence and exit 0. A
 * chat hook that refused a turn because it could not find the text would be
 * worse than no chat hook.
 */
function hookChat(
  payload: Record<string, unknown>,
  profile: { id: string; emitChat?: (d: Decision, e: string) => { stdout: string; exitCode: number } },
): number {
  if (!profile.emitChat) return 0;
  const reader = readerFor(profile.id);
  if (!reader) return 0;

  const reply = reader.current(payload);
  if (!reply || !reply.text.trim()) return 0;

  const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd();
  const eventName = String(payload["hook_event_name"] ?? payload["hookEventName"] ?? "Stop");

  const decision = decideChat(reply, {
    projectDir: resolve(cwd),
    // Both Claude Code and Copilot document this, and it is the agent telling
    // you the current turn exists because a hook blocked the last one.
    stopHookActive: payload["stop_hook_active"] === true || payload["stopHookActive"] === true,
    // Each agent names the turn differently, and getting this wrong is not
    // loud: the block-once key falls back to the session, so one block would
    // silence the rest of the session instead of the rest of the turn.
    // Observed 2026-08-18: Claude Code sends `prompt_id`, Codex sends
    // `turn_id`, Copilot sends neither and only `sessionId`.
    promptId: String(
      payload["prompt_id"] ??
        payload["promptId"] ??
        payload["turn_id"] ??
        payload["turnId"] ??
        payload["session_id"] ??
        payload["sessionId"] ??
        "",
    ),
  });

  const out = profile.emitChat(decision, eventName);
  if (out.stdout) process.stdout.write(out.stdout);
  return out.exitCode;
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

    // Chat is judged from the reply, not from a tool call, so it forks here
    // before `parse` is asked for tool input a stop event does not have.
    if (channel === "chat") return hookChat(payload, profile);

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
  plain-english lint --chat          lint what agents said in the chat window
  plain-english render               regenerate docs/ and prompt templates
  plain-english policy               write this repo's AI writing policy
  plain-english explain [RULE]       show a rule, or list them all
  plain-english doctor               environment dump for bug reports
  plain-english init                 wire this repo up
  plain-english hook <CHANNEL>       pre-tool-call adapter (docs|github|issue)

LINT OPTIONS
  --format text|json|unix|github|sarif
                                     output shape (default: text).
                                     unix is path:line:col for editors.
  --fail-on never|error|warn         exit-code threshold (default: never)

LINT --chat OPTIONS
  Reads the session transcripts each agent writes to local disk. Local only:
  a transcript holds whatever passed through a tool, so this is never a CI
  step and the GitHub Action takes no --chat input.

  --agent ID|all                     claude-code, codex, copilot, cursor
                                     (default: all)
  --since DAYS                       how far back to look (default: 30).
                                     Bounded by the agent's own retention.
  --all-projects                     every project, not just this repository
  --summary                          findings per 1,000 words, main loop
                                     against subagents. The split is the
                                     point: an output style never reaches a
                                     subagent.

RENDER OPTIONS
  --check                            exit 1 if generated files are stale
  --root PATH                        repo root (default: cwd)

POLICY OPTIONS
  --out PATH                         where to write it
                                     (default: docs/ai-writing-policy.md)
  --check                            exit 1 if the policy is stale, naming
                                     which sections moved
  --root PATH                        repo root (default: cwd)

INIT OPTIONS
  --agent ID                         claude-code (default), copilot, codex,
                                     cursor, or all
  --user                             also write outside the repo, under ~.
                                     Copilot's CLI needs this; nothing else does.
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
    // Whatever this machine would do to a hook that is installed correctly.
    // Codex is the one profile with an answer: its repository file is read only
    // in a trusted folder, and until then nothing runs and nothing is said.
    for (const problem of profile.diagnose?.(root) ?? []) {
      lines.push(`  ${" ".repeat(12)} ! ${problem}`);
    }
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
      case "policy":
        return cmdPolicy(args);
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
          includeUser: Boolean(args.flags["user"]),
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

/**
 * Exit, but not before stdout has actually left the process.
 *
 * `process.exit()` discards whatever stdout still has buffered. Writing to a
 * terminal that is invisible, because a TTY write is synchronous. Writing to a
 * pipe it is not: the buffer is about 64 KB, and a report larger than that
 * arrives truncated at exactly that boundary with no error anywhere.
 *
 * Found with `lint --chat --format json`, whose output is naturally large: 514
 * KB of valid JSON in a file became 65 KB of invalid JSON through a pipe. The
 * same fault was always reachable by `lint` over a big enough tree, and a
 * consumer parsing that output would have seen a syntax error rather than a
 * clue.
 *
 * So: hand the exit code over, and wait for the drain when bytes are still in
 * flight. An `error` listener covers the reader closing the pipe early, which
 * is what `| head` does and which would otherwise hang here.
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  if (process.stdout.writableLength === 0) {
    process.exit(code);
    return;
  }
  process.stdout.once("error", () => process.exit(code));
  process.stdout.once("drain", () => process.exit(code));
}

main().then(exitWhenFlushed, (e: unknown) => {
  process.stderr.write(`plain-english: ${e instanceof Error ? e.stack : String(e)}\n`);
  exitWhenFlushed(2);
});
