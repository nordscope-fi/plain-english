// Verification probe: run the BUILT hook adapter against real pre-tool-call
// payloads and check the decision.
//
// It imports from dist/ rather than src/, which is the whole reason it exists
// alongside the vitest suite: it catches a build that compiled but does not
// run, and a profile that is exported from source but missing from the package.
//
// It lives in a file because the payloads contain command strings that a
// shell-level guard reads as real invocations.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decide } from "../dist/adapters/hook.js";
import { PROFILES, byId } from "../dist/agents/registry.js";
import { compile, loadDefault } from "../dist/rules.js";

const T = mkdtempSync(resolve(tmpdir(), "pe-probe-"));
const ruleSet = compile(loadDefault());
const EM = "—";
let failures = 0;

function check(ok, label) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

function probe(name, payload, channel, want, wantRule, agent = "claude-code") {
  const profile = byId(agent);
  const d = decide(profile.parse(payload), channel, { projectDir: T, ruleSet });
  const got = d.allow ? "allow" : "deny";
  const ruleOk = !wantRule || d.findings.some((f) => f.ruleId === wantRule);
  const ok = got === want && ruleOk;
  if (!ok) failures++;
  const detail = d.findings.map((f) => `${f.ruleId}:${JSON.stringify(f.match)}`).join(" ") || "-";
  console.log(`${ok ? "PASS" : "FAIL"}  want=${want.padEnd(5)} got=${got.padEnd(5)}  ${name}`);
  if (!ok) console.log(`      findings: ${detail}`);
  return d;
}

writeFileSync(
  resolve(T, "msg.txt"),
  "fix: retry window\n\nLet us delve into why the first attempt failed.\n",
);
writeFileSync(resolve(T, "body.md"), `## Summary\n\nFixes the window ${EM} wrong unit.\n`);

const commitCmd = ["git", "commit", "-F", `${T}/msg.txt`].join(" ");
const prCmd = ["gh", "pr", "create", "--title", "'fix'", "--body-file", `${T}/body.md`].join(" ");
const readCmd = ["gh", "pr", "view", "42", "--json", "body"].join(" ");

console.log("-- extraction --");

probe("em dash in a markdown write", {
  tool_name: "Write",
  tool_input: { file_path: `${T}/x.md`, content: `The build failed ${EM} the cache was stale.` },
}, "docs", "deny", "em-dash");

probe("banned word inside a fenced code block", {
  tool_name: "Write",
  tool_input: { file_path: `${T}/x.md`, content: "```\nleverage()\n```" },
}, "docs", "allow");

probe("banned word in a non-markdown file", {
  tool_name: "Write",
  tool_input: { file_path: `${T}/config.json`, content: '{"s":"leverage"}' },
}, "docs", "allow");

probe("markdown file outside the project dir", {
  tool_name: "Write",
  tool_input: { file_path: "/elsewhere/other.md", content: `a ${EM} b` },
}, "docs", "allow");

probe("message file passed with -F", {
  tool_name: "Bash", tool_input: { command: commitCmd },
}, "github", "deny", "delve");

probe("body file passed with --body-file", {
  tool_name: "Bash", tool_input: { command: prCmd },
}, "github", "deny", "em-dash");

probe("read-only gh command", {
  tool_name: "Bash", tool_input: { command: readCmd },
}, "github", "allow");

probe("inline -m message", {
  tool_name: "Bash", tool_input: { command: `git commit -m "Furthermore, fix the cache"` },
}, "github", "deny", "furthermore");

probe("em dash in an issue title", {
  tool_name: "mcp__linear__save_issue",
  tool_input: { title: `Refresh token race ${EM} two workers`, description: "ok" },
}, "issue", "deny", "em-dash");

probe("patch old_string is not judged", {
  tool_name: "mcp__linear__save_issue",
  tool_input: { patch: [{ old_string: `Furthermore ${EM} we utilize this.`, new_string: "It retries once." }] },
}, "issue", "allow");

console.log("\n-- per agent --");

// Every profile has to see the same text in the same payload. Three of the four
// read the snake_case envelope Claude Code established; Cursor uses it too with
// different tool names.
for (const profile of PROFILES) {
  probe(`${profile.id}: reads a markdown Write`, {
    tool_name: "Write",
    tool_input: { file_path: `${T}/x.md`, content: `a ${EM} b` },
  }, "docs", "deny", "em-dash", profile.id);
}

probe("codex: reads added lines out of an apply_patch", {
  tool_name: "apply_patch",
  tool_input: { input: `*** Begin Patch\n*** Add File: x.md\n+a ${EM} b\n*** End Patch` },
}, "docs", "deny", "em-dash", "codex");

probe("codex: a patch touching only source is not prose", {
  tool_name: "apply_patch",
  tool_input: { input: "*** Begin Patch\n*** Add File: x.ts\n+const leverage = 1;\n*** End Patch" },
}, "docs", "allow", undefined, "codex");

console.log("\n-- wire formats --");

// The four places the protocols genuinely differ. A vendor changing one of
// these should show up here as well as in the unit tests.
const denyEvent = (id) =>
  byId(id).parse({
    tool_name: "Write",
    tool_input: { file_path: `${T}/x.md`, content: `a ${EM} b` },
  });
const emit = (id, event) =>
  byId(id).emit(decide(denyEvent(id), "docs", { projectDir: T, ruleSet }), event).stdout;
const wire = (id, event = "pre") => {
  const out = emit(id, event);
  return out ? JSON.parse(out) : {};
};

check(wire("claude-code").hookSpecificOutput?.permissionDecision === "ask",
  "claude-code nests permissionDecision under hookSpecificOutput");
check(wire("copilot").permissionDecision === "ask" && !wire("copilot").hookSpecificOutput,
  "copilot puts permissionDecision at the top level");
// Codex fails the hook run outright on `ask`, so its advisory travels as
// additionalContext on the same pre event.
const codexPre = wire("codex");
check(codexPre.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      !!codexPre.hookSpecificOutput?.additionalContext &&
      codexPre.hookSpecificOutput?.permissionDecision === undefined,
  "codex tells the model on the pre event and never sends ask");

// Cursor parses `ask` and then allows, so its advisory has to reach the model
// as text or it reaches nobody.
check(wire("cursor").permission === "allow" && !!wire("cursor").additional_context,
  "cursor allows and attaches additional_context");

// Both Codex hook output schemas set additionalProperties: false, so a stray
// key throws the whole reply away rather than being ignored.
check(JSON.stringify(Object.keys(codexPre)) === '["hookSpecificOutput"]' &&
      JSON.stringify(Object.keys(codexPre.hookSpecificOutput).sort()) ===
        '["additionalContext","hookEventName"]',
  "codex pre output carries no key Codex would reject");
check(PROFILES.every((p) => emit(p.id, "post") === ""),
  "nothing is said after the write, on any agent");

console.log("\n-- refusal message --");

const denied = probe("deny message quotes the text and offers narrow fixes first", {
  tool_name: "Write",
  tool_input: { file_path: `${T}/x.md`, content: `a ${EM} b` },
}, "docs", "deny", "em-dash");

const reason = denied.reason ?? "";
check(reason.includes(EM), "quotes the offending character");
check(reason.includes("plain-english-disable-next-line"), "offers the one-line suppression");
check(reason.indexOf("disable-next-line") < reason.indexOf("ack"), "narrow fix listed before the ack file");
check(reason.includes("the human's call"), "marks the ack file as not the agent's call");

console.log("\n-- fail-open --");

// A malformed payload must never block a write, in any protocol. Copilot is the
// one agent that reads a non-zero exit on this event as a refusal, so its exit
// code matters as much as its output.
for (const profile of PROFILES) {
  for (const event of ["pre", "post"]) {
    const out = profile.emit(decide(profile.parse({}), "docs", { projectDir: T, ruleSet }), event);
    check(out.stdout === "" && out.exitCode === 0,
      `${profile.id}: empty payload allows on ${event}, exit 0`);
  }
}

rmSync(T, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll adapter probes passed." : `\n${failures} probe(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
