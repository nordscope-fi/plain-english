import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildCapture, record } from "../src/record.ts";
import { decide } from "../src/adapters/hook.ts";
import { byId } from "../src/agents/registry.ts";
import { compile, loadDefault } from "../src/rules.ts";

/**
 * Several adapters were written from vendor documentation, and the
 * documentation was wrong twice. Capturing one real payload settles what
 * reading harder cannot.
 *
 * Two properties matter more than the feature. It must never break the linter,
 * and it must never leak: a payload carries the whole text somebody was about
 * to write, from whatever repository they were in.
 */
const ruleSet = compile({ ...loadDefault(), failOn: "never" });
const cursor = byId("cursor")!;

function inTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), "pe-rec-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function capture(dir: string, content: string, verbatim = false) {
  const raw = { tool_name: "Write", tool_input: { file_path: resolve(dir, "x.md"), content } };
  const parsed = cursor.parse(raw);
  const d = decide(parsed, "docs", { projectDir: dir, ruleSet });
  const body = buildCapture(raw, parsed, d, cursor.emit(d, "post").stdout, {
    dir,
    agent: "cursor",
    channel: "docs",
    event: "post",
    projectDir: dir,
    version: "9.9.9",
    verbatim,
  });
  return { body, json: body ? JSON.parse(body) : null };
}

describe("a capture keeps the shape and drops the prose", () => {
  it("records the field names, which is the whole point", () => {
    inTmp((dir) => {
      const { json } = capture(dir, "We leverage this.");
      expect(Object.keys(json.raw.tool_input)).toEqual(["file_path", "content"]);
      expect(json.parsed.tool).toBe("write");
      expect(json.decision.ruleIds).toContain("leverage");
    });
  });

  it("reduces prose to a length and a hash by default", () => {
    inTmp((dir) => {
      const { body, json } = capture(dir, "We leverage this secret plan.");
      expect(body).not.toContain("secret plan");
      expect(json.raw.tool_input.content).toMatch(/^<\d+ chars, sha256:[0-9a-f]{12}>$/);
      expect(json.redacted).toBe(true);
    });
  });

  it("keeps prose only when asked, for a payload you wrote yourself", () => {
    inTmp((dir) => {
      const { body, json } = capture(dir, "We leverage this.", true);
      expect(body).toContain("We leverage this.");
      expect(json.redacted).toBe(false);
    });
  });

  it("never records the reason, which quotes the matched text back", () => {
    inTmp((dir) => {
      const { body, json } = capture(dir, "We leverage this.");
      expect(json.stdoutKeys).toEqual(["additional_context"]);
      expect(body).not.toContain("Rewrite the quoted text");
    });
  });
});

describe("paths never survive a capture", () => {
  it("rewrites the project directory to the corpus placeholder", () => {
    inTmp((dir) => {
      const { body, json } = capture(dir, "We leverage this.");
      expect(json.raw.tool_input.file_path).toBe("{{TMP}}/x.md");
      expect(body).not.toContain(dir);
    });
  });

  it("writes a portable path whichever platform recorded it", () => {
    // A capture is meant to be committed and replayed anywhere, so a fixture
    // recorded on Windows must not arrive carrying `{{TMP}}\x.md`. Simulated
    // rather than skipped, so the check runs on every platform.
    const winRoot = "C:\\work\\repo";
    const raw = {
      tool_name: "Write",
      tool_input: { file_path: `${winRoot}\\docs\\x.md`, content: "hi" },
    };
    const parsed = cursor.parse(raw);
    const d = decide(parsed, "docs", { projectDir: winRoot, ruleSet });
    const json = JSON.parse(
      buildCapture(raw, parsed, d, "", {
        dir: ".",
        agent: "cursor",
        channel: "docs",
        event: "pre",
        projectDir: winRoot,
        version: "9.9.9",
      })!,
    );
    expect(json.raw.tool_input.file_path).toBe("{{TMP}}/docs/x.md");
  });

  it("refuses to write a capture that still holds a home path", () => {
    // The check that matters. A partial scrub which wrote anyway would put
    // somebody's home directory into a committed fixture.
    inTmp((dir) => {
      const elsewhere = resolve(homedir(), "other-repo", "x.md");
      const raw = { tool_name: "Write", tool_input: { file_path: elsewhere, content: "hi" } };
      const parsed = cursor.parse(raw);
      const d = decide(parsed, "docs", { projectDir: dir, ruleSet });
      const body = buildCapture(raw, parsed, d, "", {
        dir,
        agent: "cursor",
        channel: "docs",
        event: "pre",
        // A project dir that shares no prefix with the path in the payload, so
        // the placeholder substitution cannot save it. `~` still does.
        projectDir: "/nowhere",
        version: "9.9.9",
      });
      // Either the home rewrite caught it or the leak check refused it. Both
      // are acceptable; a raw home path in the output is not.
      if (body !== null) expect(body).not.toMatch(/\/Users\/|\/home\//);
    });
  });

  it("passes the private-reference gate the release runs", () => {
    inTmp((dir) => {
      const { body } = capture(dir, "We leverage this.");
      // scripts/check-no-private-refs.sh denylists these across the tree, runs
      // in pretest and is a required CI job, so a capture that carried one
      // would fail `npm test` before vitest started.
      expect(body).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/);
    });
  });
});

describe("recording cannot break the linter", () => {
  it("returns null rather than throwing when the directory is impossible", () => {
    inTmp((dir) => {
      const raw = { tool_name: "Write", tool_input: { file_path: "x.md", content: "hi" } };
      const parsed = cursor.parse(raw);
      const d = decide(parsed, "docs", { projectDir: dir, ruleSet });
      // A path under a file, which cannot be a directory.
      const impossible = resolve(dir, "x.md", "captures");
      expect(() =>
        record(raw, parsed, d, "", {
          dir: impossible,
          agent: "cursor",
          channel: "docs",
          event: "pre",
          projectDir: dir,
          version: "9.9.9",
        }),
      ).not.toThrow();
    });
  });

  it("writes one file per call without collisions", () => {
    inTmp((dir) => {
      const out = resolve(dir, "captures");
      const raw = { tool_name: "Write", tool_input: { file_path: resolve(dir, "x.md"), content: "We leverage this." } };
      const parsed = cursor.parse(raw);
      const d = decide(parsed, "docs", { projectDir: dir, ruleSet });
      const opts = {
        dir: out,
        agent: "cursor",
        channel: "docs",
        event: "pre" as const,
        projectDir: dir,
        version: "9.9.9",
      };
      for (let i = 0; i < 5; i++) record(raw, parsed, d, "", opts);
      expect(readdirSync(out)).toHaveLength(5);
      // Each is independently valid JSON.
      for (const f of readdirSync(out)) {
        expect(() => JSON.parse(readFileSync(resolve(out, f), "utf8"))).not.toThrow();
      }
    });
  });
});

/**
 * The signal a frozen fixture cannot give.
 *
 * If a vendor renames `tool_input`, the committed recording still says
 * `tool_input`, the replay still passes, and the hook allows everything in the
 * field that moved. What actually shows drift is a write-shaped call that
 * yields nothing, and that is detectable on every user's machine for free.
 */
describe("the drift canary", () => {
  const noted = (raw: Record<string, unknown>, dir: string): string => {
    const original = process.stderr.write.bind(process.stderr);
    let seen = "";
    process.stderr.write = ((s: string) => {
      seen += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      decide(byId("claude-code")!.parse(raw), "docs", { projectDir: dir, ruleSet });
    } finally {
      process.stderr.write = original;
    }
    return seen;
  };

  it("says something when a write yields no path and no text", () => {
    inTmp((dir) => {
      // What a renamed field looks like from in here.
      const seen = noted({ tool_name: "Write", tool_input: { arguments: { path: "x.md" } } }, dir);
      expect(seen).toContain("read nothing from a write call");
      // By this point the payload has been normalised, so the field names that
      // would name the problem are gone. The recorder is what captures them,
      // and the message has to send the reader there.
      expect(seen, "no route to a diagnosis").toContain("PLAIN_ENGLISH_RECORD");
    });
  });

  it("stays quiet on a write it understood", () => {
    inTmp((dir) => {
      const raw = { tool_name: "Write", tool_input: { file_path: resolve(dir, "x.md"), content: "ok" } };
      expect(noted(raw, dir)).toBe("");
    });
  });

  it("stays quiet on a tool that is not a write at all", () => {
    inTmp((dir) => {
      expect(noted({ tool_name: "Bash", tool_input: { command: "ls" } }, dir)).toBe("");
    });
  });
});
