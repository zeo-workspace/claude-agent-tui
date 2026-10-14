import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(forkRoot, rel), "utf8"));
}

const pkg = readJson("package.json");
const deps = (pkg.dependencies ?? {}) as Record<string, string>;

// --- Task 2.1: kept ACP + reused-SDK deps pinned exactly (no caret/tilde) ---

test("fork deps: @agentclientprotocol/sdk pinned exactly to 1.8.0, no range (R2.1)", () => {
  assert.equal(deps["@agentclientprotocol/sdk"], "1.8.0");
  assert.doesNotMatch(deps["@agentclientprotocol/sdk"] ?? "", /[\^~]/);
});

test("fork deps: @anthropic-ai/claude-agent-sdk pinned exactly to 0.3.296, no range (R2.2)", () => {
  assert.equal(deps["@anthropic-ai/claude-agent-sdk"], "0.3.296");
  assert.doesNotMatch(deps["@anthropic-ai/claude-agent-sdk"] ?? "", /[\^~]/);
});

// --- Task 2.2: node-pty is the only extra runtime dep vs upstream v0.53.0 ---

test("fork deps: node-pty present in dependencies, no range (R2.3)", () => {
  assert.ok("node-pty" in deps, "node-pty must be a runtime dependency");
  assert.doesNotMatch(deps["node-pty"] ?? "", /[\^~]/);
});

test("fork deps: node-pty is the ONLY dependency key added vs upstream v0.53.0 (R2.3)", () => {
  const provenance = readJson(".fork-provenance.json");
  const upstreamKeys = provenance.upstreamDependencyKeys as string[] | undefined;
  assert.ok(
    Array.isArray(upstreamKeys) && upstreamKeys.length > 0,
    "the upstream v0.53.0 dependency-key baseline must be frozen in provenance",
  );
  const current = new Set(Object.keys(deps));
  const upstream = new Set(upstreamKeys);
  const added = [...current].filter((k) => !upstream.has(k)).sort();
  const removed = [...upstream].filter((k) => !current.has(k)).sort();
  assert.deepEqual(added, ["node-pty"], "exactly one dependency key added: node-pty");
  assert.deepEqual(removed, [], "no upstream dependency key removed");
});

// --- 2026-10-15: the SDK pins carry the upstream commit they were taken from ---

test("fork deps: the SDK pins equal provenance.dependencyPinAnchor (upstream d6f60f51)", () => {
  const anchor = readJson(".fork-provenance.json").dependencyPinAnchor as
    | { sha?: string; pins?: Record<string, string> }
    | undefined;
  assert.ok(anchor?.pins, "provenance must record where the SDK pins came from");
  assert.match(anchor.sha ?? "", /^[0-9a-f]{40}$/, "the anchor is a full upstream commit sha");
  for (const [name, version] of Object.entries(anchor.pins)) {
    assert.equal(deps[name], version, `${name} must equal the anchored upstream pin`);
  }
});
