/**
 * Loading, validating and merging rulesets.
 *
 * A project never forks the ruleset. It writes a `.plain-english.yml` that
 * `extends: default` and adds vocabulary, path exclusions, and severity
 * overrides. Upstream rule fixes keep reaching it.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { findUnsafe } from "./safe-regex.ts";

export type Severity = "error" | "warn" | "off";

export interface Rule {
  id: string;
  severity: Severity;
  match: string;
  unless?: string[];
  message?: string;
  /** URL explaining why the rule exists. Vale calls this `link`. */
  link?: string;
  /**
   * Why this project changed the rule.
   *
   * Set in `.plain-english.yml`, never in the shipped ruleset. A config
   * override silences a rule across every file, which is broader than any
   * comment, so the generated policy prints this next to the change. Nothing
   * validates the text.
   */
  reason?: string;
  /**
   * When set, the rule fires only if matches exceed this rate per 1,000 words.
   * Presence alone is not a finding.
   */
  perThousandWords?: number;
  /** Compiled lazily by `compile`. */
  re?: RegExp;
  unlessRe?: RegExp[];
}

export type ReadabilityKind =
  | "unglossed-term"
  | "long-sentence"
  | "unexplained-suppression"
  // Chat only, and declared under `chat.limits` rather than `readability`.
  // These two measure what one reply asks the reader to carry. A document has
  // no equivalent fault: length is how a document does its job.
  | "reply-length"
  | "reader-load"
  | "unreadable-ask"
  | "reply-pace";

/** A rule measured over sentence structure rather than matched at a point. */
export interface ReadabilityRule {
  id: string;
  severity: Severity;
  /**
   * Absent only in an unmerged overlay, where a project overrides a rule the
   * base already defines. `merge` requires it of an id the base does not know.
   */
  kind?: ReadabilityKind;
  /** long-sentence and reply-length: words above which the rule fires. */
  maxWords?: number;
  /** reader-load only: distinct backticked names above which the rule fires. */
  maxTerms?: number;
  /**
   * reply-pace only: the average sentence length a whole reply may hold.
   *
   * Distinct from long-sentence's `maxWords`, which judges one sentence. A
   * reply where every sentence is fifteen words breaks no single-sentence rule
   * and is still exhausting, because nothing in it lets up.
   */
  maxMeanWords?: number;
  /**
   * reply-pace only: the shortest reply worth measuring.
   *
   * A two-sentence answer has no pace. Without a floor the rule would fire on
   * a one-line answer that happened to need twenty words.
   */
  minWords?: number;
  /**
   * unreadable-ask only: subordinating clauses a closing question may carry.
   *
   * Separate from `maxWords` because the two faults are different. A long ask
   * is tiring; a nested one cannot be answered without unpacking it first.
   */
  maxClauses?: number;
  /**
   * unglossed-term only: names a reader already knows.
   *
   * Separate from the shared `allow` list on purpose. `allow` suppresses every
   * rule on a matching line, so putting "GitHub" there would also silence an
   * em dash on any line that mentions GitHub.
   */
  known?: string[];
  /**
   * unglossed-term only: ordinary words typed in capitals for emphasis.
   *
   * Separate from `known` because they are a different claim. `known` says the
   * reader already knows this name. `emphasis` says this is not a name at all,
   * it is a word somebody shouted.
   */
  emphasis?: string[];
  message?: string;
  link?: string;
  /** Why this project changed the rule. See `Rule.reason`. */
  reason?: string;
}

export interface Structure {
  id: string;
  name: string;
  description: string;
  bad?: string;
  good?: string;
}

/** One rendering of the chat guidance. Ordered narrowest first. */
export interface ChatLevel {
  id: string;
  name: string;
  description?: string;
  /**
   * How this level renders.
   *
   * `sections` gives every rule its own heading and paragraph, which is right
   * when the reader has room for it. `bullets` gives one checklist, which is
   * the point of a level that exists to be short. Absent means `sections`, so
   * a level written before this key keeps rendering the way it did.
   */
  form?: "sections" | "bullets";
}

/**
 * Which levels an entry appears in.
 *
 * Absent means every level, so an entry added upstream reaches everyone
 * without each project having to opt in. An empty list means none, which is
 * how a project turns one section off without forking the ruleset.
 */
type Levelled = { levels?: string[] };

export type ChatGuidance = Levelled & {
  id: string;
  name?: string;
  description?: string;
  /**
   * The rule in one imperative line, for the checklist rendering.
   *
   * Optional. Without it the brief style falls back to the first sentence of
   * `description`, so a project that adds guidance still renders at every
   * level without having to write the line twice.
   */
  short?: string;
  bad?: string;
  good?: string;
  reason?: string;
};

/**
 * The skeleton of a reply.
 *
 * Every other entry in this section is a rule about a reply. This is the shape
 * of one, and it is here because a model reproduces a shape far more reliably
 * than it weighs eighteen rules and derives one.
 *
 * `template` reaches the style inside a fenced block, which the masking pass
 * blanks, so its placeholder text is never read as prose by the linter.
 */
export type ChatShape = Levelled & {
  name: string;
  description?: string;
  template: string;
};

/**
 * A complete reply, both halves.
 *
 * `bad` opens with the phrases `chat.tells` bans, which is the point: an
 * example of the reply nobody should write has to contain one. It reaches the
 * style inside a blockquote, which the masking pass skips, so the style still
 * lints clean under the ruleset it illustrates.
 */
export type ChatExample = Levelled & {
  id: string;
  name?: string;
  /** What the reader asked, so the reply has something to be a reply to. */
  ask?: string;
  bad?: string;
  good?: string;
  /** One line on what separates the two, when the difference is not obvious. */
  note?: string;
};

/**
 * A chat-only phrase, held as literal text rather than a regex.
 *
 * Every other rule in this file carries a pattern, because a pattern is what
 * the engine needs. These carry phrases, because the same list has two
 * readers: `lint --chat` compiles it to a regex, and the output style prints
 * it to a model as words not to write. Storing the regex and re-deriving the
 * words for the prompt is the drift this package exists to remove.
 */
export type ChatTell = Levelled & {
  id: string;
  /** `start` anchors to the beginning of the reply. `anywhere` does not. */
  at: "start" | "anywhere";
  phrases: string[];
  severity: Severity;
  message?: string;
  reason?: string;
};

export type ChatAvoid = Levelled & { text: string };

export interface ChatSection {
  /** The channel boundary, stated to the model. */
  scope: string;
  /** Which level the AGENTS.md fragment carries and `init` selects. */
  level: string;
  levels: ChatLevel[];
  guidance: ChatGuidance[];
  tells: ChatTell[];
  avoid: ChatAvoid[];
  expand: string[];
  /** The reply skeleton, when the ruleset carries one. */
  shape?: ChatShape;
  /** Worked replies, both halves. */
  examples: ChatExample[];
  /**
   * What the chat judge reads for, beyond whether the length was earned.
   *
   * Here rather than in `render` because a prompt carrying wording no config
   * governs is wording a project cannot change and `render --check` cannot see
   * drift in. Each entry becomes a bullet in the generated prompt.
   *
   * The reason there is a semantic check at all: a pattern finds an acronym
   * and a camel-cased name, and the terms a reader actually stops on are
   * ordinary words carrying a technical sense. Measured 2026-08-19,
   * `unglossed-term` fired zero times on all five replies that drew a
   * complaint.
   */
  judge: ChatJudgeCheck[];
  /**
   * The tier at which a chat finding holds a turn.
   *
   * Separate from the global `failOn` because the two answer different
   * questions. The global one decides whether a lint run fails a build, and
   * defaulting that to blocking would break the CI of everyone who installs
   * this. Chat has no build to fail: the whole cost of blocking is a few
   * seconds and a rewrite, and the whole cost of not blocking is that the
   * reader has already read the reply by the time anyone objects.
   *
   * Unset means fall back to the global value.
   */
  failOn?: FailOn;
  /**
   * What one reply may ask the reader to carry.
   *
   * Here rather than in `readability` because these apply to a reply and to
   * nothing else. Same shape as a readability rule, and `chatRuleSet` appends
   * them to `readability` so the whole existing lint path runs unchanged.
   */
  limits: ReadabilityRule[];
}

export interface ChatJudgeCheck {
  id: string;
  description: string;
}

/** True when a levelled entry belongs in `level`. */
export function inLevel(entry: Levelled, level: string): boolean {
  return entry.levels === undefined || entry.levels.includes(level);
}

export type FailOn = "error" | "warn" | "never";

/**
 * One rule about the shape of a document.
 *
 * The same fields a chat guidance entry carries, plus `flag`. Two readers need
 * this list and they need it phrased two ways: the skill tells a writer what
 * to do, and the gate prompt needs the fault to look for. Holding both here is
 * what stops the two drifting into disagreeing about the same rule.
 */
export type DocsGuidance = ChatGuidance & {
  /** The rule as the fault, for the judge prompt. */
  flag?: string;
};

/**
 * How to write a document, as opposed to what to cut from one.
 *
 * The word rules, the readability rules and the sentence shapes already say
 * what not to write, and until this section existed that was the whole docs
 * channel: a judge listing prohibitions, and a reference titled "AI-Tell
 * Patterns to Cut". A document can obey every one of those and still bury what
 * it is for.
 *
 * No `levels`, `tells` or `limits`. A document that runs long is doing its job,
 * and one rendering is enough: unlike the chat channel there is no menu of
 * lengths for a reader to pick from.
 */
export interface DocsSection {
  scope: string;
  /** Where the generated guidance is installed, and what it is called. */
  skill: { name: string; description: string };
  guidance: DocsGuidance[];
}

export interface RuleSet {
  version: 1;
  meta: { title: string; intro: string };
  /**
   * Severity threshold at which the exit code becomes non-zero, and at which
   * the editor hook refuses a write.
   *
   *   never  report everything and exit 0   (the default)
   *   error  non-zero when a blocking finding exists
   *   warn   non-zero when any finding exists, warnings included
   *
   * The default is advisory. Comparable tools are advisory, published guidance
   * puts word-choice rules in the warning tier, and a gate people cannot merge
   * past gets bypassed. Blocking is something a project opts into.
   */
  failOn: FailOn;
  rules: Rule[];
  readability: ReadabilityRule[];
  structures: Structure[];
  /**
   * How to write a document. Empty when the ruleset carries no `docs` key, and
   * every consumer checks, so a config written before this section still
   * renders every target it used to.
   */
  docs: DocsSection;
  /**
   * The chat channel.
   *
   * Separate from everything above because it is the one channel whose text is
   * read once, by one person, mid-task. The rules that make a chat reply
   * readable would make a commit message useless, so they cannot share a list.
   */
  chat: ChatSection;
  allow: AllowEntry[];
  exclude: string[];
  /** Compiled from `allow`. */
  allowRe?: CompiledAllow[];
}

/**
 * One vocabulary declaration.
 *
 * A bare string is the original form and still means what it always did:
 * silence every rule on a matching line. That is a blunt instrument, and it
 * was the only one available. Measured on one repository, an entry added to
 * stop the linter asking for a gloss on the word "Deal" was also hiding 247
 * other findings, and nothing said so.
 *
 * `rules` narrows the entry to the rules it was meant for. `semantic` sends
 * the same vocabulary to the prompt-based layer, which reads no config of its
 * own and so used to ask for a gloss the deterministic side had been told to
 * skip.
 */
export interface AllowEntry {
  /** Regex, matched case-insensitively. */
  pattern: string;
  /** Rule ids this entry silences. Absent or empty means every rule. */
  rules?: string[];
  /** Declare the same terms to the semantic layer as vocabulary it knows. */
  semantic?: boolean;
}

/** An `allow` entry with its regex built. */
export interface CompiledAllow {
  entry: AllowEntry;
  re: RegExp;
  /** Absent means every rule. */
  rules?: Set<string>;
}

interface RawRule {
  id?: unknown;
  severity?: unknown;
  match?: unknown;
  unless?: unknown;
  message?: unknown;
  link?: unknown;
  perThousandWords?: unknown;
  reason?: unknown;
}

interface RawSet {
  version?: unknown;
  extends?: unknown;
  meta?: { title?: unknown; intro?: unknown };
  punctuation?: unknown;
  rules?: unknown;
  readability?: unknown;
  structures?: unknown;
  chat?: unknown;
  allow?: unknown;
  exclude?: unknown;
}

export class RuleError extends Error {}

/** Rule and section ids. Mirrors `$defs.id` in rules/schema.json. */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the built-in ruleset lives, both from src/ and from dist/. */
export function defaultRulesPath(): string {
  for (const p of [
    resolve(HERE, "..", "rules", "default.yml"),
    resolve(HERE, "..", "..", "rules", "default.yml"),
  ]) {
    if (existsSync(p)) return p;
  }
  throw new RuleError("built-in ruleset not found (rules/default.yml)");
}

function asStringArray(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError(`${where} must be a list`);
  return v.map((x, i) => {
    if (typeof x !== "string") throw new RuleError(`${where}[${i}] must be a string`);
    return x;
  });
}

const ALLOW_KEYS = new Set(["pattern", "rules", "semantic"]);

/**
 * Read `allow`, in either shape.
 *
 * The string form is the whole of the original language and stays exact, so
 * every config written before scoping existed keeps its meaning.
 */
function readAllow(v: unknown): AllowEntry[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError("allow must be a list");
  return v.map((raw, i) => {
    if (typeof raw === "string") return { pattern: raw };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RuleError(`allow[${i}] must be a string or a mapping with 'pattern'`);
    }
    const e = raw as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!ALLOW_KEYS.has(key)) {
        throw new RuleError(
          `allow[${i}]: unknown key '${key}'. Valid keys: ${[...ALLOW_KEYS].sort().join(", ")}`,
        );
      }
    }
    if (typeof e["pattern"] !== "string") {
      throw new RuleError(`allow[${i}].pattern must be a string`);
    }
    const out: AllowEntry = { pattern: e["pattern"] };
    if (e["rules"] !== undefined) {
      out.rules = asStringArray(e["rules"], `allow[${i}].rules`);
    }
    if (e["semantic"] !== undefined) {
      if (typeof e["semantic"] !== "boolean") {
        throw new RuleError(`allow[${i}].semantic must be true or false`);
      }
      out.semantic = e["semantic"];
    }
    return out;
  });
}

function readRules(v: unknown, where: string): Rule[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError(`${where} must be a list`);
  return v.map((raw, i) => {
    const r = raw as RawRule;
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) {
      throw new RuleError(`${where}[${i}].id must be a kebab-case string`);
    }
    const severity = (r.severity ?? "error") as Severity;
    if (!["error", "warn", "off"].includes(severity)) {
      throw new RuleError(`${where}[${i}] (${r.id}): severity must be error, warn or off`);
    }
    if (r.match !== undefined && typeof r.match !== "string") {
      throw new RuleError(`${where}[${i}] (${r.id}): match must be a string`);
    }
    if (r.message !== undefined && typeof r.message !== "string") {
      throw new RuleError(`${where}[${i}] (${r.id}): message must be a string`);
    }
    const rule: Rule = {
      id: r.id,
      severity,
      match: (r.match as string) ?? "",
      unless: asStringArray(r.unless, `${where}[${i}] (${r.id}).unless`),
    };
    if (typeof r.message === "string") rule.message = r.message;
    if (typeof r.link === "string") rule.link = r.link;
    if (typeof r.reason === "string") rule.reason = r.reason;
    if (r.perThousandWords !== undefined) {
      const n = Number(r.perThousandWords);
      if (!Number.isFinite(n) || n < 0) {
        throw new RuleError(
          `${where}[${i}] (${r.id}): perThousandWords must be a non-negative number`,
        );
      }
      rule.perThousandWords = n;
    }
    return rule;
  });
}

function readReadability(v: unknown): ReadabilityRule[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError("readability must be a list");
  const KINDS = [
    "unglossed-term",
    "long-sentence",
    "unexplained-suppression",
    "reply-length",
    "reader-load",
    "unreadable-ask",
    "reply-pace",
  ];
  return v.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r["id"] !== "string") {
      throw new RuleError(`readability[${i}].id must be a string`);
    }
    // `kind` is required of a definition and optional in an overlay, exactly
    // as `match` is on a word rule. Demanding it of every entry made the
    // override printed in the README a hard error, so a project that added its
    // own vocabulary could not lint at all. `merge` asks for it when the id is
    // new to the base.
    const kind = r["kind"];
    if (kind !== undefined && (typeof kind !== "string" || !KINDS.includes(kind))) {
      throw new RuleError(
        `readability[${i}] (${r["id"]}): kind must be one of ${KINDS.join(", ")}`,
      );
    }
    const severity = (r["severity"] ?? "warn") as Severity;
    if (!["error", "warn", "off"].includes(severity)) {
      throw new RuleError(
        `readability[${i}] (${r["id"]}): severity must be error, warn or off`,
      );
    }
    const out: ReadabilityRule = { id: r["id"], severity };
    if (kind !== undefined) out.kind = kind as ReadabilityKind;
    if (r["maxWords"] !== undefined) {
      const n = Number(r["maxWords"]);
      if (!Number.isInteger(n) || n < 1) {
        throw new RuleError(
          `readability[${i}] (${r["id"]}): maxWords must be a positive integer`,
        );
      }
      out.maxWords = n;
    }
    if (r["maxTerms"] !== undefined) {
      const n = Number(r["maxTerms"]);
      if (!Number.isInteger(n) || n < 1) {
        throw new RuleError(
          `readability[${i}] (${r["id"]}): maxTerms must be a positive integer`,
        );
      }
      out.maxTerms = n;
    }
    for (const key of ["maxMeanWords", "minWords"] as const) {
      if (r[key] === undefined) continue;
      const n = Number(r[key]);
      if (!Number.isInteger(n) || n < 1) {
        throw new RuleError(
          `readability[${i}] (${r["id"]}): ${key} must be a positive integer`,
        );
      }
      out[key] = n;
    }
    if (r["maxClauses"] !== undefined) {
      const n = Number(r["maxClauses"]);
      if (!Number.isInteger(n) || n < 0) {
        throw new RuleError(
          `readability[${i}] (${r["id"]}): maxClauses must be a whole number`,
        );
      }
      out.maxClauses = n;
    }
    for (const field of ["known", "emphasis"] as const) {
      if (!Array.isArray(r[field])) continue;
      out[field] = (r[field] as unknown[]).map((k, j) => {
        if (typeof k !== "string") {
          throw new RuleError(`readability[${i}] (${r["id"]}).${field}[${j}] must be a string`);
        }
        return k;
      });
    }
    if (typeof r["message"] === "string") out.message = r["message"];
    if (typeof r["link"] === "string") out.link = r["link"];
    if (typeof r["reason"] === "string") out.reason = r["reason"];
    return out;
  });
}

function readStructures(v: unknown): Structure[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError("structures must be a list");
  return v.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    for (const k of ["id", "name", "description"]) {
      if (typeof s[k] !== "string") {
        throw new RuleError(`structures[${i}].${k} must be a string`);
      }
    }
    const out: Structure = {
      id: s["id"] as string,
      name: s["name"] as string,
      description: s["description"] as string,
    };
    if (typeof s["bad"] === "string") out.bad = s["bad"];
    if (typeof s["good"] === "string") out.good = s["good"];
    return out;
  });
}

const EMPTY_CHAT: ChatSection = {
  scope: "",
  level: "",
  levels: [],
  guidance: [],
  tells: [],
  avoid: [],
  expand: [],
  examples: [],
  judge: [],
  limits: [],
};

const EMPTY_DOCS: DocsSection = { scope: "", skill: { name: "", description: "" }, guidance: [] };

/**
 * The docs section.
 *
 * Absent in every config written before it existed, and absent in most project
 * configs, so a missing key is the normal case and never an error.
 */
function readDocs(v: unknown): DocsSection {
  if (v === undefined || v === null) return { ...EMPTY_DOCS, guidance: [] };
  if (typeof v !== "object" || Array.isArray(v)) throw new RuleError("docs must be a mapping");
  const d = v as Record<string, unknown>;

  const out: DocsSection = { ...EMPTY_DOCS, skill: { ...EMPTY_DOCS.skill }, guidance: [] };
  if (d["scope"] !== undefined) {
    if (typeof d["scope"] !== "string") throw new RuleError("docs.scope must be a string");
    out.scope = d["scope"];
  }

  if (d["skill"] !== undefined) {
    if (typeof d["skill"] !== "object" || d["skill"] === null || Array.isArray(d["skill"])) {
      throw new RuleError("docs.skill must be a mapping");
    }
    const k = d["skill"] as Record<string, unknown>;
    for (const f of ["name", "description"] as const) {
      if (typeof k[f] !== "string") throw new RuleError(`docs.skill.${f} must be a string`);
    }
    // The name becomes a directory on disk and a key a loader matches on, so
    // it takes the same shape as every other id in this file.
    if (!ID_RE.test(k["name"] as string)) {
      throw new RuleError("docs.skill.name must be a kebab-case string");
    }
    out.skill = { name: k["name"] as string, description: k["description"] as string };
  }

  if (d["guidance"] !== undefined) {
    if (!Array.isArray(d["guidance"])) throw new RuleError("docs.guidance must be a list");
    out.guidance = d["guidance"].map((raw, i) => {
      const g = raw as Record<string, unknown>;
      if (typeof g["id"] !== "string" || !ID_RE.test(g["id"])) {
        throw new RuleError(`docs.guidance[${i}].id must be a kebab-case string`);
      }
      const entry: DocsGuidance = { id: g["id"] };
      for (const k of ["name", "description", "short", "flag", "bad", "good", "reason"] as const) {
        if (typeof g[k] === "string") entry[k] = g[k] as string;
      }
      return entry;
    });
  }

  return out;
}

function readShape(v: unknown): ChatShape | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new RuleError("chat.shape must be a mapping");
  }
  const r = v as Record<string, unknown>;
  for (const k of ["name", "template"] as const) {
    if (typeof r[k] !== "string") throw new RuleError(`chat.shape.${k} must be a string`);
  }
  const out: ChatShape = { name: r["name"] as string, template: r["template"] as string };
  if (typeof r["description"] === "string") out.description = r["description"];
  const levels = readLevels(r["levels"], "chat.shape.levels");
  if (levels) out.levels = levels;
  return out;
}

function readExamples(v: unknown): ChatExample[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError("chat.examples must be a list");
  return v.map((raw, i) => {
    const e = raw as Record<string, unknown>;
    if (typeof e["id"] !== "string" || !ID_RE.test(e["id"])) {
      throw new RuleError(`chat.examples[${i}].id must be a kebab-case string`);
    }
    const out: ChatExample = { id: e["id"] };
    for (const k of ["name", "ask", "bad", "good", "note"] as const) {
      if (typeof e[k] === "string") out[k] = e[k] as string;
    }
    const levels = readLevels(e["levels"], `chat.examples[${i}].levels`);
    if (levels) out.levels = levels;
    return out;
  });
}

function readLevels(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  return asStringArray(v, where);
}

/**
 * The chat section.
 *
 * Absent in most project configs, and absent in every ruleset written before
 * this section existed, so a missing key is an empty section rather than an
 * error. `merge` is what decides whether an overlay entry is allowed to name
 * an id the base does not have.
 */
function readChatJudge(v: unknown): ChatJudgeCheck[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RuleError("chat.judge must be a list");
  return v.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r["id"] !== "string" || !r["id"]) {
      throw new RuleError(`chat.judge[${i}].id must be a string`);
    }
    if (typeof r["description"] !== "string" || !r["description"].trim()) {
      throw new RuleError(`chat.judge[${i}] (${r["id"]}): description must be a string`);
    }
    return { id: r["id"], description: r["description"].trim() };
  });
}

function readChat(v: unknown): ChatSection {
  if (v === undefined || v === null) return { ...EMPTY_CHAT };
  if (typeof v !== "object" || Array.isArray(v)) throw new RuleError("chat must be a mapping");
  const c = v as Record<string, unknown>;

  const out: ChatSection = { ...EMPTY_CHAT };
  if (c["scope"] !== undefined) {
    if (typeof c["scope"] !== "string") throw new RuleError("chat.scope must be a string");
    out.scope = c["scope"];
  }
  if (c["level"] !== undefined) {
    if (typeof c["level"] !== "string") throw new RuleError("chat.level must be a string");
    out.level = c["level"];
  }

  if (c["levels"] !== undefined) {
    if (!Array.isArray(c["levels"])) throw new RuleError("chat.levels must be a list");
    out.levels = c["levels"].map((raw, i) => {
      const l = raw as Record<string, unknown>;
      for (const k of ["id", "name"]) {
        if (typeof l[k] !== "string") throw new RuleError(`chat.levels[${i}].${k} must be a string`);
      }
      const level: ChatLevel = { id: l["id"] as string, name: l["name"] as string };
      if (typeof l["description"] === "string") level.description = l["description"];
      if (l["form"] !== undefined) {
        if (l["form"] !== "sections" && l["form"] !== "bullets") {
          throw new RuleError(`chat.levels[${i}].form must be 'sections' or 'bullets'`);
        }
        level.form = l["form"];
      }
      return level;
    });
  }

  if (c["guidance"] !== undefined) {
    if (!Array.isArray(c["guidance"])) throw new RuleError("chat.guidance must be a list");
    out.guidance = c["guidance"].map((raw, i) => {
      const g = raw as Record<string, unknown>;
      if (typeof g["id"] !== "string" || !ID_RE.test(g["id"])) {
        throw new RuleError(`chat.guidance[${i}].id must be a kebab-case string`);
      }
      const entry: ChatGuidance = { id: g["id"] };
      for (const k of ["name", "description", "short", "bad", "good", "reason"] as const) {
        if (typeof g[k] === "string") entry[k] = g[k] as string;
      }
      const levels = readLevels(g["levels"], `chat.guidance[${i}].levels`);
      if (levels) entry.levels = levels;
      return entry;
    });
  }

  if (c["tells"] !== undefined) {
    if (!Array.isArray(c["tells"])) throw new RuleError("chat.tells must be a list");
    out.tells = c["tells"].map((raw, i) => {
      const t = raw as Record<string, unknown>;
      if (typeof t["id"] !== "string" || !ID_RE.test(t["id"])) {
        throw new RuleError(`chat.tells[${i}].id must be a kebab-case string`);
      }
      const at = (t["at"] ?? "anywhere") as string;
      if (at !== "start" && at !== "anywhere") {
        throw new RuleError(`chat.tells[${i}] (${t["id"]}): at must be start or anywhere`);
      }
      const severity = (t["severity"] ?? "warn") as Severity;
      if (!["error", "warn", "off"].includes(severity)) {
        throw new RuleError(
          `chat.tells[${i}] (${t["id"]}): severity must be error, warn or off`,
        );
      }
      const entry: ChatTell = {
        id: t["id"],
        at,
        severity,
        phrases: asStringArray(t["phrases"], `chat.tells[${i}] (${t["id"]}).phrases`),
      };
      if (typeof t["message"] === "string") entry.message = t["message"];
      if (typeof t["reason"] === "string") entry.reason = t["reason"];
      const levels = readLevels(t["levels"], `chat.tells[${i}].levels`);
      if (levels) entry.levels = levels;
      return entry;
    });
  }

  if (c["avoid"] !== undefined) {
    if (!Array.isArray(c["avoid"])) throw new RuleError("chat.avoid must be a list");
    out.avoid = c["avoid"].map((raw, i) => {
      const a = raw as Record<string, unknown>;
      if (typeof a["text"] !== "string") throw new RuleError(`chat.avoid[${i}].text must be a string`);
      const entry: ChatAvoid = { text: a["text"] };
      const levels = readLevels(a["levels"], `chat.avoid[${i}].levels`);
      if (levels) entry.levels = levels;
      return entry;
    });
  }

  out.expand = asStringArray(c["expand"], "chat.expand");
  out.shape = readShape(c["shape"]);
  out.examples = readExamples(c["examples"]);
  out.judge = readChatJudge(c["judge"]);
  if (c["failOn"] !== undefined) {
    const f = c["failOn"];
    if (f !== "error" && f !== "warn" && f !== "never") {
      throw new RuleError("chat.failOn must be error, warn or never");
    }
    out.failOn = f;
  }
  // Same reader as `readability`, so a limit is validated, overridden and
  // switched off through exactly the machinery that already exists.
  out.limits = readReadability(c["limits"]);
  return out;
}

/**
 * A phrase, as a regex that matches the phrase and nothing else.
 *
 * The apostrophe is the only character that needs more than escaping. A model
 * writes "You're" and "You’re" interchangeably, and a rule that catches one
 * and not the other reports half the time while looking like it works.
 */
export function phrasePattern(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['\u2019]/g, "['\u2019]");
}

/**
 * Chat tells, compiled into ordinary rules.
 *
 * Returned separately rather than merged into `set.rules`, because these apply
 * to one channel only. A reply that opens "Great question" is a finding; a
 * document quoting that phrase is not.
 */
/**
 * The ruleset as the chat channel sees it.
 *
 * Three differences from the document ruleset, each with a reason:
 *
 *   + chat tells, which apply here and nowhere else. A reply that opens
 *     "Great question" is a finding; a document quoting the phrase is not.
 *   - `unexplained-suppression`, because a chat reply carries no waivers and
 *     nothing in it could ever be one.
 *
 * Returned compiled, so a caller cannot forget.
 */
export function chatRuleSet(set: RuleSet, level?: string): RuleSet {
  return compile({
    ...set,
    rules: [...set.rules.map((r) => ({ ...r })), ...chatRules(set, level)],
    readability: [
      ...set.readability
        .filter((r) => r.kind !== "unexplained-suppression")
        .map((r) => ({ ...r })),
      // The reply limits, which apply here and nowhere else. A document that
      // runs long is doing its job; a reply that runs long is the complaint
      // this package heard most often over seven days of transcripts.
      ...(set.chat.limits ?? []).map((r) => ({ ...r })),
    ],
    allow: [...set.allow],
  });
}

export function chatRules(set: RuleSet, level?: string): Rule[] {
  return set.chat.tells
    .filter((t) => t.severity !== "off")
    .filter((t) => level === undefined || inLevel(t, level))
    .filter((t) => t.phrases.length)
    .map((t) => {
      const body = `(?:${t.phrases.map(phrasePattern).join("|")})`;
      const rule: Rule = {
        id: t.id,
        severity: t.severity,
        // \b after the body, not before: several phrases start at the very
        // beginning of a reply where there is no preceding word character for
        // \b to sit against.
        match: t.at === "start" ? `^\\s*${body}\\b` : `\\b${body}\\b`,
        unless: [],
      };
      if (t.message) rule.message = t.message;
      return rule;
    });
}

function parseSet(text: string, where: string): RawSet {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new RuleError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || typeof doc !== "object") {
    throw new RuleError(`${where}: expected a YAML mapping`);
  }
  const raw = doc as RawSet;
  if (raw.version !== 1) {
    throw new RuleError(`${where}: version must be 1 (got ${String(raw.version)})`);
  }
  rejectUnknownKeys(raw as Record<string, unknown>, where);
  return raw;
}

/**
 * Keys a ruleset or project config may carry. Mirrors rules/schema.json.
 *
 * Exported so a test can hold the two sides together. The schema drifted for
 * three releases without `failOn` or `readability`, and since it is
 * `additionalProperties: false` it would have rejected this repo's own config
 * had anything been validating against it.
 */
export const KNOWN_TOP_LEVEL = new Set([
  "version",
  "extends",
  "meta",
  "allow",
  "exclude",
  "failOn",
  "punctuation",
  "rules",
  "readability",
  "structures",
  "chat",
  "docs",
]);

/** Levenshtein distance, used only to suggest the key the author meant. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length]!;
}

/**
 * A typo'd key used to be accepted in silence, so `allowlist:` for `allow:`
 * looked like it worked and suppressed nothing. Erroring here, with a
 * suggestion, is the whole value of shipping a schema.
 */
function rejectUnknownKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (KNOWN_TOP_LEVEL.has(key)) continue;
    const lower = key.toLowerCase();
    // A prefix relationship catches the common shape of this typo, where
    // someone writes `allowlist` or `excludes` for `allow` and `exclude`.
    // Edit distance alone misses `allowlist` -> `allow`, which is 4 apart.
    const near =
      [...KNOWN_TOP_LEVEL]
        .filter((k) => lower.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(lower))
        .sort((a, b) => b.length - a.length)
        .map((k) => [k, 0] as const)[0] ??
      [...KNOWN_TOP_LEVEL]
        .map((k) => [k, editDistance(lower, k.toLowerCase())] as const)
        .filter(([, d]) => d <= 3)
        .sort((x, y) => x[1] - y[1])[0];
    throw new RuleError(
      `${where}: unknown key '${key}'` +
        (near ? `. Did you mean '${near[0]}'?` : "") +
        `\n  Valid keys: ${[...KNOWN_TOP_LEVEL].sort().join(", ")}`,
    );
  }
}

function toRuleSet(raw: RawSet): RuleSet {
  const meta = raw.meta ?? {};
  const failOn = (raw as { failOn?: unknown }).failOn;
  if (failOn !== undefined && !["error", "warn", "never"].includes(String(failOn))) {
    throw new RuleError(`failOn must be error, warn or never (got ${String(failOn)})`);
  }
  return {
    version: 1,
    failOn: (failOn as FailOn) ?? "never",
    meta: {
      title: typeof meta.title === "string" ? meta.title : "Writing style",
      intro: typeof meta.intro === "string" ? meta.intro : "",
    },
    // Punctuation and word rules share a namespace once loaded. They are split
    // in the file only so the generated docs can group them.
    rules: [...readRules(raw.punctuation, "punctuation"), ...readRules(raw.rules, "rules")],
    readability: readReadability(raw.readability),
    structures: readStructures(raw.structures),
    chat: readChat(raw.chat),
    docs: readDocs((raw as { docs?: unknown }).docs),
    allow: readAllow(raw.allow),
    exclude: asStringArray(raw.exclude, "exclude"),
  };
}

/** Load the built-in ruleset. */
export function loadDefault(): RuleSet {
  const path = defaultRulesPath();
  return toRuleSet(parseSet(readFileSync(path, "utf8"), path));
}

/**
 * Merge a project config over a base.
 *
 * A project entry with the same id overrides the base entry field by field, so
 * `- id: showcase\n  severity: warn` changes only the severity and keeps the
 * upstream regex and message.
 */
export function merge(base: RuleSet, overlay: RuleSet): RuleSet {
  const byId = new Map(base.rules.map((r) => [r.id, { ...r }]));
  for (const r of overlay.rules) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.severity = r.severity;
      if (r.match) existing.match = r.match;
      if (r.unless && r.unless.length) existing.unless = r.unless;
      if (r.message) existing.message = r.message;
      if (r.link) existing.link = r.link;
      if (r.perThousandWords !== undefined) existing.perThousandWords = r.perThousandWords;
      if (r.reason) existing.reason = r.reason;
    } else {
      if (!r.match) {
        throw new RuleError(`rule '${r.id}' is new to this config and needs a 'match'`);
      }
      byId.set(r.id, { ...r });
    }
  }
  const structures = new Map(base.structures.map((s) => [s.id, s]));
  for (const s of overlay.structures) structures.set(s.id, s);

  const readability = new Map(base.readability.map((r) => [r.id, { ...r }]));
  for (const r of overlay.readability) {
    const existing = readability.get(r.id);
    if (existing) {
      existing.severity = r.severity;
      if (r.maxWords !== undefined) existing.maxWords = r.maxWords;
      // A project's `known` list adds to the defaults instead of replacing
      // them, so nobody has to restate "GitHub" to add their own terms.
      if (r.known?.length) existing.known = [...(existing.known ?? []), ...r.known];
      if (r.emphasis?.length) {
        existing.emphasis = [...(existing.emphasis ?? []), ...r.emphasis];
      }
      if (r.message) existing.message = r.message;
      if (r.link) existing.link = r.link;
      if (r.reason) existing.reason = r.reason;
    } else {
      if (!r.kind) {
        throw new RuleError(`readability rule '${r.id}' is new to this config and needs a 'kind'`);
      }
      if (r.kind === "long-sentence" && r.maxWords === undefined) {
        throw new RuleError(`readability rule '${r.id}': long-sentence needs maxWords`);
      }
      readability.set(r.id, { ...r });
    }
  }

  return {
    version: 1,
    failOn: overlay.failOn ?? base.failOn,
    meta: overlay.meta.title ? overlay.meta : base.meta,
    rules: [...byId.values()],
    readability: [...readability.values()],
    structures: [...structures.values()],
    chat: mergeChat(base.chat, overlay.chat),
    docs: mergeDocs(base.docs, overlay.docs),
    allow: [...base.allow, ...overlay.allow],
    exclude: [...base.exclude, ...overlay.exclude],
  };
}

/**
 * Merge one docs section over another.
 *
 * By id, like `mergeChat` does for guidance, and deliberately not wholesale
 * the way `avoid` and `expand` are merged. Replacing the list would mean
 * restating all of it to change one rule, which is how a list stops tracking
 * the one it was copied from.
 */
function mergeDocs(base: DocsSection | undefined, overlay: DocsSection | undefined): DocsSection {
  const b = base ?? EMPTY_DOCS;
  if (!overlay) return { ...b, skill: { ...b.skill }, guidance: b.guidance.map((g) => ({ ...g })) };

  const guidance = new Map(b.guidance.map((g) => [g.id, { ...g }]));
  for (const g of overlay.guidance) {
    const existing = guidance.get(g.id);
    if (!existing) {
      guidance.set(g.id, { ...g });
      continue;
    }
    for (const k of ["name", "description", "short", "flag", "bad", "good", "reason"] as const) {
      if (g[k]) existing[k] = g[k];
    }
  }

  return {
    scope: overlay.scope || b.scope,
    skill: {
      name: overlay.skill.name || b.skill.name,
      description: overlay.skill.description || b.skill.description,
    },
    guidance: [...guidance.values()],
  };
}

/**
 * Merge one chat section over another.
 *
 * Field by field on a matching id, the same idiom the word rules use, so
 * `- id: time-estimates\n  levels: []` moves one section out of every level
 * and keeps its wording. `levels: []` is meaningful and `undefined` is not, so
 * the check is for presence rather than for length.
 */
function mergeChat(base: ChatSection, overlay: ChatSection): ChatSection {
  const guidance = new Map(base.guidance.map((g) => [g.id, { ...g }]));
  for (const g of overlay.guidance) {
    const existing = guidance.get(g.id);
    if (!existing) {
      guidance.set(g.id, { ...g });
      continue;
    }
    for (const k of ["name", "description", "short", "bad", "good", "reason"] as const) {
      if (g[k]) existing[k] = g[k];
    }
    if (g.levels !== undefined) existing.levels = g.levels;
  }

  const tells = new Map(base.tells.map((t) => [t.id, { ...t }]));
  for (const t of overlay.tells) {
    const existing = tells.get(t.id);
    if (!existing) {
      if (!t.phrases.length) {
        throw new RuleError(`chat tell '${t.id}' is new to this config and needs 'phrases'`);
      }
      tells.set(t.id, { ...t });
      continue;
    }
    existing.severity = t.severity;
    // A project's phrases add to the defaults, the way `known` does on
    // unglossed-term. Replacing them would mean restating the shipped list to
    // add one phrase, which is how a list stops tracking upstream.
    if (t.phrases.length) existing.phrases = [...existing.phrases, ...t.phrases];
    if (t.message) existing.message = t.message;
    if (t.reason) existing.reason = t.reason;
    if (t.levels !== undefined) existing.levels = t.levels;
  }

  // A project overrides a threshold or switches a limit off by id, the same
  // way it overrides a readability rule. Anything new needs a `kind`, which
  // `readReadability` has already checked.
  // `?? []` on both sides, matching the note in `readabilityFindings`: a chat
  // section hand-assembled by a consumer, or written before 0.12.0, reaches
  // here without this key. That is an older config, not a reason to throw.
  const limits = new Map((base.limits ?? []).map((l) => [l.id, { ...l }]));
  for (const l of overlay.limits ?? []) {
    const existing = limits.get(l.id);
    if (!existing) {
      if (!l.kind) {
        throw new RuleError(`chat limit '${l.id}' is new to this config and needs a 'kind'`);
      }
      limits.set(l.id, { ...l });
      continue;
    }
    existing.severity = l.severity;
    if (l.maxWords !== undefined) existing.maxWords = l.maxWords;
    if (l.maxTerms !== undefined) existing.maxTerms = l.maxTerms;
    if (l.maxClauses !== undefined) existing.maxClauses = l.maxClauses;
    if (l.maxMeanWords !== undefined) existing.maxMeanWords = l.maxMeanWords;
    if (l.minWords !== undefined) existing.minWords = l.minWords;
    if (l.message) existing.message = l.message;
    if (l.reason) existing.reason = l.reason;
  }

  return {
    scope: overlay.scope || base.scope,
    level: overlay.level || base.level,
    levels: overlay.levels.length ? overlay.levels : base.levels,
    guidance: [...guidance.values()],
    tells: [...tells.values()],
    avoid: overlay.avoid.length ? overlay.avoid : base.avoid,
    expand: overlay.expand.length ? overlay.expand : base.expand,
    // Nullish, like `limits` above and for the same reason: a chat section
    // hand-assembled by a consumer, or written before this key existed, reaches
    // here without it. That is an older config, not a reason to throw.
    // Wholesale, like `avoid` and `expand`. An example is one unit and half of
    // one is nonsense, and a skeleton a project half-overrode would render as
    // two shapes disagreeing with each other.
    shape: overlay.shape ?? base.shape,
    examples: overlay.examples?.length ? overlay.examples : (base.examples ?? []),
    judge: overlay.judge?.length ? overlay.judge : (base.judge ?? []),
    ...(overlay.failOn ?? base.failOn ? { failOn: overlay.failOn ?? base.failOn } : {}),
    limits: [...limits.values()],
  };
}

/** Load a project config, resolving `extends`. */
export function loadConfig(path: string): RuleSet {
  const raw = parseSet(readFileSync(path, "utf8"), path);
  const overlay = toRuleSet(raw);
  const ext = raw.extends;
  if (ext === undefined || ext === "default") {
    return merge(loadDefault(), overlay);
  }
  if (typeof ext !== "string") throw new RuleError(`${path}: extends must be a string`);
  const basePath = isAbsolute(ext) ? ext : resolve(dirname(path), ext);
  return merge(loadConfig(basePath), overlay);
}

/**
 * Find and load the ruleset for a directory: `.plain-english.yml` if present
 * anywhere from `from` up to the filesystem root, otherwise the built-in set.
 */
export function resolveRuleSet(from: string): RuleSet {
  let dir = resolve(from);
  for (;;) {
    for (const name of [".plain-english.yml", ".plain-english.yaml"]) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return compile(loadConfig(candidate));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return compile(loadDefault());
}

/**
 * Compile every regex once. Throws on an invalid or unsafe pattern, naming the
 * rule so the author knows which line of their config to fix.
 */
export function compile(set: RuleSet): RuleSet {
  const guard = (source: string, where: string) => {
    const unsafe = findUnsafe(source);
    if (unsafe) {
      throw new RuleError(
        `${where}: pattern ${JSON.stringify(source)} can backtrack catastrophically ` +
          `(${unsafe.kind}: ${unsafe.detail}).\n` +
          `  This would hang the linter. Rewrite it without the nested repeat, ` +
          `for example (a+)+ as a+ .`,
      );
    }
  };

  for (const rule of set.rules) {
    if (rule.severity === "off" || !rule.match) continue;
    guard(rule.match, `rule '${rule.id}'`);
    try {
      rule.re = new RegExp(rule.match, "gi");
    } catch (e) {
      throw new RuleError(
        `rule '${rule.id}': invalid regex ${JSON.stringify(rule.match)}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    rule.unlessRe = (rule.unless ?? []).map((u, i) => {
      guard(u, `rule '${rule.id}' unless[${i}]`);
      try {
        return new RegExp(u, "i");
      } catch (e) {
        throw new RuleError(
          `rule '${rule.id}': invalid unless[${i}] ${JSON.stringify(u)}: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    });
  }
  // Every id an `allow` entry may legitimately name. The chat tells compile
  // into rules of their own later, so they belong here too.
  // Defensive on every list: `compile` is public, and a ruleset assembled by a
  // consumer rather than loaded from YAML may carry only the sections it uses.
  const ids = new Set([
    ...(set.rules ?? []).map((r) => r.id),
    ...(set.readability ?? []).map((r) => r.id),
    ...(set.chat?.tells ?? []).map((t) => t.id),
    ...(set.chat?.limits ?? []).map((r) => r.id),
  ]);

  // A bare string reaching here means a caller built the ruleset by hand
  // rather than loading it, which the public API allows. Normalise instead of
  // rejecting: the string form is still the language, it just came in raw.
  set.allow = (set.allow ?? []).map((a) =>
    typeof a === "string" ? { pattern: a as string } : a,
  );

  set.allowRe = set.allow.map((a, i) => {
    guard(a.pattern, `allow[${i}]`);
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, "i");
    } catch (e) {
      throw new RuleError(
        `allow[${i}]: invalid regex ${JSON.stringify(a.pattern)}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    const compiled: CompiledAllow = { entry: a, re };
    // An empty list is the same as no list. Writing `rules: []` and getting an
    // entry that silences nothing at all would be a trap of its own.
    if (a.rules?.length) compiled.rules = new Set(a.rules);
    // A misspelled rule id reaches nothing and says nothing, which is the
    // failure this whole key exists to end. Same argument as the unknown-key
    // error at the top level.
    for (const id of a.rules ?? []) {
      if (!ids.has(id)) {
        throw new RuleError(
          `allow[${i}].rules: no rule called '${id}'.\n` +
            `  Run 'plain-english explain' to list the rule ids.`,
        );
      }
    }
    return compiled;
  });
  return set;
}
