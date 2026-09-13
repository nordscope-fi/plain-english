import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { matchesAny } from "./glob.ts";
import { maskNonProse } from "./mask.ts";
import { sentences } from "./sentences.ts";
import type { WritingProfileConfig } from "./rules.ts";

export const PROFILE_GENRES = ["chat", "technical-doc", "decision", "status", "email", "repository"] as const;

type Metric = { value: number; stable: boolean };
type ObservedValue = { value: string; count: number; stable: boolean };
type Approval = "connectives" | "domainTerms";
type GenreResult = {
  status: "stable" | "mixed" | "insufficient";
  files: number;
  words: number;
  sentences: number;
  spelling: { value: "us" | "uk" | "mixed" | "unknown"; stable: boolean };
  sentenceWords: { p10: number; median: number; p90: number; cv: number; stable: boolean };
  paragraphSentences: { p10: number; median: number; p90: number; stable: boolean };
  headingTitleCase: Metric;
  listLineRate: Metric;
  directAddressPerThousand: Metric;
  punctuationPerThousand: { emDash: Metric; semicolon: Metric; parentheses: Metric };
  connectives: ObservedValue[];
  domainTerms: ObservedValue[];
};

export interface WritingProfile {
  version: 1;
  sourceHash: string;
  sources: Record<string, string[]>;
  genres: Record<string, GenreResult>;
  approvals: Record<string, Approval[]>;
  preferences: Record<string, unknown>;
}

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const SPELLINGS: Array<[RegExp, RegExp]> = [
  [/\bcolor\b/giu, /\bcolour\b/giu], [/\bbehavior\b/giu, /\bbehaviour\b/giu],
  [/\borganize\b/giu, /\borganise\b/giu], [/\bcenter\b/giu, /\bcentre\b/giu],
  [/\blicense\b/giu, /\blicence\b/giu], [/\banalyze\b/giu, /\banalyse\b/giu],
];
const CONNECTIVES = [
  "for example", "for instance", "in practice", "as a result", "however", "therefore",
  "instead", "because", "still", "then", "also", "so", "but", "yet",
];
const DOMAIN_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "another", "before", "being", "between",
  "both", "could", "each", "example", "first", "from", "have", "however", "instance", "into", "itself", "more", "most",
  "other", "over", "same", "should", "some", "such", "than", "that", "their", "them",
  "then", "there", "therefore", "these", "they", "this", "those", "through", "under", "using", "very",
  "what", "when", "where", "which", "while", "will", "with", "would", "your", "you",
]);

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile() && MARKDOWN.has(extname(entry.name).toLowerCase())) out.push(path);
  }
  return out;
}

const round = (value: number, places = 2): number => Number(value.toFixed(places));
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const rows = [...values].sort((a, b) => a - b);
  return rows[Math.min(rows.length - 1, Math.floor((rows.length - 1) * p))] ?? 0;
}
function cv(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return mean ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean : 0;
}
function close(a: number, b: number, tolerance = 0.2): boolean {
  return Math.abs(a - b) <= Math.max(0.01, Math.max(Math.abs(a), Math.abs(b)) * tolerance);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function spelling(text: string): { value: "us" | "uk" | "mixed" | "unknown"; share: number } {
  let us = 0;
  let uk = 0;
  for (const [a, b] of SPELLINGS) { us += text.match(a)?.length ?? 0; uk += text.match(b)?.length ?? 0; }
  const total = us + uk;
  if (!total) return { value: "unknown", share: 0 };
  if (us === uk) return { value: "mixed", share: 0.5 };
  return us > uk ? { value: "us", share: us / total } : { value: "uk", share: uk / total };
}

function rankedValues(files: Array<{ text: string }>, kind: "connectives" | "domainTerms"): ObservedValue[] {
  const counts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  for (const file of files) {
    const local = new Set<string>();
    if (kind === "connectives") {
      for (const sentence of sentences(file.text)) {
        const start = sentence.text.trim().toLowerCase();
        const found = CONNECTIVES.find((value) => start === value || start.startsWith(`${value},`) || start.startsWith(`${value} `));
        if (!found) continue;
        counts.set(found, (counts.get(found) ?? 0) + 1);
        local.add(found);
      }
    } else {
      const prose = maskNonProse(file.text, { maskComments: true }).toLowerCase();
      for (const term of prose.match(/\b[\p{L}][\p{L}-]{3,}\b/gu) ?? []) {
        if (DOMAIN_STOP_WORDS.has(term)) continue;
        counts.set(term, (counts.get(term) ?? 0) + 1);
        local.add(term);
      }
    }
    for (const value of local) fileCounts.set(value, (fileCounts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([value, count]) => count >= 3 && (fileCounts.get(value) ?? 0) >= 2)
    .sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
    .slice(0, 8)
    .map(([value, count]) => ({ value, count, stable: false }));
}

function stats(files: Array<{ path: string; text: string }>): Omit<GenreResult, "status"> {
  const raw = files.map((file) => file.text).join("\n\n");
  const prose = maskNonProse(raw, { maskComments: true });
  const sentenceCounts = sentences(raw).map((row) => row.words);
  const words = prose.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? [];
  const paragraphCounts = raw.split(/\n\s*\n/u).map((paragraph) => sentences(paragraph).length).filter(Boolean);
  const headings = raw.match(/^#{1,6}\s+.+$/gmu) ?? [];
  const titleHeadings = headings.filter((line) => line.replace(/^#{1,6}\s+/, "").split(/\s+/u).filter(Boolean).every((word) => /^(?:[A-Z0-9`]|a$|an$|and$|as$|at$|for$|in$|of$|on$|or$|the$|to$)/u.test(word))).length;
  const lines = raw.split("\n").filter((line) => line.trim());
  const perThousand = (count: number) => round((count / Math.max(1, words.length)) * 1000);
  const result = {
    files: files.length, words: words.length, sentences: sentenceCounts.length,
    spelling: { value: spelling(prose).value, stable: false },
    sentenceWords: { p10: percentile(sentenceCounts, 0.1), median: percentile(sentenceCounts, 0.5), p90: percentile(sentenceCounts, 0.9), cv: round(cv(sentenceCounts)), stable: false },
    paragraphSentences: { p10: percentile(paragraphCounts, 0.1), median: percentile(paragraphCounts, 0.5), p90: percentile(paragraphCounts, 0.9), stable: false },
    headingTitleCase: { value: headings.length ? round(titleHeadings / headings.length) : 0, stable: false },
    listLineRate: { value: lines.length ? round(lines.filter((line) => /^\s*(?:[-*+] |\d+[.)] )/u.test(line)).length / lines.length) : 0, stable: false },
    directAddressPerThousand: { value: perThousand(words.filter((word) => /^(?:you|your|yours|yourself)$/iu.test(word)).length), stable: false },
    punctuationPerThousand: {
      emDash: { value: perThousand(raw.match(/—/gu)?.length ?? 0), stable: false },
      semicolon: { value: perThousand(raw.match(/;/gu)?.length ?? 0), stable: false },
      parentheses: { value: perThousand(raw.match(/[()]/gu)?.length ?? 0), stable: false },
    },
    connectives: rankedValues(files, "connectives"),
    domainTerms: rankedValues(files, "domainTerms"),
  };
  return result;
}

function genre(files: Array<{ path: string; text: string }>): GenreResult {
  const result = stats(files);
  const halves = [0, 1].map((side) => stats(files.filter((file) => Number.parseInt(hash(file.path).slice(0, 2), 16) % 2 === side)));
  if (files.length < 2 || result.words < 1000 || halves.some((half) => half.sentences < 20)) return { status: "insufficient", ...result };
  const [a, b] = halves as [ReturnType<typeof stats>, ReturnType<typeof stats>];
  const aSpell = spelling(files.filter((file) => Number.parseInt(hash(file.path).slice(0, 2), 16) % 2 === 0).map((file) => file.text).join("\n"));
  const bSpell = spelling(files.filter((file) => Number.parseInt(hash(file.path).slice(0, 2), 16) % 2 === 1).map((file) => file.text).join("\n"));
  result.spelling.stable = aSpell.value === bSpell.value && ["us", "uk"].includes(aSpell.value) && aSpell.share >= 0.8 && bSpell.share >= 0.8;
  result.sentenceWords.stable = close(a.sentenceWords.median, b.sentenceWords.median) && Math.abs(a.sentenceWords.cv - b.sentenceWords.cv) <= 0.1;
  result.paragraphSentences.stable = close(a.paragraphSentences.median, b.paragraphSentences.median);
  for (const key of ["headingTitleCase", "listLineRate", "directAddressPerThousand"] as const) result[key].stable = close(a[key].value, b[key].value);
  for (const key of ["emDash", "semicolon", "parentheses"] as const) result.punctuationPerThousand[key].stable = close(a.punctuationPerThousand[key].value, b.punctuationPerThousand[key].value);
  for (const key of ["connectives", "domainTerms"] as const) {
    const aValues = new Set(a[key].map((item) => item.value));
    const bValues = new Set(b[key].map((item) => item.value));
    for (const item of result[key]) item.stable = aValues.has(item.value) && bValues.has(item.value);
  }
  const stable = [result.spelling.stable, result.sentenceWords.stable, result.paragraphSentences.stable].filter(Boolean).length >= 2;
  return { status: stable ? "stable" : "mixed", ...result };
}

export function buildWritingProfile(root: string, config: WritingProfileConfig, existing = ""): WritingProfile {
  const all = walk(root).map((path) => ({ path: relative(root, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
  const sources: Record<string, string[]> = {};
  const genres: Record<string, GenreResult> = {};
  for (const [name, patterns] of Object.entries(config.samples).sort(([a], [b]) => a.localeCompare(b))) {
    const selected = all.filter((file) => matchesAny(file.path, patterns)).sort((a, b) => a.path.localeCompare(b.path));
    sources[name] = selected.map((file) => file.path);
    genres[name] = genre(selected);
  }
  let preferences: Record<string, unknown> = {};
  let approvals: Record<string, Approval[]> = {};
  if (existing.trim()) {
    const parsed = parseYaml(existing) as { approvals?: unknown; preferences?: unknown } | null;
    if (parsed?.preferences && typeof parsed.preferences === "object" && !Array.isArray(parsed.preferences)) preferences = parsed.preferences as Record<string, unknown>;
    if (parsed?.approvals && typeof parsed.approvals === "object" && !Array.isArray(parsed.approvals)) {
      for (const [name, fields] of Object.entries(parsed.approvals)) {
        if (!Array.isArray(fields)) continue;
        approvals[name] = fields.filter((field): field is Approval => field === "connectives" || field === "domainTerms");
      }
    }
  }
  const sourceHash = hash(Object.entries(sources).flatMap(([, paths]) => paths.map((path) => `${path}\0${readFileSync(resolve(root, path), "utf8")}`)).join("\0"));
  return { version: 1, sourceHash, sources, genres, approvals, preferences };
}

export function writingProfileYaml(profile: WritingProfile): string { return stringifyYaml(profile, { lineWidth: 0 }); }

export function readWritingProfile(path: string): WritingProfile | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const parsed = parseYaml(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return undefined;
  return parsed as WritingProfile;
}

export function writingProfileGuidance(profile: WritingProfile): string[] {
  const out: string[] = [];
  for (const [name, row] of Object.entries(profile.genres)) {
    if (row.status !== "stable") continue;
    const parts: string[] = [];
    if (row.spelling.stable && row.spelling.value !== "mixed" && row.spelling.value !== "unknown") parts.push(`uses ${row.spelling.value.toUpperCase()} spelling`);
    if (row.sentenceWords.stable) parts.push(`usually keeps sentences between ${row.sentenceWords.p10} and ${row.sentenceWords.p90} words`);
    if (row.paragraphSentences.stable) parts.push(`usually keeps paragraphs between ${row.paragraphSentences.p10} and ${row.paragraphSentences.p90} sentences`);
    if (row.headingTitleCase.stable) parts.push(row.headingTitleCase.value >= 0.8 ? "uses title case headings" : row.headingTitleCase.value <= 0.2 ? "uses sentence case headings" : `uses title case for ${Math.round(row.headingTitleCase.value * 100)}% of headings`);
    if (row.listLineRate.stable) parts.push(`${Math.round(row.listLineRate.value * 100)}% of non-empty lines are list items`);
    if (row.directAddressPerThousand.stable) parts.push(`uses direct address ${row.directAddressPerThousand.value} times per 1,000 words`);
    const punctuation = Object.entries(row.punctuationPerThousand).filter(([, metric]) => metric.stable).map(([mark, metric]) => `${mark} ${metric.value}`).join(", ");
    if (punctuation) parts.push(`punctuation per 1,000 words: ${punctuation}`);
    const approved = new Set(profile.approvals?.[name] ?? []);
    if (approved.has("connectives")) {
      const values = row.connectives.filter((item) => item.stable).map((item) => item.value);
      if (values.length) parts.push(`often starts sentences with ${values.join(", ")}`);
    }
    if (approved.has("domainTerms")) {
      const values = row.domainTerms.filter((item) => item.stable).map((item) => item.value);
      if (values.length) parts.push(`uses these recurring project terms: ${values.join(", ")}`);
    }
    for (const part of parts) out.push(`${name}: ${part}.`);
  }
  for (const [key, value] of Object.entries(profile.preferences)) out.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return out;
}

export function approveWritingProfile(profile: WritingProfile, value: string): WritingProfile {
  const approvals = Object.fromEntries(Object.entries(profile.approvals ?? {}).map(([genre, fields]) => [genre, [...fields]])) as Record<string, Approval[]>;
  for (const selector of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [genre, field, ...rest] = selector.split(":");
    if (rest.length || !genre || (field !== "connectives" && field !== "domainTerms")) {
      throw new Error(`unknown profile approval: ${selector}`);
    }
    const row = profile.genres[genre];
    if (!row) throw new Error(`unknown profile genre: ${genre}`);
    if (!row[field].some((item) => item.stable)) throw new Error(`profile approval has no stable values: ${selector}`);
    approvals[genre] = [...new Set([...(approvals[genre] ?? []), field])].sort() as Approval[];
  }
  return { ...profile, approvals };
}
