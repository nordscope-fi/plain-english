/** Project context for native writing guidance, without restating the rules. */
import type { CheckerIo } from "./io.ts";
import { nodeIo } from "./node-io.ts";
import { loadDefault, type RuleSet } from "./rules.ts";
import { vocabularyForPrompt } from "./render.ts";

export function projectGuidance(set: RuleSet, io: CheckerIo = nodeIo): string {
  const defaultNames = new Set(loadDefault(io).readability.flatMap((rule) =>
    rule.kind === "unglossed-term" ? rule.known ?? [] : []));
  const names = [...new Set(set.readability.flatMap((rule) =>
    rule.kind === "unglossed-term" ? rule.known ?? [] : []))]
    .filter((name) => !defaultNames.has(name));
  const vocabulary = vocabularyForPrompt(set);
  const notes = set.profileGuidance ?? [];
  if (!names.length && !vocabulary && !notes.length) return "";
  return [
    "Plain English project guidance. Preserve facts, qualifications, and the reader's requested form.",
    ...(names.length ? [`Project readers already know these names: ${names.join(", ")}.`] : []),
    ...(vocabulary ? [vocabulary] : []),
    ...notes,
  ].join("\n");
}
