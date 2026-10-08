#!/usr/bin/env node
// Release identity comes from npm's fixed HTTPS endpoint. This is not an
// independent cryptographic verification of the Sigstore signatures.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SLSA = "https://slsa.dev/provenance/v1";
const REPOSITORY = "https://github.com/nordscope-fi/plain-english";
const BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  requireMatch(value !== null && typeof value === "object" && !Array.isArray(value), `Malformed ${label}`);
  return value;
}

function base64(value, label, size) {
  requireMatch(typeof value === "string" && value.length > 0, `Malformed ${label}`);
  const bytes = Buffer.from(value, "base64");
  requireMatch(bytes.toString("base64") === value && (size === undefined || bytes.length === size), `Malformed ${label}`);
  return bytes;
}

function expectedEndpoint(version) {
  requireMatch(typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version), "Invalid release version");
  return `https://registry.npmjs.org/-/npm/v1/attestations/plain-english@${version}`;
}

function distribution(dist, version) {
  const endpoint = expectedEndpoint(version);
  object(dist, "distribution metadata");
  const metadata = object(dist.attestations, "attestation metadata");
  requireMatch(metadata.url === endpoint, "Published attestation URL differs from the fixed registry endpoint");
  requireMatch(object(metadata.provenance, "provenance metadata").predicateType === SLSA, "Published provenance type differs");
  requireMatch(typeof dist.integrity === "string" && dist.integrity.startsWith("sha512-"), "Malformed published integrity");
  return { endpoint, digest: base64(dist.integrity.slice(7), "published SHA512 integrity", 64).toString("hex") };
}

export function verifyPublishedRelease(dist, attestations, version, gitCommit) {
  const expected = distribution(dist, version);
  requireMatch(typeof gitCommit === "string" && /^[0-9a-f]{40}$/.test(gitCommit), "Expected commit must be a complete lowercase Git SHA");
  const entries = object(attestations, "registry attestations").attestations;
  requireMatch(Array.isArray(entries), "Missing registry attestations");
  const provenance = entries.filter((entry) => object(entry, "registry attestation").predicateType === SLSA);
  requireMatch(provenance.length === 1, "Missing or ambiguous SLSA provenance");
  const envelope = object(object(provenance[0].bundle, "provenance bundle").dsseEnvelope, "DSSE envelope");
  requireMatch(envelope.payloadType === "application/vnd.in-toto+json", "Malformed DSSE payload type");
  requireMatch(Array.isArray(envelope.signatures) && envelope.signatures.length > 0, "Missing DSSE signatures");
  for (const signature of envelope.signatures) base64(object(signature, "DSSE signature").sig, "DSSE signature");
  const payload = base64(envelope.payload, "DSSE payload");
  const text = payload.toString("utf8");
  requireMatch(Buffer.from(text, "utf8").equals(payload), "Malformed DSSE UTF-8 payload");
  let statement;
  try { statement = object(JSON.parse(text), "DSSE statement"); }
  catch { throw new Error("Malformed DSSE statement"); }
  requireMatch(statement._type === "https://in-toto.io/Statement/v1" && statement.predicateType === SLSA, "Published statement type differs");
  requireMatch(Array.isArray(statement.subject) && statement.subject.length === 1, "Missing or ambiguous published artifact");
  const subject = object(statement.subject[0], "published subject");
  requireMatch(subject.name === `pkg:npm/plain-english@${version}`, "Published package name or version differs");
  requireMatch(object(subject.digest, "published digest").sha512 === expected.digest, "Published artifact digest differs");
  const build = object(object(statement.predicate, "SLSA predicate").buildDefinition, "build definition");
  requireMatch(build.buildType === BUILD_TYPE, "Published build type differs");
  const workflow = object(object(build.externalParameters, "workflow parameters").workflow, "workflow identity");
  requireMatch(workflow.repository === REPOSITORY && workflow.path === ".github/workflows/release.yml", "Published workflow identity differs");
  requireMatch(typeof workflow.ref === "string" && /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(workflow.ref), "Malformed workflow reference");
  requireMatch(Array.isArray(build.resolvedDependencies), "Missing resolved source dependencies");
  const source = build.resolvedDependencies.filter((dependency) => {
    const value = object(dependency, "source dependency");
    requireMatch(typeof value.uri === "string", "Malformed source dependency URI");
    return value.uri.startsWith(`git+${REPOSITORY}@`);
  });
  requireMatch(source.length === 1, "Missing or ambiguous source repository");
  requireMatch(source[0].uri === `git+${REPOSITORY}@${workflow.ref}`, "Published source repository reference differs");
  requireMatch(object(source[0].digest, "source digest").gitCommit === gitCommit, "Published source commit differs");
  return { version, gitCommit, integrity: dist.integrity, attestationUrl: expected.endpoint };
}

/** Trust the npm registry HTTPS response, with no redirected source. */
export async function fetchPublishedAttestations(version, fetcher = globalThis.fetch, timeoutMs = TIMEOUT_MS) {
  requireMatch(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS, "Invalid registry deadline");
  const response = await fetcher(expectedEndpoint(version), {
    redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" },
  });
  requireMatch(response.ok, `Registry request failed: HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length !== null) {
    requireMatch(/^\d+$/.test(length), "Malformed registry response length");
    requireMatch(Number(length) <= MAX_BYTES, "Registry response exceeds size limit");
  }
  requireMatch(response.body, "Missing registry response body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("Registry response exceeds size limit");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Malformed registry response JSON"); }
}

async function main(args) {
  requireMatch(args.length === 3, "Usage: verify-published-release.mjs <dist-json-path> <version> <git-commit>");
  const [path, version, gitCommit] = args;
  requireMatch(statSync(path).size <= MAX_BYTES, "Distribution metadata exceeds size limit");
  const bytes = readFileSync(path);
  requireMatch(bytes.length <= MAX_BYTES, "Distribution metadata exceeds size limit");
  let dist;
  try { dist = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Malformed distribution metadata JSON"); }
  distribution(dist, version);
  const attestations = await fetchPublishedAttestations(version);
  verifyPublishedRelease(dist, attestations, version, gitCommit);
  process.stdout.write(`Published release identity matches plain-english@${version} at ${gitCommit} (npm HTTPS provenance).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Cannot verify published release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
