/**
 * Project vocabulary approval: one literal term waived for one lexical rule.
 *
 * The Claude Code plugin's review panel offers it, in two steps (ADR-007).
 * `check` says what would change and writes nothing; `write` saves only when
 * the configuration is still byte for byte what the check saw. Every check
 * reads through an io (ADR-008): `approvalPlan` decides, and the caller
 * writes, the CLI through `approve-write.ts` and the mod through `$.fs`.
 */

import { isMap, isSeq, parseDocument } from "yaml";
import type { CheckerIo } from "./io.ts";
import { nodeIo } from "./node-io.ts";
import type { RuleSet } from "./rules.ts";
import { sha256 } from "./sha256.ts";

const CONFIG_NAMES = [".plain-english.yml", ".plain-english.yaml"];

/** A deliberate project exception for one literal term and one lexical rule. */
export function approveTerm(text: string, term: string, ruleId: string, reason: string): string {
  if (!/^[A-Za-z][\w .-]{0,79}$/.test(term) || !/[\w]$/.test(term)) {
    throw new Error("Approve one short word or name, not a passage.");
  }
  if (!/^[\w-]+$/.test(ruleId) || /(?:length|count|paragraph|sentence|structure)/.test(ruleId)) {
    throw new Error("This rule checks context, not an approved term.");
  }
  if (typeof reason !== "string" || !reason.trim() || /[\r\n\x00-\x1f]/.test(reason)) {
    throw new Error("Give a one-line reason for this project exception.");
  }
  const doc = parseDocument(text || "version: 1\nextends: default\n");
  if (doc.errors.length) throw new Error("The project configuration cannot be parsed.");
  if (!isMap(doc.contents)) throw new Error("The project configuration must be a mapping.");
  const existing = doc.get("allow", true);
  if (existing !== undefined && !isSeq(existing)) throw new Error("The existing allow entries must be a list.");
  if (existing === undefined) doc.set("allow", doc.createNode([]));
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = doc.createNode({
    pattern: `(?<![\\w])${escaped}(?![\\w])`,
    rules: [ruleId],
    ...(ruleId === "unglossed-term" ? { semantic: true } : {}),
  });
  entry.commentBefore = ` Approved in Plain English review: ${reason.trim()}`;
  doc.addIn(["allow"], entry);
  return doc.toString();
}

/**
 * Whether anything stands at `path`, a link included. `existsSync` follows a
 * link, so a link to a missing file would read as "no config" and the write
 * would create the link's target (found by a security review of 83ad212).
 */
function present(path: string, io: CheckerIo): boolean {
  return io.stat(path) !== undefined;
}

/** Whether a path names a file, following a link as `existsSync` does. */
function existsFollowing(path: string, io: CheckerIo): boolean {
  const facts = io.stat(path);
  if (facts === undefined) return false;
  return facts.kind !== "link" || (facts.realPath !== undefined && io.stat(facts.realPath) !== undefined);
}

/** The project's own config, or a refusal when an ancestor's would govern it. */
function approvalConfig(directory: string, io: CheckerIo): { path: string; exists: boolean } {
  for (const name of CONFIG_NAMES) {
    const path = io.path.join(directory, name);
    if (present(path, io)) return { path, exists: true };
  }
  let ancestor = directory;
  while (io.path.dirname(ancestor) !== ancestor) {
    ancestor = io.path.dirname(ancestor);
    if (CONFIG_NAMES.some((name) => existsFollowing(io.path.join(ancestor, name), io))) {
      throw new Error("This project uses an inherited configuration. Add the scoped term to that configuration by hand; no child configuration was created.");
    }
  }
  return { path: io.path.join(directory, ".plain-english.yml"), exists: false };
}

/** Why a rule cannot take a vocabulary exception, or `undefined` when it can. */
function notApprovable(set: RuleSet, ruleId: string): string | undefined {
  if (set.structures.some((structure) => structure.id === ruleId)) return "This rule cannot be approved as project vocabulary.";
  const known = set.rules.some((rule) => rule.id === ruleId) ||
    set.readability.some((rule) => rule.id === ruleId) ||
    (set.families ?? []).some((family) => `family-${family.id}` === ruleId);
  return known ? undefined : `no rule ${ruleId}`;
}

export interface ApprovalRequest {
  phase: "check" | "write";
  term: string;
  rule: string;
  reason: string;
  /** What `check` returned; `write` refuses unless the project still matches it. */
  expect?: { root?: unknown; config?: unknown; exists?: unknown; hash?: unknown };
}

export type ApprovalResult =
  | { ok: true; root: string; config: string; exists: boolean; hash: string; modelVocabulary: boolean }
  | { ok: false; message: string };

/** What a `write` step would save, beside the answer it gives. */
export type ApprovalPlan =
  | { result: Extract<ApprovalResult, { ok: true }>; write?: { path: string; exists: boolean; text: string } }
  | { result: Extract<ApprovalResult, { ok: false }> };

/**
 * Decide one approval step in `cwd`, never throwing: a refusal is a result.
 * A `write` step that passes every check carries the text to save; the caller
 * saves it, refusing a link and a file that appeared since the check.
 */
export function approvalPlan(cwd: string, request: ApprovalRequest, ruleSetFor: (directory: string) => RuleSet, io: CheckerIo = nodeIo): ApprovalPlan {
  try {
    const where = io.stat(io.path.resolve(io.cwd, cwd));
    const root = where?.realPath;
    if (root === undefined) throw new Error("Cannot locate the project directory.");
    if (io.stat(root)?.kind !== "directory") throw new Error("Cannot locate the project directory.");
    const { path, exists } = approvalConfig(root, io);
    if (exists) {
      const link = io.stat(path);
      if (link === undefined || link.kind !== "file" || link.realPath !== path) throw new Error("Review the linked configuration by hand.");
    }
    const original = exists ? io.read(path) ?? "" : "";
    const updated = approveTerm(original, request.term, request.rule, request.reason);
    const refusal = notApprovable(ruleSetFor(root), request.rule);
    if (refusal) throw new Error(refusal);
    const state = { root, config: io.path.basename(path), exists, hash: sha256(original) };
    const result = { ok: true as const, ...state, modelVocabulary: request.rule === "unglossed-term" };
    if (request.phase !== "write") return { result };
    const seen = request.expect;
    if (!seen || seen.root !== state.root || seen.config !== state.config || seen.exists !== state.exists || seen.hash !== state.hash) {
      throw new Error("The configuration changed. Review it again before saving.");
    }
    return { result, write: { path, exists, text: updated } };
  } catch (error) {
    return { result: { ok: false, message: error instanceof Error ? error.message : String(error) } };
  }
}
