/**
 * Linting files and directories, shared by the CLI's `lint` and the Claude
 * Code plugin's `/plain-english` (ADR-008). Files come through an io; the
 * caller supplies the scan, so the CLI's source-prose parser stays out of the
 * plugin.
 */
import type { Finding, Suppression } from "./lint.ts";
import { matchesAny } from "./glob.ts";
import type { CheckerIo } from "./io.ts";
import type { RuleSet } from "./rules.ts";

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const SKIPPED = new Set(["node_modules", ".git", "dist"]);

export interface ScanResult {
  findings: Finding[];
  timedOut: string[];
  suppressed: Suppression[];
}

export interface FileFindings {
  file: string;
  findings: Finding[];
}

/** What `existsSync` and `statSync` answer: the path, following a final link. */
function followed(path: string, io: CheckerIo) {
  const facts = io.stat(path);
  if (facts?.kind !== "link") return facts;
  return facts.realPath === undefined ? undefined : io.stat(facts.realPath);
}

/** Every Markdown file at or under `target`, plus `extraExtensions` when given. */
export function walkTarget(target: string, io: CheckerIo, extraExtensions?: ReadonlySet<string>, out: string[] = []): string[] {
  if (followed(target, io)?.kind === "file") {
    out.push(target);
    return out;
  }
  for (const name of io.list(target) ?? []) {
    if (SKIPPED.has(name)) continue;
    const full = io.path.resolve(target, name);
    // A directory entry's own type: a link is neither a file nor a directory.
    if (io.stat(full)?.kind === "directory") walkTarget(full, io, extraExtensions, out);
    else {
      const extension = io.path.extname(name).toLowerCase();
      if (MARKDOWN.has(extension) || extraExtensions?.has(extension)) out.push(full);
    }
  }
  return out;
}

export interface LintedTargets {
  all: FileFindings[];
  /** Rules that ran out of match budget, by file. */
  stalled: Map<string, Set<string>>;
  suppressed: Suppression[];
}

/**
 * Lint each target under `root`, skipping the project's excluded paths.
 * Returns the first target that does not exist instead, as the CLI exits 2
 * on it.
 */
export function lintTargets(
  targets: string[],
  root: string,
  ruleSet: RuleSet,
  scan: (text: string, file: string) => ScanResult,
  io: CheckerIo,
  extraExtensions?: ReadonlySet<string>,
): LintedTargets | { missing: string } {
  const out: LintedTargets = { all: [], stalled: new Map(), suppressed: [] };
  for (const target of targets) {
    const abs = io.path.resolve(io.cwd, root, target);
    if (followed(abs, io) === undefined) return { missing: target };
    for (const file of walkTarget(abs, io, extraExtensions)) {
      const rel = io.path.relative(root, file);
      if (matchesAny(rel, ruleSet.exclude)) continue;
      const res = scan(io.read(file) ?? "", file);
      if (res.timedOut.length) out.stalled.set(file, new Set(res.timedOut));
      out.suppressed.push(...res.suppressed);
      out.all.push({ file, findings: res.findings });
    }
  }
  return out;
}

export interface TextStyle {
  red(text: string): string;
  yellow(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const PLAIN: TextStyle = { red: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };

/** The `text` format: findings under each file's name, then a count. */
export function formatText(all: FileFindings[], root: string, unit: string, io: CheckerIo, style: TextStyle = PLAIN): string {
  let out = "";
  for (const { file, findings } of all) {
    if (!findings.length) continue;
    out += style.bold(io.path.relative(root, file) || file) + "\n";
    for (const f of findings) {
      const tag = f.severity === "error" ? style.red("block") : style.yellow(" warn");
      const hint = f.message ? style.dim(`  ${f.message}`) : "";
      out += `  ${String(f.line).padStart(4)}:${String(f.column).padEnd(3)} ${tag}  ` +
        `${JSON.stringify(f.match)} ${style.dim(`(${f.ruleId})`)}${hint}\n`;
      if (f.link) out += style.dim(`         ${f.link}\n`);
    }
    out += "\n";
  }
  const errors = countOf(all, "error");
  const warns = countOf(all, "warn");
  const scanned = all.length;
  if (errors || warns) {
    out += `${errors} blocking, ${warns} warning${warns === 1 ? "" : "s"} across ${scanned} ${unit}${scanned === 1 ? "" : "s"}\n`;
  } else {
    out += style.dim(`clean (${scanned} ${unit}${scanned === 1 ? "" : "s"})\n`);
  }
  return out;
}

export function countOf(all: FileFindings[], severity: "error" | "warn"): number {
  return all.reduce((n, f) => n + f.findings.filter((x) => x.severity === severity).length, 0);
}

/** The one line that says `allow` hid something, without listing it. */
export function suppressedLine(suppressed: Suppression[], style: TextStyle = PLAIN): string {
  if (!suppressed.length) return "";
  return style.dim(
    `${suppressed.length} finding${suppressed.length === 1 ? "" : "s"} hidden by allow ` +
      `(--show-suppressed for which)\n`,
  );
}

/** One standard-error line per file whose rules ran out of match budget. */
export function stalledNotes(stalled: Map<string, Set<string>>, root: string, io: CheckerIo): string[] {
  return [...stalled].map(([file, ids]) =>
    `plain-english: match budget exhausted on ${io.path.relative(root, file)}; ` +
      `these rules did not run: ${[...ids].sort().join(", ")}`);
}

/** The exit code `failOn` gives these counts. */
export function exitFor(failOn: string, errors: number, warns: number): number {
  if (failOn === "warn") return errors + warns > 0 ? 1 : 0;
  if (failOn === "never") return 0;
  return errors > 0 ? 1 : 0;
}
