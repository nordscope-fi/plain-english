import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error maintainer-only plain JavaScript module
import {
  GATES,
  assertOutsideRepository,
  analyzeStructures,
  auditOutputs,
  blindComparison,
  blindGateReview,
  checkOutputs,
  comparisons,
  evaluationHome,
  gatePass,
  generationTasks,
  gateReviewTasks,
  instructionSystems,
  pairVerdicts,
  readJsonl,
  report,
  splitFor,
  validateCase,
  validateGate,
  validateOutput,
  wilsonLower,
  writeJsonl,
} from "../scripts/evaluation/core.mjs";
// @ts-expect-error maintainer-only plain JavaScript module
import { protectedLiterals } from "../scripts/evaluation/transcripts.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "scripts/evaluate-writing.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(name: string): string {
  const path = mkdtempSync(resolve(tmpdir(), `${name}-`));
  temporary.push(path);
  return path;
}

function rawCase(id = "case-1", group = "conversation-1", genre = "chat") {
  return {
    id,
    group,
    source: genre === "chat" ? "chat" : "repository",
    genre,
    prompt: `Write the synthetic ${genre} response for ${id}.`,
    contract: {
      audience: "A fictional reader.",
      desiredAction: "Choose the documented next step.",
      required: ["Name the result.", "State the next step."],
      protected: ["E_SAMPLE", "€40"],
    },
  };
}

function allPass(run: string, benchmarkCase: ReturnType<typeof validateCase>, system: string) {
  return validateGate({
    run,
    caseId: benchmarkCase.id,
    system,
    reviewer: "reviewer-1",
    checks: Object.fromEntries(GATES.map((gate: string) => [gate, "pass"])),
    requirements: benchmarkCase.contract.required.map(() => "pass"),
  }, [benchmarkCase]);
}

function fixture(seed = "fixture-seed") {
  const benchmarkCase = validateCase(rawCase(), seed);
  benchmarkCase.split = "development";
  const systems = instructionSystems("released", "candidate A", "candidate B");
  const tasks = generationTasks([benchmarkCase], systems, { run: "run-1", split: "development", seed });
  const outputs = tasks.map((task: Record<string, unknown>) => validateOutput({
    run: "run-1",
    caseId: task.caseId,
    system: task.system,
    caseHash: task.caseHash,
    instructionHash: task.instructionHash,
    model: "fictional-model-1",
    settingsHash: "settings-1",
    text: `Synthetic output ${String(task.instructionHash).slice(0, 8)} for the comparison.`,
  }));
  const gates = systems.map((system: { id: string }) => allPass("run-1", benchmarkCase, system.id));
  return { benchmarkCase, systems, tasks, outputs, gates };
}

describe("the private writing evaluation contract", () => {
  it("protects exact literals without counting nested dates twice", () => {
    expect(protectedLiterals("Keep `2026-08-23-plan.md`, 18, and `npm test`."))
      .toEqual(["`2026-08-23-plan.md`", "`npm test`", "18"]);
  });

  it("does not protect decorative transcript separators", () => {
    expect(protectedLiterals("`★ Insight ─────────`\n`────────────`\nKeep `real-command`."))
      .toEqual(["`real-command`"]);
  });

  it("keeps every item in one conversation on the same side of the holdout", () => {
    expect(splitFor("conversation-1", "seed")).toBe(splitFor("conversation-1", "seed"));
    expect(["development", "holdout"]).toContain(splitFor("conversation-1", "seed"));
  });

  it("validates and hashes the frozen task contract", () => {
    const item = validateCase(rawCase(), "seed");
    expect(item.caseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item.contract.required).toEqual(["Name the result.", "State the next step."]);
    expect(item.contract.protected).toEqual(["E_SAMPLE", "€40"]);
  });

  it("rejects an unrecognised genre", () => {
    expect(() => validateCase(rawCase("x", "x", "sales-pitch"), "seed")).toThrow(/genre/);
  });

  it("loads only synthetic checked-in cases", () => {
    const rows = readJsonl(resolve(import.meta.dirname, "fixtures/evaluation/cases.jsonl"));
    expect(rows).toHaveLength(2);
    expect(rows.every((row: { id: string }) => row.id.startsWith("synthetic-"))).toBe(true);
  });
});

describe("provider-neutral generation tasks", () => {
  it("compares the unshaped model, release, and two candidates", () => {
    const { systems, tasks } = fixture();
    expect(tasks.map((task: { system: string }) => task.system).sort()).toEqual([
      "candidate-a", "candidate-b", "released", "unshaped",
    ]);
    expect(tasks.every((task: { caseHash: string; instructionHash: string }) => task.caseHash && task.instructionHash)).toBe(true);
    expect(systems.find((system: { id: string }) => system.id === "candidate-a").instruction).toBe("candidate A");
    expect(systems.find((system: { id: string }) => system.id === "candidate-b").instruction).toBe("candidate B");
  });

  it("produces a stable shuffled order from a declared seed", () => {
    const { benchmarkCase, systems } = fixture();
    const first = generationTasks([benchmarkCase], systems, { run: "r", split: "development", seed: "same" });
    const second = generationTasks([benchmarkCase], systems, { run: "r", split: "development", seed: "same" });
    expect(first).toEqual(second);
  });

  it("rejects stale instructions and mixed model settings", () => {
    const { tasks, outputs } = fixture();
    expect(() => checkOutputs(tasks, [{ ...outputs[0], instructionHash: "stale" }], "run-1")).toThrow(/stale instructions/);
    expect(() => checkOutputs(tasks, [outputs[0], { ...outputs[1], model: "other-model" }], "run-1")).toThrow(/one model/);
  });
});

describe("correctness gates before preference", () => {
  it("hides the instruction system during correctness review", () => {
    const { benchmarkCase, outputs } = fixture();
    const tasks = gateReviewTasks([benchmarkCase], outputs, { run: "run-1", split: "development", seed: "seed" });
    const view = blindGateReview(tasks[0], [benchmarkCase], outputs);
    expect(view).toHaveProperty("output");
    expect(view).not.toHaveProperty("system");
    expect(JSON.stringify(view)).not.toContain(tasks[0].system);
  });

  it("reports literal loss and length drift without calling them correctness", () => {
    const { benchmarkCase, outputs } = fixture();
    benchmarkCase.prompt = `Revise this.\nSOURCE REPLY\nKeep E_SAMPLE and €40 in this source reply.`;
    const unshaped = outputs.find((row: { system: string }) => row.system === "unshaped")!;
    const released = outputs.find((row: { system: string }) => row.system === "released")!;
    const audited = auditOutputs([benchmarkCase], [
      { ...unshaped, text: "Keep E_SAMPLE and €40 in this source reply." },
      { ...released, text: "A shorter reply." },
    ], { run: "run-1", split: "development" });
    expect(audited.systems.unshaped.literalPasses).toBe(1);
    expect(audited.systems.released.literalFailures).toBe(1);
    expect(audited.systems.released.missingLiterals).toBe(2);
  });

  it("requires every gate and every case requirement to pass", () => {
    const { benchmarkCase } = fixture();
    const passed = allPass("run-1", benchmarkCase, "released");
    expect(gatePass(passed)).toBe(true);
    expect(gatePass({ ...passed, checks: { ...passed.checks, preservation: "fail" } })).toBe(false);
    expect(gatePass({ ...passed, checks: { ...passed.checks, grounding: "fail" } })).toBe(false);
    expect(gatePass({ ...passed, requirements: ["pass", "uncertain"] })).toBe(false);
  });

  it("refuses a gate that silently omits a frozen requirement", () => {
    const { benchmarkCase } = fixture();
    const gate = allPass("run-1", benchmarkCase, "released");
    expect(() => validateGate({ ...gate, requirements: ["pass"] }, [benchmarkCase])).toThrow(/requires 2/);
  });

  it("schedules preference only when both outputs pass", () => {
    const { benchmarkCase, outputs, gates } = fixture();
    const failed = gates.map((gate: Record<string, unknown>) => gate.system === "candidate-b"
      ? { ...gate, checks: { ...(gate.checks as object), action: "fail" } }
      : gate);
    const rows = comparisons([benchmarkCase], outputs, failed, { run: "run-1", split: "development", seed: "seed" });
    expect(rows).toHaveLength(6);
    expect(rows.every((row: { left: string; right: string }) => row.left !== "candidate-b" && row.right !== "candidate-b")).toBe(true);
  });
});

describe("experimental structure signals", () => {
  it("reports triads, repeated openings, and confidence without creating findings", () => {
    const { benchmarkCase, outputs } = fixture();
    outputs[0].text = "We may test red, blue, and green.\n\nWe may test one.\n\nWe may test two.";
    const result = analyzeStructures([benchmarkCase], outputs, { run: "run-1", split: "development" });
    expect(result.rows[0]).toMatchObject({ triads: 1, repeatedOpenings: 2 });
    expect(result.rows[0].confidence.qualified).toBe(3);
  });
});

describe("blind, mirrored preference review", () => {
  it("presents A and B without revealing their systems", () => {
    const { benchmarkCase, outputs, gates } = fixture();
    const rows = comparisons([benchmarkCase], outputs, gates, { run: "run-1", split: "development", seed: "seed" });
    const view = blindComparison(rows[0], [benchmarkCase], outputs);
    expect(view.A).toContain("output");
    expect(view.B).toContain("output");
    expect(view).not.toHaveProperty("left");
    expect(view).not.toHaveProperty("right");
    expect(JSON.stringify(view)).not.toContain(rows[0].left);
  });

  it("turns agreement under reversed order into one verdict", () => {
    const { benchmarkCase, outputs, gates } = fixture();
    const rows = comparisons([benchmarkCase], outputs, gates, { run: "run-1", split: "development", seed: "seed" });
    const pair = rows.filter((row: { left: string; right: string }) => [row.left, row.right].sort().join() === "candidate-a,released");
    const votes = pair.map((row: { id: string; left: string; right: string }) => ({
      run: "run-1", comparisonId: row.id, reviewer: "r", reason: "Synthetic preference.",
      choice: row.left === "candidate-a" ? "A" : "B",
    }));
    const [verdict] = pairVerdicts(pair, votes);
    expect(verdict.outcome).toBe("candidate-a");
    expect(verdict.orderConsistent).toBe(true);
  });

  it("records an order-sensitive disagreement as a tie", () => {
    const { benchmarkCase, outputs, gates } = fixture();
    const scheduled = comparisons([benchmarkCase], outputs, gates, { run: "run-1", split: "development", seed: "seed" });
    const first = scheduled[0];
    const systems = [first.left, first.right].sort().join();
    const rows = scheduled.filter((row: { left: string; right: string }) => [row.left, row.right].sort().join() === systems);
    const votes = rows.map((row: { id: string }) => ({ run: "run-1", comparisonId: row.id, reviewer: "r", reason: "Synthetic preference.", choice: "A" }));
    const [verdict] = pairVerdicts(rows, votes);
    expect(verdict.outcome).toBe("tie");
    expect(verdict.orderConsistent).toBe(false);
  });
});

describe("pre-registered evidence thresholds", () => {
  it("uses a confidence bound rather than the observed win rate alone", () => {
    expect(wilsonLower(7, 10)).toBeLessThan(0.5);
    expect(wilsonLower(40, 50)).toBeGreaterThan(0.5);
  });

  it("can pass only on frozen holdout with enough total cases, genres, consistency, and preservation", () => {
    const seed = "report";
    const systems = instructionSystems("released", "candidate A", "candidate B");
    const cases = Array.from({ length: 50 }, (_, i) => {
      const item = validateCase(rawCase(`case-${i}`, `group-${i}`, ["chat", "technical-doc", "decision", "status", "email", "repository"][i % 6]), seed);
      item.split = i < 10 ? "holdout" : "development";
      return item;
    });
    const tasks = generationTasks(cases, systems, { run: "evidence", split: "holdout", seed });
    const outputs = tasks.map((task: Record<string, string>) => validateOutput({
      ...task,
      model: "fixed-model",
      settingsHash: "fixed-settings",
      text: `${task.system} synthetic output`,
    }));
    const holdout = cases.filter((item) => item.split === "holdout");
    const gates = holdout.flatMap((item) => systems.map((system: { id: string }) => allPass("evidence", item, system.id)));
    const scheduled = comparisons(cases, outputs, gates, { run: "evidence", split: "holdout", seed });
    const votes = scheduled.map((row: { id: string; left: string; right: string }) => {
      const preferred = row.left.startsWith("candidate-") && row.right === "released"
        ? row.left
        : row.right.startsWith("candidate-") && row.left === "released"
          ? row.right
          : "tie";
      const choice = preferred === "tie" ? "TIE" : preferred === row.left ? "A" : "B";
      return { run: "evidence", comparisonId: row.id, reviewer: "r", reason: "Synthetic benchmark vote.", choice };
    });
    const result = report(cases, outputs, gates, scheduled, votes, { run: "evidence", split: "holdout" });
    expect(result.totalCases).toBe(50);
    expect(result.candidates["candidate-a"].ready).toBe(true);
    expect(result.candidates["candidate-b"].ready).toBe(true);
  });
});

describe("private storage and the maintainer CLI", () => {
  it("uses operating-system user data and refuses the repository", () => {
    expect(evaluationHome({}, "darwin", "/fictional-home")).toContain("Library/Application Support/plain-english/evaluation");
    expect(evaluationHome({ LOCALAPPDATA: "C:\\Users\\writer\\AppData\\Local" }, "win32", "C:\\Users\\writer"))
      .toBe("C:\\Users\\writer\\AppData\\Local\\plain-english\\evaluation");
    expect(() => assertOutsideRepository(resolve(ROOT, "evaluation-data"), ROOT)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepository("C:\\Users\\writer\\evaluation", "D:\\a\\plain-english")).not.toThrow();
  });

  it("round-trips JSONL with an atomic replacement", () => {
    const dir = temp("plain-english-eval-jsonl");
    const file = resolve(dir, "rows.jsonl");
    writeJsonl(file, [{ id: 1 }, { id: 2 }]);
    expect(readJsonl(file)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("can reuse a split seed without moving seen groups into holdout", () => {
    const dir = temp("plain-english-eval-seed");
    const store = resolve(dir, "store");
    execFileSync(process.execPath, [CLI, "init", "--split-seed", "frozen-seed", "--store", store]);
    const config = JSON.parse(readFileSync(resolve(store, "manifest.json"), "utf8"));
    expect(config.splitSeed).toBe("frozen-seed");
  });

  it("clones transcript cases while rebuilding protected literals", () => {
    const dir = temp("plain-english-eval-clone");
    const source = resolve(dir, "source");
    const destination = resolve(dir, "destination");
    execFileSync(process.execPath, [CLI, "init", "--split-seed", "frozen-seed", "--store", source]);
    execFileSync(process.execPath, [CLI, "init", "--split-seed", "frozen-seed", "--store", destination]);
    const item = rawCase("clone-case", "clone-group");
    item.prompt = "Revise this.\nSOURCE REPLY\nKeep `2026-08-23-plan.md` and 18.";
    item.contract.protected = ["old-noise"];
    writeJsonl(resolve(source, "cases.jsonl"), [validateCase(item, "frozen-seed")]);
    execFileSync(process.execPath, [CLI, "clone", "transcript-cases", source, "--store", destination]);
    const [cloned] = readJsonl(resolve(destination, "cases.jsonl"));
    expect(cloned.contract.protected).toEqual(["`2026-08-23-plan.md`", "18"]);
  });

  it("runs the local case, output, gate, blind review, and report workflow", () => {
    const dir = temp("plain-english-eval-cli");
    const store = resolve(dir, "store");
    execFileSync(process.execPath, [CLI, "init", "--store", store]);
    const config = JSON.parse(readFileSync(resolve(store, "manifest.json"), "utf8"));
    let group = "group-0";
    for (let i = 1; splitFor(group, config.splitSeed) !== "development"; i++) group = `group-${i}`;
    const casesFile = resolve(dir, "cases.jsonl");
    writeFileSync(casesFile, `${JSON.stringify(rawCase("cli-case", group))}\n`);
    execFileSync(process.execPath, [CLI, "import", "cases", casesFile, "--store", store]);
    execFileSync(process.execPath, [CLI, "pack", "trial", "--store", store]);
    const tasks = readJsonl(resolve(store, "runs/trial/tasks-development.jsonl"));
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task: { modelInput: { prompt: string } }) => task.modelInput.prompt.includes("synthetic"))).toBe(true);

    const outputsFile = resolve(dir, "outputs.jsonl");
    writeJsonl(outputsFile, tasks.map((task: Record<string, string>) => ({
      run: "trial",
      caseId: task.caseId,
      system: task.system,
      caseHash: task.caseHash,
      instructionHash: task.instructionHash,
      model: "fixed-model",
      settingsHash: "fixed-settings",
      text: `Synthetic answer ${task.instructionHash.slice(0, 6)}.`,
    })));
    execFileSync(process.execPath, [CLI, "import", "outputs", outputsFile, "--store", store]);
    execFileSync(process.execPath, [CLI, "pack", "trial-v2", "--store", store]);
    execFileSync(process.execPath, [
      CLI, "reuse", "outputs", "trial", "trial-v2",
      "--systems", "unshaped,released,candidate-a,candidate-b", "--store", store,
    ]);
    expect(readJsonl(resolve(store, "outputs.jsonl")).filter((row: { run: string }) => row.run === "trial-v2")).toHaveLength(4);
    execFileSync(process.execPath, [CLI, "gate", "prepare", "trial", "--store", store]);
    const gateView = JSON.parse(execFileSync(process.execPath, [CLI, "gate", "next", "trial", "--store", store], { encoding: "utf8" }));
    expect(gateView).toHaveProperty("output");
    expect(gateView).not.toHaveProperty("system");

    const storedCase = readJsonl(resolve(store, "cases.jsonl"))[0];
    const gatesFile = resolve(dir, "gates.jsonl");
    writeJsonl(gatesFile, tasks.map((task: Record<string, string>) => ({
      run: "trial",
      caseId: task.caseId,
      system: task.system,
      reviewer: "reviewer-1",
      checks: Object.fromEntries(GATES.map((gate: string) => [gate, "pass"])),
      requirements: storedCase.contract.required.map(() => "pass"),
    })));
    execFileSync(process.execPath, [CLI, "import", "gates", gatesFile, "--store", store]);
    execFileSync(process.execPath, [CLI, "prepare", "trial", "--store", store]);

    const presentations = readJsonl(resolve(store, "runs/trial/comparisons-development.jsonl"));
    expect(presentations).toHaveLength(12);
    const view = JSON.parse(execFileSync(process.execPath, [CLI, "review", "next", "trial", "--store", store], { encoding: "utf8" }));
    expect(view).toHaveProperty("A");
    expect(view).toHaveProperty("B");
    expect(view).not.toHaveProperty("left");

    execFileSync(process.execPath, [
      CLI, "review", "vote", "trial", view.id, "A",
      "--reviewer", "reviewer-1", "--reason", "The synthetic A is easier to act on.",
      "--store", store,
    ]);
    const output = execFileSync(process.execPath, [CLI, "report", "trial", "--store", store], { encoding: "utf8" });
    expect(output).toContain("writing evaluation: trial (development)");
    expect(output).toContain("pairwise verdicts pending");
  });

  it("keeps holdout generation sealed", () => {
    const dir = temp("plain-english-eval-holdout");
    const store = resolve(dir, "store");
    execFileSync(process.execPath, [CLI, "init", "--store", store]);
    const result = spawnSync(process.execPath, [CLI, "pack", "trial", "--split", "holdout", "--store", store], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holdout");
    expect(result.stderr).toContain("sealed");
  });
});
