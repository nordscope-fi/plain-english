/**
 * Which tool names write issue or comment text.
 *
 * Its own file so the Claude Code plugin can ship this pattern alone. The
 * plugin's mod needs only the names; bundling `issue.ts` brought its HTML
 * parser along, which the Claude directory held as minified code.
 */

const WRITE_NAMES = "save_(?:issue|comment)|createJiraIssue|editJiraIssue|addOrEditJiraIssueComment|createConfluenceContent|updateConfluenceContent|createConfluenceComment|updateConfluenceComment";
/** Anchored: read tools and names ending in `_preview` must not be selected. */
export const ISSUE_TOOL_PATTERN = `^(?:.*[_:]|MCP:)?(?:${WRITE_NAMES})$`;
export const ISSUE_TOOLS = new RegExp(ISSUE_TOOL_PATTERN);
