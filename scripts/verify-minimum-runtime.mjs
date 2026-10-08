#!/usr/bin/env node
// Exercise the installed tarball on the package's oldest supported runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.versions.node, "20.0.0", "Run this consumer check with Node 20.0.0");
assert.equal(process.argv.length, 3, "Supply the clean consumer directory");
const consumer = resolve(process.argv[2]);
const require = createRequire(resolve(consumer, "package.json"));
const manifestPath = require.resolve("plain-english/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const cli = resolve(dirname(manifestPath), "dist/cli.js");
const { lint } = await import(pathToFileURL(require.resolve("plain-english")));
const sourceProse = await import(pathToFileURL(require.resolve("plain-english/source-prose")));
assert.ok(Object.keys(sourceProse).length > 0, "The source-prose export loads");
const fixture = mkdtempSync(resolve(tmpdir(), "plain-english-runtime-"));

try {
  writeFileSync(resolve(fixture, ".plain-english.yml"), "version: 1\nextends: default\nfailOn: error\nmodelChecks: false\n");
  const clean = "- Keep the cable dry.\n  - Connect the plug.\n\n```txt\nWe leverage this.\n```\n\n> We leverage this.\n";
  const bad = "The cache expires hourly.\n\nWe leverage this.\n";
  assert.equal(lint(clean, fixture).errorCount, 0, "List prose survives, code and quotes stay masked");
  const findings = lint(bad, fixture).findings;
  assert.ok(findings.some(finding => finding.match === "leverage" && finding.line === 3 && finding.column === 4), "Markdown findings retain source positions");
  assert.ok(lint("- We leverage this.\n", fixture).errorCount > 0, "List prose is checked");

  function run(args, input) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: fixture, encoding: "utf8", input, timeout: 15_000 });
  }
  for (const [file, text, source, status] of [
    ["clean.md", clean, false, 0],
    ["bad.md", bad, false, 1],
    ["clean.tsx", 'export const Notice = () => <p>The cache expires hourly.</p>;\n', true, 0],
    ["bad.tsx", 'export const Notice = () => <p>We leverage this.</p>;\n', true, 1],
  ]) {
    writeFileSync(resolve(fixture, file), text);
    const result = run(["lint", file, "--fail-on", "error", ...(source ? ["--source-prose"] : [])]);
    assert.equal(result.status, status, result.stderr + result.stdout);
  }

  for (const [html, decision] of [
    ["<p>The cache &amp; queue.</p><code>We leverage this.</code>", "allow"],
    ["<p>We lever&#97;ge this.</p>", "deny"],
  ]) {
    const payload = { cwd: fixture, toolName: "mcp__atlassian__editJiraIssue", toolArgs: JSON.stringify({ content: html }) };
    const result = run(["hook", "--agent", "copilot", "--channel", "issue", "--event", "pre"], JSON.stringify(payload));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stderr, "", "The hook must not fail open after an error");
    if (decision === "allow") assert.equal(result.stdout, "");
    else assert.equal(JSON.parse(result.stdout).permissionDecision, decision);
  }
  console.log(`Node ${process.versions.node}: plain-english@${manifest.version} Markdown, source prose and HTML issue controls passed.`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
