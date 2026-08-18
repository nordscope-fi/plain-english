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
  | "unexplained-suppression";

/** A rule measured over sentence structure rather than matched at a point. */
export interface ReadabilityRule {
  id: string;
  severity: Severity;
  /**
   * Absent only in an unmerged overlay, where a project overrides a rule the
   * base already defines. `merge` requires it of an id the base does not know.
   */
  kind?: ReadabilityKind;
  /** long-sentence only: words above which the rule fires. */
  maxWords?: number;
  /**
   * unglossed-term only: names a reader already knows.
   *
   * Separate from the shared `allow` list on purpose. `allow` suppresses every
   * rule on a matching line, so putting "GitHub" there would also silence an
   * em dash on any line that mentions GitHub.
   */
  known?: string[];
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
  bad?: string;
  good?: string;
  reason?: string;
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
}

/** True when a levelled entry belongs in `level`. */
export function inLevel(entry: Levelled, level: string): boolean {
  return entry.levels === undefined || entry.levels.includes(level);
}

export type FailOn = "error" | "warn" | "never";

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
   * The chat channel.
   *
   * Separate from everything above because it is the one channel whose text is
   * read once, by one person, mid-task. The rules that make a chat reply
   * readable would make a commit message useless, so they cannot share a list.
   */
  chat: ChatSection;
  allow: string[];
  exclude: string[];
  /** Compiled from `allow`. */
  allowRe?: RegExp[];
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
  const KINDS = ["unglossed-term", "long-sentence", "unexplained-suppression"];
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
    if (Array.isArray(r["known"])) {
      out.known = (r["known"] as unknown[]).map((k, j) => {
        if (typeof k !== "string") {
          throw new RuleError(`readability[${i}] (${r["id"]}).known[${j}] must be a string`);
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
};

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
      for (const k of ["name", "description", "bad", "good", "reason"] as const) {
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
    readability: set.readability
      .filter((r) => r.kind !== "unexplained-suppression")
      .map((r) => ({ ...r })),
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
    allow: asStringArray(raw.allow, "allow"),
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
    allow: [...base.allow, ...overlay.allow],
    exclude: [...base.exclude, ...overlay.exclude],
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
    for (const k of ["name", "description", "bad", "good", "reason"] as const) {
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

  return {
    scope: overlay.scope || base.scope,
    level: overlay.level || base.level,
    levels: overlay.levels.length ? overlay.levels : base.levels,
    guidance: [...guidance.values()],
    tells: [...tells.values()],
    avoid: overlay.avoid.length ? overlay.avoid : base.avoid,
    expand: overlay.expand.length ? overlay.expand : base.expand,
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
  set.allowRe = set.allow.map((a, i) => {
    guard(a, `allow[${i}]`);
    try {
      return new RegExp(a, "i");
    } catch (e) {
      throw new RuleError(
        `allow[${i}]: invalid regex ${JSON.stringify(a)}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  });
  return set;
}
