# Portable writing skill: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `plain-english` skill to the Claude Code plugin that carries the checker into Claude chat and Cowork and checks a draft passed as text.

**Architecture:** A new pure function, `checkDraft`, joins the core that `scripts/build-plugin.mjs` bundles. The build writes that core into the skill's own folder, where the mod also loads it, so there is one copy. Beside it sits a small script that reads a draft on standard input and prints a JSON report. `plain-english render` generates the skill's `SKILL.md` from the ruleset, reusing the output style's reply rules.

**Tech Stack:** TypeScript (strict), vitest, esbuild through `scripts/build-plugin.mjs`, Node 20 or later.

**Spec:** `docs/architecture/specs/2026-10-10-portable-writing-skill.md`

## Global Constraints

- Every plugin file stays under 262,144 bytes, and the plugin under 512 files (the existing test in `test/claude-code-plugin.test.ts`).
- No path inside the skill is more than three segments below the skill root. The upload page refused "Zip file contains path more than 10 folders deep".
- `check.mjs` has no `node:` import, no `require`, no `eval`, and starts no program.
- `checkDraft` reads no file, keeps no state, and makes no model call. The bundled ruleset arrives through `io.defaultRules()`.
- No bundled core file contains an uppercase template such as `${CLAUDE_SKILL_DIR}`; the existing test holds this. The renderers are not bundled today, so the placeholder in `SKILL.md`'s generator stays out of the core.
- `SKILL.md`'s description is at most 200 characters, and `SKILL.md` has no line of the form `` !`command` ``.
- The plugin README keeps no command block, and no sentence in it pairs a download or fetch with a run (existing README tests).
- Engines floor stays `"node": ">=20"`; the chat environment measured `v22.22.0`.
- Every Markdown file under `docs/` passes `npm run lint:self`.
- Before pushing: `claude plugin validate --strict .`, `claude plugin validate --strict integrations/claude-code-plugin` and `claude plugin test integrations/claude-code-plugin`, as CI runs them.
- The release is a minor bump, made with `npm version minor --no-git-tag-version`.

## Review Focus

1. A reply that quotes a banned phrase inside a code block, as Claude does when explaining a rule. Expected: no finding for the quoted phrase.
2. A draft carrying a suppression comment such as `<!-- plain-english-disable-next-line leverage: x -->`. Expected: the finding still appears, because a draft carries no waivers.
3. The script called with nothing on standard input, or with input that never closes. Expected: an `invalid` report and exit 2, within about 10 seconds at worst.
4. The script called with no kind or a misspelled one, such as `Reply`. Expected: an `invalid` report naming the bad kind, exit 2, without reading standard input.
5. A very large draft, such as 290,000 characters. Expected: valid JSON with status `checked` or `incomplete`, never a crash.

Tests for 1 and 2 are in Task 1; tests for 3, 4 and 5 are in Task 3.

---

### Task 1: The `checkDraft` function

**Files:**
- Create: `src/draft-check.ts`
- Modify: `src/adapters/chat.ts:161` (export `JUDGEABLE`)
- Modify: `src/plugin-core.ts` (export `checkDraft` and its types)
- Test: `test/draft-check.test.ts`

**Interfaces:**
- Consumes: `lintText`, `DEFAULT_BUDGET_MS` and `Finding` from `src/lint.ts`; `chatRuleSet`, `compile` and `loadDefault` from `src/rules.ts`; `HOOK_BUDGET_MS` from `src/adapters/hook.ts`; `JUDGEABLE` from `src/adapters/chat.ts`; `CheckerIo` from `src/io.ts`.
- Produces, exported from `src/plugin-core.ts`:

```ts
export type DraftKind = "reply" | "document";
export interface DraftFinding { ruleId: string; severity: "error" | "warn"; line: number; column: number; quote: string; message: string; mayStand?: true }
export interface DraftReport { status: "checked" | "incomplete" | "invalid"; kind?: DraftKind; findings: DraftFinding[]; review: string[]; notes: string[] }
export interface DraftCheckOptions { budgetMs?: number }
export function checkDraft(request: unknown, io: CheckerIo, options?: DraftCheckOptions): DraftReport;
```

- [ ] **Step 1: Write the failing tests**

Create `test/draft-check.test.ts`:

```ts
/**
 * `checkDraft`, the function the plain-english skill's script calls on a
 * draft in Claude chat and Cowork (ADR-009). Every test runs it with an io
 * that holds only the bundled rules and throws on any other use, which is
 * what proves it reads no file and keeps no state.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDraft } from "../src/draft-check.ts";
import type { CheckerIo } from "../src/io.ts";
import { pathsFor } from "../src/paths.ts";

const RULES = readFileSync(resolve(import.meta.dirname, "../rules/default.yml"), "utf8");

function rulesOnlyIo(): CheckerIo {
  const refuse = (what: string) => (): never => {
    throw new Error(`checkDraft used io.${what}`);
  };
  return {
    cwd: "/",
    path: pathsFor("/"),
    env: {},
    home: undefined,
    now: () => 0,
    notice: refuse("notice"),
    read: refuse("read"),
    stat: refuse("stat"),
    list: refuse("list"),
    state: { get: refuse("state.get"), set: refuse("state.set") },
    defaultRules: () => RULES,
  };
}

const LONG = Array(60).fill("The build takes two minutes.").join(" ");
const ids = (report: { findings: { ruleId: string }[] }) => report.findings.map((f) => f.ruleId);

describe("checkDraft on a reply", () => {
  it("reports a stock opener and a banned word, quoting each", () => {
    const report = checkDraft({ text: "Great question. We leverage this approach.", kind: "reply" }, rulesOnlyIo());
    expect(report.status).toBe("checked");
    expect(report.kind).toBe("reply");
    expect(ids(report)).toEqual(expect.arrayContaining(["affirmation-opener", "leverage"]));
    const leverage = report.findings.find((f) => f.ruleId === "leverage");
    expect(leverage).toMatchObject({ severity: "error", line: 1, quote: "leverage" });
    expect(leverage?.message.length).toBeGreaterThan(0);
  });

  it("passes a clean reply", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "reply" }, rulesOnlyIo());
    expect(report).toMatchObject({ status: "checked", findings: [], notes: [] });
  });

  it("marks a length finding as one the person's request can justify", () => {
    const report = checkDraft({ text: LONG, kind: "reply" }, rulesOnlyIo());
    const length = report.findings.find((f) => f.ruleId === "reply-length");
    expect(length?.mayStand).toBe(true);
    for (const f of report.findings.filter((x) => x.mayStand)) {
      expect(["reply-length", "reader-load", "reply-pace"]).toContain(f.ruleId);
    }
  });

  it("returns the reply judge's checks as questions", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "reply" }, rulesOnlyIo());
    expect(report.review.map((q) => q.split(":")[0])).toEqual([
      "unexplained-terms",
      "no-let-up",
      "answers-a-question-nobody-asked",
    ]);
  });

  it("ignores a banned phrase quoted inside a code block", () => {
    const report = checkDraft({ text: "The rule flags this:\n\n```text\nWe leverage this.\n```", kind: "reply" }, rulesOnlyIo());
    expect(ids(report)).not.toContain("leverage");
  });

  it("does not let a suppression comment hide a finding", () => {
    const text = "<!-- plain-english-disable-next-line leverage: quoted -->\nWe leverage this.";
    expect(ids(checkDraft({ text, kind: "reply" }, rulesOnlyIo()))).toContain("leverage");
    expect(ids(checkDraft({ text, kind: "document" }, rulesOnlyIo()))).toContain("leverage");
  });
});

describe("checkDraft on a document", () => {
  it("reports a banned word and applies no reply limit", () => {
    expect(ids(checkDraft({ text: "We leverage this approach.", kind: "document" }, rulesOnlyIo()))).toContain("leverage");
    expect(ids(checkDraft({ text: LONG, kind: "document" }, rulesOnlyIo()))).not.toContain("reply-length");
  });

  it("returns the document judge's faults of shape as questions", () => {
    const report = checkDraft({ text: "The build takes two minutes.", kind: "document" }, rulesOnlyIo());
    expect(report.review).toHaveLength(8);
    for (const question of report.review) expect(question).toMatch(/^[a-z0-9-]+: \S/);
  });
});

describe("checkDraft on input it cannot check", () => {
  it.each([
    [null, "object"],
    ["We leverage this.", "object"],
    [{ text: "x", kind: "email" }, "email"],
    [{ text: "x" }, "kind"],
  ])("refuses %j as invalid", (request, named) => {
    const report = checkDraft(request, rulesOnlyIo());
    expect(report.status).toBe("invalid");
    expect(report.findings).toEqual([]);
    expect(report.notes.join(" ")).toContain(named);
  });

  it("refuses empty text as invalid and keeps the kind", () => {
    const report = checkDraft({ text: "  \n", kind: "reply" }, rulesOnlyIo());
    expect(report).toMatchObject({ status: "invalid", kind: "reply" });
  });

  it("reports a run that ran out of time as incomplete, never as checked", () => {
    const report = checkDraft({ text: "We leverage this. ".repeat(20000), kind: "document" }, rulesOnlyIo(), { budgetMs: 0 });
    expect(report.status).toBe("incomplete");
    expect(report.notes[0]).toContain("ran out of time");
  });
});
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `npx vitest run test/draft-check.test.ts`
Expected: FAIL, because `../src/draft-check.ts` does not exist.

- [ ] **Step 3: Export `JUDGEABLE`**

In `src/adapters/chat.ts`, line 161, change:

```ts
const JUDGEABLE = new Set(["reply-length", "reader-load", "reply-pace"]);
```

to:

```ts
export const JUDGEABLE: ReadonlySet<string> = new Set(["reply-length", "reader-load", "reply-pace"]);
```

- [ ] **Step 4: Write `src/draft-check.ts`**

```ts
/**
 * Check one draft passed as text (ADR-009).
 *
 * The plain-english skill's script calls this in Claude chat and Cowork,
 * where there is no project, no session and no hook event. The caller is the
 * model, so the checks a judge makes in Claude Code come back as questions
 * for it to answer about its own draft.
 */

import { HOOK_BUDGET_MS } from "./adapters/hook.ts";
import { JUDGEABLE } from "./adapters/chat.ts";
import type { CheckerIo } from "./io.ts";
import { DEFAULT_BUDGET_MS, lintText, type Finding } from "./lint.ts";
import { chatRuleSet, compile, loadDefault } from "./rules.ts";

export type DraftKind = "reply" | "document";

export interface DraftFinding {
  ruleId: string;
  severity: "error" | "warn";
  line: number;
  column: number;
  /** The matched passage. */
  quote: string;
  /** What to do about it. */
  message: string;
  /** A count the person's request can justify, such as length they asked for. */
  mayStand?: true;
}

export interface DraftReport {
  status: "checked" | "incomplete" | "invalid";
  kind?: DraftKind;
  findings: DraftFinding[];
  /** Questions only a reader can answer. */
  review: string[];
  /** Why a report is incomplete or invalid. */
  notes: string[];
}

export interface DraftCheckOptions {
  /** Milliseconds all rules may spend matching. Tests pass 0 to force a timeout. */
  budgetMs?: number;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function asFinding(f: Finding): DraftFinding {
  return {
    ruleId: f.ruleId,
    severity: f.severity,
    line: f.line,
    column: f.column,
    quote: f.match,
    message: f.message ?? "",
    ...(JUDGEABLE.has(f.ruleId) ? { mayStand: true as const } : {}),
  };
}

export function checkDraft(request: unknown, io: CheckerIo, options: DraftCheckOptions = {}): DraftReport {
  const invalid = (note: string, kind?: DraftKind): DraftReport => ({
    status: "invalid",
    ...(kind ? { kind } : {}),
    findings: [],
    review: [],
    notes: [note],
  });
  if (request === null || typeof request !== "object") {
    return invalid("The request must be an object with text and kind.");
  }
  const { text, kind } = request as Record<string, unknown>;
  if (kind !== "reply" && kind !== "document") {
    return invalid(`The kind must be reply or document; got ${kind === undefined ? "none" : JSON.stringify(kind)}.`);
  }
  if (typeof text !== "string" || !text.trim()) {
    return invalid("The text is empty, so there is no draft to check.", kind);
  }

  const base = compile(loadDefault(io));
  const reply = kind === "reply";
  const result = lintText(reply ? text.trim() : text, reply ? chatRuleSet(base) : base, {
    // A draft carries no waivers, and one that quotes the directive syntax is
    // not writing one.
    allowInlineSuppression: false,
    budgetMs: options.budgetMs ?? (reply ? HOOK_BUDGET_MS : DEFAULT_BUDGET_MS),
  });

  const findings = result.findings.map(asFinding);
  const review = reply
    ? base.chat.judge.map((check) => `${check.id}: ${oneLine(check.description)}`)
    : base.docs.guidance.flatMap((g) => (g.flag ? [`${g.id}: ${oneLine(g.flag)}`] : []));

  if (result.timedOut.length) {
    const rules = [...result.timedOut].sort().join(", ");
    return { status: "incomplete", kind, findings, review, notes: [`These rules ran out of time and did not report: ${rules}.`] };
  }
  return { status: "checked", kind, findings, review, notes: [] };
}
```

- [ ] **Step 5: Run the tests to watch them pass**

Run: `npx vitest run test/draft-check.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Export from the core**

Add to `src/plugin-core.ts`, after the `lintText` line:

```ts
export { checkDraft, type DraftCheckOptions, type DraftFinding, type DraftKind, type DraftReport } from "./draft-check.ts";
```

Then update the file's opening comment, which says the module holds "Everything the Claude Code plugin's mod calls (ADR-008)", to read:

```ts
/**
 * Everything the Claude Code plugin's mod calls (ADR-008), and the draft
 * check its writing skill's script calls (ADR-009).
```

- [ ] **Step 7: Build and run the whole suite**

Run: `npm test`
Expected: PASS. `pretest` rebuilds `integrations/claude-code-plugin/hooks/core/`; the bundle now carries `checkDraft`.

- [ ] **Step 8: Commit**

```bash
git add src/draft-check.ts src/adapters/chat.ts src/plugin-core.ts test/draft-check.test.ts integrations/claude-code-plugin/hooks/core
git commit -F <message file>
```

Message: `feat(core): check a draft passed as text, for the writing skill (#130)`, with a body naming the three statuses and the no-file, no-state, no-model constraint.

---

### Task 2: Generate the skill's `SKILL.md`

**Files:**
- Modify: `src/render.ts` (new `WRITING_SKILL_NAME`, `writingSkillPath`, `renderWritingSkill`; one new `renderAll` target)
- Create (generated): `integrations/claude-code/skills/plain-english/SKILL.md`
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `styleBody(ruleset, level)` and `wrap(text)` in `src/render.ts`; `ruleset.chat.level`.
- Produces: `renderWritingSkill(ruleset: RuleSet): string`, `writingSkillPath(): string` returning `integrations/claude-code/skills/plain-english/SKILL.md`, and `WRITING_SKILL_NAME = "plain-english"`. Task 3 copies the generated file into the plugin.

- [ ] **Step 1: Write the failing tests**

Add `renderWritingSkill` and `writingSkillPath` to the import list at the top of `test/render.test.ts`, then append:

```ts
describe("renderWritingSkill", () => {
  const set = compile(loadDefault());
  const skill = renderWritingSkill(set);

  it("is a skill named plain-english, with a description the host can load it from", () => {
    const front = skill.split("\n---\n")[0];
    expect(front).toMatch(/^---\nname: plain-english\ndescription: .+/);
    const description = front.match(/description: (.*)/)?.[1] ?? "";
    // An older help article caps it at 200 characters; the skills guide at 1,024.
    expect(description.length).toBeLessThanOrEqual(200);
    for (const task of ["email", "report", "question", "review"]) expect(description).toContain(task);
  });

  it("carries the reply rules the output style carries, so the two cannot drift", () => {
    const style = renderOutputStyle(set);
    const body = style.slice(style.indexOf("## What this applies to"));
    expect(skill).toContain(body.trim());
  });

  it("says when to check, how to run the script, and what to do with each status", () => {
    expect(skill).toContain("longer than about 100 words");
    expect(skill).toContain('node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" reply');
    expect(skill).toContain("`scripts/check.mjs`");
    for (const status of ["checked", "incomplete", "invalid", "unavailable", "mayStand", "review"]) {
      expect(skill).toContain(status);
    }
    expect(skill).toContain("In Claude Code");
  });

  it("carries no line that runs a command when the skill loads", () => {
    // The directory holds a skill line of the form !`command` that runs a file
    // from a subfolder.
    expect(skill).not.toMatch(/!`/);
  });

  it("is one of the files render writes", () => {
    const paths = renderAll(set, "/repo").map((t) => t.path);
    expect(paths).toContain(resolve("/repo", writingSkillPath()));
  });
});
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `npx vitest run test/render.test.ts -t renderWritingSkill`
Expected: FAIL, because `renderWritingSkill` is not exported.

- [ ] **Step 3: Write the renderer**

In `src/render.ts`, after `renderDocsSkill`, add:

```ts
/** The writing skill's name, and the folder build-plugin copies (ADR-009). */
export const WRITING_SKILL_NAME = "plain-english";

export function writingSkillPath(): string {
  return `integrations/claude-code/skills/${WRITING_SKILL_NAME}/SKILL.md`;
}

// Under 200 characters: an older help article caps a description there.
const WRITING_SKILL_DESCRIPTION =
  "Plain-English writing rules and a draft checker. Use when answering a question, " +
  "drafting an email, report or document, or reviewing prose. Not for code.";

/**
 * The writing skill for Claude chat and Cowork, where output styles do not
 * load (ADR-009).
 *
 * The reply rules come from `styleBody`, the same lines the output style and
 * the AGENTS fragment use. The instructions for running the checker live here
 * and not in the ruleset, because they describe this package's script, not a
 * writing rule.
 */
export function renderWritingSkill(ruleset: RuleSet): string {
  const out: string[] = [
    "---",
    `name: ${WRITING_SKILL_NAME}`,
    `description: ${WRITING_SKILL_DESCRIPTION}`,
    "---",
    "",
    "<!-- GENERATED by `plain-english render` from rules/default.yml. Do not edit. -->",
    "",
    "# Plain English",
    "",
    ...wrap(
      "These rules make a reply or a draft readable on the first pass. A checker in this " +
        "skill's `scripts` folder finds the faults a pattern can catch, and returns questions " +
        "about the ones only a reader can judge.",
    ),
    "",
    "## When to run the check",
    "",
    ...wrap(
      "Run it on every document, email or report you write, and on any reply longer than " +
        "about 100 words. Shorter replies follow the rules below without a check.",
    ),
    "",
    ...wrap(
      "In Claude Code, do not run it. The plain-english plugin already checks there, so " +
        "follow the rules and skip the script.",
    ),
    "",
    "## How to run it",
    "",
    "```sh",
    "node \"${CLAUDE_SKILL_DIR}/scripts/check.mjs\" reply <<'DRAFT'",
    "<the draft>",
    "DRAFT",
    "```",
    "",
    ...wrap(
      "Use `document` in place of `reply` for an email, report or other document. " +
        "Cowork replaces the folder placeholder for you. In chat it stays as written: use " +
        "`scripts/check.mjs` in the folder that holds this file. Install nothing and use no " +
        "network: the checker needs only Node.",
    ),
    "",
    "## What to do with the report",
    "",
    ...wrap("- `checked` with findings: fix each one, then run the check once more. Run it at most twice for one draft.", "  "),
    ...wrap("- A finding with `mayStand` counts length or names. Keep it when the person asked for depth.", "  "),
    ...wrap("- `review`: answer each question about your own draft, and fix what it finds.", "  "),
    ...wrap("- `checked` with no findings: send the draft without mentioning the check.", "  "),
    ...wrap("- `invalid`: the call was wrong. Fix the kind or the empty text and run it again once.", "  "),
    ...wrap(
      "- `incomplete`, `unavailable`, or no `node`: send the draft and add one line saying it " +
        "was not fully checked.",
      "  ",
    ),
    ...wrap(
      "- Prose someone supplies with \"check this\": run it with the kind that fits, quote the " +
        "findings, and edit only as far as they asked. A light edit fixes clear faults only.",
      "  ",
    ),
    "",
    "# The rules for a reply",
    "",
    ...styleBody(ruleset, ruleset.chat.level),
  ];
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
```

Check `wrap`'s signature before use: `renderDocsSkill` calls `wrap(text)` and `wrap(text, "  ")`, so both forms exist.

- [ ] **Step 4: Add the render target**

In `renderAll`, after the guarded docs-skill entry, add:

```ts
    { path: resolve(root, ...writingSkillPath().split("/")), content: renderWritingSkill(ruleset) },
```

- [ ] **Step 5: Run the tests to watch them pass**

Run: `npx vitest run test/render.test.ts`
Expected: PASS. If an existing test pins the number of files `renderAll` returns, raise that number by one: the new skill is one more generated file.

- [ ] **Step 6: Generate the file and check it**

Run: `npx tsc -p tsconfig.json && node dist/cli.js render`
Then: `npm run render -- --check`
Expected: `generated files are up to date`. Read `integrations/claude-code/skills/plain-english/SKILL.md` once from top to bottom: the instructions come first, then `# The rules for a reply`.

- [ ] **Step 7: Commit**

```bash
git add src/render.ts test/render.test.ts integrations/claude-code/skills/plain-english/SKILL.md
git commit -F <message file>
```

Message: `feat(render): generate the writing skill for chat and Cowork (#130)`.

---

### Task 3: Move the core into the skill, and add the script

**Files:**
- Create: `integrations/claude-code/skills/plain-english/scripts/check.mjs`
- Modify: `scripts/build-plugin.mjs` (core folder; leftover check for `hooks/core/`; `version.mjs`; guidance paths)
- Modify: `integrations/claude-code-plugin/hooks/register.ts:5-9` (the two core imports)
- Modify: `src/plugin-core.ts` (opening comment names the new folder)
- Modify: `test/claude-code-plugin.test.ts`
- Built: `integrations/claude-code-plugin/skills/plain-english/` (`SKILL.md`, `scripts/check.mjs`, `scripts/version.mjs`, `scripts/core/*.mjs`); `integrations/claude-code-plugin/hooks/core/` is removed

**Interfaces:**
- Consumes: `checkDraft` and `pathsFor` from the bundled `plugin-core.mjs` (Task 1); the generated `SKILL.md` (Task 2).
- Produces: `node scripts/check.mjs <reply|document>` with the draft on standard input. It prints `DraftReport` plus `version` as JSON, or `{"status":"unavailable", ...}`. Exit 0 checked with no errors, 1 checked with errors, 2 otherwise. The mod imports the core from `../skills/plain-english/scripts/core/`.

- [ ] **Step 1: Point the existing tests at the new folder**

In `test/claude-code-plugin.test.ts`, change only these code lines. Leave the comments that quote past directory messages, such as `hooks/core/chunk-6VUKDY2J.mjs`, as they are: they record what the directory said at the time.

- Line 37: `const CORE = resolve(PLUGIN, "hooks/core");` becomes:

```ts
  const CORE_PATH = "skills/plain-english/scripts/core";
  const CORE = resolve(PLUGIN, CORE_PATH);
```

- Line 38: in `coreFiles`, `` `hooks/core/${name}` `` becomes `` `${CORE_PATH}/${name}` ``.
- Every `import("../integrations/claude-code-plugin/hooks/core/...")` (lines 260, 261, 295, 302, 303 and 449) becomes `import("../integrations/claude-code-plugin/skills/plain-english/scripts/core/...")`.
- Line 446: `resolve(PLUGIN, "hooks/core/plugin-core.mjs")` becomes `resolve(PLUGIN, "skills/plain-english/scripts/core/plugin-core.mjs")`.
- In the test "start no program, and carry no Node, eval or uppercase template the directory flags", after `expect(existsSync(resolve(PLUGIN, "dist"))).toBe(false);`, add:

```ts
    // The core moved into the writing skill (ADR-009), and only one copy ships.
    expect(existsSync(resolve(PLUGIN, "hooks/core"))).toBe(false);
```

- In the test "ships the existing writing guidance without changing it", add to the path list:

```ts
      "skills/plain-english/SKILL.md",
      "skills/plain-english/scripts/check.mjs",
```

- [ ] **Step 2: Write the failing tests for the skill**

Change the `node:child_process` import at the top of the file to `import { spawn, spawnSync } from "node:child_process";`, add `afterAll, beforeAll` to the `vitest` import, and append:

```ts
/**
 * The writing skill as Claude chat receives it (ADR-009). Chat copies a
 * skill's own folder into its code environment and nothing else from the
 * plugin, so the checker's core lives inside the skill and runs from there.
 */
describe("the plain-english skill as chat receives it", () => {
  const SKILL = resolve(PLUGIN, "skills/plain-english");
  const filesIn = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name).slice(dir.length + 1))
      .sort();

  it("names the package version the plugin does", async () => {
    const { default: version } = await import("../integrations/claude-code-plugin/skills/plain-english/scripts/version.mjs");
    expect(version).toBe(json(resolve(ROOT, "package.json")).version);
  });

  it("keeps every path within three segments of the skill root", () => {
    for (const file of filesIn(SKILL)) expect(file.split(/[\\/]/).length, file).toBeLessThanOrEqual(3);
  });

  it("runs a script that imports no Node module, builds no code and starts nothing", () => {
    const text = readFileSync(resolve(SKILL, "scripts/check.mjs"), "utf8");
    expect(text).not.toMatch(/from\s*["']node:|import\(\s*["']node:|require\(/);
    expect(text).not.toMatch(/\beval\b|\bnew Function\b|child_process|\bspawn(?:Sync)?\(/);
    expect(text).not.toMatch(/https?:\/\//);
  });

  describe("run from a folder holding only the skill", () => {
    let work = "";
    let copy = "";
    beforeAll(() => {
      work = mkdtempSync(resolve(tmpdir(), "pe-skill-"));
      copy = resolve(work, "plain-english");
      cpSync(SKILL, copy, { recursive: true });
    });
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    const run = (args: string[], input: string, folder = copy) => {
      const result = spawnSync(process.execPath, [resolve(folder, "scripts/check.mjs"), ...args], {
        cwd: work, input, encoding: "utf8", timeout: 30_000,
      });
      // A crash prints to standard error and leaves standard output empty.
      expect(result.stderr, result.stderr).toBe("");
      return { code: result.status, report: JSON.parse(result.stdout) as Record<string, unknown> & { findings: { ruleId: string }[] } };
    };

    it("finds problems in a reply and exits 1", () => {
      const { code, report } = run(["reply"], "Great question. We leverage this approach.");
      expect(code).toBe(1);
      expect(report.status).toBe("checked");
      expect(report.version).toBe(json(resolve(ROOT, "package.json")).version);
      expect(report.findings.map((f) => f.ruleId)).toContain("leverage");
    });

    it("passes a clean reply and exits 0", () => {
      expect(run(["reply"], "The build takes two minutes.")).toMatchObject({ code: 0, report: { status: "checked", findings: [] } });
    });

    it("applies no reply limit to a document", () => {
      const long = Array(60).fill("The build takes two minutes.").join(" ");
      expect(run(["document"], long).report.findings.map((f) => f.ruleId)).not.toContain("reply-length");
    });

    it("reports empty input as invalid and exits 2", () => {
      expect(run(["reply"], "")).toMatchObject({ code: 2, report: { status: "invalid" } });
    });

    it.each([[[]], [["Reply"]]])("reports a missing or misspelled kind %j as invalid and exits 2", (args) => {
      const { code, report } = run(args, "The build takes two minutes.");
      expect(code).toBe(2);
      expect(report.status).toBe("invalid");
    });

    it("answers a very large draft with a report, not a crash", () => {
      const { report } = run(["document"], "The build takes two minutes. ".repeat(10_000));
      expect(["checked", "incomplete"]).toContain(report.status);
    });

    it("gives up on input that never closes and reports invalid", async () => {
      const child = spawn(process.execPath, [resolve(copy, "scripts/check.mjs"), "reply"], { cwd: work });
      child.stdin.write("The build takes two minutes.");
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      const code = await new Promise<number | null>((done) => child.on("close", done));
      expect(code).toBe(2);
      expect(JSON.parse(out).status).toBe("invalid");
    }, 20_000);

    it("reports unavailable and exits 2 when the core does not load", () => {
      const broken = resolve(work, "broken");
      cpSync(copy, broken, { recursive: true });
      rmSync(resolve(broken, "scripts/core/plugin-core.mjs"));
      expect(run(["reply"], "The build takes two minutes.", broken)).toMatchObject({ code: 2, report: { status: "unavailable" } });
    });
  });
});
```

The very large draft is 290,000 characters, and a measured run took 598 to 680 ms against the 2,000 ms budget. The test still accepts `incomplete`, because which status a slow machine reaches is not the property under test. The never-closing test waits out the script's 10-second limit, so it carries its own 20-second timeout.

- [ ] **Step 3: Run the tests to watch them fail**

Run: `npx vitest run test/claude-code-plugin.test.ts`
Expected: FAIL. The existing directory tests fail on the missing `skills/plain-english/scripts/core`, and the new block fails on the missing skill folder.

- [ ] **Step 4: Write the script**

Create `integrations/claude-code/skills/plain-english/scripts/check.mjs`:

```js
// The plain-english skill's draft check (ADR-009). Claude runs it on a draft
// in chat or Cowork: the kind is the one argument, the draft arrives on
// standard input, and a JSON report goes to standard output. Exit 0 when the
// draft is clean, 1 when it has errors, 2 when it was not checked. It
// installs nothing, reads no file and opens no connection.

const kind = process.argv[2];

// Read only when the kind is valid, and stop waiting after 10 seconds. Input
// that never closes would otherwise hold the script until the caller's own
// timeout.
let text = "";
let readFailed = "";
if (!process.stdin.isTTY && (kind === "reply" || kind === "document")) {
  process.stdin.setEncoding("utf8");
  const timer = setTimeout(() => {
    readFailed = "Standard input did not close within 10 seconds. Pass the draft with a heredoc.";
    process.stdin.destroy();
  }, 10_000);
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch (error) {
    readFailed ||= `Standard input failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

let report;
try {
  const core = await import("./core/plugin-core.mjs");
  const { default: rules } = await import("./core/default-rules.mjs");
  const { default: version } = await import("./version.mjs");
  const nothing = () => undefined;
  const io = {
    cwd: "/",
    path: core.pathsFor("/"),
    env: {},
    home: undefined,
    now: () => Date.now(),
    notice: nothing,
    read: nothing,
    stat: nothing,
    list: nothing,
    state: { get: nothing, set: () => false },
    defaultRules: () => rules,
  };
  report = readFailed
    ? { status: "invalid", kind, findings: [], review: [], notes: [readFailed], version }
    : { ...core.checkDraft({ text, kind }, io), version };
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  report = { status: "unavailable", findings: [], review: [], notes: [`The checker did not load: ${reason}`] };
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.status !== "checked" ? 2 : report.findings.some((f) => f.severity === "error") ? 1 : 0;
```

A missing or misspelled kind skips the read and reaches `checkDraft` with empty text. `checkDraft` checks the kind first, so the report names the kind.

- [ ] **Step 5: Move the core in the build**

In `scripts/build-plugin.mjs`:

1. Change `const coreDir = resolve(plugin, "hooks", "core");` to:

```js
// The checker's core lives inside the writing skill, the one folder Claude
// chat copies into its code environment. The mod imports it from there, so
// one copy serves both (ADR-009).
const coreDir = resolve(plugin, "skills", "plain-english", "scripts", "core");
const oldCoreDir = resolve(plugin, "hooks", "core");
const skillVersionTo = resolve(plugin, "skills", "plain-english", "scripts", "version.mjs");
```

`rulesTo` is already defined from `coreDir`, so the ruleset moves with it.

2. Add to `guidancePaths`:

```js
  "skills/plain-english/SKILL.md",
  "skills/plain-english/scripts/check.mjs",
```

3. In the main block, after `const pkg = pluginPackageJson(version);`, add:

```js
  const skillVersion = `// GENERATED by scripts/build-plugin.mjs from package.json. Do not edit.\nexport default ${JSON.stringify(version)};\n`;
```

4. In the stale checks, change each `hooks/core/` label to `skills/plain-english/scripts/core/` (three places: the changed-file push, the leftover push and the `default-rules.mjs` push). After the `dist/` leftover check, add:

```js
  if (existsSync(oldCoreDir)) stale.push("hooks/core/ (moved into skills/plain-english/scripts/core/)");
  if (!existsSync(skillVersionTo) || readFileSync(skillVersionTo, "utf8") !== skillVersion) {
    stale.push("skills/plain-english/scripts/version.mjs");
  }
```

5. In the write branch, after `rmSync(coreDir, { recursive: true, force: true });`, add `rmSync(oldCoreDir, { recursive: true, force: true });`. After `writeFileSync(rulesTo, rules, "utf8");`, add `writeFileSync(skillVersionTo, skillVersion, "utf8");`. Change the final message's `integrations/claude-code-plugin/hooks/core/` to `integrations/claude-code-plugin/skills/plain-english/scripts/core/`.

6. Update the two comments that name `hooks/core/` (the file's opening comment and the one above `bundleCore`) to the new folder.

- [ ] **Step 6: Point the mod at the new folder**

In `integrations/claude-code-plugin/hooks/register.ts`, change the two imports:

```ts
} from '../skills/plain-english/scripts/core/plugin-core.mjs'
import DEFAULT_RULES from '../skills/plain-english/scripts/core/default-rules.mjs'
```

In `src/plugin-core.ts`, change "bundles this into `hooks/core/`" to "bundles this into `skills/plain-english/scripts/core/`, where the mod and the writing skill's script both import it".

- [ ] **Step 7: Build, and run the tests to watch them pass**

Run: `npm run build && npx vitest run test/claude-code-plugin.test.ts`
Expected: PASS. The build removes `hooks/core/` and writes the skill folder. Then run `node scripts/build-plugin.mjs --check` and expect `plugin: bundle and ruleset match the working tree`.

- [ ] **Step 8: Run Anthropic's checks**

Run each, from the repository root:

```bash
claude plugin validate --strict .
claude plugin validate --strict integrations/claude-code-plugin
claude plugin test integrations/claude-code-plugin
```

Expected: `✔ Validation passed` twice, then `36 pass` and `0 fail`. A probe on 10 October gave exactly these results for this layout on Claude Code 2.1.296. The README warning about a missing install line is not new; the README leaves the install command out on purpose.

- [ ] **Step 9: Run the whole suite**

Run: `npm test && npm run render -- --check && npm run policy:check`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A integrations/claude-code-plugin integrations/claude-code/skills/plain-english/scripts/check.mjs scripts/build-plugin.mjs src/plugin-core.ts test/claude-code-plugin.test.ts
git commit -F <message file>
```

Message: `feat(claude-code): move the checker into the writing skill and add its script (#130)`. `-A` on the plugin folder records the removal of `hooks/core/`.

---

### Task 4: Listing text, documentation, decision record and release

**Files:**
- Create: `docs/architecture/adr/009-checker-ships-in-a-skill.md`
- Modify: `integrations/claude-code-plugin/.claude-plugin/plugin.json` (`description`)
- Modify: `.claude-plugin/marketplace.json` (both `description` fields)
- Modify: `integrations/claude-code-plugin/README.md` (core path in three places; a section per app; a reviewer subsection)
- Modify: `CONTRIBUTING.md:60` (core path)
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json` (bump)

**Interfaces:**
- Consumes: everything built in Tasks 1 to 3.
- Produces: the release.

- [ ] **Step 1: Make the listing text match each app**

The directory policy says "descriptions must precisely match actual functionality", and the listing reads `plugin.json` and the README. Set `description` in `integrations/claude-code-plugin/.claude-plugin/plugin.json` to:

```text
Catches stock AI phrases, vague claims and unexplained jargon before a reader sees them. In Claude Code it checks Markdown writes, commit and pull request messages and tracker issues, and holds a chat reply with a clear tell for a rewrite. In Claude chat and Cowork, a writing skill gives Claude the rules and checks substantial drafts.
```

In `.claude-plugin/marketplace.json`, set the marketplace `description` to `The plain-english prose linter: a Claude Code mod that refuses writes and holds replies, and a writing skill for Claude chat and Cowork.`, and the plugin entry's `description` to `Catches stock AI phrases, vague claims and unexplained jargon. Checks writes and replies in Claude Code, and drafts in Claude chat and Cowork.`

- [ ] **Step 2: Update the plugin README**

In `integrations/claude-code-plugin/README.md`:

- Line 11: "The plugin carries the checker's core under `hooks/core/`" becomes "The plugin carries the checker's core under `skills/plain-english/scripts/core/`, inside the writing skill, so the mod and the skill share one copy".
- Line 113: "`hooks/core/` is the checker from this repository" becomes "`skills/plain-english/scripts/core/` is the checker from this repository".
- Line 138: "writes the checker's core and the ruleset into `hooks/core/`" becomes "writes the checker's core and the ruleset into `skills/plain-english/scripts/core/`".

After the Install section, add:

```markdown
## What each Claude app gets

- **Claude Code:** the mod. It checks Markdown writes, commit and pull request messages and tracker issues before they are saved, and holds a chat reply with a clear tell for a rewrite.
- **Claude chat and Cowork:** the writing skill, `plain-english`. Claude loads it when a request fits its description, such as drafting an email or a report. It gives Claude the reply rules and checks every document and any reply over about 100 words. The check runs in Claude's own code environment and sends nothing anywhere.

A skill loads only when the request fits, so an ordinary question may not load it. To have replies checked as a rule, add this sentence to your profile instructions: "Use the plain-english skill for any prose you write for me." You can also pick the skill by typing `/` in the message box. The plugin changes no settings itself.
```

Under `## For reviewers: what the plugin runs, reads, writes and sends`, before `### Bundled code`, add:

```markdown
### The writing skill's script

`skills/plain-english/scripts/check.mjs` is a script the skill's instructions ask Claude to call on a draft in chat or Cowork. No hook or event starts it, and in Claude Code the instructions say not to call it. It reads the draft from standard input, prints a JSON report and exits. It imports no Node module, reads no file, opens no connection and starts no program. It imports the same core the mod does, from the folder beside it.
```

Run: `npx vitest run test/claude-code-plugin.test.ts -t README`
Expected: PASS. If the sentence test fails, find the sentence that pairs a download or fetch word with a run word, and split it.

- [ ] **Step 3: Update CONTRIBUTING**

In `CONTRIBUTING.md`, line 60, change `integrations/claude-code-plugin/hooks/core/` to `integrations/claude-code-plugin/skills/plain-english/scripts/core/`.

- [ ] **Step 4: Write the decision record**

Copy `docs/architecture/adr/_template.md` to `docs/architecture/adr/009-checker-ships-in-a-skill.md` and fill its headings:

- **Status:** Accepted. **Date:** the day of the commit.
- **Context:** output styles and mods do not load in Claude chat or Cowork; skills do. The 10 October live test ran the bundled checker in chat on the web and the phone on Node `v22.22.0`; no Anthropic page promises Node there. Chat copies a skill's own folder only. The directory portal lists the plugin for all three apps.
- **Decision:** the checker's core moves from `hooks/core/` into `skills/plain-english/scripts/core/`, and the mod imports it from there. A script beside it calls `checkDraft`, which returns `checked`, `incomplete` or `invalid`; the script adds `unavailable`. It reads no file, keeps no state and makes no model call. Judge checks come back as questions.
- **Consequences:** one copy of the core. The mod's imports reach into the skill's folder. In Claude Code the skill's instructions say not to run the script. Replies are checked only when the skill loads, so the README offers a profile sentence.
- **Alternatives considered:** four, each rejected.
  - Faking a Claude Code hook event couples the skill to that format, and a failed check looks clean.
  - The self-contained command-line file from the pre-commit integration is about 1.6 MB, over the 262,144-byte limit.
  - A second copy of the core in the skill puts the same code through the directory's scan on every version.
  - A separate plugin for chat and Cowork means two listings and two reviews; the portal showed one plugin can be listed everywhere.
- **Re-evaluation triggers:** chat stops providing Node 20 or later; the directory flags the mod importing from a skill folder; the portal stops listing the plugin outside Claude Code.

- [ ] **Step 5: Changelog and bump**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- The Claude Code plugin carries a writing skill, `plain-english`, for Claude chat and Cowork. It gives Claude the reply rules there, and checks a substantial draft with a script that runs the plugin's own checker. The checker's core gains `checkDraft`, which checks a reply or document passed as text and reports whether every check ran.

### Changed

- The plugin's bundled checker moved from `hooks/core/` to `skills/plain-english/scripts/core/`, so the mod and the writing skill share one copy.
```

Bump the minor version with the command in `AGENTS.md` (`npm version minor` with the flag that skips the tag), then run `npm run build` so the plugin's `package.json` and the skill's `version.mjs` follow the new version.

- [ ] **Step 6: Verify everything**

Run: `npm test && npm run render -- --check && npm run policy:check && npm run lint:self`
Then the three commands from Task 3, Step 8.
Expected: all PASS.

- [ ] **Step 7: Commit**

Stage `docs/architecture/adr/009-checker-ships-in-a-skill.md`, `integrations/claude-code-plugin`, `.claude-plugin/marketplace.json`, `CONTRIBUTING.md`, `CHANGELOG.md`, `package.json` and `package-lock.json`, and commit with a message file.

Message: `docs(claude-code): record ADR-009 and release the writing skill (#130)`.

- [ ] **Step 8: Ship**

Follow the `pe-ship` skill from its Step 6: push, open the pull request, wait for CI, hand over the merge command. The hand checks in the spec's "What must hold before release" come before the directory submission for this first version, and before merging for any later one.
