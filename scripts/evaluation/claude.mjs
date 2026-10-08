#!/usr/bin/env node
// Public synthetic tasks only. Native eval supplies isolated child sessions.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { assertOutsideRepository, sha256, stableJson } from "./core.mjs";

const MODES = ["ordinary", "guidance", "checks"];
const ROOT = resolve(import.meta.dirname, "../..");

/** Hash every shipped file that can affect an evaluated plugin. */
export function pluginFingerprint(root) {
  const skipped = new Set(["tests", "types", "evals", "node_modules", ".git", "tsconfig.json", "README.md"]);
  const files = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipped.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), path);
      else files.push([path, sha256(readFileSync(resolve(directory, entry.name)))]);
    }
  }
  walk(root);
  return sha256(stableJson(files));
}

export function benchmarkCases() {
  const cases = [];
  for (let i = 1; i <= 8; i++) {
    const code = `E_RETRY_${i}`;
    const count = 10 + i;
    const price = `$${30 + i}`;
    const templates = [
      ["chat", `Explain why a fictional backup failed with ${code}. Evidence: the destination was full; the source remains intact. Recommend freeing space and retrying. Do not claim a successful retry.`, [code], ["Name the full destination.", "Preserve that the source is intact.", "Recommend freeing space and retrying without claiming success."]],
      ["technical-doc", `Draft a Markdown paragraph explaining a fictional API retry policy. The error is ${code}. Wait ${count} seconds between attempts. Stop after 3 attempts. There is no evidence that retrying fixes authentication failures.`, [code, `${count} seconds`, "3 attempts"], ["Explain the delay and limit.", "Keep the authentication qualification."]],
      ["decision", `Recommend a fictional subscription: Basic costs ${price} monthly and supports ${count} exports; Plus costs $90 monthly and supports 100 exports. The reader needs 8 exports. State both options' cost and the reason for your recommendation without inventing features.`, [price, "$90", `${count}`, "100", "8"], ["Recommend Basic based on the stated need.", "State both costs and export limits.", "Add no unsupported features."]],
      ["status", `Write a status update. In a fictional migration ${count} of 20 jobs completed. One blocked job reports ${code}; the cause is not yet known. The next step is to inspect its log. There is no completion date.`, [`${count}`, "20", code], ["State completed count.", "Keep the cause unknown and avoid an invented date.", "Name log inspection as the next step."]],
      ["email", `Draft an email asking a fictional supplier to refund ${price} for order SAMPLE-${i}. The parcel arrived damaged. A photo is attached. The contract has not been reviewed, so do not assert a legal entitlement or threaten action.`, [price, `SAMPLE-${i}`], ["Ask for the refund and refer to the photo.", "Preserve uncertainty about entitlement.", "Do not invent threats or a deadline."]],
      ["repository", `Draft a pull request description. A fictional retry counter previously ran 4 attempts instead of 3. This change stops after 3 attempts. Validation command: npm test. The only known result is that ${count} retry tests passed; do not claim the whole suite passed. Error code ${code} remains unchanged.`, ["4", "3", "npm test", `${count}`, code], ["Explain the before and after behavior.", "Name validation and the actual limited result.", "Keep the error code unchanged."]],
    ];
    for (const [genre, prompt, protectedValues, required] of templates) {
      const row = { id: `${genre}-${i}`, genre, prompt, protected: protectedValues, required };
      cases.push({ ...row, caseHash: sha256(stableJson(row)) });
    }
  }
  return cases;
}

function protectedPattern(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = /^[A-Za-z0-9_]/.test(value) ? "(?<![A-Za-z0-9_])" : "";
  const end = /[A-Za-z0-9_]$/.test(value) ? "(?![A-Za-z0-9_])" : "";
  return `${start}${escaped}${end}`;
}

export function caseDefinition(item, mode, guidance) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  return {
    schema_version: "1.1", name: item.id, runs: 1,
    execution: {
      prompt: `${item.prompt}\nReturn only the requested text. Do not inspect files or call tools.`,
      max_turns: 8, timeout_seconds: 120, allowed_tools: [],
      ...(mode === "ordinary" ? {} : { append_system_prompt: guidance }),
    },
    graders: item.protected.map((value, index) => ({
      name: `protected-${index + 1}`, type: "regex", target: "last_message",
      pattern: protectedPattern(value),
    })),
  };
}

export function summarizeRun(run) {
  if (run.error || run.aborted || run.skippedPaidGraders) throw new Error(run.error || "Incomplete generation");
  // Native eval adds fields without renaming them. Keep unavailable telemetry unknown.
  const trace = run.tracePath && existsSync(run.tracePath)
    ? readFileSync(run.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const messages = trace.filter((event) => event.type === "assistant")
    .flatMap((event) => (event.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text));
  const final = trace.findLast((event) => event.type === "result");
  const init = trace.find((event) => event.type === "system" && event.subtype === "init");
  if (final?.is_error) throw new Error(`Generation failed: ${final.subtype}`);
  const text = final?.result ?? run.lastMessage ?? run.last_message ?? run.finalResponse ?? run.response ?? messages.at(-1);
  if (typeof text !== "string" || !text.trim()) throw new Error("Native evaluation returned no reply");
  return {
    text,
    durationSeconds: run.durationSeconds ?? (typeof final?.duration_ms === "number" ? final.duration_ms / 1000 : null),
    costUsd: run.costUsd ?? final?.total_cost_usd ?? null,
    model: init?.model ?? null,
    claudeVersion: init?.claude_code_version ?? null,
    apiKeySource: init?.apiKeySource ?? null,
    usage: run.usage ?? final?.usage ?? null,
    modelUsage: final?.modelUsage ?? null,
    interruptions: run.interruptions ?? null,
    turns: run.turns ?? run.numTurns ?? run.num_turns ?? final?.num_turns ?? null,
  };
}

export function blindReviews(cases, outputs, seed) {
  const reviews = [], keys = [];
  for (const item of cases) {
    const rows = outputs.filter((row) => row.caseId === item.id);
    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        const pair = [rows[left], rows[right]];
        const id = sha256(`${seed}\0${item.id}\0${pair.map((row) => row.mode).join("\0")}`).slice(0, 20);
        if (parseInt(id.slice(0, 2), 16) % 2) pair.reverse();
        reviews.push({ id, prompt: item.prompt, required: item.required, protected: item.protected,
          A: pair[0].text, B: pair[1].text, factsPreservedA: null, factsPreservedB: null,
          completeA: null, completeB: null, choice: null, reason: null });
        keys.push({ id, caseId: item.id, A: pair[0].mode, B: pair[1].mode });
      }
    }
  }
  return { reviews: reviews.sort((a, b) => a.id.localeCompare(b.id)), keys };
}

/** Execute native binaries and Node launchers without a platform shell. */
function runClaude(command, args, options) {
  return /\.(?:mjs|cjs|js)$/i.test(command)
    ? execFileSync(process.execPath, [command, ...args], options)
    : execFileSync(command, args, options);
}

function runtimeIdentity(command) {
  let claudeVersion = null;
  try {
    claudeVersion = runClaude(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/)[0] || null;
  } catch { /* Preparing offline is allowed; running requires the same identity. */ }
  return { claudeVersion, providerFlags: Object.fromEntries([
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
  ].map((name) => [name, Boolean(process.env[name])])) };
}

async function main(args) {
  const command = args.shift();
  if (!new Set(["prepare", "run"]).has(command)) throw new Error("Usage: claude.mjs prepare|run --out <outside-repo> [--limit 2] [--max-cost-usd 2] [--claude-command path]");
  function option(name, fallback) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
    args.splice(index, 2); return value;
  }
  const claudeCommand = option("--claude-command", "claude");
  const destination = option("--out");
  if (!destination) throw new Error("--out must name an output directory outside the repository");
  const out = resolve(destination);
  assertOutsideRepository(out, ROOT);
  const limit = Number(option("--limit", "48"));
  const budget = Number(option("--max-cost-usd", "2"));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 48) throw new Error("--limit must be 1..48");
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("--max-cost-usd must be positive");
  if (args.length) throw new Error(`Unexpected argument ${args[0]}`);
  const cases = benchmarkCases().slice(0, limit);
  const style = readFileSync(resolve(ROOT, "integrations/claude-code/output-styles/plain-english.md"), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const document = readFileSync(resolve(ROOT, "integrations/claude-code/skills/writing-a-document/SKILL.md"), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const guidance = `${style}\n\n${document}`;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const pluginHash = pluginFingerprint(resolve(ROOT, "integrations/claude-code-plugin"));
  const identity = { cases: cases.map((row) => row.caseHash), guidanceHash: sha256(guidance), pluginHash, benchmarkHash: sha256(readFileSync(import.meta.filename)), runtime: runtimeIdentity(claudeCommand) };
  if (command === "run" && !identity.runtime.claudeVersion) {
    throw new Error("Claude executable version is unavailable; refusing to generate or compare results.");
  }
  const identityPath = resolve(out, "identity.json");
  if (existsSync(identityPath) && stableJson(JSON.parse(readFileSync(identityPath, "utf8"))) !== stableJson(identity)) {
    throw new Error("Inputs changed. Choose a new output directory to keep the comparison reproducible.");
  }
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  writeFileSync(resolve(out, "cases.json"), JSON.stringify(cases, null, 2));
  for (const mode of MODES) {
    const plugin = resolve(out, mode);
    if (mode === "checks") cpSync(resolve(ROOT, "integrations/claude-code-plugin"), plugin, { recursive: true });
    else {
      mkdirSync(resolve(plugin, ".claude-plugin"), { recursive: true });
      writeFileSync(resolve(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: `writing-benchmark-${mode}`, version: "1.0.0" }));
    }
    for (const item of cases) {
      const directory = resolve(plugin, "evals", item.id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "case.yaml"), stringify(caseDefinition(item, mode, guidance)));
    }
  }
  if (command === "prepare") { process.stdout.write(`Prepared ${cases.length} synthetic cases across three modes.\n`); return; }
  const outputs = [], metrics = [];
  let generationIdentity = null;
  let spent = 0;
  for (const mode of MODES) {
    const resultPath = resolve(out, `${mode}-result.json`);
    if (!existsSync(resultPath)) {
      if (spent >= budget) throw new Error("Cost ceiling reached; partial results retained");
      try {
        runClaude(claudeCommand, ["plugin", "eval", resolve(out, mode), "--ablation", "none", "--runs", "1",
          "--trust-plugin", "--no-publish", "--keep-temp", "--max-cost-usd", String(budget - spent), "--json", resultPath],
          { stdio: "inherit", env: { ...process.env, CLAUDECODE: "" } });
      } catch (error) { if (!existsSync(resultPath)) throw error; }
    }
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (typeof result.costUsd !== "number" || !Number.isFinite(result.costUsd) || result.costUsd < 0) {
      throw new Error(`${mode} cost is unavailable; refusing to launch more generations`);
    }
    spent += result.costUsd;
    if (result.partial) throw new Error(`Partial ${mode} run: ${result.partialReason}`);
    const modeRows = [];
    const seen = new Set();
    for (const item of result.cases ?? []) {
      if (seen.has(item.name)) throw new Error(`Duplicate ${mode} case ${item.name}`);
      seen.add(item.name);
      const nativeRuns = item.arms?.with ?? [];
      if (nativeRuns.length !== 1) throw new Error(`Expected one ${mode} generation for ${item.name}`);
      const row = summarizeRun(nativeRuns[0]);
      if (!row.model || !row.claudeVersion) throw new Error(`Generation identity unavailable for ${mode} ${item.name}`);
      const observed = { model: row.model, claudeVersion: row.claudeVersion, apiKeySource: row.apiKeySource };
      if (identity.runtime.claudeVersion && observed.claudeVersion !== identity.runtime.claudeVersion) {
        throw new Error(`Generation identity changed: executable version differs for ${mode} ${item.name}`);
      }
      if (generationIdentity && stableJson(generationIdentity) !== stableJson(observed)) {
        throw new Error(`Generation identity changed for ${mode} ${item.name}; choose a new output directory`);
      }
      generationIdentity ??= observed;
      const benchmark = cases.find((candidate) => candidate.id === item.name);
      if (!benchmark) throw new Error(`Unknown evaluation case ${item.name}`);
      modeRows.push({ caseId: item.name, mode, ...row,
        missingProtected: benchmark.protected.filter((value) => !new RegExp(protectedPattern(value)).test(row.text)) });
    }
    if (modeRows.length !== cases.length) throw new Error(`Missing ${mode} outputs`);
    outputs.push(...modeRows);
    metrics.push({ mode, durationSeconds: result.durationSeconds ?? null, costUsd: result.costUsd ?? null,
      backgroundCheckCostUsd: null,
      cliVersion: result.claudeVersion ?? null, score: result.aggregates?.overallScore ?? null });
    writeFileSync(resolve(out, "outputs.json"), JSON.stringify(outputs, null, 2));
  }
  const { reviews, keys } = blindReviews(cases, outputs, sha256(stableJson(identity)));
  writeFileSync(resolve(out, "blind-review.json"), JSON.stringify(reviews, null, 2));
  writeFileSync(resolve(out, "review-key.json"), JSON.stringify(keys, null, 2));
  writeFileSync(resolve(out, "metrics.json"), JSON.stringify({ metrics, generationIdentity, humanReview: "pending", limitations:
    "One run per task is a smoke comparison. Literal preservation does not prove factual correctness or writing quality. Native costs and the ceiling exclude separately spawned background checks, whose cost remains unknown. Unavailable telemetry is null. Repeat runs and independent blinded review are required before superiority claims." }, null, 2));
  process.stdout.write(`Saved ${outputs.length} outputs and ${reviews.length} blinded comparisons. Human review pending.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
