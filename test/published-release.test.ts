import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error maintainer JavaScript release helper
import * as release from "../scripts/verify-published-release.mjs";
const { verifyPublishedRelease } = release;

const VERSION = "1.6.0";
const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const REPOSITORY = "https://github.com/nordscope-fi/plain-english";
const SLSA = "https://slsa.dev/provenance/v1";
const digest = Buffer.alloc(64, 7);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1", predicateType: SLSA,
    subject: [{ name: `pkg:npm/plain-english@${VERSION}`, digest: { sha512: digest.toString("hex") } }],
    predicate: { buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: { workflow: { repository: REPOSITORY, path: ".github/workflows/release.yml", ref: "refs/heads/main" } },
      resolvedDependencies: [{ uri: `git+${REPOSITORY}@refs/heads/main`, digest: { gitCommit: COMMIT } }],
    } },
  };
  const envelope = { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    signatures: [{ sig: Buffer.from("fixture-signature").toString("base64"), keyid: "fixture" }] };
  return {
    dist: { integrity: `sha512-${digest.toString("base64")}`, attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/plain-english@${VERSION}`,
      provenance: { predicateType: SLSA },
    } },
    attestations: { attestations: [{ predicateType: SLSA, bundle: { dsseEnvelope: envelope } }] },
    statement, envelope,
  };
}

describe("published release identity", () => {
  it("matches the published digest to the expected repository, workflow and commit", () => {
    const { dist, attestations } = fixture();
    expect(verifyPublishedRelease(dist, attestations, VERSION, COMMIT)).toMatchObject({
      version: VERSION, gitCommit: COMMIT, integrity: dist.integrity,
      attestationUrl: dist.attestations.url,
    });
  });

  it.each([
    ["package version", (f: ReturnType<typeof fixture>) => { f.statement.subject[0]!.name = "pkg:npm/plain-english@1.7.0"; }],
    ["package name", (f: ReturnType<typeof fixture>) => { f.statement.subject[0]!.name = `pkg:npm/another-package@${VERSION}`; }],
    ["artifact digest", (f: ReturnType<typeof fixture>) => { f.statement.subject[0]!.digest.sha512 = Buffer.alloc(64, 8).toString("hex"); }],
    ["source commit", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "a".repeat(40); }],
    ["workflow repository", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.externalParameters.workflow.repository += "-different"; }],
    ["workflow path", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/test.yml"; }],
    ["source repository URI", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.uri = "git+https://github.com/another/repo@refs/heads/main"; }],
    ["source reference", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.uri = `git+${REPOSITORY}@refs/heads/other`; }],
    ["provenance metadata", (f: ReturnType<typeof fixture>) => { f.dist.attestations.provenance.predicateType = "not-slsa"; }],
    ["registry endpoint", (f: ReturnType<typeof fixture>) => { f.dist.attestations.url = "https://another.example/attestation"; }],
    ["DSSE payload type", (f: ReturnType<typeof fixture>) => { f.envelope.payloadType = "text/plain"; }],
    ["statement predicate", (f: ReturnType<typeof fixture>) => { f.statement.predicateType = "not-slsa"; }],
    ["statement type", (f: ReturnType<typeof fixture>) => { f.statement._type = "not-in-toto"; }],
    ["noncanonical integrity", (f: ReturnType<typeof fixture>) => { f.dist.integrity += "=="; }],
    ["ambiguous subjects", (f: ReturnType<typeof fixture>) => { f.statement.subject.push({ ...f.statement.subject[0]! }); }],
    ["ambiguous source dependencies", (f: ReturnType<typeof fixture>) => { f.statement.predicate.buildDefinition.resolvedDependencies.push({ ...f.statement.predicate.buildDefinition.resolvedDependencies[0]! }); }],
    ["ambiguous provenance", (f: ReturnType<typeof fixture>) => { f.attestations.attestations.push({ ...f.attestations.attestations[0]! }); }],
    ["missing signature", (f: ReturnType<typeof fixture>) => { f.envelope.signatures = []; }],
  ])("rejects mismatched or malformed %s", (_name, edit) => {
    const f = fixture();
    (edit as (value: ReturnType<typeof fixture>) => void)(f);
    f.envelope.payload = Buffer.from(JSON.stringify(f.statement)).toString("base64");
    expect(() => verifyPublishedRelease(f.dist, f.attestations, VERSION, COMMIT)).toThrow();
  });

  it.each(["%%%", Buffer.from("not JSON").toString("base64"), ""])('rejects a malformed DSSE payload: %s', (payload) => {
    const f = fixture(); f.envelope.payload = payload;
    expect(() => verifyPublishedRelease(f.dist, f.attestations, VERSION, COMMIT)).toThrow();
  });

  it("fetches only the fixed registry HTTPS endpoint without redirects", async () => {
    const { attestations } = fixture();
    const requested: unknown[] = [];
    const result = await release.fetchPublishedAttestations(VERSION, async (url: string, options: RequestInit) => {
      requested.push([url, options.redirect, options.signal instanceof AbortSignal]);
      return new Response(JSON.stringify(attestations));
    });
    expect(requested).toEqual([[`https://registry.npmjs.org/-/npm/v1/attestations/plain-english@${VERSION}`, "error", true]]);
    expect(result).toEqual(attestations);
  });

  it.each([
    ["HTTP failure", new Response("registry error", { status: 503 }), /HTTP 503/],
    ["oversized response", new Response("x".repeat(1024 * 1024 + 1)), /size limit/],
    ["malformed JSON", new Response("not JSON"), /Malformed registry/],
  ])("rejects registry %s", async (_name, response, error) => {
    await expect(release.fetchPublishedAttestations(VERSION, async () => response)).rejects.toThrow(error);
  });

  it("aborts an unresponsive registry request at its deadline", async () => {
    await expect(release.fetchPublishedAttestations(VERSION, (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("aborted request")), { once: true })), 20))
      .rejects.toThrow(/aborted request/);
  });

  it("makes the CLI succeed only for the expected published identity", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pe-published-cli-")); dirs.push(dir);
    const { dist, attestations } = fixture();
    const path = resolve(dir, "dist.json"); writeFileSync(path, JSON.stringify(dist));
    const shim = resolve(dir, "registry.mjs");
    writeFileSync(shim, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(attestations))});\n`);
    const run = (commit: string) => spawnSync(process.execPath, ["--import", shim,
      resolve(import.meta.dirname, "../scripts/verify-published-release.mjs"), path, VERSION, commit], { encoding: "utf8" });
    const accepted = run(COMMIT);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("Published release identity matches");
    const rejected = run("a".repeat(40));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Published source commit differs");
  });
});
