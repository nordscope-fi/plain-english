// Verification probe: run the built hook adapter against real PreToolUse
// payloads and check the decision. Lives in a file because the payloads
// contain command strings that a shell-level guard reads as real invocations.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decide, toHookOutput } from "../dist/adapters/claude-hook.js";
import { compile, loadDefault } from "../dist/rules.js";

const T = mkdtempSync(resolve(tmpdir(), "pe-probe-"));
const ruleSet = compile(loadDefault());
const EM = "—";
let failures = 0;

function probe(name, payload, channel, want, wantRule) {
  const d = decide(payload, channel, { projectDir: T, ruleSet });
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

const denied = probe("deny message quotes the text and offers narrow fixes first", {
  tool_name: "Write",
  tool_input: { file_path: `${T}/x.md`, content: `a ${EM} b` },
}, "docs", "deny", "em-dash");

const reason = denied.reason ?? "";
const checks = [
  [reason.includes(EM), "quotes the offending character"],
  [reason.includes("plain-english-disable-next-line"), "offers the one-line suppression"],
  [reason.indexOf("disable-next-line") < reason.indexOf("ack"), "narrow fix listed before the ack file"],
  [reason.includes("the human's call"), "marks the ack file as not the agent's call"],
];
for (const [ok, label] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// Fail-open: a malformed payload must never block a write.
const empty = toHookOutput(decide({}, "docs", { projectDir: T, ruleSet }));
const failOpen = empty === "";
if (!failOpen) failures++;
console.log(`${failOpen ? "PASS" : "FAIL"}  empty payload allows (fail-open)`);

rmSync(T, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll adapter probes passed." : `\n${failures} probe(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
