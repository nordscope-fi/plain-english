/**
 * Project vocabulary approval: one literal term waived for one lexical rule.
 *
 * The Claude Code plugin's review panel offers it. The mod asks the person and
 * this command does every file read and write, in two steps (ADR-007). `check`
 * says what would change and writes nothing; `write` saves only when the
 * configuration is still byte for byte what the check saw.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import type { RuleSet } from "./rules.ts";

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
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The project's own config, or a refusal when an ancestor's would govern it. */
function approvalConfig(directory: string): { path: string; exists: boolean } {
  for (const name of CONFIG_NAMES) {
    const path = join(directory, name);
    if (present(path)) return { path, exists: true };
  }
  let ancestor = directory;
  while (dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor);
    if (CONFIG_NAMES.some((name) => existsSync(join(ancestor, name)))) {
      throw new Error("This project uses an inherited configuration. Add the scoped term to that configuration by hand; no child configuration was created.");
    }
  }
  return { path: join(directory, ".plain-english.yml"), exists: false };
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Run one approval step in `cwd`, never throwing: a refusal is a result. */
export function approveInProject(cwd: string, request: ApprovalRequest, ruleSetFor: (directory: string) => RuleSet): ApprovalResult {
  try {
    const root = realpathSync(cwd);
    if (!statSync(root).isDirectory()) throw new Error("Cannot locate the project directory.");
    const { path, exists } = approvalConfig(root);
    if (exists) {
      const link = lstatSync(path);
      if (link.isSymbolicLink() || !link.isFile() || realpathSync(path) !== path) throw new Error("Review the linked configuration by hand.");
    }
    const original = exists ? readFileSync(path, "utf8") : "";
    const updated = approveTerm(original, request.term, request.rule, request.reason);
    const refusal = notApprovable(ruleSetFor(root), request.rule);
    if (refusal) throw new Error(refusal);
    const state = { root, config: basename(path), exists, hash: sha256(original) };
    if (request.phase === "write") {
      const seen = request.expect;
      if (!seen || seen.root !== state.root || seen.config !== state.config || seen.exists !== state.exists || seen.hash !== state.hash) {
        throw new Error("The configuration changed. Review it again before saving.");
      }
      // Never through a link, and never over a file that appeared after the
      // check: a new config is created exclusively, an existing one is opened
      // without following a link.
      const fd = openSync(path, exists ? constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) : "wx", 0o644);
      try {
        writeFileSync(fd, updated);
      } finally {
        closeSync(fd);
      }
    }
    return { ok: true, ...state, modelVocabulary: request.rule === "unglossed-term" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
