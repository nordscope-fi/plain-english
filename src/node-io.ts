/**
 * The checker's `io` backed by Node, for the CLI (ADR-008). The only module on
 * the core's paths that imports from `node:`; the plugin build swaps it for a
 * stub, and the mod passes its own `io` everywhere.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckerIo, FileFacts } from "./io.ts";
import type { PathApi } from "./paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the built-in ruleset lives, both from src/ and from dist/. */
export function defaultRulesPath(): string {
  for (const p of [path.resolve(HERE, "..", "rules", "default.yml"), path.resolve(HERE, "..", "..", "rules", "default.yml")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("built-in ruleset not found (rules/default.yml)");
}

const missing = (error: unknown) => {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Where a state value lives: one file in the temporary folder, because each
 * CLI run is a new process. Its modification time is when it was set.
 */
export function nodeStatePath(key: string): string {
  return path.resolve(tmpdir(), key);
}

export const nodeIo: CheckerIo = {
  get cwd() { return process.cwd(); },
  path: path as unknown as PathApi,
  env: process.env,
  get home() { return homedir(); },
  now: () => Date.now(),
  notice: (text) => { process.stderr.write(`${text}\n`); },
  read(file) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  stat(file): FileFacts | undefined {
    try {
      const facts = lstatSync(file);
      let realPath: string | undefined;
      try { realPath = realpathSync(file); } catch { /* a dangling link resolves to nothing */ }
      return {
        kind: facts.isSymbolicLink() ? "link" : facts.isFile() ? "file" : facts.isDirectory() ? "directory" : "other",
        mtimeMs: facts.mtimeMs,
        ...(realPath === undefined ? {} : { realPath }),
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  state: {
    get(key) {
      try {
        const file = nodeStatePath(key);
        return { at: statSync(file).mtimeMs, value: readFileSync(file, "utf8") };
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        const file = nodeStatePath(key);
        writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
        const now = new Date();
        utimesSync(file, now, now);
        return true;
      } catch {
        return false;
      }
    },
  },
  defaultRules: () => readFileSync(defaultRulesPath(), "utf8"),
};
