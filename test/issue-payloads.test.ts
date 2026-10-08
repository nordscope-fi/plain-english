import { describe, expect, it } from "vitest";
import { extractFromIssue, decide } from "../src/adapters/hook.ts";
import { issueFields } from "../src/agents/fields.ts";
import { ISSUE_TOOLS, ISSUE_TOOL_PATTERN } from "../src/agents/issue.ts";
import { byId } from "../src/agents/registry.ts";
import { compile, loadDefault } from "../src/rules.ts";

const BAD = "We leverage this.";
const GOOD = "The cache expires hourly.";
const strict = compile({ ...loadDefault(), failOn: "error" });
const text = (value: string) => ({ type: "text", text: value });
const adf = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });

describe("reader-visible issue and page fields", () => {
  it.each([
    { summary: BAD }, { fields: { summary: BAD } },
    { fields: { description: BAD } }, { commentBody: BAD }, { content: BAD },
    { description: adf(paragraph(text(BAD))) },
    { body: { storage: { value: `<p>${BAD}</p>`, representation: "storage" } } },
    { content: `<p>${BAD}</p>` },
    { contentFormat: "adf", content: JSON.stringify(adf(paragraph(text(BAD)))) },
    { body: { atlas_doc_format: { representation: "atlas_doc_format", value: JSON.stringify(adf(paragraph(text(BAD)))) } } },
  ])("finds introduced prose in %j", input => {
    expect(extractFromIssue(input).join("\n")).toContain(BAD);
  });

  it("preserves all supplied fields and canonical patch replacements on repeated normalization", () => {
    const input = { title: "A title", summary: "A summary", fields: { summary: "Nested summary", description: "Nested description" }, description: "A description", body: "A body", commentBody: "A comment", content: "Page content", patch: [{ old_string: BAD, new_string: "Replacement" }] };
    const canonical = issueFields(input);
    expect(issueFields(canonical)).toEqual(canonical);
    expect(extractFromIssue(canonical)).toEqual(["A title\n\nA summary\n\nNested summary", "A description\n\nNested description", "A body\n\nA comment\n\nPage content", "Replacement"]);
  });

  it("skips rich-text code, quotes, URLs and attributes", () => {
    const input = { description: adf(
      paragraph(text(GOOD), { ...text(BAD), marks: [{ type: "code" }] }),
      { type: "codeBlock", content: [text(BAD)] },
      { type: "blockquote", content: [paragraph(text(BAD))] },
      { type: "media", attrs: { title: BAD } },
      paragraph({ ...text("A link."), marks: [{ type: "link", attrs: { href: BAD } }] }),
    ) };
    const parts = extractFromIssue(input);
    expect(parts.join("\n")).toContain(GOOD);
    expect(parts.join("\n")).toContain("A link.");
    expect(parts.join("\n")).not.toContain(BAD);
  });

  it("decodes visible HTML text but ignores code and hidden content", () => {
    const input = { content: `<p title="${BAD}">The cache &amp; queue.</p><!-- ${BAD} --><script>${BAD}</script><style>${BAD}</style><pre>${BAD}</pre><code>${BAD}</code><blockquote>${BAD}</blockquote><ac:structured-macro ac:name="code"><ac:plain-text-body>${BAD}</ac:plain-text-body></ac:structured-macro><p>The cache expires.</p>` };
    const value = extractFromIssue(input).join("\n");
    expect(value).toContain("The cache & queue.");
    expect(value).toContain("The cache expires.");
    expect(value).not.toContain(BAD);
  });

  it("ignores metadata, removed text and unsupported containers in partial updates", () => {
    expect(extractFromIssue({ fields: { labels: [BAD], assignee: { name: BAD } }, issueId: BAD, old_string: BAD, patch: [{ old_string: BAD }], content: { query: BAD } })).toEqual([]);
    expect(extractFromIssue({ fields: { description: null }, summary: GOOD })).toEqual([GOOD]);
  });

  it("preserves word boundaries around omitted inline code", () => {
    expect(extractFromIssue({ content: "<p>lever<code>variable</code>age</p>" }).join("\n")).not.toContain("leverage");
    expect(extractFromIssue({ description: adf(paragraph(text("lever"), { ...text("variable"), marks: [{ type: "code" }] }, text("age"))) }).join("\n")).not.toContain("leverage");
  });

  it("bounds malformed or cyclic rich documents", () => {
    const cycle: Record<string, unknown> = {};
    cycle.content = [cycle];
    expect(extractFromIssue({ description: cycle })).toEqual([]);
    expect(extractFromIssue({ body: { value: "{invalid", representation: "atlas_doc_format" } })).toEqual([]);
    expect(extractFromIssue({ content: "x".repeat(300_000) })[0]!.length).toBe(256 * 1024);
  });
});

describe("write tool selection", () => {
  const writes = ["createJiraIssue", "editJiraIssue", "addOrEditJiraIssueComment", "createConfluenceContent", "updateConfluenceContent", "createConfluenceComment", "updateConfluenceComment", "save_issue", "save_comment"];
  it("matches write names through native MCP prefixes only", () => {
    for (const name of writes) for (const prefix of ["", "MCP:", "mcp__atlassian__", "mcp_atlassian_"]) expect(ISSUE_TOOLS.test(prefix + name), prefix + name).toBe(true);
    for (const name of ["getJiraIssue", "searchJiraIssuesUsingJql", "getConfluenceContent", "createJiraIssue_preview", "previewcreateJiraIssue", "createJiraIssueSomething"]) expect(ISSUE_TOOLS.test(name), name).toBe(false);
  });

  it.each(["copilot", "codex", "cursor", "vibe", "gemini", "qwen", "antigravity"])("checks nested Jira text through the %s native envelope", id => {
    const profile = byId(id)!;
    const args = { fields: { description: adf(paragraph(text(BAD))) } };
    const raw = id === "antigravity" ? { toolCall: { name: "call_mcp_tool", args: { ToolName: "mcp_atlassian_editJiraIssue", Arguments: args } } } : id === "copilot" ? { toolName: "mcp__atlassian__editJiraIssue", toolArgs: JSON.stringify(args) } : { tool_name: "mcp__atlassian__editJiraIssue", tool_input: args };
    expect(decide(profile.parse(raw), "issue", { ruleSet: strict }).decision).toBe("deny");
    expect(JSON.stringify(profile.plan({ prompts: {}, model: "unused" }))).toContain(id === "vibe" ? `re:${ISSUE_TOOL_PATTERN}` : id === "antigravity" ? "createJiraIssue" : ISSUE_TOOL_PATTERN);
  });

  it("leaves unrelated Antigravity MCP relays outside the issue channel", () => {
    const event = byId("antigravity")!.parse({ toolCall: { name: "call_mcp_tool", args: { ToolName: "getConfluenceContent", Arguments: { content: BAD } } } });
    expect(extractFromIssue(event.input)).toEqual([]);
  });
});
