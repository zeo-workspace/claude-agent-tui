import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { connectTestClient } from "./helpers/acp-client-connection.ts";
import { nodeToWebReadable, nodeToWebWritable } from "../dist/utils.js";

// Story 011 / Task 3 — smoke-test `initialize` over the REAL ND-JSON stdio transport
// (§15). The built agent (`node dist/index.js` → runAcp → ndJsonStream(stdin/stdout)
// + AgentSideConnection on the default stub engine) is driven by the SDK's own
// ClientSideConnection, which owns JSON-RPC framing + response correlation. We assert
// the §15 capability shape byte-for-byte and pin `protocolVersion` to the integer 1.
// Degrau 1 is READ-ONLY: NO `session/new` or `session/prompt` is sent — only the
// `initialize` handshake is exercised end-to-end.
//
// OPEN (§15 🧪, deferred to story 025): whether the user's installed Zed actually
// sends/accepts `protocolVersion: 1` and tolerates the UNSTABLE `usage_update`
// SessionUpdate is UNVERIFIED. This test pins only the shape the FORK advertises.

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");

let child: ChildProcessWithoutNullStreams;
let stderr = "";
let initResult: any;

function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`initialize over NDJSON timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

before(
  async () => {
    // Spawn the built agent over stdio (no shell — array args). stderr is captured
    // so a boot failure surfaces in the assertion message instead of hanging.
    child = spawn("node", ["dist/index.js"], {
      cwd: forkRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const input = nodeToWebWritable(child.stdin);
    const output = nodeToWebReadable(child.stdout);
    const stream = ndJsonStream(input, output);

    // initialize triggers no agent→client callbacks; this minimal Client satisfies
    // the connection factory. An unexpected callback throws loudly (READ-ONLY).
    const connection = connectTestClient({
        async requestPermission() {
          throw new Error("unexpected client callback during READ-ONLY initialize smoke");
        },
        async sessionUpdate() {},
        async writeTextFile() {
          return {};
        },
        async readTextFile() {
          return { content: "" };
        },
      },
      stream,
    );

    initResult = await withTimeout(
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      15000,
      () => stderr,
    );
  },
  { timeout: 25000 },
);

after(() => {
  if (child && !child.killed) child.kill();
});

// --- 3.2: protocolVersion pinned to the INTEGER 1 (rejects a string-"1" regression) ---

test("initialize smoke (§15): protocolVersion is the integer 1 over NDJSON", () => {
  assert.equal(typeof initResult.protocolVersion, "number", "protocolVersion must be a number, not a string");
  assert.ok(Number.isInteger(initResult.protocolVersion), "protocolVersion must be an integer");
  assert.equal(initResult.protocolVersion, 1, "protocolVersion must be exactly 1");
});

// --- 3.1: the full §15 agentCapabilities block, plus agentInfo + authMethods --------

test("initialize smoke (§15): agentCapabilities block matches the §15 shape exactly", () => {
  const caps = initResult.agentCapabilities;
  assert.ok(caps && typeof caps === "object", "agentCapabilities must be present");
  assert.deepEqual(caps.promptCapabilities, { image: true, embeddedContext: true });
  assert.deepEqual(caps.mcpCapabilities, { http: true, sse: true });
  assert.equal(caps.loadSession, true);
  assert.ok(
    caps.sessionCapabilities && typeof caps.sessionCapabilities === "object",
    "sessionCapabilities must be present",
  );
});

test("initialize smoke (§15): agentInfo and authMethods are present", () => {
  assert.ok(initResult.agentInfo && typeof initResult.agentInfo === "object", "agentInfo must be present");
  assert.ok(Array.isArray(initResult.authMethods), "authMethods must be an array");
});
