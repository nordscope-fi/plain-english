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
