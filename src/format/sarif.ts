/**
 * SARIF 2.1.0 output.
 *
 * SARIF is the interchange format for static-analysis findings, and it is worth
 * emitting for a reason that has nothing to do with CI. GitHub code scanning
 * ingests it and annotates a pull request, which is the obvious half. The other
 * half is that Microsoft's SARIF extension renders a results file into VS
 * Code's Problems list, and several coding agents read that list and treat what
 * they find there as feedback to act on. So one serializer reaches agents that
 * this package has no adapter for and never will.
 *
 * Only GitHub's documented ingest subset is emitted. The full schema is large,
 * most of it optional, and every field here has a consumer.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 * GitHub's subset: https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
 */

import { isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Finding } from "../lint.ts";
import type { RuleSet } from "../rules.ts";

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const HOMEPAGE = "https://github.com/nordscope-fi/plain-english";

/** One file's findings, as `lint` already groups them. */
export interface SarifInput {
  file: string;
  findings: Finding[];
}

/**
 * SARIF wants a URI relative to the scanned root, with forward slashes on every
 * platform. A Windows path with backslashes is accepted by nothing.
 *
 * A file outside the root gets an absolute `file://` URI instead of a relative
 * one full of `../`. GitHub code scanning rejects a path that climbs out of the
 * repository, and `lint /some/other/place` is a legitimate thing to run.
 */
function toUri(file: string, root: string): string {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return pathToFileURL(file).href;
  }
  return rel.split(sep).join("/").split("\\").join("/");
}

/**
 * Rule metadata for the rules that actually fired.
 *
 * The full ruleset is 41 entries and most runs touch three. Listing only what
 * fired keeps the file small without losing anything a consumer reads: an
 * unreferenced rule descriptor has no effect on how a result is displayed.
 */
function driverRules(ids: Set<string>, ruleSet: RuleSet): object[] {
  const out: object[] = [];

  for (const id of [...ids].sort()) {
    const rule = ruleSet.rules.find((r) => r.id === id);
    const readability = ruleSet.readability.find((r) => r.id === id);
    const link = rule?.link ?? readability?.link;
    const text = rule?.message ?? readability?.message ?? `Rewrite the text flagged by ${id}.`;

    out.push({
      // No `name`. SARIF §3.49.7 requires it to differ from `id` when both are
      // present, and a rule id here is already the human-readable name.
      id,
      shortDescription: { text },
      ...(link ? { helpUri: link } : {}),
      properties: { tags: ["prose", "style"] },
    });
  }

  return out;
}

/**
 * A SARIF log for one lint run.
 *
 * `warn` maps to SARIF's `warning`; SARIF has no third level between that and
 * `error`, which suits a linter with exactly two.
 */
export function toSarif(
  input: SarifInput[],
  ruleSet: RuleSet,
  opts: { root: string; version: string },
): object {
  const fired = new Set<string>();
  const results: object[] = [];

  for (const { file, findings } of input) {
    const uri = toUri(file, opts.root);
    for (const f of findings) {
      fired.add(f.ruleId);
      results.push({
        ruleId: f.ruleId,
        level: f.severity === "error" ? "error" : "warning",
        message: { text: f.message ?? `${JSON.stringify(f.match)} reads as machine-generated.` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              region: {
                startLine: f.line,
                startColumn: f.column,
                // SARIF's endColumn is exclusive, so this is the character
                // after the match rather than the last one in it.
                endColumn: f.column + [...f.match].length,
                snippet: { text: f.lineText },
              },
            },
          },
        ],
      });
    }
  }

  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "plain-english",
            semanticVersion: opts.version,
            version: opts.version,
            informationUri: HOMEPAGE,
            rules: driverRules(fired, ruleSet),
          },
        },
        results,
      },
    ],
  };
}
