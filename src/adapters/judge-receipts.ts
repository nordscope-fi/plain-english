/**
 * Opt-in judge receipts for evaluation runs (`PLAIN_ENGLISH_JUDGE_RECEIPTS`).
 *
 * Node only, and CLI only: the Claude Code plugin's build replaces this module
 * with one that records nothing (ADR-008).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JudgeMeasurement } from "./judge-measurement.ts";

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
