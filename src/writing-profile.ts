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
};

export interface WritingProfile {
  version: 1;
  sourceHash: string;
  sources: Record<string, string[]>;
  genres: Record<string, GenreResult>;
  preferences: Record<string, unknown>;
}

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const SPELLINGS: Array<[RegExp, RegExp]> = [
  [/\bcolor\b/giu, /\bcolour\b/giu], [/\bbehavior\b/giu, /\bbehaviour\b/giu],
  [/\borganize\b/giu, /\borganise\b/giu], [/\bcenter\b/giu, /\bcentre\b/giu],
  [/\blicense\b/giu, /\blicence\b/giu], [/\banalyze\b/giu, /\banalyse\b/giu],
];

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
  if (existing.trim()) {
    const parsed = parseYaml(existing) as { preferences?: unknown } | null;
    if (parsed?.preferences && typeof parsed.preferences === "object" && !Array.isArray(parsed.preferences)) preferences = parsed.preferences as Record<string, unknown>;
  }
  const sourceHash = hash(Object.entries(sources).flatMap(([, paths]) => paths.map((path) => `${path}\0${readFileSync(resolve(root, path), "utf8")}`)).join("\0"));
  return { version: 1, sourceHash, sources, genres, preferences };
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
    for (const part of parts) out.push(`${name}: ${part}.`);
  }
  for (const [key, value] of Object.entries(profile.preferences)) out.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return out;
}
