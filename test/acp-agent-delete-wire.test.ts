import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

// Story 061 / Task 2.1 — regression guard for the `session/delete` wire name.
//
// acp-sdk 1.0.0 dispatches the `session/delete` wire method to the agent handler
// named EXACTLY `deleteSession` (no `unstable_` prefix). The SDK's registration gate
// is (node_modules/@agentclientprotocol/sdk/dist/acp.js:972):
//
//     if (implementation.deleteSession) {
//         app.onRequest(AGENT_METHODS.session_delete,
//                       async (ctx) => (await implementation.deleteSession(ctx.params)) ?? {});
//     }
//
// The fork had named the handler `unstable_deleteSession`, so that `if` was false and
// `session/delete` was never registered — the handler was dead code over the wire, and
// a client (Zed) calling `session/delete` got a no-op instead of a torn-down session.
// These tests fail (Red) while the handler carries the `unstable_` prefix and pass
// (Green) once it is renamed to `deleteSession`.
//
// `unstable_forkSession` MUST keep its prefix (acp.js:975 binds
// `implementation.unstable_forkSession` for `session/fork`), so it is guarded here too
// against an accidental over-eager rename (story R3 / U2).
//
// Hermetic by design: asserts the public class surface plus a thin shim mirroring the
// SDK's bind logic — no PTY, no disk, no SDK private state. The handler body's teardown
// + on-disk-transcript removal is unchanged by the rename (only the method name changes)
// and is covered by `tsc` over the untouched body; the test runner does not enable
// `--experimental-test-module-mocks`, so the external disk helper cannot be module-mocked
// here, and exercising it for real would couple this wire test to on-disk transcript layout.

function freshAgent() {
  // The handler surface lives on the prototype; an empty client stub is sufficient to
  // inspect it — same construction the initialize-purity suite uses (no engine/session).
  return new ClaudeAcpAgent({}, console);
}

test("session/delete wire: handler is named deleteSession (no unstable_ prefix)", () => {
  const agent = freshAgent();
  assert.equal(
    typeof agent.deleteSession,
    "function",
    "acp-sdk 1.0.0 dispatches session/delete → implementation.deleteSession",
  );
  assert.equal(
    agent.unstable_deleteSession,
    undefined,
    "unstable_deleteSession is dead code under acp-sdk 1.0.0 — the prefixed name must be gone",
  );
});

test("session/delete wire: SDK registration gate selects the handler", () => {
  const agent = freshAgent();
  // Mirror the SDK's bind logic: it registers session/delete ONLY when
  // `implementation.deleteSession` is present. A wrongly-prefixed name leaves it unbound.
  let registered = null;
  const app = {
    onRequest: (method) => {
      registered = method;
    },
  };
  if (agent.deleteSession) {
    app.onRequest("session/delete", (ctx) => agent.deleteSession(ctx.params));
  }
  assert.equal(
    registered,
    "session/delete",
    "session/delete must register because implementation.deleteSession is present",
  );
});

test("session/fork wire: unstable_forkSession KEEPS its prefix (not renamed by mistake)", () => {
  const agent = freshAgent();
  assert.equal(
    typeof agent.unstable_forkSession,
    "function",
    "acp-sdk 1.0.0 still dispatches session/fork → implementation.unstable_forkSession (prefix stays)",
  );
});

// ---- Story 063 / Task 4.1 — delete never fails on a missing transcript (upstream #1351) --------
//
// Port of claude-agent-plus's story 062 / 2.1. ACP: deleting a session that never existed SHOULD
// succeed silently; the SDK throws "Invalid sessionId" for a non-UUID and "Session … not found in …"
// when nothing is on disk — which includes a live session never prompted. The SDK reads
// CLAUDE_CONFIG_DIR, so the agent-level cases run against an empty temporary config.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteSessionIfStored } from "../dist/session-delete.js";

function withTempConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), "tui-063-delete-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("063 hostile: any other SDK error still rejects", async () => {
  const boom = new Error("EACCES: permission denied, unlink '/x.jsonl'");
  await assert.rejects(
    deleteSessionIfStored(randomUUID(), async () => {
      throw boom;
    }),
    boom,
  );
});

test("063 hostile: a non-Error throw is not mistaken for not-found", async () => {
  await assert.rejects(
    deleteSessionIfStored(randomUUID(), async () => {
      throw "Session x not found in any project directory";
    }),
  );
});

test("063 the SDK's not-found error resolves", async () => {
  const id = randomUUID();
  await deleteSessionIfStored(id, async () => {
    throw new Error(`Session ${id} not found in any project directory`);
  });
});

test("063 a non-UUID id resolves without calling the SDK", async () => {
  let called = 0;
  await deleteSessionIfStored("not-a-uuid", async () => {
    called++;
  });
  assert.equal(called, 0);
});

test("063 agent: non-UUID, unknown UUID and never-prompted session delete successfully", async (t) => {
  withTempConfig(t);
  const agent = freshAgent();
  assert.deepEqual(await agent.deleteSession({ sessionId: "not-a-uuid" }), {});
  assert.deepEqual(await agent.deleteSession({ sessionId: randomUUID() }), {});
  // Never prompted: a live in-memory session with no transcript on disk.
  const neverPrompted = randomUUID();
  agent.sessions[neverPrompted] = {};
  agent.teardownSession = async (id) => {
    delete agent.sessions[id];
  };
  assert.deepEqual(await agent.deleteSession({ sessionId: neverPrompted }), {});
  assert.equal(agent.sessions[neverPrompted], undefined);
});

test("063 unchanged: a session with a transcript is gone after delete", async (t) => {
  const config = withTempConfig(t);
  const id = randomUUID();
  const projectDir = join(config, "projects", "-tmp-project");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${id}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", sessionId: id, cwd: "/tmp/project" }) + "\n");
  const agent = freshAgent();
  assert.deepEqual(await agent.deleteSession({ sessionId: id }), {});
  assert.equal(existsSync(transcript), false);
});
