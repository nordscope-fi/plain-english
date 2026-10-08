import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, openSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Provider-reported measurements contain no prompts or generated text. */
export interface JudgeMeasurement {
  provider: "claude" | "vibe" | "unknown";
  outcome: "complete" | "failed" | "timed_out" | "unavailable";
  reportedCostUsd: number | null;
  /** Reported API pricing does not establish the account's invoice. */
  invoiceCostUsd: null;
  costBasis: "provider-reported-api-estimate" | "unknown";
  usage: Record<string, number> | null;
  modelUsage: Record<string, Record<string, number>> | null;
}

const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const MODEL_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "webSearchRequests", "costUSD", "contextWindow", "maxOutputTokens"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function measuredFields(value: unknown, fields: string[]): Record<string, number> | null {
  const object = record(value);
  if (!object) return null;
  const measured = Object.fromEntries(fields.flatMap((field) => {
    const number = nonnegative(object[field]);
    return number === null || (field !== "costUSD" && !Number.isSafeInteger(number)) ? [] : [[field, number]];
  }));
  return Object.keys(measured).length ? measured : null;
}

/** Read only the native result object, never arbitrary generated JSON. */
export function nativeJudgeResult(stdout: string): Record<string, unknown> | undefined {
  try {
    const result = record(JSON.parse(stdout.trim()));
    return result?.["type"] === "result" ? result : undefined;
  } catch { return undefined; }
}

export function judgeMeasurement(
  stdout: string,
  provider: JudgeMeasurement["provider"],
  outcome: JudgeMeasurement["outcome"],
  structuredOutput: boolean,
): JudgeMeasurement {
  const result = structuredOutput ? nativeJudgeResult(stdout) : undefined;
  const reportedCostUsd = nonnegative(result?.["total_cost_usd"]);
  const modelUsage = Object.fromEntries(Object.entries(record(result?.["modelUsage"]) ?? {}).flatMap(([model, value]) => {
    // Limit model identifiers to provider names, never free-form text fields.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,119}$/.test(model)) return [];
    const measured = measuredFields(value, MODEL_FIELDS);
    return measured ? [[model, measured]] : [];
  }));
  return {
    provider: result ? "claude" : provider,
    outcome: result?.["is_error"] === true ? "failed" : outcome,
    reportedCostUsd,
    invoiceCostUsd: null,
    costBasis: reportedCostUsd === null ? "unknown" : "provider-reported-api-estimate",
    usage: measuredFields(result?.["usage"], TOKEN_FIELDS),
    modelUsage: Object.keys(modelUsage).length ? modelUsage : null,
  };
}

interface CaptureState {
  path: string;
  captureId: string;
  issuedCalls: number;
  completedCalls: number;
  captureHealthy: boolean;
}

let activeCapture: CaptureState | undefined;

function receiptAppender(env: NodeJS.ProcessEnv): ((receipt: Record<string, unknown>) => boolean) | undefined {
  const path = env["PLAIN_ENGLISH_JUDGE_RECEIPTS"];
  if (!path) return undefined;
  return (receipt) => {
    let fd: number | undefined;
    try {
      if (!isAbsolute(path)) throw new Error("absolute receipt destination required");
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      appendFileSync(fd, JSON.stringify({ schemaVersion: 1, ...receipt }) + "\n");
      return true;
    } catch {
      if (activeCapture?.path === path) activeCapture.captureHealthy = false;
      process.stderr.write("plain-english: model usage capture unavailable.\n");
      return false;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* Optional capture cannot stop a check. */ }
      }
    }
  };
}

/** Establish capture even when a hook needs no model call. */
export function initializeJudgeReceipts(env: NodeJS.ProcessEnv = process.env): () => void {
  const append = receiptAppender(env);
  const path = env["PLAIN_ENGLISH_JUDGE_RECEIPTS"];
  if (!append || !path) return () => {};
  const state: CaptureState = { path, captureId: randomUUID(), issuedCalls: 0, completedCalls: 0, captureHealthy: true };
  activeCapture = state;
  append({ phase: "capture-enabled", captureVersion: 1, captureId: state.captureId });
  return () => {
    append({ phase: "capture-finished", captureId: state.captureId, issuedCalls: state.issuedCalls,
      completedCalls: state.completedCalls, captureHealthy: state.captureHealthy });
    if (activeCapture === state) activeCapture = undefined;
  };
}

/** Opt-in measurements are separate from disabled conversation persistence. */
export function startJudgeReceipt(
  env: NodeJS.ProcessEnv,
  provider: JudgeMeasurement["provider"],
): (measurement: JudgeMeasurement) => void {
  const append = receiptAppender(env);
  if (!append) return () => {};
  const state = activeCapture?.path === env["PLAIN_ENGLISH_JUDGE_RECEIPTS"] ? activeCapture : undefined;
  if (state) state.issuedCalls++;
  const callId = randomUUID();
  append({ phase: "started", callId, provider, ...(state ? { captureId: state.captureId } : {}) });
  return (measurement) => {
    if (state) state.completedCalls++;
    append({ phase: "finished", callId, ...(state ? { captureId: state.captureId } : {}), ...measurement });
  };
}
