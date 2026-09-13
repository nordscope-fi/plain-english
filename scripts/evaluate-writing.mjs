#!/usr/bin/env node

/**
 * Maintainer-only writing evaluation harness.
 *
 * It does not call a model. Collected prose and evaluation records stay in the
 * operating system's user-data directory unless the maintainer moves them.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readAll, READERS } from "../dist/chat/registry.js";
import { protectedLiterals } from "./evaluation/transcripts.mjs";
import {
  GATES,
  SCHEMA_VERSION,
  SYSTEMS,
  assertOutsideRepository,
  analyzeStructures,
  auditOutputs,
  blindGateReview,
  blindComparison,
  checkOutputs,
  comparisons,
  evaluationHome,
  generationTasks,
  gateReviewTasks,
  instructionSystems,
  readJsonl,
  report,
  sha256,
  validateCase,
  validateGate,
  validateOutput,
  validateUnique,
  validateVote,
  writeJson,
  writeJsonl,
} from "./evaluation/core.mjs";

const REPOSITORY = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

function takeOption(name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  if (at === argv.length - 1) throw new Error(`${name} needs a value`);
  const value = argv[at + 1];
  argv.splice(at, 2);
  return value;
}

function hasFlag(name) {
  const at = argv.indexOf(name);
  if (at === -1) return false;
  argv.splice(at, 1);
  return true;
}

const store = resolve(takeOption("--store", evaluationHome()));
assertOutsideRepository(store, REPOSITORY);

function path(name) {
  return resolve(store, name);
}

function runPath(run, name) {
  safeRun(run);
  return path(`runs/${run}/${name}`);
}

function safeRun(run) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(run) || basename(run) !== run) {
    throw new Error("run must be one file-safe name");
  }
}

function manifest() {
  if (!existsSync(path("manifest.json"))) {
    throw new Error(`no evaluation store at ${store}; run init first`);
  }
  return JSON.parse(readFileSync(path("manifest.json"), "utf8"));
}

function init() {
  const suppliedSeed = takeOption("--split-seed");
  if (existsSync(path("manifest.json"))) {
    process.stdout.write(`evaluation store already exists at ${store}\n`);
    return;
  }
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeJson(path("manifest.json"), {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    splitSeed: suppliedSeed || sha256(`${store}\0plain-english-writing-eval`).slice(0, 24),
    holdoutUnlocked: {},
  });
  for (const file of ["cases.jsonl", "outputs.jsonl", "gates.jsonl", "votes.jsonl"]) {
    writeJsonl(path(file), []);
  }
  process.stdout.write(`created private evaluation store at ${store}\n`);
}

function merge(existing, incoming, key, label) {
  validateUnique(existing, key, label);
  validateUnique(incoming, key, label);
  const seen = new Set(existing.map(key));
  for (const row of incoming) {
    if (seen.has(key(row))) throw new Error(`${label} already exists: ${key(row)}`);
  }
  return [...existing, ...incoming];
}

function importRows(kind, file) {
  const config = manifest();
  const raw = readJsonl(resolve(file));
  if (kind === "cases") {
    const incoming = raw.map((row) => validateCase(row, config.splitSeed));
    const existing = readJsonl(path("cases.jsonl")).map((row) => validateCase(row, config.splitSeed));
    writeJsonl(path("cases.jsonl"), merge(existing, incoming, (row) => row.id, "case"));
  } else if (kind === "outputs") {
    const incoming = raw.map(validateOutput);
    const existing = readJsonl(path("outputs.jsonl")).map(validateOutput);
    const combined = merge(existing, incoming, (row) => `${row.run}/${row.caseId}/${row.system}`, "output");
    for (const run of new Set(incoming.map((row) => row.run))) {
      const tasks = ["development", "holdout"].flatMap((split) => readJsonl(runPath(run, `tasks-${split}.jsonl`)));
      checkOutputs(tasks, combined.filter((row) => row.run === run), run);
    }
    writeJsonl(path("outputs.jsonl"), combined);
  } else if (kind === "gates") {
    const cases = readJsonl(path("cases.jsonl"));
    const incoming = raw.map((row) => validateGate(row, cases));
    const existing = readJsonl(path("gates.jsonl")).map((row) => validateGate(row, cases));
    const outputKeys = new Set(readJsonl(path("outputs.jsonl")).map((row) => `${row.run}/${row.caseId}/${row.system}`));
    for (const gate of incoming) {
      const key = `${gate.run}/${gate.caseId}/${gate.system}`;
      if (!outputKeys.has(key)) throw new Error(`gate has no imported output: ${key}`);
    }
    writeJsonl(path("gates.jsonl"), merge(existing, incoming, (row) => `${row.run}/${row.caseId}/${row.system}`, "gate"));
  } else if (kind === "votes") {
    const incoming = raw.map(validateVote);
    const existing = readJsonl(path("votes.jsonl")).map(validateVote);
    for (const vote of incoming) {
      const comparisonIds = new Set(["development", "holdout"].flatMap((split) =>
        readJsonl(runPath(vote.run, `comparisons-${split}.jsonl`)).map((row) => row.id),
      ));
      if (!comparisonIds.has(vote.comparisonId)) throw new Error(`vote names an unknown comparison: ${vote.comparisonId}`);
    }
    writeJsonl(path("votes.jsonl"), merge(existing, incoming, (row) => row.comparisonId, "vote"));
  } else {
    throw new Error("import kind must be cases, outputs, gates, or votes");
  }
  process.stdout.write(`imported ${raw.length} ${kind} record${raw.length === 1 ? "" : "s"}\n`);
}

function words(value) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function transcriptGenre(value) {
  const text = value.toLowerCase();
  if (/\b(subject:|dear |email|inbox|recipient|send this)\b/u.test(text)) return "email";
  if (/\b(recommend|decision|option|choose|trade-?off|approve|which of the)\b/u.test(text)) return "decision";
  if (/\b(commit|pull request|merge|branch|release|changelog|repository|github|issue #)\b/u.test(text)) return "repository";
  if (/\b(done|implemented|completed|blocked|remaining|next step|tests? pass|verification)\b/u.test(text)) return "status";
  if (/^#{1,4}\s/mu.test(value) || words(value) >= 240 || /\b(architecture|configuration|workflow|how it works)\b/u.test(text)) return "technical-doc";
  return "chat";
}

const CONTRACTS = {
  chat: {
    desiredAction: "Understand the answer and take any action the source reply asks for.",
    required: ["Keep the source reply's answer or central result.", "Keep each caveat, request, and next action that changes what the reader should do.", "Do not add claims that the source reply does not support."],
  },
  "technical-doc": {
    desiredAction: "Understand the explanation and apply its procedure or conclusion correctly.",
    required: ["Keep the source explanation's conclusion and causal reasoning.", "Keep every procedure, constraint, and warning that affects correctness.", "Do not add technical claims that the source reply does not support."],
  },
  decision: {
    desiredAction: "Make the decision requested by the source reply with its costs visible.",
    required: ["Keep the recommendation or decision question.", "Keep every material option, cost, and tradeoff in the source reply.", "Do not add decision criteria that the source reply does not support."],
  },
  status: {
    desiredAction: "Understand what is done, what remains, and whether any response is needed.",
    required: ["Keep what the source reply says is complete, pending, or blocked.", "Keep its verification evidence and next action.", "Do not claim work or checks that the source reply does not report."],
  },
  email: {
    desiredAction: "Understand and respond to the message's request.",
    required: ["Keep the message's purpose and requested response.", "Keep every material deadline, commitment, and qualification.", "Do not add facts or commitments that the source reply does not support."],
  },
  repository: {
    desiredAction: "Understand the repository change or review and take its stated next action.",
    required: ["Keep the source reply's repository result, finding, or recommendation.", "Keep every material check, changed artifact, and next action.", "Do not add repository state or verification that the source reply does not report."],
  },
};

function transcriptCase(agent, reply, splitSeed) {
  const fingerprint = sha256(`${agent}\0${reply.source}\0${reply.line}\0${reply.text}`);
  const group = sha256(`${agent}\0${reply.session || reply.source}`).slice(0, 24);
  const genre = transcriptGenre(reply.text);
  const contract = CONTRACTS[genre];
  const prompt = [
    `Revise this coding-agent reply for a collaborator. Preserve its meaning and factual content, but make it clearer, more useful, and easier to act on. Output only the revised reply.`,
    "",
    "SOURCE REPLY",
    reply.text.trim(),
  ].join("\n");
  return {
    agent,
    case: validateCase({
      id: `transcript-${fingerprint.slice(0, 20)}`,
      group,
      source: "chat",
      genre,
      prompt,
      contract: {
        audience: "A collaborator using a coding agent.",
        desiredAction: contract.desiredAction,
        required: contract.required,
        protected: protectedLiterals(reply.text),
      },
    }, splitSeed),
  };
}

function selectTranscriptCases(candidates, limit, seed) {
  const selected = [];
  const selectedIds = new Set();
  const groupCounts = new Map();
  const genres = [...new Set(candidates.map((row) => row.case.genre))].sort();
  const agents = [...new Set(candidates.map((row) => row.agent))].sort();
  const ordered = [...candidates].sort((a, b) =>
    sha256(`${seed}\0${a.agent}\0${a.case.id}`).localeCompare(sha256(`${seed}\0${b.agent}\0${b.case.id}`)),
  );
  for (const groupLimit of [1, 2, Number.POSITIVE_INFINITY]) {
    let changed = true;
    while (selected.length < limit && changed) {
      changed = false;
      for (const genre of genres) {
        for (const agent of agents) {
          const next = ordered.find((row) =>
            row.agent === agent && row.case.genre === genre && !selectedIds.has(row.case.id) &&
            (groupCounts.get(row.case.group) ?? 0) < groupLimit,
          );
          if (!next) continue;
          selected.push(next);
          selectedIds.add(next.case.id);
          groupCounts.set(next.case.group, (groupCounts.get(next.case.group) ?? 0) + 1);
          changed = true;
          if (selected.length === limit) return selected;
        }
      }
    }
  }
  return selected;
}

function collectTranscripts() {
  const config = manifest();
  const limit = Number.parseInt(takeOption("--limit", "50"), 10);
  const minimumDevelopment = Number.parseInt(takeOption("--min-development", String(Math.min(40, limit))), 10);
  const minimumWords = Number.parseInt(takeOption("--min-words", "40"), 10);
  const seed = takeOption("--seed", "transcript-cases-v1");
  const dryRun = hasFlag("--dry-run");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  if (!Number.isSafeInteger(minimumDevelopment) || minimumDevelopment < 0) throw new Error("--min-development must be a non-negative integer");
  if (minimumDevelopment > limit + 50) throw new Error("--min-development cannot exceed the sample size plus 50");
  if (!Number.isSafeInteger(minimumWords) || minimumWords < 1) throw new Error("--min-words must be a positive integer");

  const results = readAll(READERS, {});
  const seenText = new Set();
  const candidates = [];
  for (const result of results) {
    for (const reply of result.replies) {
      const count = words(reply.text);
      if (count < minimumWords || count > 800) continue;
      const textHash = sha256(reply.text.trim());
      if (seenText.has(textHash)) continue;
      seenText.add(textHash);
      candidates.push(transcriptCase(result.id, reply, config.splitSeed));
    }
  }
  const reservoir = selectTranscriptCases(candidates, Math.min(candidates.length, limit + 50), seed);
  const selected = reservoir.slice(0, limit);
  for (const row of reservoir.slice(limit)) {
    if (selected.filter((item) => item.case.split === "development").length >= minimumDevelopment) break;
    if (row.case.split === "development") selected.push(row);
  }
  if (selected.length < limit) throw new Error(`only ${selected.length} eligible transcript replies were found; requested ${limit}`);
  if (selected.filter((row) => row.case.split === "development").length < minimumDevelopment) {
    throw new Error(`the transcript sample cannot supply ${minimumDevelopment} development cases`);
  }
  if (new Set(selected.map((row) => row.case.genre)).size < 4) {
    throw new Error("the selected transcript cases cover fewer than four writing genres");
  }

  const existing = readJsonl(path("cases.jsonl")).map((row) => validateCase(row, config.splitSeed));
  const existingIds = new Set(existing.map((row) => row.id));
  const incoming = selected.map((row) => row.case).filter((row) => !existingIds.has(row.id));
  if (!dryRun) writeJsonl(path("cases.jsonl"), [...existing, ...incoming]);

  for (const result of results) {
    const state = result.unavailable ? "unavailable" : `${result.replies.length} replies`;
    process.stdout.write(`${result.id.padEnd(12)} ${state}\n`);
  }
  const byGenre = Object.fromEntries([...new Set(selected.map((row) => row.case.genre))].sort().map((genre) => [genre, selected.filter((row) => row.case.genre === genre).length]));
  const byAgent = Object.fromEntries([...new Set(selected.map((row) => row.agent))].sort().map((agent) => [agent, selected.filter((row) => row.agent === agent).length]));
  const bySplit = Object.fromEntries(["development", "holdout"].map((split) => [split, selected.filter((row) => row.case.split === split).length]));
  process.stdout.write(`selected ${selected.length} private cases across ${Object.keys(byGenre).length} genres and ${Object.keys(byAgent).length} agents\n`);
  process.stdout.write(`genres ${JSON.stringify(byGenre)}\n`);
  process.stdout.write(`agents ${JSON.stringify(byAgent)}\n`);
  process.stdout.write(`splits ${JSON.stringify(bySplit)}\n`);
  process.stdout.write(dryRun ? "dry run; no cases written\n" : `wrote ${incoming.length} new cases; ${existing.length + incoming.length} total\n`);
}

function cloneTranscriptCases(from) {
  const config = manifest();
  const sourceStore = resolve(from);
  assertOutsideRepository(sourceStore, REPOSITORY);
  const existing = readJsonl(path("cases.jsonl"));
  if (existing.length) throw new Error("clone transcript-cases needs an empty destination store");
  const sourceCases = readJsonl(resolve(sourceStore, "cases.jsonl"));
  const cloned = sourceCases.map((row) => {
    const promptParts = row.prompt.split("\nSOURCE REPLY\n");
    if (promptParts.length !== 2) throw new Error(`case ${row.id} is not a collected transcript case`);
    const sourceReply = promptParts[1];
    return validateCase({
      id: row.id,
      group: row.group,
      source: row.source,
      genre: row.genre,
      prompt: row.prompt,
      contract: {
        ...row.contract,
        protected: protectedLiterals(sourceReply),
      },
    }, config.splitSeed);
  });
  writeJsonl(path("cases.jsonl"), cloned);
  const development = cloned.filter((row) => row.split === "development").length;
  process.stdout.write(`cloned ${cloned.length} transcript cases; ${development} development and ${cloned.length - development} holdout\n`);
}

function reuseOutputs(fromRun, toRun) {
  safeRun(fromRun);
  safeRun(toRun);
  const split = takeOption("--split", "development");
  const namedSystems = takeOption("--systems");
  if (!namedSystems) throw new Error("reuse outputs needs --systems");
  const selectedSystems = namedSystems.split(",").map((value) => value.trim());
  if (selectedSystems.some((value) => !SYSTEMS.includes(value))) {
    throw new Error(`--systems must use: ${SYSTEMS.join(", ")}`);
  }
  requireHoldout(toRun, split);
  const tasks = readJsonl(runPath(toRun, `tasks-${split}.jsonl`));
  const taskMap = new Map(tasks.map((task) => [`${task.caseId}\0${task.system}`, task]));
  const outputs = readJsonl(path("outputs.jsonl")).map(validateOutput);
  const existing = new Set(outputs.filter((row) => row.run === toRun).map((row) => `${row.caseId}\0${row.system}`));
  const reused = [];
  for (const output of outputs.filter((row) => row.run === fromRun && selectedSystems.includes(row.system))) {
    const key = `${output.caseId}\0${output.system}`;
    const task = taskMap.get(key);
    if (!task) throw new Error(`target run has no matching task for ${output.caseId}/${output.system}`);
    if (task.caseHash !== output.caseHash || task.instructionHash !== output.instructionHash) {
      throw new Error(`cannot reuse changed task ${output.caseId}/${output.system}`);
    }
    if (existing.has(key)) throw new Error(`target output already exists: ${output.caseId}/${output.system}`);
    existing.add(key);
    reused.push({ ...output, run: toRun });
  }
  writeJsonl(path("outputs.jsonl"), [...outputs, ...reused]);
  process.stdout.write(`reused ${reused.length} unchanged outputs from ${fromRun} in ${toRun}\n`);
}

function releasedInstructions() {
  const source = readFileSync(resolve(REPOSITORY, "AGENTS.md"), "utf8");
  const match = /<!-- plain-english:start -->([\s\S]*?)<!-- plain-english:end -->/.exec(source);
  if (!match) throw new Error("AGENTS.md has no generated plain-english instruction block");
  return match[1].trim();
}

function systems() {
  return instructionSystems(
    releasedInstructions(),
    readFileSync(resolve(import.meta.dirname, "evaluation/candidates/task-contract.md"), "utf8"),
    readFileSync(resolve(import.meta.dirname, "evaluation/candidates/reader-action.md"), "utf8"),
  );
}

function requireHoldout(run, split) {
  if (split !== "holdout") return;
  const config = manifest();
  if (!config.holdoutUnlocked?.[run]) {
    throw new Error(`holdout for ${run} is sealed; finish development review and run holdout unlock ${run}`);
  }
}

function pack(run) {
  safeRun(run);
  const split = takeOption("--split", "development");
  const seed = takeOption("--seed", run);
  requireHoldout(run, split);
  const cases = readJsonl(path("cases.jsonl"));
  const tasks = generationTasks(cases, systems(), { run, split, seed });
  writeJsonl(runPath(run, `tasks-${split}.jsonl`), tasks);
  writeJson(runPath(run, `tasks-${split}.manifest.json`), {
    schemaVersion: SCHEMA_VERSION,
    run,
    split,
    seed,
    taskCount: tasks.length,
    taskSetHash: sha256(tasks.map((task) => `${task.caseHash}:${task.instructionHash}`).join("\n")),
  });
  process.stdout.write(`packed ${tasks.length} shuffled generation tasks at ${runPath(run, `tasks-${split}.jsonl`)}\n`);
}

function prepare(run) {
  const split = takeOption("--split", "development");
  const seed = takeOption("--seed", run);
  requireHoldout(run, split);
  const cases = readJsonl(path("cases.jsonl"));
  const outputs = readJsonl(path("outputs.jsonl")).map(validateOutput);
  const gates = readJsonl(path("gates.jsonl")).map((row) => validateGate(row, cases));
  const tasks = readJsonl(runPath(run, `tasks-${split}.jsonl`));
  checkOutputs(tasks, outputs.filter((row) => row.run === run && cases.some((item) => item.id === row.caseId && item.split === split)), run);
  const rows = comparisons(cases, outputs, gates, { run, split, seed });
  writeJsonl(runPath(run, `comparisons-${split}.jsonl`), rows);
  process.stdout.write(`prepared ${rows.length} blind presentations (${rows.length / 2} mirrored pairs)\n`);
}

function prepareGateReviews(run) {
  const split = takeOption("--split", "development");
  const seed = takeOption("--seed", run);
  requireHoldout(run, split);
  const cases = readJsonl(path("cases.jsonl"));
  const outputs = readJsonl(path("outputs.jsonl")).map(validateOutput);
  const tasks = readJsonl(runPath(run, `tasks-${split}.jsonl`));
  const selectedIds = new Set(cases.filter((row) => row.split === split).map((row) => row.id));
  checkOutputs(tasks, outputs.filter((row) => row.run === run && selectedIds.has(row.caseId)), run);
  const rows = gateReviewTasks(cases, outputs, { run, split, seed });
  writeJsonl(runPath(run, `gate-reviews-${split}.jsonl`), rows);
  process.stdout.write(`prepared ${rows.length} blind correctness reviews\n`);
}

function nextGateReview(run) {
  const split = takeOption("--split", "development");
  requireHoldout(run, split);
  const tasks = readJsonl(runPath(run, `gate-reviews-${split}.jsonl`));
  const gates = readJsonl(path("gates.jsonl")).map((row) => validateGate(row, readJsonl(path("cases.jsonl"))));
  const reviewed = new Set(gates.filter((row) => row.run === run).map((row) => `${row.caseId}\0${row.system}`));
  const next = tasks.find((row) => !reviewed.has(`${row.caseId}\0${row.system}`));
  if (!next) {
    process.stdout.write("no pending correctness reviews\n");
    return;
  }
  const view = blindGateReview(next, readJsonl(path("cases.jsonl")), readJsonl(path("outputs.jsonl")).map(validateOutput));
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

function recordGateReview(run, id) {
  const split = takeOption("--split", "development");
  const reviewer = takeOption("--reviewer");
  const note = takeOption("--note");
  const checks = Object.fromEntries(GATES.map((name) => [name, takeOption(`--${name}`)]));
  const requirementValue = takeOption("--requirements");
  if (!reviewer || !requirementValue) throw new Error("gate record needs --reviewer and --requirements");
  requireHoldout(run, split);
  const tasks = readJsonl(runPath(run, `gate-reviews-${split}.jsonl`));
  const task = tasks.find((row) => row.id === id);
  if (!task) throw new Error(`unknown gate review: ${id}`);
  const cases = readJsonl(path("cases.jsonl"));
  const gate = validateGate({
    run,
    caseId: task.caseId,
    system: task.system,
    reviewer,
    checks,
    requirements: requirementValue.split(",").map((value) => value.trim()),
    note,
  }, cases);
  const gates = readJsonl(path("gates.jsonl")).map((row) => validateGate(row, cases));
  if (gates.some((row) => row.run === run && row.caseId === gate.caseId && row.system === gate.system)) {
    throw new Error("this output already has a correctness review");
  }
  writeJsonl(path("gates.jsonl"), [...gates, gate]);
  process.stdout.write(`recorded blind correctness review ${id}\n`);
}

function nextReview(run) {
  const split = takeOption("--split", "development");
  requireHoldout(run, split);
  const comparisonsList = readJsonl(runPath(run, `comparisons-${split}.jsonl`));
  const votes = readJsonl(path("votes.jsonl")).map(validateVote);
  const voted = new Set(votes.filter((vote) => vote.run === run).map((vote) => vote.comparisonId));
  const next = comparisonsList.find((row) => !voted.has(row.id));
  if (!next) {
    process.stdout.write("no pending blind comparisons\n");
    return;
  }
  const view = blindComparison(next, readJsonl(path("cases.jsonl")), readJsonl(path("outputs.jsonl")));
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}

function recordVote(run, comparisonId, choice) {
  const split = takeOption("--split", "development");
  const reviewer = takeOption("--reviewer");
  const reason = takeOption("--reason");
  if (!reviewer || !reason) throw new Error("review vote needs --reviewer and --reason");
  requireHoldout(run, split);
  const comparisonsList = readJsonl(runPath(run, `comparisons-${split}.jsonl`));
  if (!comparisonsList.some((row) => row.id === comparisonId)) throw new Error(`unknown comparison: ${comparisonId}`);
  const vote = validateVote({ run, comparisonId, reviewer, choice, reason, at: new Date().toISOString() });
  const votes = readJsonl(path("votes.jsonl")).map(validateVote);
  if (votes.some((row) => row.comparisonId === comparisonId)) throw new Error(`comparison already has a vote: ${comparisonId}`);
  writeJsonl(path("votes.jsonl"), [...votes, vote]);
  process.stdout.write(`recorded blind vote for ${comparisonId}\n`);
}

function loadReport(run, split) {
  const cases = readJsonl(path("cases.jsonl"));
  return report(
    cases,
    readJsonl(path("outputs.jsonl")).map(validateOutput),
    readJsonl(path("gates.jsonl")).map((row) => validateGate(row, cases)),
    readJsonl(runPath(run, `comparisons-${split}.jsonl`)),
    readJsonl(path("votes.jsonl")).map(validateVote),
    { run, split },
  );
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printReport(result) {
  process.stdout.write(`writing evaluation: ${result.run} (${result.split})\n`);
  process.stdout.write(`${result.cases} cases in this split, ${result.totalCases} total; ${result.genres.length} genres here; ${result.pairwise.pending} pairwise verdicts pending\n\n`);
  for (const [system, correctness] of Object.entries(result.correctness)) {
    process.stdout.write(`${system.padEnd(12)} correctness ${correctness.passed}/${correctness.reviewed} (${percent(correctness.passRate)}), preservation failures ${correctness.preservationFailures}, grounding failures ${correctness.groundingFailures}\n`);
  }
  for (const [system, candidate] of Object.entries(result.candidates)) {
    const preference = candidate.preference;
    process.stdout.write(`\n${system} against released\n`);
    process.stdout.write(`  ${preference.wins} wins, ${preference.losses} losses, ${preference.ties} ties; win rate ${percent(preference.winRate)}; lower 95% bound ${percent(preference.lower95)}\n`);
    process.stdout.write(`  mirrored-order consistency ${percent(preference.orderConsistency)}; evidence gate ${candidate.ready ? "PASS" : "NOT MET"}\n`);
    for (const [name, passed] of Object.entries(candidate.checks)) {
      process.stdout.write(`  ${passed ? "pass" : "wait"} ${name}\n`);
    }
  }
}

function showReport(run) {
  const split = takeOption("--split", "development");
  const format = takeOption("--format", "text");
  requireHoldout(run, split);
  const result = loadReport(run, split);
  if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (format === "text") printReport(result);
  else throw new Error("--format must be text or json");
}

function showAudit(run) {
  const split = takeOption("--split", "development");
  const format = takeOption("--format", "text");
  requireHoldout(run, split);
  const result = auditOutputs(
    readJsonl(path("cases.jsonl")),
    readJsonl(path("outputs.jsonl")).map(validateOutput),
    { run, split },
  );
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (format !== "text") throw new Error("--format must be text or json");
  process.stdout.write(`deterministic output audit: ${run} (${split}), ${result.cases} cases\n`);
  for (const [system, row] of Object.entries(result.systems)) {
    process.stdout.write(`${system.padEnd(12)} literals ${row.literalPasses}/${row.outputs}; ${row.missingLiterals} missing; median length ${row.medianLengthRatio.toFixed(2)}x; short ${row.shorterThanHalf}; long ${row.longerThanOneAndHalf}; instruction echoes ${row.instructionEchoes}\n`);
    process.stdout.write(`${"".padEnd(12)} missing by kind ${JSON.stringify(row.missingByKind)}\n`);
    process.stdout.write(`${"".padEnd(12)} source <=225 words ${row.bySourceLength.atMost225.literalPasses}/${row.bySourceLength.atMost225.outputs}; source >225 words ${row.bySourceLength.over225.literalPasses}/${row.bySourceLength.over225.outputs}\n`);
  }
  process.stdout.write("These are triage signals, not correctness or preference verdicts.\n");
}

function showAnalysis(run) {
  const split = takeOption("--split", "development");
  const format = takeOption("--format", "text");
  requireHoldout(run, split);
  const comparisonsFile = runPath(run, `comparisons-${split}.jsonl`);
  const result = analyzeStructures(
    readJsonl(path("cases.jsonl")),
    readJsonl(path("outputs.jsonl")).map(validateOutput),
    {
      run,
      split,
      comparisons: existsSync(comparisonsFile) ? readJsonl(comparisonsFile) : [],
      votes: readJsonl(path("votes.jsonl")).map(validateVote),
    },
  );
  if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (format === "text") {
    process.stdout.write(`experimental structure analysis: ${run} (${split}), ${result.cases} cases\n`);
    for (const [name, evidence] of Object.entries(result.evidence)) {
      process.stdout.write(`${name}: ${evidence.activeOutputs}/${evidence.eligibleOutputs} active outputs; source ${percent(evidence.humanSourceActivation)}; preference ${percent(evidence.preference)}; lower 95% ${percent(evidence.lower95)}; promotion ${evidence.ready ? "PASS" : "NOT MET"}\n`);
    }
    process.stdout.write("These measurements do not create lint findings.\n");
  } else throw new Error("--format must be text or json");
}

function unlock(run) {
  const config = manifest();
  if (config.holdoutUnlocked?.[run]) {
    process.stdout.write(`holdout for ${run} was already unlocked at ${config.holdoutUnlocked[run]}\n`);
    return;
  }
  const result = loadReport(run, "development");
  const cases = readJsonl(path("cases.jsonl"));
  const neededOutputs = result.cases * 4;
  const everyGateReviewed = Object.values(result.correctness).every((row) => row.reviewed === result.cases);
  if (cases.length < 50 || result.cases < 40 || result.genres.length < 4 || result.outputs !== neededOutputs || !everyGateReviewed || result.pairwise.pending !== 0) {
    throw new Error("holdout stays sealed until the store has 50 cases and development has 40 cases, four genres, every output, every correctness review, and every scheduled pairwise verdict");
  }
  config.holdoutUnlocked ??= {};
  config.holdoutUnlocked[run] = new Date().toISOString();
  writeJson(path("manifest.json"), config);
  process.stdout.write(`unlocked holdout for ${run}; this cannot be treated as development data now\n`);
}

function help() {
  process.stdout.write(`plain-english private writing evaluation\n\n`);
  process.stdout.write(`  init [--store PATH] [--split-seed TEXT]\n`);
  process.stdout.write(`  import cases|outputs|gates|votes FILE [--store PATH]\n`);
  process.stdout.write(`  collect transcripts [--limit N] [--min-development N] [--min-words N] [--seed TEXT] [--dry-run]\n`);
  process.stdout.write(`  clone transcript-cases FROM_STORE\n`);
  process.stdout.write(`  reuse outputs FROM_RUN TO_RUN --systems SYSTEM,... [--split development|holdout]\n`);
  process.stdout.write(`  pack RUN [--split development|holdout] [--seed TEXT]\n`);
  process.stdout.write(`  prepare RUN [--split development|holdout] [--seed TEXT]\n`);
  process.stdout.write(`  gate prepare RUN [--split development|holdout] [--seed TEXT]\n`);
  process.stdout.write(`  gate next RUN [--split development|holdout]\n`);
  process.stdout.write(`  gate record RUN ID --reviewer NAME --correctness RESULT --completeness RESULT --preservation RESULT --grounding RESULT --audience RESULT --action RESULT --requirements RESULT,... [--note TEXT]\n`);
  process.stdout.write(`  review next RUN [--split development|holdout]\n`);
  process.stdout.write(`  review vote RUN ID A|B|tie --reviewer NAME --reason TEXT [--split ...]\n`);
  process.stdout.write(`  report RUN [--split development|holdout] [--format text|json]\n`);
  process.stdout.write(`  audit RUN [--split development|holdout] [--format text|json]\n`);
  process.stdout.write(`  analyze RUN [--split development|holdout] [--format text|json]\n`);
  process.stdout.write(`  holdout unlock RUN\n`);
  process.stdout.write(`\nNo command calls a model. Evaluation prose stays outside the repository.\n`);
}

try {
  const command = argv.shift();
  if (!command || command === "help" || hasFlag("--help")) help();
  else if (command === "init") init();
  else if (command === "import") importRows(argv.shift(), argv.shift());
  else if (command === "collect" && argv[0] === "transcripts") { argv.shift(); collectTranscripts(); }
  else if (command === "clone" && argv[0] === "transcript-cases") { argv.shift(); cloneTranscriptCases(argv.shift()); }
  else if (command === "reuse" && argv[0] === "outputs") { argv.shift(); reuseOutputs(argv.shift(), argv.shift()); }
  else if (command === "pack") pack(argv.shift());
  else if (command === "prepare") prepare(argv.shift());
  else if (command === "gate" && argv[0] === "prepare") { argv.shift(); prepareGateReviews(argv.shift()); }
  else if (command === "gate" && argv[0] === "next") { argv.shift(); nextGateReview(argv.shift()); }
  else if (command === "gate" && argv[0] === "record") { argv.shift(); recordGateReview(argv.shift(), argv.shift()); }
  else if (command === "review" && argv[0] === "next") { argv.shift(); nextReview(argv.shift()); }
  else if (command === "review" && argv[0] === "vote") { argv.shift(); recordVote(argv.shift(), argv.shift(), argv.shift()); }
  else if (command === "report") showReport(argv.shift());
  else if (command === "audit") showAudit(argv.shift());
  else if (command === "analyze") showAnalysis(argv.shift());
  else if (command === "holdout" && argv[0] === "unlock") { argv.shift(); unlock(argv.shift()); }
  else throw new Error("unknown evaluation command; run help");
  if (argv.length) throw new Error(`unexpected argument: ${argv[0]}`);
} catch (error) {
  process.stderr.write(`plain-english evaluation: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
