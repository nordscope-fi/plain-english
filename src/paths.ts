/**
 * The path functions the checker's core uses, without `node:path`.
 *
 * The core runs inside the Claude Code mod, which has no Node (ADR-008). The
 * CLI hands the core Node's own `path`, so its behaviour does not change; the
 * mod hands it one of these, picked by the shape of the session's folder.
 * Both follow Node's algorithms for the functions listed in `PathApi`, and
 * `test/pure-io.test.ts` holds them to Node's results. `resolve` with no
 * absolute argument resolves against the root, since there is no process
 * folder here: callers pass the project folder first.
 */
export interface PathApi {
  readonly sep: "/" | "\\";
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
}

const SLASH = 47; // "/"
const BACKSLASH = 92; // "\\"
const DOT = 46; // "."
const COLON = 58; // ":"

const isPosixSep = (code: number) => code === SLASH;
const isWinSep = (code: number) => code === SLASH || code === BACKSLASH;
const isDriveLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** Resolves `.` and `..` segments; Node's `normalizeString`. */
function normalizeString(path: string, allowAboveRoot: boolean, separator: string, isSep: (code: number) => boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isSep(code)) break;
    else code = SLASH;
    if (isSep(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // a doubled separator or a "." segment
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function posixNormalize(path: string): string {
  if (path.length === 0) return ".";
  const isAbs = path.charCodeAt(0) === SLASH;
  const trailing = path.charCodeAt(path.length - 1) === SLASH;
  let out = normalizeString(path, !isAbs, "/", isPosixSep);
  if (out.length === 0) {
    if (isAbs) return "/";
    return trailing ? "./" : ".";
  }
  if (trailing) out += "/";
  return isAbs ? `/${out}` : out;
}

/** Node's extension rule, shared by both styles from a given start index. */
function extFrom(path: string, start: number, isSep: (code: number) => boolean): string {
  let startDot = -1;
  let startPart = start;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (isSep(code)) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
  return path.slice(startDot, end);
}

function baseFrom(path: string, start: number, isSep: (code: number) => boolean): string {
  let first = start;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= start; --i) {
    if (isSep(path.charCodeAt(i))) {
      if (!matchedSlash) {
        first = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? "" : path.slice(first, end);
}

export const posixPaths: PathApi = {
  sep: "/",
  resolve(...paths) {
    let resolved = "";
    let absolute = false;
    for (let i = paths.length - 1; i >= 0 && !absolute; i--) {
      const path = paths[i]!;
      if (path.length === 0) continue;
      resolved = `${path}/${resolved}`;
      absolute = path.charCodeAt(0) === SLASH;
    }
    // Without an absolute argument there is no process folder to start from,
    // so the result is rooted at "/" (see the module comment).
    return `/${normalizeString(resolved, false, "/", isPosixSep)}`;
  },
  join(...paths) {
    const joined = paths.filter((p) => p.length > 0).join("/");
    return joined.length === 0 ? "." : posixNormalize(joined);
  },
  relative(from, to) {
    if (from === to) return "";
    from = posixPaths.resolve(from);
    to = posixPaths.resolve(to);
    if (from === to) return "";
    const fromStart = 1;
    const fromEnd = from.length;
    const fromLen = fromEnd - fromStart;
    const toStart = 1;
    const toLen = to.length - toStart;
    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      else if (fromCode === SLASH) lastCommonSep = i;
    }
    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === SLASH) return to.slice(toStart + i + 1);
        if (i === 0) return to.slice(toStart + i);
      } else if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === SLASH) lastCommonSep = i;
        else if (i === 0) lastCommonSep = 0;
      }
    }
    let out = "";
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === SLASH) out += out.length === 0 ? ".." : "/..";
    }
    return `${out}${to.slice(toStart + lastCommonSep)}`;
  },
  dirname(path) {
    if (path.length === 0) return ".";
    const hasRoot = path.charCodeAt(0) === SLASH;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path.charCodeAt(i) === SLASH) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return path.slice(0, end);
  },
  basename: (path) => baseFrom(path, 0, isPosixSep),
  extname: (path) => extFrom(path, 0, isPosixSep),
  isAbsolute: (path) => path.length > 0 && path.charCodeAt(0) === SLASH,
};

/** The device or UNC root at the start of a Windows path, Node's way. */
function winRoot(path: string): { device: string; rootEnd: number; isAbsolute: boolean } {
  const len = path.length;
  let rootEnd = 0;
  let device = "";
  let isAbsolute = false;
  const code = path.charCodeAt(0);
  if (len === 1) {
    if (isWinSep(code)) return { device: "", rootEnd: 1, isAbsolute: true };
    return { device: "", rootEnd: 0, isAbsolute: false };
  }
  if (isWinSep(code)) {
    isAbsolute = true;
    if (isWinSep(path.charCodeAt(1))) {
      let j = 2;
      let last = j;
      while (j < len && !isWinSep(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        last = j;
        while (j < len && isWinSep(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isWinSep(path.charCodeAt(j))) j++;
          if (j === len || j !== last) {
            device = `\\\\${firstPart}\\${path.slice(last, j)}`;
            rootEnd = j;
          }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else if (isDriveLetter(code) && path.charCodeAt(1) === COLON) {
    device = path.slice(0, 2);
    rootEnd = 2;
    if (len > 2 && isWinSep(path.charCodeAt(2))) {
      isAbsolute = true;
      rootEnd = 3;
    }
  }
  return { device, rootEnd, isAbsolute };
}

function winNormalize(path: string): string {
  const len = path.length;
  if (len === 0) return ".";
  const { device, rootEnd, isAbsolute } = winRoot(path);
  if (len === 1) return isWinSep(path.charCodeAt(0)) ? "\\" : path;
  let tail = rootEnd < len ? normalizeString(path.slice(rootEnd), !isAbsolute, "\\", isWinSep) : "";
  if (tail.length === 0 && !isAbsolute) tail = ".";
  if (tail.length > 0 && isWinSep(path.charCodeAt(len - 1))) tail += "\\";
  if (device === "") return isAbsolute ? `\\${tail}` : tail;
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

export const win32Paths: PathApi = {
  sep: "\\",
  resolve(...paths) {
    let resolvedDevice = "";
    let resolvedTail = "";
    let resolvedAbsolute = false;
    for (let i = paths.length - 1; i >= 0; i--) {
      const path = paths[i]!;
      if (path.length === 0) continue;
      const { device, rootEnd, isAbsolute } = winRoot(path);
      if (device.length > 0) {
        if (resolvedDevice.length > 0) {
          if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
        } else {
          resolvedDevice = device;
        }
      }
      if (resolvedAbsolute) {
        if (resolvedDevice.length > 0) break;
      } else {
        resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
        resolvedAbsolute = isAbsolute;
        if (isAbsolute && resolvedDevice.length > 0) break;
      }
    }
    resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isWinSep);
    return resolvedAbsolute ? `${resolvedDevice}\\${resolvedTail}` : `${resolvedDevice}${resolvedTail}` || ".";
  },
  join(...paths) {
    const parts = paths.filter((p) => p.length > 0);
    if (parts.length === 0) return ".";
    let joined = parts.join("\\");
    const first = parts[0]!;
    let needsReplace = true;
    let slashCount = 0;
    if (isWinSep(first.charCodeAt(0))) {
      ++slashCount;
      if (first.length > 1 && isWinSep(first.charCodeAt(1))) {
        ++slashCount;
        if (first.length > 2) {
          if (isWinSep(first.charCodeAt(2))) ++slashCount;
          else needsReplace = false;
        }
      }
    }
    if (needsReplace) {
      while (slashCount < joined.length && isWinSep(joined.charCodeAt(slashCount))) slashCount++;
      if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
    }
    return winNormalize(joined);
  },
  relative(from, to) {
    const fromOrig = win32Paths.resolve(from);
    const toOrig = win32Paths.resolve(to);
    if (fromOrig === toOrig) return "";
    from = fromOrig.toLowerCase();
    to = toOrig.toLowerCase();
    if (from === to) return "";
    let fromStart = 0;
    while (fromStart < from.length && from.charCodeAt(fromStart) === BACKSLASH) fromStart++;
    let fromEnd = from.length;
    while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === BACKSLASH) fromEnd--;
    const fromLen = fromEnd - fromStart;
    let toStart = 0;
    while (toStart < to.length && to.charCodeAt(toStart) === BACKSLASH) toStart++;
    let toEnd = to.length;
    while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === BACKSLASH) toEnd--;
    const toLen = toEnd - toStart;
    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      else if (fromCode === BACKSLASH) lastCommonSep = i;
    }
    if (i !== length) {
      if (lastCommonSep === -1) return toOrig;
    } else {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === BACKSLASH) return toOrig.slice(toStart + i + 1);
        if (i === 2) return toOrig.slice(toStart + i);
      }
      if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === BACKSLASH) lastCommonSep = i;
        else if (i === 2) lastCommonSep = 3;
      }
      if (lastCommonSep === -1) lastCommonSep = 0;
    }
    let out = "";
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === BACKSLASH) out += out.length === 0 ? ".." : "\\..";
    }
    toStart += lastCommonSep;
    if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;
    if (toOrig.charCodeAt(toStart) === BACKSLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
  },
  dirname(path) {
    const len = path.length;
    if (len === 0) return ".";
    const { rootEnd } = winRoot(path);
    let end = -1;
    let matchedSlash = true;
    for (let i = len - 1; i >= rootEnd; --i) {
      if (isWinSep(path.charCodeAt(i))) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) {
      if (rootEnd === 0) return ".";
      end = rootEnd;
    }
    return path.slice(0, end);
  },
  basename(path) {
    const start = path.length >= 2 && isDriveLetter(path.charCodeAt(0)) && path.charCodeAt(1) === COLON ? 2 : 0;
    return baseFrom(path, start, isWinSep);
  },
  extname(path) {
    const start = path.length >= 2 && path.charCodeAt(1) === COLON && isDriveLetter(path.charCodeAt(0)) ? 2 : 0;
    return extFrom(path, start, isWinSep);
  },
  isAbsolute(path) {
    const len = path.length;
    if (len === 0) return false;
    const code = path.charCodeAt(0);
    return isWinSep(code) || (len > 2 && isDriveLetter(code) && path.charCodeAt(1) === COLON && isWinSep(path.charCodeAt(2)));
  },
};

/** The style a folder is written in: Windows for a drive letter or a leading backslash. */
export function pathsFor(folder: string): PathApi {
  return /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("\\") ? win32Paths : posixPaths;
}

/** A path with forward slashes, as findings and model input name files. */
export function toPosix(path: string): string {
  return path.split("\\").join("/");
}
