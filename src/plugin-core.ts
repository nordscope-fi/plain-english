/**
 * Everything the Claude Code plugin's mod calls (ADR-008), and the draft
 * check its writing skill's script calls (ADR-009).
 *
 * `scripts/build-plugin.mjs` bundles this into `hooks/core/` with no Node:
 * the mod passes its own io to every function, and the Node-only modules the
 * CLI uses by default are replaced with ones that start and record nothing.
 */
export { hookCheck, CONFIGURATION_UNAVAILABLE, type HookResult } from "./hook-check.ts";
export { claudeCodeHook } from "./agents/claude-code-hook.ts";
export { claudeCodeChat } from "./chat/claude-code.ts";
export { emptyFetched, NeedFiles, replay, replayIo, type CheckerIo, type Fetched, type FileFacts } from "./io.ts";
export { pathsFor } from "./paths.ts";
export { ModelRequest, type ModAnswer, type ModAnswers } from "./adapters/judge.ts";
export { approvalPlan, type ApprovalRequest } from "./approve.ts";
export { projectGuidance } from "./guidance.ts";
export { resolveRuleSet } from "./rules.ts";
export { lintText } from "./lint.ts";
export { checkDraft, type DraftCheckOptions, type DraftFinding, type DraftKind, type DraftReport } from "./draft-check.ts";
export { countOf, exitFor, formatText, lintTargets, stalledNotes, suppressedLine } from "./lint-files.ts";
