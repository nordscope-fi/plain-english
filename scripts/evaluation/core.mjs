import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";

export const SCHEMA_VERSION = 1;
export const GENRES = ["chat", "technical-doc", "decision", "status", "email", "repository"];
export const SYSTEMS = ["unshaped", "released", "candidate-a", "candidate-b"];
export const GATES = ["correctness", "completeness", "preservation", "grounding", "audience", "action"];

const PAIRS = SYSTEMS.flatMap((left, i) => SYSTEMS.slice(i + 1).map((right) => [left, right]));

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function stringList(value, label, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0)) {
    fail(`${label} must be ${empty ? "an" : "a non-empty"} array of strings`);
  }
  return value.map((item, i) => text(item, `${label}[${i}]`));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Keep a whole conversation or document on one side of the holdout boundary. */
export function splitFor(group, seed = "plain-english-writing-eval-v1") {
  const bucket = Number.parseInt(sha256(`${seed}\0${group}`).slice(0, 8), 16) % 100;
  return bucket < 20 ? "holdout" : "development";
}

export function validateCase(value, seed) {
  const row = record(value, "case");
  const contract = record(row.contract, "case.contract");
  const genre = text(row.genre, "case.genre");
  if (!GENRES.includes(genre)) fail(`case.genre must be one of: ${GENRES.join(", ")}`);
  const source = text(row.source, "case.source");
  if (!new Set(["chat", "repository"]).has(source)) fail("case.source must be chat or repository");
  const required = stringList(contract.required, "case.contract.required");
  const protectedLiterals = stringList(contract.protected, "case.contract.protected", { empty: true });
  const out = {
    schemaVersion: SCHEMA_VERSION,
    id: text(row.id, "case.id"),
    group: text(row.group, "case.group"),
    source,
    genre,
    prompt: text(row.prompt, "case.prompt"),
    contract: {
      audience: text(contract.audience, "case.contract.audience"),
      desiredAction: text(contract.desiredAction, "case.contract.desiredAction"),
      required,
      protected: protectedLiterals,
    },
  };
  return { ...out, split: splitFor(out.group, seed), caseHash: sha256(stableJson(out)) };
}

export function validateOutput(value) {
  const row = record(value, "output");
  const system = text(row.system, "output.system");
  if (!SYSTEMS.includes(system)) fail(`output.system must be one of: ${SYSTEMS.join(", ")}`);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    run: text(row.run, "output.run"),
    caseId: text(row.caseId, "output.caseId"),
    system,
    caseHash: text(row.caseHash, "output.caseHash"),
    instructionHash: text(row.instructionHash, "output.instructionHash"),
    model: text(row.model, "output.model"),
    settingsHash: text(row.settingsHash, "output.settingsHash"),
    text: text(row.text, "output.text"),
  };
  if (typeof row.generatedAt === "string" && row.generatedAt) out.generatedAt = row.generatedAt;
  return out;
}

export function validateGate(value, cases = []) {
  const row = record(value, "gate");
  const checks = record(row.checks, "gate.checks");
  const requirements = stringList(row.requirements, "gate.requirements");
  const out = {
    schemaVersion: SCHEMA_VERSION,
    run: text(row.run, "gate.run"),
    caseId: text(row.caseId, "gate.caseId"),
    system: text(row.system, "gate.system"),
    reviewer: text(row.reviewer, "gate.reviewer"),
    checks: {},
    requirements,
  };
  if (!SYSTEMS.includes(out.system)) fail(`gate.system must be one of: ${SYSTEMS.join(", ")}`);
  for (const gate of GATES) {
    const result = text(checks[gate], `gate.checks.${gate}`);
    if (!new Set(["pass", "fail", "uncertain"]).has(result)) {
      fail(`gate.checks.${gate} must be pass, fail, or uncertain`);
    }
    out.checks[gate] = result;
  }
  for (const [i, result] of out.requirements.entries()) {
    if (!new Set(["pass", "fail", "uncertain"]).has(result)) {
      fail(`gate.requirements[${i}] must be pass, fail, or uncertain`);
    }
  }
  const benchmarkCase = cases.find((item) => item.id === out.caseId);
  if (benchmarkCase && out.requirements.length !== benchmarkCase.contract.required.length) {
    fail(`gate.requirements has ${out.requirements.length} results; case ${out.caseId} requires ${benchmarkCase.contract.required.length}`);
  }
  if (typeof row.note === "string" && row.note.trim()) out.note = row.note.trim();
  return out;
}

export function gatePass(gate) {
  return GATES.every((name) => gate.checks[name] === "pass") &&
    gate.requirements.every((result) => result === "pass");
}

export function validateVote(value) {
  const row = record(value, "vote");
  const choice = text(row.choice, "vote.choice").toUpperCase();
  if (!new Set(["A", "B", "TIE"]).has(choice)) fail("vote.choice must be A, B, or tie");
  const out = {
    schemaVersion: SCHEMA_VERSION,
    run: text(row.run, "vote.run"),
    comparisonId: text(row.comparisonId, "vote.comparisonId"),
    reviewer: text(row.reviewer, "vote.reviewer"),
    choice,
    reason: text(row.reason, "vote.reason"),
  };
  if (typeof row.at === "string" && row.at) out.at = row.at;
  return out;
}

export function validateUnique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) fail(`duplicate ${label}: ${id}`);
    seen.add(id);
  }
  return rows;
}

export function instructionSystems(released, candidateA, candidateB) {
  return [
    { id: "unshaped", instruction: "" },
    { id: "released", instruction: released },
    { id: "candidate-a", instruction: candidateA.trim() },
    { id: "candidate-b", instruction: candidateB.trim() },
  ];
}

/** Produce provider-neutral generation tasks and bind every output to its inputs. */
export function generationTasks(cases, systems, { run, split = "development", seed = "tasks" }) {
  if (!new Set(["development", "holdout"]).has(split)) fail("split must be development or holdout");
  const tasks = [];
  for (const benchmarkCase of cases.filter((item) => item.split === split)) {
    for (const system of systems) {
      const instructionHash = sha256(system.instruction);
      tasks.push({
        schemaVersion: SCHEMA_VERSION,
        run,
        caseId: benchmarkCase.id,
        caseHash: benchmarkCase.caseHash,
        split,
        system: system.id,
        instructionHash,
        modelInput: {
          instruction: system.instruction,
          prompt: benchmarkCase.prompt,
        },
        reviewOnly: {
          contract: benchmarkCase.contract,
        },
      });
    }
  }
  return tasks.sort((a, b) => sha256(`${seed}\0${a.caseId}\0${a.system}`).localeCompare(sha256(`${seed}\0${b.caseId}\0${b.system}`)));
}

export function checkOutputs(tasks, outputs, run) {
  const wanted = new Map(tasks.map((task) => [`${task.caseId}\0${task.system}`, task]));
  const rows = outputs.filter((row) => row.run === run);
  validateUnique(rows, (row) => `${row.caseId}\0${row.system}`, "output");
  for (const output of rows) {
    const task = wanted.get(`${output.caseId}\0${output.system}`);
    if (!task) fail(`output ${output.caseId}/${output.system} has no generation task in this split`);
    if (output.caseHash !== task.caseHash) fail(`output ${output.caseId}/${output.system} uses a stale case`);
    if (output.instructionHash !== task.instructionHash) fail(`output ${output.caseId}/${output.system} uses stale instructions`);
  }
  const byCase = new Map();
  for (const output of rows) {
    const key = output.caseId;
    const baseline = byCase.get(key);
    const identity = `${output.model}\0${output.settingsHash}`;
    if (baseline && baseline !== identity) fail(`case ${key} was not generated with one model and settings hash`);
    byCase.set(key, identity);
  }
  return rows;
}

function wordCount(value) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function literalKind(value) {
  if (value.startsWith("```")) return "code-block";
  if (value.startsWith("`")) return "inline-code";
  if (/^https?:\/\//u.test(value)) return "url";
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(value)) return "email";
  if (/^(?:\.{0,2}\/|\/)/u.test(value)) return "path";
  return "number";
}

/** Deterministic signals for triage. They do not replace correctness review. */
export function auditOutputs(cases, outputs, { run, split = "development" }) {
  const selectedCases = cases.filter((row) => row.split === split);
  const caseMap = new Map(selectedCases.map((row) => [row.id, row]));
  const rows = outputs.filter((row) => row.run === run && caseMap.has(row.caseId)).map((output) => {
    const benchmarkCase = caseMap.get(output.caseId);
    const source = benchmarkCase.prompt.split("\nSOURCE REPLY\n").at(-1);
    const missing = benchmarkCase.contract.protected.filter((literal) => !output.text.includes(literal));
    const sourceWords = Math.max(1, wordCount(source));
    const outputWords = wordCount(output.text);
    return {
      caseId: output.caseId,
      system: output.system,
      genre: benchmarkCase.genre,
      missing,
      sourceWords,
      outputWords,
      lengthRatio: outputWords / sourceWords,
      instructionEcho: /\bWRITING (?:INSTRUCTIONS|TASK)\b/u.test(output.text),
    };
  });
  const systems = {};
  for (const system of SYSTEMS) {
    const systemRows = rows.filter((row) => row.system === system);
    const ratios = systemRows.map((row) => row.lengthRatio);
    const shortSources = systemRows.filter((row) => row.sourceWords <= 225);
    const longSources = systemRows.filter((row) => row.sourceWords > 225);
    const missingByKind = {};
    for (const literal of systemRows.flatMap((row) => row.missing)) {
      const kind = literalKind(literal);
      missingByKind[kind] = (missingByKind[kind] ?? 0) + 1;
    }
    systems[system] = {
      outputs: systemRows.length,
      literalPasses: systemRows.filter((row) => row.missing.length === 0).length,
      literalFailures: systemRows.filter((row) => row.missing.length > 0).length,
      missingLiterals: systemRows.reduce((sum, row) => sum + row.missing.length, 0),
      missingByKind,
      medianLengthRatio: median(ratios),
      shorterThanHalf: systemRows.filter((row) => row.lengthRatio < 0.5).length,
      longerThanOneAndHalf: systemRows.filter((row) => row.lengthRatio > 1.5).length,
      instructionEchoes: systemRows.filter((row) => row.instructionEcho).length,
      bySourceLength: {
        atMost225: { outputs: shortSources.length, literalPasses: shortSources.filter((row) => row.missing.length === 0).length },
        over225: { outputs: longSources.length, literalPasses: longSources.filter((row) => row.missing.length === 0).length },
      },
    };
  }
  return { schemaVersion: SCHEMA_VERSION, run, split, cases: selectedCases.length, systems };
}

/** Experimental structure signals. They remain evidence, never lint findings. */
export function structuralSignals(value) {
  const sentences = value.split(/(?<=[.!?])\s+/u).map((row) => row.trim()).filter(Boolean);
  const paragraphs = value.split(/\n\s*\n/u).map((row) => row.trim()).filter(Boolean);
  const triads = sentences.filter((row) => {
    const commas = (row.match(/,/gu) ?? []).length;
    return commas >= 2 && /\b(?:and|or)\b/iu.test(row);
  }).length;
  const openings = paragraphs.map((row) => (row.match(/^\W*([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)?)/u)?.[1] ?? "").toLowerCase());
  const openingCounts = new Map();
  for (const opening of openings.filter(Boolean)) openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
  const repeatedOpenings = [...openingCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const confidence = {
    qualified: (value.match(/\b(?:may|might|could|likely|probably|appears?|suggests?)\b/giu) ?? []).length,
    certain: (value.match(/\b(?:will|must|always|never|clearly|definitely)\b/giu) ?? []).length,
  };
  const confidenceBySentence = sentences.map((sentence) => {
    const qualified = /\b(?:may|might|could|likely|probably|appears?|suggests?)\b/iu.test(sentence);
    const certain = /\b(?:will|must|always|never|clearly|definitely)\b/iu.test(sentence);
    if (qualified && certain) return "mixed";
    if (qualified) return "qualified";
    if (certain) return "certain";
    return "unmarked";
  });
  const paragraphShapes = paragraphs.map((paragraph) => {
    const lengths = paragraph.split(/(?<=[.!?])\s+/u).map((sentence) => wordCount(sentence)).filter(Boolean);
    return lengths.map((length) => length <= 8 ? "short" : length <= 20 ? "medium" : "long").join("-");
  }).filter(Boolean);
  const shapeCounts = new Map();
  for (const shape of paragraphShapes) shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
  const dominantShapeCount = Math.max(0, ...shapeCounts.values());
  const confidenceSentences = {
    qualified: confidenceBySentence.filter((value) => value === "qualified").length,
    certain: confidenceBySentence.filter((value) => value === "certain").length,
    mixed: confidenceBySentence.filter((value) => value === "mixed").length,
    unmarked: confidenceBySentence.filter((value) => value === "unmarked").length,
  };
  const markedConfidence = confidenceSentences.qualified + confidenceSentences.certain + confidenceSentences.mixed;
  const confidenceDominance = markedConfidence
    ? Math.max(confidenceSentences.qualified, confidenceSentences.certain) / markedConfidence
    : 0;
  const signals = {
    repeatedTriads: {
      eligible: sentences.length >= 5,
      active: sentences.length >= 5 && triads >= 2,
    },
    repeatedParagraphShapes: {
      eligible: paragraphs.length >= 3,
      active: paragraphs.length >= 3 && dominantShapeCount >= 3 && dominantShapeCount / paragraphs.length >= 0.6,
    },
    uniformConfidence: {
      eligible: sentences.length >= 5 && markedConfidence >= 3,
      active: sentences.length >= 5 && markedConfidence >= 3 && confidenceDominance >= 0.9,
    },
  };
  return {
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    triads,
    repeatedOpenings,
    paragraphShapes: {
      distinct: shapeCounts.size,
      dominantCount: dominantShapeCount,
      dominantShare: paragraphs.length ? dominantShapeCount / paragraphs.length : 0,
    },
    confidence: {
      ...confidence,
      sentences: confidenceSentences,
      dominantShare: confidenceDominance,
    },
    signals,
  };
}

function sourceReply(benchmarkCase) {
  const marker = "\nSOURCE REPLY\n";
  const at = benchmarkCase.prompt.indexOf(marker);
  return at === -1 ? "" : benchmarkCase.prompt.slice(at + marker.length).trim();
}

function signalEvidence(name, selectedCases, allCases, rows, comparisonsList, votes, split) {
  const relevantRows = rows.filter((row) => row.signals[name].eligible);
  const activeRows = relevantRows.filter((row) => row.signals[name].active);
  const sourceRows = selectedCases.map((benchmarkCase) => sourceReply(benchmarkCase)).filter(Boolean).map(structuralSignals)
    .filter((row) => row.signals[name].eligible);
  const activeSources = sourceRows.filter((row) => row.signals[name].active).length;
  const rowMap = new Map(rows.map((row) => [`${row.caseId}\0${row.system}`, row]));
  const verdicts = pairVerdicts(comparisonsList, votes).filter((row) => row.outcome !== "pending");
  let comparisonsCount = 0;
  let decisive = 0;
  let preferredWithout = 0;
  for (const verdict of verdicts) {
    const [first, second] = verdict.systems;
    const firstRow = rowMap.get(`${verdict.caseId}\0${first}`);
    const secondRow = rowMap.get(`${verdict.caseId}\0${second}`);
    if (!firstRow?.signals[name].eligible || !secondRow?.signals[name].eligible) continue;
    if (firstRow.signals[name].active === secondRow.signals[name].active) continue;
    comparisonsCount += 1;
    if (verdict.outcome === "tie") continue;
    decisive += 1;
    const without = firstRow.signals[name].active ? second : first;
    if (verdict.outcome === without) preferredWithout += 1;
  }
  const preference = decisive ? preferredWithout / decisive : 0;
  const sourceActivation = sourceRows.length ? activeSources / sourceRows.length : 0;
  const genres = new Set(allCases.map((row) => row.genre)).size;
  const checks = {
    frozenHoldout: split === "holdout",
    atLeast50PrivateCases: allCases.length >= 50,
    atLeast4Genres: genres >= 4,
    atLeast20EligibleOutputs: relevantRows.length >= 20,
    atLeast20ActiveOutputs: activeRows.length >= 20,
    preferenceAbove70: preference > 0.7,
    lowerBoundAbove50: wilsonLower(preferredWithout, decisive) > 0.5,
    humanSourceActivationAtMost5: sourceActivation <= 0.05,
  };
  return {
    eligibleOutputs: relevantRows.length,
    activeOutputs: activeRows.length,
    eligibleHumanSources: sourceRows.length,
    activeHumanSources: activeSources,
    humanSourceActivation: sourceActivation,
    comparisons: comparisonsCount,
    decisive,
    preferredWithout,
    preference,
    lower95: wilsonLower(preferredWithout, decisive),
    checks,
    ready: Object.values(checks).every(Boolean),
  };
}

export function analyzeStructures(cases, outputs, { run, split = "development", comparisons: comparisonsList = [], votes = [] }) {
  const caseMap = new Map(cases.filter((row) => row.split === split).map((row) => [row.id, row]));
  const rows = outputs.filter((row) => row.run === run && caseMap.has(row.caseId)).map((row) => ({
    caseId: row.caseId,
    system: row.system,
    genre: caseMap.get(row.caseId).genre,
    ...structuralSignals(row.text),
  }));
  const signalNames = ["repeatedTriads", "repeatedParagraphShapes", "uniformConfidence"];
  const systems = Object.fromEntries(SYSTEMS.map((system) => [system, Object.fromEntries(signalNames.map((name) => {
    const systemRows = rows.filter((row) => row.system === system && row.signals[name].eligible);
    return [name, {
      eligible: systemRows.length,
      active: systemRows.filter((row) => row.signals[name].active).length,
    }];
  }))]));
  const evidence = Object.fromEntries(signalNames.map((name) => [
    name,
    signalEvidence(name, [...caseMap.values()], cases, rows, comparisonsList, votes, split),
  ]));
  return { schemaVersion: SCHEMA_VERSION, run, split, cases: caseMap.size, systems, evidence, rows };
}

/** Blind correctness tasks hide the instruction system from the reviewer. */
export function gateReviewTasks(cases, outputs, { run, split = "development", seed = "gates" }) {
  const caseIds = new Set(cases.filter((row) => row.split === split).map((row) => row.id));
  return outputs.filter((row) => row.run === run && caseIds.has(row.caseId)).map((row) => ({
    schemaVersion: SCHEMA_VERSION,
    run,
    split,
    id: sha256(`${run}\0${row.caseId}\0${row.system}\0gate`).slice(0, 20),
    caseId: row.caseId,
    system: row.system,
  })).sort((a, b) => sha256(`${seed}\0${a.id}`).localeCompare(sha256(`${seed}\0${b.id}`)));
}

export function blindGateReview(task, cases, outputs) {
  const benchmarkCase = cases.find((row) => row.id === task.caseId);
  const output = outputs.find((row) => row.run === task.run && row.caseId === task.caseId && row.system === task.system);
  if (!benchmarkCase || !output) fail(`gate review ${task.id} cannot resolve its case and output`);
  return {
    id: task.id,
    genre: benchmarkCase.genre,
    prompt: benchmarkCase.prompt,
    contract: benchmarkCase.contract,
    output: output.text,
    exactProtectedText: {
      pass: benchmarkCase.contract.protected.filter((literal) => output.text.includes(literal)),
      missing: benchmarkCase.contract.protected.filter((literal) => !output.text.includes(literal)),
    },
  };
}

function comparisonId(run, caseId, left, right, round) {
  return sha256(`${run}\0${caseId}\0${left}\0${right}\0${round}`).slice(0, 20);
}

/** Two mirrored presentations expose whether A/B order changes the verdict. */
export function comparisons(cases, outputs, gates, { run, split = "development", seed = "compare" }) {
  const gateMap = new Map(gates.filter((row) => row.run === run).map((row) => [`${row.caseId}\0${row.system}`, row]));
  const outputMap = new Map(outputs.filter((row) => row.run === run).map((row) => [`${row.caseId}\0${row.system}`, row]));
  const rows = [];
  for (const benchmarkCase of cases.filter((item) => item.split === split)) {
    for (const [first, second] of PAIRS) {
      const firstGate = gateMap.get(`${benchmarkCase.id}\0${first}`);
      const secondGate = gateMap.get(`${benchmarkCase.id}\0${second}`);
      if (!firstGate || !secondGate || !gatePass(firstGate) || !gatePass(secondGate)) continue;
      const firstOutput = outputMap.get(`${benchmarkCase.id}\0${first}`);
      const secondOutput = outputMap.get(`${benchmarkCase.id}\0${second}`);
      if (!firstOutput || !secondOutput) continue;
      const swap = Number.parseInt(sha256(`${seed}\0${benchmarkCase.id}\0${first}\0${second}`).slice(0, 2), 16) % 2 === 1;
      const left = swap ? second : first;
      const right = swap ? first : second;
      rows.push({ schemaVersion: SCHEMA_VERSION, run, split, caseId: benchmarkCase.id, round: 1, id: comparisonId(run, benchmarkCase.id, left, right, 1), left, right });
      rows.push({ schemaVersion: SCHEMA_VERSION, run, split, caseId: benchmarkCase.id, round: 2, id: comparisonId(run, benchmarkCase.id, right, left, 2), left: right, right: left });
    }
  }
  return rows.sort((a, b) => sha256(`${seed}\0${a.id}`).localeCompare(sha256(`${seed}\0${b.id}`)));
}

export function blindComparison(comparison, cases, outputs) {
  const benchmarkCase = cases.find((item) => item.id === comparison.caseId);
  const left = outputs.find((item) => item.run === comparison.run && item.caseId === comparison.caseId && item.system === comparison.left);
  const right = outputs.find((item) => item.run === comparison.run && item.caseId === comparison.caseId && item.system === comparison.right);
  if (!benchmarkCase || !left || !right) fail(`comparison ${comparison.id} cannot resolve its case and outputs`);
  return {
    id: comparison.id,
    genre: benchmarkCase.genre,
    prompt: benchmarkCase.prompt,
    contract: benchmarkCase.contract,
    A: left.text,
    B: right.text,
  };
}

function chosenSystem(comparison, vote) {
  if (vote.choice === "TIE") return "tie";
  return vote.choice === "A" ? comparison.left : comparison.right;
}

/** Collapse mirrored presentations into one order-checked pairwise verdict. */
export function pairVerdicts(comparisonsList, votes) {
  const voteMap = new Map(votes.map((vote) => [vote.comparisonId, vote]));
  const grouped = new Map();
  for (const comparison of comparisonsList) {
    const pair = [comparison.left, comparison.right].sort();
    const key = `${comparison.caseId}\0${pair[0]}\0${pair[1]}`;
    const list = grouped.get(key) ?? [];
    list.push(comparison);
    grouped.set(key, list);
  }
  const verdicts = [];
  for (const [key, pair] of grouped) {
    if (pair.length !== 2) continue;
    const selected = pair.map((comparison) => {
      const vote = voteMap.get(comparison.id);
      return vote ? chosenSystem(comparison, vote) : undefined;
    });
    if (selected.some((value) => value === undefined)) {
      verdicts.push({ key, caseId: pair[0].caseId, systems: [pair[0].left, pair[0].right].sort(), outcome: "pending", orderConsistent: undefined });
      continue;
    }
    const consistent = selected[0] === selected[1];
    verdicts.push({
      key,
      caseId: pair[0].caseId,
      systems: [pair[0].left, pair[0].right].sort(),
      outcome: consistent ? selected[0] : "tie",
      orderConsistent: consistent,
    });
  }
  return verdicts;
}

export function wilsonLower(wins, total, z = 1.96) {
  if (total === 0) return 0;
  const p = wins / total;
  const z2 = z * z;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (center - margin) / (1 + z2 / total);
}

function preferenceSummary(verdicts, cases, system, opponent) {
  const relevant = verdicts.filter((row) => row.systems.includes(system) && row.systems.includes(opponent) && row.outcome !== "pending");
  const wins = relevant.filter((row) => row.outcome === system).length;
  const losses = relevant.filter((row) => row.outcome === opponent).length;
  const ties = relevant.length - wins - losses;
  const decisive = wins + losses;
  const byGenre = {};
  for (const genre of GENRES) {
    const ids = new Set(cases.filter((item) => item.genre === genre).map((item) => item.id));
    const rows = relevant.filter((row) => ids.has(row.caseId));
    const genreWins = rows.filter((row) => row.outcome === system).length;
    const genreLosses = rows.filter((row) => row.outcome === opponent).length;
    if (genreWins + genreLosses > 0) byGenre[genre] = genreWins / (genreWins + genreLosses);
  }
  const judgedOrder = relevant.filter((row) => row.orderConsistent !== undefined);
  return {
    completed: relevant.length,
    wins,
    losses,
    ties,
    winRate: decisive ? wins / decisive : 0,
    lower95: wilsonLower(wins, decisive),
    orderConsistency: judgedOrder.length ? judgedOrder.filter((row) => row.orderConsistent).length / judgedOrder.length : 0,
    byGenre,
  };
}

export function report(cases, outputs, gates, comparisonsList, votes, { run, split = "development" }) {
  const selectedCases = cases.filter((item) => item.split === split);
  const caseIds = new Set(selectedCases.map((item) => item.id));
  const selectedOutputs = outputs.filter((item) => item.run === run && caseIds.has(item.caseId));
  const selectedGates = gates.filter((item) => item.run === run && caseIds.has(item.caseId));
  const selectedComparisons = comparisonsList.filter((item) => item.run === run && item.split === split);
  const selectedVotes = votes.filter((item) => item.run === run);
  const verdicts = pairVerdicts(selectedComparisons, selectedVotes);
  const correctness = {};
  for (const system of SYSTEMS) {
    const rows = selectedGates.filter((item) => item.system === system);
    correctness[system] = {
      reviewed: rows.length,
      passed: rows.filter(gatePass).length,
      passRate: rows.length ? rows.filter(gatePass).length / rows.length : 0,
      preservationFailures: rows.filter((row) => row.checks.preservation === "fail").length,
      groundingFailures: rows.filter((row) => row.checks.grounding === "fail").length,
    };
  }
  const genres = [...new Set(selectedCases.map((item) => item.genre))].sort();
  const allGenres = [...new Set(cases.map((item) => item.genre))].sort();
  const candidates = {};
  for (const system of ["candidate-a", "candidate-b"]) {
    const preference = preferenceSummary(verdicts, selectedCases, system, "released");
    const genreRates = Object.values(preference.byGenre);
    const gatesForCandidate = correctness[system];
    const released = correctness.released;
    const checks = {
      frozenHoldout: split === "holdout",
      atLeast50PrivateCases: cases.length >= 50,
      atLeast4Genres: allGenres.length >= 4,
      winRateAtLeast65: preference.winRate >= 0.65,
      lowerBoundAbove50: preference.lower95 > 0.5,
      everyMeasuredGenreAtLeast55: genreRates.length >= 4 && genreRates.every((rate) => rate >= 0.55),
      orderConsistencyAtLeast90: preference.orderConsistency >= 0.9,
      zeroPreservationFailures: gatesForCandidate.preservationFailures === 0,
      zeroGroundingFailures: gatesForCandidate.groundingFailures === 0,
      noTaskCompletionLoss: gatesForCandidate.passRate >= released.passRate,
    };
    candidates[system] = { preference, checks, ready: Object.values(checks).every(Boolean) };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    run,
    split,
    cases: selectedCases.length,
    totalCases: cases.length,
    genres,
    totalGenres: allGenres,
    outputs: selectedOutputs.length,
    correctness,
    pairwise: {
      scheduled: verdicts.length,
      completed: verdicts.filter((row) => row.outcome !== "pending").length,
      pending: verdicts.filter((row) => row.outcome === "pending").length,
    },
    candidates,
  };
}

export function evaluationHome(env = process.env, platform = process.platform, home = homedir()) {
  const paths = platform === "win32" ? win32 : posix;
  if (env.PLAIN_ENGLISH_EVAL_HOME) return paths.resolve(env.PLAIN_ENGLISH_EVAL_HOME);
  if (platform === "darwin") return paths.resolve(home, "Library", "Application Support", "plain-english", "evaluation");
  if (platform === "win32") return paths.resolve(env.LOCALAPPDATA || paths.resolve(home, "AppData", "Local"), "plain-english", "evaluation");
  return paths.resolve(env.XDG_DATA_HOME || paths.resolve(home, ".local", "share"), "plain-english", "evaluation");
}

export function assertOutsideRepository(store, repository) {
  const looksWindows = (value) => /^(?:[a-z]:[\\/]|\\\\)/i.test(value);
  const paths = looksWindows(store) || looksWindows(repository) ? win32 : posix;
  const rel = paths.relative(paths.resolve(repository), paths.resolve(store));
  const isInside = rel === "" || (!paths.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${paths.sep}`));
  if (isInside) {
    fail("evaluation data must live outside the repository; set PLAIN_ENGLISH_EVAL_HOME to a user-data directory");
  }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${path}:${i + 1}: ${error.message}`);
    }
  });
}

export function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(temporary, path);
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
