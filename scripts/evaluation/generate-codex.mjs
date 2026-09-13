#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  assertOutsideRepository,
  evaluationHome,
  readJsonl,
  sha256,
  stableJson,
  validateOutput,
  writeJsonl,
} from "./core.mjs";

const repository = resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);

function takeOption(name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  if (at === argv.length - 1) throw new Error(`${name} needs a value`);
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
}

function safeRun(value) {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(value) || basename(value) !== value) {
    throw new Error("run must be one file-safe name");
  }
  return value;
}

const run = safeRun(argv.shift() ?? "");
const split = takeOption("--split", "development");
const model = takeOption("--model", "gpt-5.6-terra");
const reasoning = takeOption("--reasoning", "low");
const jobs = Number.parseInt(takeOption("--jobs", "4"), 10);
const timeoutMs = Number.parseInt(takeOption("--timeout-ms", "240000"), 10);
const retries = Number.parseInt(takeOption("--retries", "2"), 10);
const limitValue = takeOption("--limit");
const limit = limitValue === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitValue, 10);
const store = resolve(takeOption("--store", evaluationHome()));

assertOutsideRepository(store, repository);
if (!new Set(["development", "holdout"]).has(split)) throw new Error("--split must be development or holdout");
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 12) throw new Error("--jobs must be between 1 and 12");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000) throw new Error("--timeout-ms must be at least 10000");
if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new Error("--retries must be between 0 and 5");
if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
if (argv.length) throw new Error(`unexpected argument: ${argv[0]}`);

const runDirectory = resolve(store, "runs", run);
const tasksPath = resolve(runDirectory, `tasks-${split}.jsonl`);
const outputsPath = resolve(store, "outputs.jsonl");
const responseDirectory = resolve(runDirectory, "responses");
const failureDirectory = resolve(runDirectory, "failures");
const workspace = resolve(runDirectory, "empty-workspace");
for (const directory of [responseDirectory, failureDirectory, workspace]) mkdirSync(directory, { recursive: true, mode: 0o700 });

const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const settings = {
  provider: "codex-cli",
  cliVersion,
  model,
  reasoning,
  sandbox: "read-only",
  ephemeral: true,
  ignoreUserConfig: true,
  workspace: "empty",
};
const settingsHash = sha256(stableJson(settings));
const tasks = readJsonl(tasksPath);
const allOutputs = readJsonl(outputsPath).map(validateOutput);
const existingKeys = new Set(allOutputs.filter((row) => row.run === run).map((row) => `${row.caseId}\0${row.system}`));
const pending = tasks.filter((task) => !existingKeys.has(`${task.caseId}\0${task.system}`)).slice(0, limit);

function modelPrompt(task) {
  const sections = [];
  if (task.modelInput.instruction.trim()) {
    sections.push("WRITING INSTRUCTIONS", task.modelInput.instruction.trim());
  } else {
    sections.push("WRITING INSTRUCTIONS", "No additional writing rules are supplied.");
  }
  sections.push("WRITING TASK", task.modelInput.prompt.trim());
  sections.push("RESPONSE CONTRACT", "Return only the requested reply. Do not inspect files, call tools, or discuss these instructions.");
  return `${sections.join("\n\n")}\n`;
}

function generate(task, attempt) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputFile = resolve(responseDirectory, `${task.caseId}-${task.system}.txt`);
    const failureFile = resolve(failureDirectory, `${task.caseId}-${task.system}-attempt-${attempt}.txt`);
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--model", model,
      "--config", `model_reasoning_effort=${JSON.stringify(reasoning)}`,
      "--color", "never",
      "--output-last-message", outputFile,
      "--cd", workspace,
      "-",
    ];
    const child = spawn("codex", args, { cwd: workspace, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut || !existsSync(outputFile)) {
        if (stderr) writeFileSync(failureFile, stderr, { mode: 0o600 });
        rejectPromise(new Error(timedOut ? "generation timed out" : `Codex exited ${code ?? "without a code"}`));
        return;
      }
      const text = readFileSync(outputFile, "utf8").trim();
      unlinkSync(outputFile);
      if (!text) {
        rejectPromise(new Error("Codex returned an empty reply"));
        return;
      }
      resolvePromise(validateOutput({
        run,
        caseId: task.caseId,
        system: task.system,
        caseHash: task.caseHash,
        instructionHash: task.instructionHash,
        model,
        settingsHash,
        text,
        generatedAt: new Date().toISOString(),
      }));
    });
    child.stdin.end(modelPrompt(task));
  });
}

let cursor = 0;
let completed = 0;
const failures = [];

async function worker() {
  while (cursor < pending.length) {
    const task = pending[cursor++];
    let output;
    let lastError;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        output = await generate(task, attempt);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!output) {
      failures.push({ task, error: lastError });
      process.stdout.write(`failed ${failures.length}; completed ${completed}/${pending.length}\n`);
      continue;
    }
    allOutputs.push(output);
    writeJsonl(outputsPath, allOutputs);
    completed++;
    if (completed % 10 === 0 || completed === pending.length) {
      process.stdout.write(`completed ${completed}/${pending.length}; ${failures.length} failed\n`);
    }
  }
}

try {
  process.stdout.write(`generation run ${run}: ${pending.length} pending tasks; ${model}, ${reasoning} reasoning, ${jobs} jobs; settings ${settingsHash.slice(0, 12)}\n`);
  await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, () => worker()));
  if (failures.length) {
    process.stderr.write(`${failures.length} tasks failed; diagnostic text is private at ${failureDirectory}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`generation complete: ${completed} new outputs; ${allOutputs.filter((row) => row.run === run).length} in run\n`);
  }
} catch (error) {
  process.stderr.write(`writing generation: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
