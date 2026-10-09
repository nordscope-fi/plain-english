import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { sha256 } from "../src/sha256.ts";
import { pathsFor, posixPaths, win32Paths } from "../src/paths.ts";

/**
 * The plugin's mod has no Node (ADR-008). These are the pure stand-ins the
 * checker's core uses there, held to Node's own results.
 */
describe("sha256", () => {
  const samples = ["", "a", "abc", "plain english", "é ü ß 中文 🙂", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000), "line\nbreak\r\n\0nul"];
  for (const text of samples) {
    it(`matches node:crypto for ${JSON.stringify(text.slice(0, 12))} (${text.length} characters)`, () => {
      expect(sha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
    });
  }
});

describe("paths", () => {
  const posixCases: [string, unknown[]][] = [
    ["resolve", ["/repo", "docs/a.md"]], ["resolve", ["/repo/docs", "../README.md"]], ["resolve", ["/repo", "/abs/x.md"]],
    ["resolve", ["/repo/", "./a//b/../c"]], ["resolve", ["/"]], ["resolve", ["/a/b", ".."]], ["resolve", ["/a", "b", "c/../d"]],
    ["dirname", ["/repo/docs/a.md"]], ["dirname", ["/repo"]], ["dirname", ["/"]], ["dirname", ["a.md"]], ["dirname", ["docs/a.md"]],
    ["relative", ["/repo", "/repo/docs/a.md"]], ["relative", ["/repo/docs", "/repo/README.md"]], ["relative", ["/repo", "/repo"]], ["relative", ["/a/b", "/c"]],
    ["extname", ["a.md"]], ["extname", ["a.tar.gz"]], ["extname", [".plain-english.yml"]], ["extname", ["noext"]], ["extname", ["/x/.hidden"]],
    ["isAbsolute", ["/a"]], ["isAbsolute", ["a"]], ["isAbsolute", ["./a"]],
    ["basename", ["/repo/docs/a.md"]], ["basename", ["/repo/"]], ["join", ["/repo", "docs", "../a.md"]], ["join", ["a", "b"]],
  ];
  for (const [fn, args] of posixCases) {
    it(`posix ${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}) matches node:path`, () => {
      expect((posixPaths as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args))
        .toEqual((posix as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args));
    });
  }

  const win32Cases: [string, unknown[]][] = [
    ["resolve", ["C:\\repo", "docs\\a.md"]], ["resolve", ["C:\\repo", "docs/a.md"]], ["resolve", ["C:\\repo\\docs", "..\\README.md"]],
    ["resolve", ["C:\\repo", "D:\\x\\y.md"]], ["resolve", ["c:/repo/", "./a//b/../c"]], ["resolve", ["C:\\"]], ["resolve", ["C:\\a", "\\b"]],
    ["dirname", ["C:\\repo\\docs\\a.md"]], ["dirname", ["C:\\repo"]], ["dirname", ["C:\\"]], ["dirname", ["docs\\a.md"]],
    ["relative", ["C:\\repo", "C:\\repo\\docs\\a.md"]], ["relative", ["C:\\repo\\docs", "C:\\repo\\README.md"]], ["relative", ["C:\\repo", "c:\\REPO\\x"]], ["relative", ["C:\\a", "D:\\b"]],
    ["extname", ["a.md"]], ["extname", ["C:\\x\\.hidden"]], ["isAbsolute", ["C:\\a"]], ["isAbsolute", ["C:a"]], ["isAbsolute", ["\\a"]], ["isAbsolute", ["a\\b"]],
    ["basename", ["C:\\repo\\docs\\a.md"]], ["join", ["C:\\repo", "docs", "..\\a.md"]],
  ];
  for (const [fn, args] of win32Cases) {
    it(`win32 ${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}) matches node:path`, () => {
      expect((win32Paths as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args))
        .toEqual((win32 as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args));
    });
  }

  it("picks the Windows style from a drive-letter or backslash folder, otherwise POSIX", () => {
    expect(pathsFor("C:\\work\\repo")).toBe(win32Paths);
    expect(pathsFor("\\\\server\\share\\repo")).toBe(win32Paths);
    expect(pathsFor("/work/repo")).toBe(posixPaths);
    expect(posixPaths.sep).toBe("/");
    expect(win32Paths.sep).toBe("\\");
  });
});
