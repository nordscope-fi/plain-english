/**
 * Everything the checker's core reads from outside its arguments (ADR-008).
 *
 * The CLI passes `nodeIo` from `node-io.ts`. The Claude Code mod has no Node,
 * so it passes a `replayIo` holding what it has already fetched through
 * `$.fs`. A path the replay does not hold reads as missing, and the run ends
 * with `NeedFiles` naming every such path; the mod fetches them and runs the
 * same function again, the way it answers model questions (ADR-006).
 */
import type { PathApi } from "./paths.ts";

export interface FileFacts {
  /** What the path itself is: a link is reported as a link, not followed. */
  kind: "file" | "directory" | "link" | "other";
  mtimeMs: number;
  /** The path with every link resolved; absent when that fails, as for a dangling link. */
  realPath?: string;
}

export interface CheckerIo {
  /** The folder relative paths start from. */
  readonly cwd: string;
  readonly path: PathApi;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home folder, for `~` in commands, or `undefined` when unknown. */
  readonly home: string | undefined;
  now(): number;
  /** A fixed diagnostic line; the CLI writes it to standard error. */
  notice(text: string): void;
  /** A file's text, or `undefined` when it does not exist. */
  read(path: string): string | undefined;
  /** What a path is, without following a final link, or `undefined` when missing. */
  stat(path: string): FileFacts | undefined;
  /** A directory's entry names, or `undefined` when it is not a readable directory. */
  list(dir: string): string[] | undefined;
  /**
   * Small values kept between runs, such as a turn's block state, with the
   * time each was last set. `set` reports whether the value was kept.
   */
  readonly state: { get(key: string): { value: string; at: number } | undefined; set(key: string, value: string): boolean };
  /** The text of the built-in `rules/default.yml`. */
  defaultRules(): string;
}

/** The paths a replayed run wanted and did not have. */
export class NeedFiles extends Error {
  constructor(readonly reads: string[], readonly stats: string[], readonly lists: string[]) {
    super(`plain-english needs ${reads.length + stats.length + lists.length} more file system answers`);
  }
}

/** What the mod has fetched so far. `null` records a path it found missing. */
export interface Fetched {
  reads: Map<string, string | null>;
  stats: Map<string, FileFacts | null>;
  lists: Map<string, string[] | null>;
}

export function emptyFetched(): Fetched {
  return { reads: new Map(), stats: new Map(), lists: new Map() };
}

export interface ReplayIo extends CheckerIo {
  /** `NeedFiles` for every path this run asked for and the replay lacked, if any. */
  missing(): NeedFiles | undefined;
}

export function replayIo(
  base: Pick<CheckerIo, "cwd" | "path" | "env" | "home" | "now" | "notice" | "state" | "defaultRules">,
  fetched: Fetched,
): ReplayIo {
  const wanted = { reads: new Set<string>(), stats: new Set<string>(), lists: new Set<string>() };
  const key = (path: string) => base.path.resolve(base.cwd, path);
  return {
    ...base,
    read(path) {
      const at = key(path);
      if (!fetched.reads.has(at)) {
        wanted.reads.add(at);
        return undefined;
      }
      return fetched.reads.get(at) ?? undefined;
    },
    stat(path) {
      const at = key(path);
      if (!fetched.stats.has(at)) {
        wanted.stats.add(at);
        return undefined;
      }
      return fetched.stats.get(at) ?? undefined;
    },
    list(dir) {
      const at = key(dir);
      if (!fetched.lists.has(at)) {
        wanted.lists.add(at);
        return undefined;
      }
      return fetched.lists.get(at) ?? undefined;
    },
    missing() {
      if (wanted.reads.size + wanted.stats.size + wanted.lists.size === 0) return undefined;
      return new NeedFiles([...wanted.reads], [...wanted.stats], [...wanted.lists]);
    },
  };
}

/**
 * Runs `work` against a replay. When the run lacked a path, its result and any
 * error it threw are both unreliable, so `NeedFiles` wins over either.
 */
export function replay<T>(io: ReplayIo, work: (io: CheckerIo) => T): T {
  let result: T;
  try {
    result = work(io);
  } catch (error) {
    throw io.missing() ?? error;
  }
  const missing = io.missing();
  if (missing) throw missing;
  return result;
}
