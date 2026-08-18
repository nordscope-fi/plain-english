import { describe, expect, it } from "vitest";
import { shellFileWrites } from "../src/shell.ts";

/**
 * Agents write prose through the shell. Copilot CLI 1.0.78, asked to edit a
 * markdown file, ran `printf ... > notes.md` rather than using a write tool, so
 * a hook matching Write and Edit never saw it (issue #7).
 *
 * The asymmetry governs every case below. Missing a write costs a finding.
 * Inventing one costs somebody their edit, because under `failOn: error` a
 * false positive refuses a write that was never going to a file.
 */
const w = (cmd: string) => shellFileWrites(cmd);
const one = (cmd: string) => {
  const r = shellFileWrites(cmd);
  expect(r, `expected exactly one write from: ${cmd}`).toHaveLength(1);
  return r[0]!;
};

describe("the writes it catches", () => {
  it("reads the command Copilot actually ran", () => {
    const got = one(`printf '%s\\n' "We leverage this approach." > notes.md && echo 'WROTE'`);
    expect(got.path).toBe("notes.md");
    // The format string is dropped: it is noise in a message a human reads.
    expect(got.text).toBe("We leverage this approach.");
  });

  it("reads an append", () => {
    expect(one(`echo "We leverage this." >> notes.md`).text).toBe("We leverage this.");
  });

  it("reads a heredoc into a redirect", () => {
    expect(one("cat > notes.md <<EOF\nWe leverage this.\nEOF").text).toBe("We leverage this.");
  });

  it("reads a heredoc into tee, which writes through an argument", () => {
    const got = one("tee notes.md <<'EOF'\nWe leverage this.\nEOF");
    expect(got.path).toBe("notes.md");
    expect(got.text).toBe("We leverage this.");
  });

  it("ignores a descriptor redirect sitting beside a real one", () => {
    // `> x.md 2>&1` is ordinary, and treating the pair as ambiguous would miss
    // most real writes.
    expect(one(`printf 'We leverage this.' > notes.md 2>&1`).path).toBe("notes.md");
  });

  it("finds a write in the middle of a chain", () => {
    expect(one(`cd docs && printf 'We leverage this.' > notes.md && git add -A`).path).toBe(
      "notes.md",
    );
  });

  it("drops echo flags rather than judging them", () => {
    expect(one(`echo -n "We leverage this." > notes.md`).text).toBe("We leverage this.");
  });
});

/**
 * Each of these would be a refused write that was never going to a file. They
 * are the reason this is a scanner and not a regular expression.
 */
describe("the writes it refuses to invent", () => {
  it("does not mistake a redirect inside a quoted string for the target", () => {
    // A pattern reading the first `>` targets README.md. The real target is
    // the log file, and its content really is that string.
    const got = w(`echo "see > README.md" >> log.txt`);
    expect(got).toHaveLength(1);
    expect(got[0]!.path).toBe("log.txt");
  });

  it.each([
    ["a file-descriptor redirect", `printf 'x' 2> notes.md`],
    ["a descriptor duplicate", `printf 'x' >& notes.md`],
    ["process substitution", `printf 'x' >(tee notes.md)`],
    ["content that lives in another file", `cat template.md > notes.md`],
    ["a path the shell would expand", `printf 'x' > "$DIR/notes.md"`],
    ["content the shell would expand", `printf '%s' "$TEXT" > notes.md`],
    ["a command with no redirect", `git commit -m "We leverage this."`],
    ["an unterminated quote", `printf "We leverage this > notes.md`],
    ["two plain redirects, so the target is ambiguous", `echo hi > a.md > b.md`],
    ["tee fanning out to several files", "tee a.md b.md <<EOF\nhi\nEOF"],
    ["a command whose content is not visible", `sed -i 's/a/b/' notes.md`],
    ["a copy", `cp template.md notes.md`],
    ["a here-string, which is input rather than output", `cat <<< "hi"`],
  ])("gives nothing for %s", (_label, cmd) => {
    expect(w(cmd)).toEqual([]);
  });
});

/**
 * The previous hand-written parser in this path went quadratic and hung a
 * blocking hook for 200 seconds. A scanner is linear by construction, and this
 * is the test that says so rather than assuming it.
 */
describe("it stays linear", () => {
  it.each([
    ["unterminated quotes", (n: number) => `printf "` + "a ".repeat(n)],
    ["unclosed heredocs", (n: number) => "cat > x.md <<EOF\n" + "line\n".repeat(n)],
    ["nested-looking redirects", (n: number) => "echo hi " + "> ".repeat(n) + "x.md"],
    ["quote alternation", (n: number) => `echo ` + `"a"'b'`.repeat(n) + " > x.md"],
  ])("handles %s in bounded time", (_label, build) => {
    for (const n of [10_000, 40_000]) {
      const started = performance.now();
      shellFileWrites(build(n));
      const ms = performance.now() - started;
      expect(ms, `${n} took ${ms.toFixed(0)}ms`).toBeLessThan(500);
    }
  });

  it("scales linearly and not quadratically", () => {
    const build = (n: number) => "cat > x.md <<EOF\n" + "some line of text\n".repeat(n);
    // Best of five, not one. A scheduling pause or a collection can only make a
    // run slower, so the fastest of several is the closest reading of what the
    // work costs. One sample each put this at 3.3ms against 38.9ms on a shared
    // Windows runner, a ratio of 11.8 for code that is linear.
    const time = (n: number) => {
      const input = build(n);
      let best = Infinity;
      for (let i = 0; i < 5; i += 1) {
        const s = performance.now();
        shellFileWrites(input);
        best = Math.min(best, performance.now() - s);
      }
      return best;
    };
    // Big enough to read. Best-of-five removed most of the noise and the
    // ratio still flaked at 11.4 on a shared runner, because `small` was
    // 1.3ms: at that size a single scheduling pause is a third of the
    // measurement, and the ratio inherits all of it. Four times the work makes
    // the denominator large enough that a blip cannot dominate it. The 4x
    // relationship between the two sizes is what the assertion rests on, and
    // that is unchanged.
    time(40_000); // warm
    const small = Math.max(time(40_000), 0.5);
    const large = time(160_000);
    // Four times the input. Linear predicts about 4x; quadratic predicts 16x.
    expect(large / small, `${small.toFixed(1)}ms -> ${large.toFixed(1)}ms`).toBeLessThan(10);
  });
});
