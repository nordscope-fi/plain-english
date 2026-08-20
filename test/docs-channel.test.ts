import { describe, expect, it } from "vitest";
import { compile, loadDefault } from "../src/rules.ts";
import { byId } from "../src/agents/registry.ts";
import { renderDocsSkill, renderPrompts, renderAll, renderWritingStyle } from "../src/render.ts";
import { lintText } from "../src/lint.ts";
import { resolve } from "node:path";

const set = compile(loadDefault());

/**
 * The docs channel had a judge and no style.
 *
 * `docs.txt` listed banned terms and sentence shapes to flag, and
 * `docs/writing-style.md` is titled "AI-Tell Patterns to Cut". Both are
 * prohibitions. Nothing anywhere said how a document should be shaped, which
 * is the half `chat.guidance` has carried for the chat channel all along.
 */
describe("the docs channel has guidance, not only prohibitions", () => {
  it("the shipped ruleset carries a docs section", () => {
    expect(set.docs.guidance.length).toBeGreaterThan(2);
    expect(set.docs.scope.length).toBeGreaterThan(0);
    expect(set.docs.skill.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("every docs rule says what it is and what going wrong looks like", () => {
    for (const g of set.docs.guidance) {
      expect(g.name, `${g.id} has no name`).toBeDefined();
      expect(g.description, `${g.id} has no description`).toBeDefined();
      // `flag` is the gate's half: the same rule phrased as the fault, so one
      // list feeds both the skill and the judge and the two cannot disagree.
      expect(g.flag, `${g.id} has no flag for the gate`).toBeDefined();
    }
  });
});

describe("the generated skill", () => {
  const skill = renderDocsSkill(set);

  it("opens with frontmatter a skill loader can read", () => {
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain(`name: ${set.docs.skill.name}`);
    expect(skill).toContain("description:");
    // An output style keeps the host's coding instructions. A skill is not an
    // output style and the key means nothing here.
    expect(skill).not.toContain("keep-coding-instructions");
  });

  it("carries every docs rule", () => {
    for (const g of set.docs.guidance) {
      expect(skill, `skill drops ${g.id}`).toContain(g.name!);
    }
  });

  it("passes the rules it is asking for", () => {
    expect(lintText(skill, set).errorCount).toBe(0);
  });

  it("is one of the files render writes", () => {
    const paths = renderAll(set, "/root").map((t) => t.path);
    expect(paths).toContain(
      resolve("/root", "integrations/claude-code/skills", set.docs.skill.name, "SKILL.md"),
    );
  });
});

describe("the gate learns the same rules", () => {
  const prompts = renderPrompts(set);

  it("docs.txt can flag a fault of shape, not only a banned word", () => {
    for (const g of set.docs.guidance) {
      expect(prompts["docs"], `docs.txt drops ${g.id}`).toContain(g.flag!);
    }
  });

  it("no other channel is asked about document shape", () => {
    // A commit message and an issue body are not documents, and a gate that
    // demands a purpose paragraph from a one-line commit is a gate people
    // switch off.
    for (const channel of ["github", "issue", "chat"]) {
      for (const g of set.docs.guidance) {
        expect(prompts[channel], `${channel}.txt carries ${g.id}`).not.toContain(g.flag!);
      }
    }
  });
});

describe("the reference document says how, before it says what to cut", () => {
  it("writing-style.md carries the docs guidance", () => {
    const doc = renderWritingStyle(set);
    for (const g of set.docs.guidance) expect(doc).toContain(g.name!);
  });
});

describe("installing it", () => {
  const ctx = {
    prompts: renderPrompts(set),
    model: "claude-sonnet-5",
    skills: [
      {
        name: set.docs.skill.name,
        path: `${set.docs.skill.name}/SKILL.md`,
        body: renderDocsSkill(set),
      },
    ],
  };

  it("Claude Code writes the skill beside the styles, not instead of one", () => {
    const plan = byId("claude-code")!.plan(ctx);
    const paths = (plan.files ?? []).map((f) => f.path);
    expect(paths).toContain(`.claude/skills/${set.docs.skill.name}/SKILL.md`);
  });

  it("an agent with no notion of a skill installs what it always did", () => {
    // `skills` is optional on the context and no profile is obliged to read
    // it. Passing it must not change what the other hosts write.
    for (const id of ["codex", "cursor", "copilot", "vibe"]) {
      const agent = byId(id);
      if (!agent) continue;
      const withSkill = (agent.plan(ctx).files ?? []).map((f) => f.path);
      const without = (agent.plan({ ...ctx, skills: [] }).files ?? []).map((f) => f.path);
      expect(withSkill, `${id} changed when handed a skill`).toEqual(without);
    }
  });
});
