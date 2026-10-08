import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error maintainer JavaScript tool
import { benchmarkCases, caseDefinition, summarizeRun, blindReviews, pluginFingerprint, summarizeCheckReceipts, blindOutputReviews } from "../scripts/evaluation/claude.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function trace(events: unknown[]) {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-benchmark-trace-"));
  dirs.push(dir);
  const path = resolve(dir, "trace.jsonl");
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n"));
  return path;
}

const SCRIPT = resolve(import.meta.dirname, "../scripts/evaluation/claude.mjs");
function prepared(runtimeAvailable = true) {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-benchmark-run-"));
  dirs.push(dir);
  const bin = resolve(dir, "bin space & literal"); mkdirSync(bin);
  const fake = resolve(bin, "claude.mjs");
  function setVersion(version: string, available = true) {
    writeFileSync(fake, available
      ? `if (process.argv[2] === "--version") console.log(${JSON.stringify(version)}); else process.exit(87);\n`
      : "process.exit(87);\n");
  }
  setVersion("2.1.fixture", runtimeAvailable);
  const env = { ...process.env, PATH: bin, PLAIN_ENGLISH_CHAT_JUDGE: "1" };
  execFileSync(process.execPath, [SCRIPT, "prepare", "--out", dir, "--limit", "2", "--claude-command", fake], { env });
  const identity = JSON.parse(readFileSync(resolve(dir, "identity.json"), "utf8"));
  expect(identity.runtime.claudeVersion).toBe(runtimeAvailable ? "2.1.fixture" : null);
  const cases = JSON.parse(readFileSync(resolve(dir, "cases.json"), "utf8"));
  function cached(mode: string, names = cases.map((item: { id: string }) => item.id), cost: unknown = 0.1, model = "fixture-model") {
    writeFileSync(resolve(dir, `${mode}-result.json`), JSON.stringify({
      costUsd: cost, partial: false, claudeVersion: "2.1.fixture", cases: names.map((name: string) => ({
        name, arms: { with: [{ lastMessage: "Synthetic output", durationSeconds: 1, costUsd: 0.05, turns: 1,
          tracePath: trace([
            { type: "system", subtype: "init", model, claude_code_version: "2.1.fixture", apiKeySource: "fixture-provider" },
            { type: "result", subtype: "success", is_error: false, result: "Synthetic output" },
          ]),
        }] },
      })),
    }));
  }
  for (const mode of ["ordinary", "guidance", "checks"]) cached(mode);
  const run = (extra: string[] = []) => spawnSync(process.execPath, [SCRIPT, "run", "--out", dir, "--limit", "2",
    ...(extra.includes("--claude-command") ? [] : ["--claude-command", fake]), ...extra], { env, encoding: "utf8" });
  return { dir, fake, cases, cached, run, setVersion };
}

describe("Claude writing benchmark", () => {
  it("keeps incomplete and unpriced background calls distinct from zero spending", () => {
    const rows = [
      { schemaVersion: 1, callId: "a", phase: "started" },
      { schemaVersion: 1, callId: "a", phase: "finished", reportedCostUsd: 0.02 },
      { schemaVersion: 1, callId: "b", phase: "started" },
      { schemaVersion: 1, callId: "c", phase: "started" },
      { schemaVersion: 1, callId: "c", phase: "finished", reportedCostUsd: null },
    ];
    expect(summarizeCheckReceipts(rows, true)).toEqual({
      captureEnabled: true, observedHookExecutions: 0, expectedIssuedCalls: null, expectedCompletedCalls: null,
      receiptCoverageComplete: false, issuedCalls: 3, completedCalls: 2, incompleteCalls: 1,
      unpricedCalls: 1, reportedCostUsd: null, observedPricedCostUsd: 0.02,
      invoiceCostUsd: null, costBasis: "provider-reported-api-estimate",
    });
    expect(summarizeCheckReceipts([], false).reportedCostUsd).toBeNull();
    expect(summarizeCheckReceipts([], true).reportedCostUsd).toBeNull();
  });

  it("records zero background calls only when a hook confirms capture", () => {
    const marker = { schemaVersion: 1, phase: "capture-enabled", captureVersion: 1, captureId: "hook-a" };
    expect(summarizeCheckReceipts([marker], true).reportedCostUsd).toBeNull();
    const end = { schemaVersion: 1, phase: "capture-finished", captureId: "hook-a", issuedCalls: 0, completedCalls: 0, captureHealthy: true };
    const result = summarizeCheckReceipts([marker, end], true);
    expect(result.reportedCostUsd).toBe(0);
    expect(result.issuedCalls).toBe(0);
    expect(result.observedHookExecutions).toBe(1);
    const priced = summarizeCheckReceipts([
      marker,
      { schemaVersion: 1, captureId: "hook-a", callId: "call-a", phase: "started" },
      { schemaVersion: 1, captureId: "hook-a", callId: "call-a", phase: "finished", reportedCostUsd: 0.02 },
      { ...end, issuedCalls: 1, completedCalls: 1 },
    ], true);
    expect(priced.reportedCostUsd).toBe(0.02);
    expect(priced.receiptCoverageComplete).toBe(true);
  });
  it("does not trust healthy capture when its call receipts are missing", () => {
    const rows = [
      { schemaVersion: 1, phase: "capture-enabled", captureVersion: 1, captureId: "hook-a" },
      { schemaVersion: 1, phase: "capture-finished", captureId: "hook-a", issuedCalls: 1, completedCalls: 1, captureHealthy: true },
    ];
    const result = summarizeCheckReceipts(rows, true);
    expect(result.reportedCostUsd).toBeNull();
    expect(result.receiptCoverageComplete).toBe(false);
    expect(result.expectedIssuedCalls).toBe(1);
  });
  it("configures capture inside the copied native plugin because eval drops outer environment variables", () => {
    const fixture = prepared();
    const hooks = JSON.parse(readFileSync(resolve(fixture.dir, "checks/hooks/hooks.json"), "utf8"));
    expect(hooks.modules).toEqual(["./register.ts"]);
    const module = readFileSync(resolve(fixture.dir, "checks/hooks/register.ts"), "utf8");
    expect(module).toContain('$.env.set("PLAIN_ENGLISH_JUDGE_RECEIPTS"');
    expect(module).toContain(JSON.stringify(resolve(fixture.dir, "checks-check-usage.jsonl")));
    const identity = JSON.parse(readFileSync(resolve(fixture.dir, "identity.json"), "utf8"));
    expect(identity.captureHarnessHash).toBe(createHash("sha256").update(module).digest("hex"));
  });
  it("creates one shuffled correctness review per reply without exposing its mode", () => {
    const item = benchmarkCases()[0];
    const outputs = ["ordinary", "guidance", "checks"].map((mode) => ({ caseId: item.id, mode, text: "Same reply" }));
    const { reviews, keys } = blindOutputReviews([item], outputs, "seed");
    expect(reviews).toHaveLength(3);
    expect(new Set(reviews.map((row: { id: string }) => row.id)).size).toBe(3);
    expect(keys).toHaveLength(3);
    expect(reviews.every((row: Record<string, unknown>) => !("mode" in row) && row.correctness === null && row.completeness === null)).toBe(true);
    expect(reviews[0].protected).toEqual(item.protected);
  });
  it("covers six writing tasks without private source material", () => {
    const cases = benchmarkCases();
    expect(cases).toHaveLength(48);
    expect(new Set(cases.map((row: { scenario: string }) => row.scenario)).size).toBe(24);
    expect(new Set(cases.map((row: { genre: string }) => row.genre)).size).toBe(6);
    expect(new Set(cases.map((row: { id: string }) => row.id)).size).toBe(48);
    expect(cases.every((row: { protected: string[] }) => row.protected.length > 0)).toBe(true);
  });
  it("gives the two shaped modes identical guidance", () => {
    const item = benchmarkCases()[0];
    expect(caseDefinition(item, "ordinary", "guidance").execution.append_system_prompt).toBeUndefined();
    expect(caseDefinition(item, "guidance", "guidance").execution.append_system_prompt)
      .toBe(caseDefinition(item, "checks", "guidance").execution.append_system_prompt);
  });
  it("records unavailable telemetry as unknown and rejects incomplete generations", () => {
    expect(() => summarizeRun({ error: "timeout" })).toThrow(/timeout/);
    expect(() => summarizeRun({})).toThrow(/reply/);
    const result = summarizeRun({ lastMessage: "Keep E_SAMPLE.", durationSeconds: 2, costUsd: 0.01 });
    expect(result.text).toBe("Keep E_SAMPLE.");
    expect(result.usage).toBeNull();
    expect(result.interruptions).toBeNull();
  });
  it("uses the completed native result instead of an earlier partial reply", () => {
    const path = trace([
      { type: "assistant", message: { content: [{ type: "text", text: "Earlier answer" }] } },
      { type: "result", subtype: "success", is_error: false, result: "Completed answer" },
    ]);
    expect(summarizeRun({ tracePath: path, lastMessage: "Earlier answer" }).text).toBe("Completed answer");
  });

  it("rejects duplicate cached cases instead of counting them as complete coverage", () => {
    const fixture = prepared();
    fixture.cached("ordinary", [fixture.cases[0].id, fixture.cases[0].id]);
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Duplicate ordinary case");
  });

  it("refuses unknown spending instead of granting a fresh remaining budget", () => {
    const fixture = prepared();
    fixture.cached("ordinary", undefined, null);
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ordinary cost is unavailable");
  });

  it("records the actual model and native completion telemetry", () => {
    const path = trace([
      { type: "system", subtype: "init", model: "fixture-model", claude_code_version: "2.1.fixture", apiKeySource: "fixture-provider" },
      { type: "result", subtype: "success", is_error: false, result: "Complete", duration_ms: 2500, total_cost_usd: 0.03, num_turns: 2 },
    ]);
    const row = summarizeRun({ tracePath: path });
    expect(row.model).toBe("fixture-model");
    expect(row.claudeVersion).toBe("2.1.fixture");
    expect(row.apiKeySource).toBe("fixture-provider");
    expect(row.durationSeconds).toBe(2.5);
    expect(row.costUsd).toBe(0.03);
    expect(row.turns).toBe(2);
  });

  it("includes shipped writing guidance in the benchmark identity", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-benchmark-plugin-")); dirs.push(dir);
    mkdirSync(resolve(dir, "skills", "writing"), { recursive: true });
    const file = resolve(dir, "skills", "writing", "SKILL.md");
    writeFileSync(file, "First guidance.");
    const first = pluginFingerprint(dir);
    writeFileSync(file, "Revised guidance.");
    expect(pluginFingerprint(dir)).not.toBe(first);
  });

  it("rejects cached generations after the Claude executable changes version", () => {
    const fixture = prepared();
    fixture.setVersion("2.1.other");
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Inputs changed");
  });

  it("refuses to compare cached generations when the executable identity is unavailable", () => {
    const fixture = prepared(false);
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude executable version is unavailable");
  });

  it("rejects comparisons when the observed default model changes between modes", () => {
    const fixture = prepared();
    fixture.cached("guidance", undefined, 0.1, "different-model");
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Generation identity changed");
  });

  it("explains missing native receipts without reporting zero cost", () => {
    const fixture = prepared();
    const result = fixture.run();
    expect(result.status).toBe(0);
    const metrics = JSON.parse(readFileSync(resolve(fixture.dir, "metrics.json"), "utf8"));
    const checks = metrics.metrics.find((row: { mode: string }) => row.mode === "checks");
    expect(checks.backgroundCheckCostUsd).toBeNull();
    expect(checks.backgroundCaptureReason).toBe("No capture marker was received from the native checker.");
  });
  it("accepts an explicitly selected Claude executable without shell expansion", () => {
    const fixture = prepared();
    const result = fixture.run(["--claude-command", fixture.fake]);
    expect(result.status).toBe(0);
  });

  it("does not count a different number or identifier as a preserved literal", () => {
    const item = benchmarkCases().find((row: { id: string }) => row.id === "status-1");
    const definition = caseDefinition(item, "ordinary", "");
    const counts = new RegExp(definition.graders[0].pattern);
    expect(counts.test("11 of 20 jobs completed")).toBe(true);
    expect(counts.test("111 of 20 jobs completed")).toBe(false);
    const error = new RegExp(definition.graders[2].pattern);
    expect(error.test("Error E_RETRY_10")).toBe(false);
  });

  it("blinds every comparison and leaves judgment to the reviewer", () => {
    const item = benchmarkCases()[0];
    const outputs = ["ordinary", "guidance", "checks"].map((mode) => ({
      caseId: item.id, mode, text: `A reply from ${mode}.`,
    }));
    const { reviews, keys } = blindReviews([item], outputs, "seed");
    expect(reviews).toHaveLength(3);
    expect(keys).toHaveLength(3);
    expect(reviews.every((review: Record<string, unknown>) => review.choice === null)).toBe(true);
    expect(reviews.every((review: Record<string, unknown>) => !("mode" in review))).toBe(true);
  });
});
