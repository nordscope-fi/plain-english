/**
 * Starting the agent's print mode for one judge question.
 *
 * Node only, and CLI only: the Claude Code plugin asks its session's model
 * instead, and its build replaces this module with one that starts nothing
 * (ADR-008).
 */
import { spawnSync } from "node:child_process";
import { judgeMeasurement, type JudgeMeasurement } from "./judge-measurement.ts";
import { startJudgeReceipt } from "./judge-receipts.ts";
import { JUDGE_MARKER, JUDGE_TIMEOUT_MS, parseVerdict, type JudgeOptions, type Verdict } from "./judge.ts";

export function spawnJudge(filled: string, opts: JudgeOptions, env: Readonly<Record<string, string | undefined>>): Verdict | undefined {
  const provider = opts.command === "claude" ? "claude" : opts.command === "vibe" ? "vibe" : "unknown";
  const formatIndex = opts.args.indexOf("--output-format");
  const structuredOutput = formatIndex !== -1 && opts.args[formatIndex + 1] === "json";
  const finishReceipt = startJudgeReceipt(env, provider);
  const measured = (stdout: string, outcome: JudgeMeasurement["outcome"]) => {
    // Observability cannot change the check or expose submitted text in errors.
    const measurement = judgeMeasurement(stdout, provider, outcome, structuredOutput);
    finishReceipt(measurement);
    try { opts.onMeasurement?.(measurement); } catch { /* optional */ }
  };
  let out;
  try {
    out = spawnSync(opts.command, [...opts.args, filled], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? JUDGE_TIMEOUT_MS,
      cwd: opts.cwd,
      env: {
        ...env,
        [JUDGE_MARKER]: "1",
        ...(opts.command === "vibe" ? {
          PLAIN_ENGLISH_VIBE_JUDGE: "0",
          VIBE_INCLUDE_PROJECT_CONTEXT: "false",
          VIBE_INCLUDE_PROMPT_DETAIL: "false",
          VIBE_SYSTEM_PROMPT_ID: "minimal",
          VIBE_MCP_SERVERS: "[]",
        } : {}),
      },
      // A judge that inherits stdin can block on it forever.
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    measured("", "unavailable");
    opts.onUnavailable?.("could not start");
    return undefined;
  }
  if (out.error || out.status !== 0) {
    measured(out.stdout ?? "", out.error && "code" in out.error && out.error.code === "ETIMEDOUT" ? "timed_out" : out.error ? "unavailable" : "failed");
    opts.onUnavailable?.(out.error && "code" in out.error && out.error.code === "ETIMEDOUT" ? "timed out" : out.error ? "could not start" : "failed");
    return undefined;
  }
  measured(out.stdout ?? "", "complete");
  const verdict = parseVerdict(out.stdout ?? "");
  if (!verdict) opts.onUnavailable?.("returned no usable answer");
  return verdict;
}
