/**
 * The CLI's approval write (ADR-007): never through a link, and never over a
 * file that appeared after the check. Node only; the plugin's mod writes
 * through `$.fs` at a fixed path instead (ADR-008).
 */
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { approvalPlan, type ApprovalRequest, type ApprovalResult } from "./approve.ts";
import type { RuleSet } from "./rules.ts";

/** Run one approval step in `cwd`, never throwing: a refusal is a result. */
export function approveInProject(cwd: string, request: ApprovalRequest, ruleSetFor: (directory: string) => RuleSet): ApprovalResult {
  const plan = approvalPlan(cwd, request, ruleSetFor);
  if (!plan.result.ok || !("write" in plan) || !plan.write) return plan.result;
  try {
    // A new config is created exclusively, an existing one is opened without
    // following a link.
    const fd = openSync(plan.write.path, plan.write.exists ? constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) : "wx", 0o644);
    try {
      writeFileSync(fd, plan.write.text);
    } finally {
      closeSync(fd);
    }
    return plan.result;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
