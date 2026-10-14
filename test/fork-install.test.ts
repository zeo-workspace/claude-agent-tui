import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Integration: asserts the pinned dependency set actually resolved on disk.
const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

function installedVersion(pkgName: string): string {
  const p = JSON.parse(
    readFileSync(join(forkRoot, "node_modules", pkgName, "package.json"), "utf8"),
  );
  return String(p.version);
}

test("fork install: @agentclientprotocol/sdk resolves to exactly 1.8.0 (R3.1)", () => {
  assert.equal(installedVersion("@agentclientprotocol/sdk"), "1.8.0");
});

test("fork install: @anthropic-ai/claude-agent-sdk resolves to exactly 0.3.296 (R3.1)", () => {
  assert.equal(installedVersion("@anthropic-ai/claude-agent-sdk"), "0.3.296");
});

test("fork install: node-pty is installed with no version conflict (R3.1)", () => {
  assert.match(installedVersion("node-pty"), /^\d+\.\d+\.\d+/);
});
