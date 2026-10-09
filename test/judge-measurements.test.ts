import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runJudge } from "../src/adapters/judge.ts";
import { initializeJudgeReceipts } from "../src/adapters/judge-receipts.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("background model measurements", () => {
  it("reads the Claude result envelope while reporting usage separately from its verdict", () => {
    const measurements: unknown[] = [];
    const result = {
      type: "result", subtype: "success", is_error: false,
      result: '{"ok":false,"reason":"Lead with the point."}',
      total_cost_usd: 0.012,
      usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 20 },
      modelUsage: { "claude-fixture": { inputTokens: 40, outputTokens: 12, costUSD: 0.012 } },
    };
    const verdict = runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`, "--", "--output-format", "json"], env: {},
      onMeasurement: (measurement: unknown) => measurements.push(measurement),
    });
    expect(verdict).toEqual({ ok: false, reason: "Lead with the point." });
    expect(measurements).toEqual([expect.objectContaining({
      provider: "claude", outcome: "complete", reportedCostUsd: 0.012,
      invoiceCostUsd: null, costBasis: "provider-reported-api-estimate",
      usage: result.usage, modelUsage: result.modelUsage,
    })]);
    expect(JSON.stringify(measurements)).not.toContain("PRIVATE_INPUT");
    expect(JSON.stringify(measurements)).not.toContain("Lead with the point");
  });

  it("records started and finished calls only in the explicitly selected receipt file", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-judge-receipts-")); dirs.push(dir);
    const path = resolve(dir, "usage.jsonl");
    const result = { type: "result", is_error: false, result: '{"ok":true}',
      total_cost_usd: 0.001, usage: { input_tokens: 3, output_tokens: 2 },
      session_id: "PRIVATE_SESSION", privateExtra: "PRIVATE_INPUT" };
    expect(runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`, "--", "--output-format", "json"],
      env: { PLAIN_ENGLISH_JUDGE_RECEIPTS: path },
    })).toEqual({ ok: true });
    const data = readFileSync(path, "utf8");
    const receipts = data.trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["started", "finished"]);
    expect(receipts[0].callId).toEqual(receipts[1].callId);
    expect(receipts[1]).toMatchObject({ schemaVersion: 1, outcome: "complete", reportedCostUsd: 0.001,
      usage: result.usage, invoiceCostUsd: null });
    expect(data).not.toContain("PRIVATE");
    expect(data).not.toContain(dir);
  });

  it("keeps missing measurements unknown and removes text and invalid numbers", () => {
    const measurements: unknown[] = [];
    const result = { type: "result", is_error: false, result: '{"ok":true}', total_cost_usd: -1,
      usage: { input_tokens: 1.5, output_tokens: 0, cache_read_input_tokens: -9, privateExtra: "PRIVATE_INPUT" },
      modelUsage: {
        "claude-fixture": { inputTokens: 5, outputTokens: -1, costUSD: "unknown", privateExtra: "PRIVATE_INPUT" },
        "PRIVATE INPUT TEXT": { inputTokens: 5 },
      },
    };
    expect(runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`, "--", "--output-format", "json"], env: {},
      onMeasurement: (measurement) => measurements.push(measurement),
    })).toEqual({ ok: true });
    expect(measurements).toEqual([expect.objectContaining({
      reportedCostUsd: null, invoiceCostUsd: null, costBasis: "unknown",
      usage: { output_tokens: 0 }, modelUsage: { "claude-fixture": { inputTokens: 5 } },
    })]);
    expect(JSON.stringify(measurements)).not.toContain("PRIVATE");
  });

  it("proves capture is enabled when a hook makes no background model request", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-judge-marker-")); dirs.push(dir);
    const path = resolve(dir, "usage.jsonl");
    writeFileSync(resolve(dir, ".plain-english.yml"), "version: 1\nextends: default\nmodelChecks: false\n");
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../dist/cli.js"), "hook", "docs", "--agent", "claude-code"], {
      cwd: dir, env: { ...process.env, PLAIN_ENGLISH_JUDGE_RECEIPTS: path, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", cwd: dir,
        tool_input: { file_path: resolve(dir, "note.md"), content: "The cache holds parsed results for an hour.\n" } }),
    });
    const receipts = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts).toEqual([
      expect.objectContaining({ schemaVersion: 1, captureVersion: 1, phase: "capture-enabled" }),
      expect.objectContaining({ schemaVersion: 1, phase: "capture-finished", issuedCalls: 0,
        completedCalls: 0, captureHealthy: true }),
    ]);
    expect(receipts[0].captureId).toBe(receipts[1].captureId);
    expect(JSON.stringify(receipts)).not.toContain(dir);
  });

  it("reports lost call receipts as unhealthy without changing the model verdict", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-judge-health-")); dirs.push(dir);
    const path = resolve(dir, "usage.jsonl");
    const env = { PLAIN_ENGLISH_JUDGE_RECEIPTS: path };
    const finishCapture = initializeJudgeReceipts(env);
    const marker = readFileSync(path, "utf8");
    rmSync(path); mkdirSync(path);
    expect(runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", 'console.log(\'{"ok":true}\')'], env,
    })).toEqual({ ok: true });
    rmSync(path, { recursive: true }); writeFileSync(path, marker);
    finishCapture();
    const receipts = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts.at(-1)).toMatchObject({ phase: "capture-finished", captureHealthy: false,
      issuedCalls: 1, completedCalls: 1 });
    expect(receipts).toHaveLength(2);
  });

  it("keeps usage from a failed Claude request without accepting its generated verdict", () => {
    const measurements: unknown[] = [];
    const result = { type: "result", is_error: true, result: '{"ok":true}',
      total_cost_usd: 0.004, usage: { input_tokens: 8, output_tokens: 1 } };
    expect(runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(result))})`, "--", "--output-format", "json"], env: {},
      onMeasurement: (measurement) => measurements.push(measurement),
    })).toBeUndefined();
    expect(measurements).toEqual([expect.objectContaining({ outcome: "failed", reportedCostUsd: 0.004,
      usage: result.usage, invoiceCostUsd: null })]);
  });

  it("marks timed-out calls and unavailable measurements instead of inventing zero cost", () => {
    const measurements: unknown[] = [];
    expect(runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"], env: {}, timeoutMs: 20,
      onMeasurement: (measurement) => measurements.push(measurement),
    })).toBeUndefined();
    expect(measurements).toEqual([expect.objectContaining({ outcome: "timed_out", reportedCostUsd: null,
      usage: null, modelUsage: null, invoiceCostUsd: null })]);
  });

  it("does not accept model-written price fields when the command returns plain text", () => {
    const measurements: unknown[] = [];
    const generated = { type: "result", result: '{"ok":true}', total_cost_usd: 123,
      usage: { input_tokens: 99 }, modelUsage: { "claude-invented": { costUSD: 123 } } };
    runJudge("PRIVATE_INPUT", {
      prompt: "Check: $ARGUMENTS", command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(generated))})`], env: {},
      onMeasurement: (measurement) => measurements.push(measurement),
    });
    expect(measurements).toEqual([expect.objectContaining({ reportedCostUsd: null,
      usage: null, modelUsage: null, costBasis: "unknown" })]);
  });
});
