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
    // Four different task contracts per genre; changing a number is not a new scenario.
    const alternatives = [
      [
        ["chat", `Explain a fictional dashboard mismatch to a nontechnical colleague. The dashboard says ${count} orders; the export says 20. The dashboard refreshes every 15 minutes. Refresh delay is a hypothesis, not a confirmed cause. Suggest comparing timestamps before changing data.`, [`${count}`, "20", "15 minutes"], ["Explain the mismatch plainly.", "Label refresh delay as a hypothesis.", "Suggest comparing timestamps without changing data."]],
        ["technical-doc", `Write one Markdown paragraph documenting a fictional upload limit: ${count} MB per file, JPEG or PNG only. Oversized files return ${code}; no compression occurs automatically. Do not invent a total storage limit.`, [`${count} MB`, "JPEG", "PNG", code], ["State file size and formats.", "Describe the oversized-file error and absent automatic compression.", "Do not invent storage policy."]],
        ["decision", `Recommend whether a fictional team should migrate Friday or Monday. Friday requires ${count} staff-hours; Monday requires 20. Both meet the deadline. Friday has no support coverage; Monday has two support staff. Reliability matters more than staff-hours. Show the tradeoff without calculating unsupported failure probabilities.`, [`${count}`, "20", "Friday", "Monday"], ["Recommend Monday for support coverage.", "Retain both workload figures and deadline parity.", "Do not invent failure probabilities."]],
        ["status", `Write a status update for a fictional release: ${count} checks passed, 2 are pending, none have failed. Pending checks have not run. Owner Sam will run them next. No deployment has happened. Do not call the release approved.`, [`${count}`, "2", "Sam"], ["Distinguish pending from failed checks.", "Name Sam's next step.", "Do not imply deployment or approval."]],
        ["email", `Draft an email rescheduling a fictional supplier call from Tuesday to Thursday at 14:00 UTC. Order SAMPLE-${i} is the topic. Thursday is a proposed time, not agreed. Ask for confirmation and offer to find another slot. Do not invent why the call moved.`, ["Tuesday", "Thursday", "14:00 UTC", `SAMPLE-${i}`], ["Propose the new time and retain UTC.", "Ask for confirmation with an alternative.", "Do not claim agreement or invent a reason."]],
        ["repository", `Draft a fictional issue report: upload of a ${count} MB PNG returns ${code}, but documented limit is 20 MB. Reproduction happened once on version 2.0. Expected upload acceptance. Logs are unavailable. Ask maintainers to investigate without naming a cause.`, [`${count} MB`, "PNG", code, "20 MB", "2.0"], ["State actual and expected behavior.", "Preserve single reproduction and unavailable logs.", "Do not invent root cause."]],
      ],
      [
        ["chat", `Give a light edit of this fictional note, retaining its two sentences and uncertainty: 'We may pause SAMPLE-${i} after ${count} minutes. We have not yet checked the logs.' Make it clearer without deciding whether to pause. Return exactly two sentences.`, [`SAMPLE-${i}`, `${count} minutes`], ["Return two sentences.", "Keep pause tentative and logs unchecked.", "Do not turn the edit into a decision."]],
        ["technical-doc", `Write a Markdown warning for fictional command purge --older-than ${count}d. It permanently deletes matching cached files; backups are not created. A preview is available with --dry-run. Preserve both command strings exactly. Do not imply the preview deletes files.`, [`purge --older-than ${count}d`, "--dry-run"], ["Warn about permanent deletion and no backups.", "Describe the preview correctly.", "Retain exact command text."]],
        ["decision", `Recommend a fictional report format for a screen-reader user: PDF costs ${price} and has untagged tables; HTML costs $90 and uses headings with accessible table labels. Only these accessibility properties have been tested. Explain why the costlier option may be justified without claiming full compliance.`, [price, "$90", "PDF", "HTML"], ["Recommend HTML for tested reader support.", "State costs and specific tested properties.", "Avoid full compliance claims."]],
        ["status", `Write a status update for a fictional incident: ${count} requests failed between 09:00 and 09:05 UTC. Errors stopped after a restart. The restart may be related; cause remains unconfirmed. Monitoring continues, with no claim that the incident is resolved.`, [`${count}`, "09:00", "09:05 UTC"], ["State impact and time window.", "Keep correlation distinct from cause.", "State monitoring without declaring resolution."]],
        ["email", `Draft a fictional customer email correcting an earlier invoice: SAMPLE-${i} incorrectly listed ${price}; correct amount is $90. The corrected invoice is attached. Do not say it was paid, refunded or overdue. Acknowledge the error and ask the recipient to use the corrected invoice.`, [`SAMPLE-${i}`, price, "$90"], ["Acknowledge error and give both amounts.", "Refer to corrected attachment and requested action.", "Do not invent payment state."]],
        ["repository", `Draft a fictional pull request review comment: a new branch catches all errors and returns null. In test SAMPLE-${i}, a timeout ${code} becomes null. Ask to preserve timeout information or explain this choice; do not assume the author intended to hide errors.`, ["null", `SAMPLE-${i}`, code], ["Describe the concrete observed behavior.", "Ask for preservation or explanation.", "Avoid attributing intent."]],
      ],
      [
        ["chat", `Explain fictional test evidence to a manager: ${count} checkout tests passed on staging. Production and payment-provider outages were not tested. The manager asks whether checkout is safe to deploy. Give a qualified answer and name what evidence is missing.`, [`${count}`, "staging"], ["Retain scope of passing tests.", "Do not guarantee production safety.", "Name production and provider-outage gaps."]],
        ["technical-doc", `Write one Markdown paragraph for fictional API field retry_count. Value 0 means no retry; maximum is ${count}. A missing field defaults to 0. Negative values return ${code}. Do not rename retry_count or describe the count as total attempts.`, ["retry_count", "0", `${count}`, code], ["Define retries rather than attempts.", "Keep default, maximum and negative-value behavior.", "Retain field name."]],
        ["decision", `Advise whether to buy a fictional device today. It costs ${price}; warranty terms and compatibility are unknown. It would save ${count} minutes weekly if compatible. Recommend the next decision step rather than assuming it fits.`, [price, `${count} minutes`], ["Keep price and conditional benefit.", "Recommend checking compatibility and warranty.", "Do not invent a purchase conclusion."]],
        ["status", `Write a fictional handoff: SAMPLE-${i} import is paused after ${count} rows because the input contains duplicate IDs. Original input remains unchanged. Lee owns the next step, comparing duplicate rows. Do not say which row is correct or promise a restart time.`, [`SAMPLE-${i}`, `${count}`, "Lee"], ["Explain paused state and unchanged input.", "Name owner and comparison step.", "Retain unknown correct row and restart time."]],
        ["email", `Draft a fictional internal email declining a request for ${count} extra slides by Friday. The team can provide 3 slides by Friday or all requested slides by Monday. Ask which scope the recipient prefers. Do not invent staffing or budget reasons.`, [`${count}`, "3", "Friday", "Monday"], ["Decline the original scope and deadline together.", "Offer both concrete alternatives.", "Ask for choice without invented justification."]],
        ["repository", `Draft fictional release notes: version 2.${i} changes retry limit from 4 to 3, keeps ${code}, and removes support for config key legacy_retry. Existing users of that key must update configuration before upgrading. Do not label the change backward compatible.`, [`2.${i}`, "4", "3", code, "legacy_retry"], ["State behavior and unchanged error code.", "Explain removed key and migration action.", "Do not claim backward compatibility."]],
      ],
    ];
    const scenario = (i - 1) % 4;
    const selected = scenario === 0 ? templates : alternatives[scenario - 1];
    for (const [genre, prompt, protectedValues, required] of selected) {
      const row = { id: `${genre}-${i}`, genre, scenario: `${genre}-${scenario + 1}`, prompt, protected: protectedValues, required };
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

/** Costs observed in background checks, never an account invoice or proof of hook coverage. */
export function summarizeCheckReceipts(rows, captureEnabled) {
  const started = new Map(), finished = new Map(), captures = new Set(), health = new Map();
  for (const row of rows) {
    if (row.schemaVersion !== 1) throw new Error("Invalid background-check receipt");
    if (row.phase === "capture-enabled" && row.captureVersion === 1 && typeof row.captureId === "string") {
      if (captures.has(row.captureId)) throw new Error("Duplicate background-check capture marker");
      captures.add(row.captureId); continue;
    }
    if (row.phase === "capture-finished" && typeof row.captureId === "string" &&
      Number.isSafeInteger(row.issuedCalls) && row.issuedCalls >= 0 &&
      Number.isSafeInteger(row.completedCalls) && row.completedCalls >= 0 &&
      row.completedCalls <= row.issuedCalls && typeof row.captureHealthy === "boolean") {
      if (health.has(row.captureId)) throw new Error("Duplicate background-check health marker");
      health.set(row.captureId, row); continue;
    }
    if (typeof row.callId !== "string") throw new Error("Invalid background-check receipt");
    const calls = row.phase === "started" ? started : row.phase === "finished" ? finished : null;
    if (!calls || calls.has(row.callId)) throw new Error("Duplicate or invalid background-check receipt");
    if (row.phase === "finished" && row.reportedCostUsd !== null &&
      (typeof row.reportedCostUsd !== "number" || !Number.isFinite(row.reportedCostUsd) || row.reportedCostUsd < 0)) {
      throw new Error("Invalid background-check cost");
    }
    calls.set(row.callId, row);
  }
  const healthy = captures.size > 0 && captures.size === health.size &&
    [...captures].every((id) => health.get(id)?.captureHealthy === true);
  const expectedIssuedCalls = health.size ? [...health.values()].reduce((sum, row) => sum + row.issuedCalls, 0) : null;
  const expectedCompletedCalls = health.size ? [...health.values()].reduce((sum, row) => sum + row.completedCalls, 0) : null;
  const receiptCoverageComplete = healthy && [...captures].every((id) =>
    [...started.values()].filter((row) => row.captureId === id).length === health.get(id).issuedCalls &&
    [...finished.values()].filter((row) => row.captureId === id).length === health.get(id).completedCalls) &&
    [...started.values(), ...finished.values()].every((row) => captures.has(row.captureId)) &&
    [...finished].every(([id, row]) => started.get(id)?.captureId === row.captureId);
  const unpricedCalls = [...finished.values()].filter((row) => row.reportedCostUsd === null).length;
  const observedPricedCostUsd = [...finished.values()].reduce((total, row) => total + (row.reportedCostUsd ?? 0), 0);
  const incompleteCalls = [...started.keys()].filter((id) => !finished.has(id)).length;
  return { captureEnabled, observedHookExecutions: captures.size, expectedIssuedCalls, expectedCompletedCalls,
    receiptCoverageComplete, issuedCalls: started.size, completedCalls: finished.size, incompleteCalls,
    unpricedCalls, reportedCostUsd: captureEnabled && receiptCoverageComplete && !incompleteCalls && !unpricedCalls ? observedPricedCostUsd : null,
    observedPricedCostUsd, invoiceCostUsd: null, costBasis: "provider-reported-api-estimate" };
}

/** Review individual answers before comparing style; the private key is a separate artifact. */
export function blindOutputReviews(cases, outputs, seed) {
  const reviews = [], keys = [];
  for (const row of outputs) {
    const item = cases.find((candidate) => candidate.id === row.caseId);
    if (!item) throw new Error("Unknown correctness-review case");
    const id = sha256(`${seed}\0correctness\0${item.id}\0${row.mode}`).slice(0, 20);
    reviews.push({ id, prompt: item.prompt, required: item.required, protected: item.protected,
      text: row.text, correctness: null, completeness: null, reason: null });
    keys.push({ id, caseId: item.id, mode: row.mode });
  }
  return { reviews: reviews.sort((a, b) => a.id.localeCompare(b.id)), keys };
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

/** Native eval drops custom outer env; instrument its existing startup hook in the test copy. */
export function instrumentMeasurementCapture(source, receiptPath) {
  const startup = /on\(\s*['"]session\.start['"]\s*,\s*async\s*\(\s*\$\s*,[^)]*\)\s*=>\s*\{/g;
  const matches = [...source.matchAll(startup)];
  if (matches.length !== 1) throw new Error("Native measurement capture requires one known session.start hook");
  const offset = matches[0].index + matches[0][0].length;
  const line = `\n    // Evaluation instrumentation only: capture usage metadata, not prose.\n    await $.env.set("PLAIN_ENGLISH_JUDGE_RECEIPTS", ${JSON.stringify(receiptPath)});\n`;
  return source.slice(0, offset) + line + source.slice(offset);
}

function captureSource(plugin) {
  const hooks = JSON.parse(readFileSync(resolve(plugin, "hooks/hooks.json"), "utf8"));
  if (!Array.isArray(hooks.modules) || hooks.modules.length !== 1 || !/^\.\/[A-Za-z0-9_-]+\.(?:ts|js)$/.test(hooks.modules[0])) {
    throw new Error("Native measurement capture requires one local mod module");
  }
  return resolve(plugin, "hooks", hooks.modules[0]);
}

export function installMeasurementCapture(plugin, receiptPath) {
  const path = captureSource(plugin);
  const source = instrumentMeasurementCapture(readFileSync(path, "utf8"), receiptPath);
  writeFileSync(path, source);
  return sha256(source);
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
  // The bundled CLI ships in pieces, so the receipts code can sit in any of them.
  // Receipts are written by a checker that reads PLAIN_ENGLISH_JUDGE_RECEIPTS.
  // Since ADR-008 the plugin's checker runs inside its mod and writes none.
  const pluginHooks = resolve(ROOT, "integrations/claude-code-plugin/hooks");
  const captureSupported = readdirSync(pluginHooks, { recursive: true, withFileTypes: true })
    .some((entry) => entry.isFile() && readFileSync(resolve(entry.parentPath, entry.name), "utf8").includes("PLAIN_ENGLISH_JUDGE_RECEIPTS"));
  const captureHarnessHash = captureSupported ? sha256(instrumentMeasurementCapture(readFileSync(captureSource(resolve(ROOT, "integrations/claude-code-plugin")), "utf8"), resolve(out, "checks-check-usage.jsonl"))) : null;
  const identity = { cases: cases.map((row) => row.caseHash), guidanceHash: sha256(guidance), pluginHash, benchmarkHash: sha256(readFileSync(import.meta.filename)), captureHarnessHash, runtime: runtimeIdentity(claudeCommand) };
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
    if (mode === "checks") {
      cpSync(resolve(ROOT, "integrations/claude-code-plugin"), plugin, { recursive: true });
      if (captureSupported) installMeasurementCapture(plugin, resolve(out, "checks-check-usage.jsonl"));
    }
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
    const receiptPath = resolve(out, `${mode}-check-usage.jsonl`);
    const modeCaptureSupported = mode === "checks" && captureSupported;
    if (!existsSync(resultPath)) {
      if (spent >= budget) throw new Error("Cost ceiling reached; partial results retained");
      try {
        runClaude(claudeCommand, ["plugin", "eval", resolve(out, mode), "--ablation", "none", "--runs", "1",
          "--trust-plugin", "--no-publish", "--keep-temp", "--max-cost-usd", String(budget - spent), "--json", resultPath],
          { stdio: "inherit", env: { ...process.env, CLAUDECODE: "", PLAIN_ENGLISH_JUDGE_RECEIPTS: "" } });
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
    const receipts = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const backgroundChecks = summarizeCheckReceipts(receipts, modeCaptureSupported && receipts.some((row) => row.phase === "capture-enabled"));
    const backgroundCaptureReason = mode !== "checks" ? "This mode has no checker plugin." :
      !captureSupported ? "This plugin does not implement usage receipts." :
      !backgroundChecks.captureEnabled ? "No capture marker was received from the native checker." :
      !backgroundChecks.receiptCoverageComplete ? "Checker receipt capture was incomplete or unhealthy." :
      backgroundChecks.reportedCostUsd === null ? "One or more model calls did not finish or report a price." : null;
    metrics.push({ mode, backgroundCaptureReason, durationSeconds: result.durationSeconds ?? null, costUsd: result.costUsd ?? null,
      backgroundCheckCostUsd: backgroundChecks.reportedCostUsd, backgroundChecks,
      cliVersion: result.claudeVersion ?? null, score: result.aggregates?.overallScore ?? null });
    writeFileSync(resolve(out, "outputs.json"), JSON.stringify(outputs, null, 2));
  }
  const seed = sha256(stableJson(identity));
  const { reviews, keys } = blindReviews(cases, outputs, seed);
  const correctness = blindOutputReviews(cases, outputs, seed);
  writeFileSync(resolve(out, "correctness-review.json"), JSON.stringify(correctness.reviews, null, 2));
  writeFileSync(resolve(out, "correctness-key.json"), JSON.stringify(correctness.keys, null, 2));
  writeFileSync(resolve(out, "blind-review.json"), JSON.stringify(reviews, null, 2));
  writeFileSync(resolve(out, "review-key.json"), JSON.stringify(keys, null, 2));
  writeFileSync(resolve(out, "metrics.json"), JSON.stringify({ metrics, generationIdentity, humanReview: "pending", limitations:
    "One run per task is a smoke comparison. Literal preservation does not prove factual correctness or writing quality. Native generation costs and the ceiling exclude separately spawned background checks. Receipts, when present, record provider-reported API price estimates for observed calls, not billed subscription cost or proof that every hook ran. Missing or incomplete receipts leave total background cost unknown. Unavailable telemetry is null. Repeat runs and independent blinded review are required before superiority claims." }, null, 2));
  process.stdout.write(`Saved ${outputs.length} outputs and ${reviews.length} blinded comparisons. Human review pending.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
