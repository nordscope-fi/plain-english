// Throwaway probe for plain-english issue 151: which hook events Cowork
// delivers, what their payloads hold, whether a refused write leaves the file
// unchanged, and what the reader sees when a reply is held.
//
// An uploaded plugin also syncs to Claude Code, so this does nothing unless a
// prompt in the session contained "pe-probe:on" or the task folder holds a
// file named PE-COWORK-PROBE.md. Use synthetic prose only: when on, it records
// payloads (strings cut to 300 characters) into the task folder.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const event = process.argv[2] ?? "unknown";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  payload = { unparsed: raw.slice(0, 300) };
}

const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
const session = String(payload.session_id ?? "no-session").replace(/[^\w-]/g, "_");
const stateDir = join(tmpdir(), "pe-cowork-probe");
mkdirSync(stateDir, { recursive: true });
const flag = join(stateDir, `${session}.on`);
const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
const switchedOn = prompt.includes("pe-probe:on");
if (switchedOn) writeFileSync(flag, "");
if (!switchedOn && !existsSync(flag) && !existsSync(join(cwd, "PE-COWORK-PROBE.md"))) process.exit(0);

function cut(value) {
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}[+${value.length - 300}]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(cut);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]));
  return value;
}

const record = {
  at: new Date().toISOString(),
  event,
  platform: process.platform,
  node: process.version,
  processCwd: process.cwd(),
  pluginRootSet: Boolean(process.env.CLAUDE_PLUGIN_ROOT),
  projectDirSet: Boolean(process.env.CLAUDE_PROJECT_DIR),
  // Names only, never values, to tell a Cowork task from a Claude Code session.
  envNames: Object.keys(process.env).filter((name) => /^(CLAUDE|COWORK)/.test(name)).sort(),
  payloadKeys: Object.keys(payload),
  payload: cut(payload),
};
const line = `${JSON.stringify(record)}\n`;
appendFileSync(join(stateDir, `${session}.jsonl`), line);
let logged = "the temp folder";
try {
  appendFileSync(join(cwd, "pe-cowork-probe.jsonl"), line);
  logged = "pe-cowork-probe.jsonl";
} catch {
  // A read-only task folder: the temp copy is the record.
}

function reply(body) {
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
const target = String(input.file_path ?? input.path ?? input.notebook_path ?? "");

if (event === "UserPromptSubmit" && switchedOn) {
  reply({ systemMessage: `pe-probe is on for this session; records go to ${logged}.` });
}
if (event === "SessionStart") {
  reply({ systemMessage: `pe-probe saw SessionStart (source: ${payload.source ?? "none"}).` });
}
if (event === "PreToolUse") {
  if (target.includes("pe-probe-refuse")) {
    reply({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "pe-probe refused this write on purpose, to test that a refused write leaves the file unchanged. Tell the user it was refused and do not retry.",
      },
      systemMessage: `pe-probe refused ${payload.tool_name} on ${target}.`,
    });
  }
  if (JSON.stringify(input).includes("pe-probe-slow")) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    reply({ systemMessage: "pe-probe: the 30-second wait finished without being cancelled." });
  }
  reply({ systemMessage: `pe-probe saw PreToolUse for ${payload.tool_name ?? "an unnamed tool"}.` });
}
if (event === "Stop") {
  const message = payload.last_assistant_message;
  if (typeof message !== "string") {
    reply({ systemMessage: "pe-probe: Stop arrived without last_assistant_message." });
  }
  if (message.includes("PE-PROBE-BLOCK") && payload.stop_hook_active !== true) {
    reply({
      decision: "block",
      reason: "pe-probe held this reply on purpose. Write it again without the word PE-PROBE-BLOCK.",
      systemMessage: "pe-probe held the reply once.",
    });
  }
}
process.exit(0);
