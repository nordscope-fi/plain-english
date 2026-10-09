#!/usr/bin/env node
// Synthetic child processes only. Run with: node scripts/evaluation/native-cancellation.mjs [claude executable]
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform === "win32") {
  console.log(JSON.stringify({ skipped: true, reason: "This probe checks POSIX signals and process states; Windows cancellation has not been verified." }));
  process.exit(0);
}

const executable = process.argv[2] ?? process.env.CLAUDE_BIN ?? "claude";
const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const directory = mkdtempSync(join(tmpdir(), "plain-english-cancellation-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bound = 10_000;
const terminationBound = 2_000;
const wrapper = resolve(import.meta.dirname, "../../integrations/claude-code-plugin/hooks/run-checker.mjs");

function save(path, value) {
  writeFileSync(path, value, "utf8");
}

function plugin(path, name, source) {
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  mkdirSync(join(path, "hooks"), { recursive: true });
  save(join(path, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "0.0.1", description: "Synthetic cancellation probe", author: { name: "Plain English tests" } }));
  save(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.js"] }));
  save(join(path, "hooks/register.js"), source);
}

function state(pid) {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000 }).trim() || "gone";
  } catch (error) {
    if (error.status === 1) return "gone";
    throw error;
  }
}

function alive(pid) {
  const status = state(pid);
  return status !== "gone" && !status.startsWith("Z");
}

async function until(check, timeout, description) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for ${description}.`);
    await pause(25);
  }
  return Date.now() - started;
}

async function probe(name) {
  const root = join(directory, name);
  mkdirSync(root);
  const checkerFile = join(root, "checker.json");
  const modelFile = join(root, "model.json");
  const settledFile = join(root, "settled.json");
  // The real wrapper runs the CLI beside it, so the synthetic checker takes
  // the CLI's place in a copy of the plugin's layout.
  const wrapperCopy = join(root, "layout", "hooks", "run-checker.mjs");
  const checker = join(root, "layout", "dist", "cli.mjs");
  mkdirSync(join(root, "layout", "hooks"), { recursive: true });
  mkdirSync(join(root, "layout", "dist"), { recursive: true });
  save(wrapperCopy, readFileSync(wrapper, "utf8"));
  const model = join(root, "model.mjs");
  save(checker, `import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
writeFileSync(${JSON.stringify(checkerFile)},JSON.stringify({pid:process.pid,parent:process.ppid}));
spawnSync(process.execPath,[${JSON.stringify(model)}],{stdio:'inherit'});
`);
  save(model, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(modelFile)},JSON.stringify({pid:process.pid,parent:process.ppid}));
setInterval(()=>{},1000);
`);
  const run = `const stream=$.process.spawn({argv:['node',${JSON.stringify(wrapperCopy)}],cwd:${JSON.stringify(root)},env:{PLAIN_ENGLISH_CHECK_TIMEOUT_MS:${JSON.stringify(name === "timeout" ? "1500" : "30000")}},input:'{}'});
next.signal.addEventListener('abort',()=>{void stream.return({code:null,signal:null}).catch(()=>{})},{once:true});
let stderr='';for await (const chunk of stream) {if(chunk.stream==='stderr') stderr+=chunk.text};
const ended=await stream.result;if(ended.code!==0) throw new Error(stderr)`;
  const hold = "await $.process.run(['node','-e','setInterval(()=>{},1000)'],{timeoutMs:30000})";
  const plugins = [join(root, "plugin")];
  if (name === "abandoned-dispatch") {
    plugin(plugins[0], "cancellation-probe", `export function register(on) {
on('session.start',async ($,e,next)=>{
void next(e);
await $.clock.sleep(2000);
await $.fs.write(${JSON.stringify(settledFile)},JSON.stringify({settled:true}));
return {cwd:e.cwd};
});
on('prompt.context',async ($,e,next)=>{${hold};return next(e)});
}`);
    plugins.push(join(root, "inner"));
    plugin(plugins[1], "cancellation-probe-inner", `export function register(on) {
on('session.start',async ($,e,next)=>{${run};return next(e)});
}`);
  } else if (name === "timeout") {
    plugin(plugins[0], "cancellation-probe", `export function register(on) {
on('session.start',async ($,e,next)=>{
let failure='';try {${run}} catch(error) {failure=String(error)};
await $.fs.write(${JSON.stringify(settledFile)},JSON.stringify({failure}));
${hold};return next(e);
});
}`);
  } else {
    plugin(plugins[0], "cancellation-probe", `export function register(on) {
on('session.start',async ($,e,next)=>{${run};return next(e)});
}`);
  }
  // A missing hook cannot send anything to a real model or inherited MCP server.
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "synthetic-cancellation-probe",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const host = spawn(executable, ["--setting-sources", "", "--strict-mcp-config", ...plugins.flatMap(path => ["--plugin-dir", path]), "-p", "--no-session-persistence", "--tools", "", "--max-turns", "1", "Synthetic probe."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  let output = "";
  host.on("exit", () => { exited = true; });
  host.on("error", error => { output += error.message; exited = true; });
  for (const stream of [host.stdout, host.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-2_000); });
  let checkerPid;
  let modelPid;
  try {
    await until(() => existsSync(modelFile) || exited, bound, "synthetic checker and model startup");
    assert.ok(existsSync(modelFile), `${name}: native module did not start its children. ${output}`);
    const checkerRecord = JSON.parse(readFileSync(checkerFile, "utf8"));
    const modelRecord = JSON.parse(readFileSync(modelFile, "utf8"));
    checkerPid = checkerRecord.pid;
    modelPid = modelRecord.pid;
    assert.equal(modelRecord.parent, checkerPid, "The fake model must be the checker's child.");
    assert.ok(alive(checkerPid) && alive(modelPid), `Both children must be alive before cancellation (${state(checkerPid)}, ${state(modelPid)}). ${output}`);
    if (name === "session-interrupt") {
      host.kill("SIGINT");
      await until(() => exited, terminationBound, "host shutdown after SIGINT");
    } else {
      await until(() => existsSync(settledFile) || exited, bound, "process timeout or abandoned dispatch");
      assert.ok(!exited, "The host must remain alive when this dispatch ends.");
      const settled = JSON.parse(readFileSync(settledFile, "utf8"));
      if (name === "timeout") assert.match(settled.failure, /checker timed out after 1500ms/);
      else assert.equal(settled.settled, true);
    }
    let terminationMs;
    try {
      terminationMs = await until(() => !alive(checkerPid) && !alive(modelPid), terminationBound, "checker and model termination");
    } catch (error) {
      throw new Error(`${name}: ${error.message} checker=${checkerPid} (${state(checkerPid)}), model=${modelPid} (${state(modelPid)}), hostExited=${exited}`);
    }
    return { name, hostPid: host.pid, checkerPid, modelPid, hostAliveAfterDispatch: !exited, checkerState: state(checkerPid), modelState: state(modelPid), terminationObservedMs: terminationMs };
  } finally {
    if (!exited) {
      host.kill("SIGINT");
      try { await until(() => exited, terminationBound, "probe cleanup"); } catch { host.kill("SIGKILL"); }
    }
    // Only exact fixture PIDs are cleaned up; never kill by name or broad pattern.
    for (const file of [checkerFile, modelFile]) {
      if (!existsSync(file)) continue;
      const { pid } = JSON.parse(readFileSync(file, "utf8"));
      if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

try {
  const checks = [];
  for (const name of ["session-interrupt", "timeout", "abandoned-dispatch"]) checks.push(await probe(name));
  console.log(JSON.stringify({ version, platform: process.platform, synthetic: true, terminationBoundMs: terminationBound, checks }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
