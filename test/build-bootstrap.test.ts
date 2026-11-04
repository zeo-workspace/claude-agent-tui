import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { connectTestClient } from "./helpers/acp-client-connection.ts";
import { nodeToWebReadable, nodeToWebWritable } from "../dist/utils.js";

// Story 027 / Task 1.1 — build-and-bootstrap acceptance (R1.1, R1.3). Proves the
// FROZEN ACP entrypoint (kept `runAcp` over `ndJsonStream(stdin/stdout)`, stories
// 011/023) ships in the built `dist/index.js`: `node dist/index.js` boots, completes
// the ACP `initialize` handshake over real NDJSON stdio, and — because Degrau-1 is
// read-only and the PTY is only spawned on `session/new` — does NOT spawn a `claude`
// child process before any session is created. This is an acceptance/regression guard
// over already-delivered bootstrap behaviour, not new logic (see the SEAM-MAP);
// it locks the §15 launch contract Zed depends on.

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");
const distEntry = join(forkRoot, "dist", "index.js");

let child: ChildProcessWithoutNullStreams;
let stderr = "";
let initResult: any;

function withTimeout<T>(promise: Promise<T>, ms: number, getInfo: () => string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`bootstrap initialize timed out after ${ms}ms. Agent stderr:\n${getInfo()}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

/** Direct child PIDs of `pid` via pgrep; empty array when there are none (pgrep exits 1). */
function childPids(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s));
  } catch {
    // pgrep exits non-zero when no child matches — that is the "no children" case.
    return [];
  }
}

/** `/proc/<pid>/comm` command name, for diagnostics; "?" if unreadable. */
function commOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}

before(
  async () => {
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

    // READ-ONLY: an unexpected agent→client callback throws loudly. Only `initialize`
    // is exercised — no session/new, no session/prompt.
    const connection = connectTestClient({
        async requestPermission() {
          throw new Error("unexpected client callback during read-only bootstrap");
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

// --- R1.1: the built entrypoint exists and is launchable as `node dist/index.js` ---

test("bootstrap (R1.1): dist/index.js exists as the built ACP entrypoint", () => {
  assert.doesNotThrow(() => accessSync(distEntry), `${distEntry} must exist after build`);
});

// --- R1.3: the ACP initialize handshake completes over real NDJSON stdio ----------

test("bootstrap (R1.3): node dist/index.js completes the initialize handshake over NDJSON", () => {
  assert.ok(initResult && typeof initResult === "object", "initialize must return a response object");
  assert.equal(initResult.protocolVersion, 1, "protocolVersion must be exactly 1");
  assert.ok(
    initResult.agentCapabilities && typeof initResult.agentCapabilities === "object",
    "a well-formed initialize response carries agentCapabilities",
  );
});

// --- R1.1/R1.3: no `claude` child is spawned before `session/new` (read-only boot) --

test("bootstrap: no claude child process is spawned before session/new", () => {
  const kids = childPids(child.pid!);
  const named = kids.map((p) => `${p}:${commOf(p)}`);
  assert.ok(
    !named.some((n) => /claude/i.test(n)),
    `no claude child expected before session/new, saw: [${named.join(", ")}]`,
  );
  // Stronger read-only guard: the bootstrapped agent spawns nothing at all until a
  // session is created — the PTY (the only child) is bound to session/new.
  assert.equal(kids.length, 0, `expected zero child processes after initialize, saw: [${named.join(", ")}]`);
});
