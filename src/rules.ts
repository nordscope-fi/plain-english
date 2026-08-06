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
  /** Compiled lazily by `compile`. */
  re?: RegExp;
  unlessRe?: RegExp[];
}

export interface Structure {
  id: string;
  name: string;
  description: string;
  bad?: string;
  good?: string;
}

export interface RuleSet {
  version: 1;
  meta: { title: string; intro: string };
  rules: Rule[];
  structures: Structure[];
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
}

interface RawSet {
  version?: unknown;
  extends?: unknown;
  meta?: { title?: unknown; intro?: unknown };
  punctuation?: unknown;
  rules?: unknown;
  structures?: unknown;
  allow?: unknown;
  exclude?: unknown;
}

export class RuleError extends Error {}

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
    if (typeof r.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) {
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
    return rule;
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

/** Keys a ruleset or project config may carry. Mirrors rules/schema.json. */
const KNOWN_TOP_LEVEL = new Set([
  "version",
  "extends",
  "meta",
  "allow",
  "exclude",
  "failOn",
  "punctuation",
  "rules",
  "structures",
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
  return {
    version: 1,
    meta: {
      title: typeof meta.title === "string" ? meta.title : "Writing style",
      intro: typeof meta.intro === "string" ? meta.intro : "",
    },
    // Punctuation and word rules share a namespace once loaded. They are split
    // in the file only so the generated docs can group them.
    rules: [...readRules(raw.punctuation, "punctuation"), ...readRules(raw.rules, "rules")],
    structures: readStructures(raw.structures),
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
    } else {
      if (!r.match) {
        throw new RuleError(`rule '${r.id}' is new to this config and needs a 'match'`);
      }
      byId.set(r.id, { ...r });
    }
  }
  const structures = new Map(base.structures.map((s) => [s.id, s]));
  for (const s of overlay.structures) structures.set(s.id, s);

  return {
    version: 1,
    meta: overlay.meta.title ? overlay.meta : base.meta,
    rules: [...byId.values()],
    structures: [...structures.values()],
    allow: [...base.allow, ...overlay.allow],
    exclude: [...base.exclude, ...overlay.exclude],
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
