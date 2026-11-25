// Parity round 26: a re-spawn retires the previous claude and moves the gate to the new PTY.
//
// Before: respawnSession and teardownSession ran engine.cleanup() then engine.kill(), and kill() is
// inert once the engine is disposed (R3.4), so the previous claude stayed alive until the adapter
// exited; and the gate stayed bound to the dead PTY. Now the gate's exit hook on the old PTY is
// dropped, the old PTY is killed BEFORE cleanup, and the gate follows the new PTY.
// AGENT INTEGRATION over the startEngine seam (agent-respawn precedent). node:test (build first):
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/respawn-retire.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

function makePty(name: string, log: string[]) {
  return {
    name,
    onExit: () => {
      log.push(`${name}.onExit`);
      return { dispose: () => log.push(`${name}.exitHook.dispose`) };
    },
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => log.push(`${name}.kill`),
  };
}

async function setup(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]) {
  const log: string[] = [];
  let spawns = 0;
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: (args: { sessionId?: string; cwd: string }) => {
      spawns += 1;
      return {
        sessionId: args.sessionId ?? "33333333-3333-4333-8333-333333333333",
        pty: makePty(`pty${spawns}`, log),
        watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
        cwd: args.cwd,
      };
    },
  } as never);
  t.after(() => agent.dispose());
  const a = agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
    sessions: Record<string, Record<string, unknown>>;
    respawnSession: (sid: string, s: unknown, c: unknown) => Promise<void>;
  };
  const { sessionId } = await a.createSession({ cwd: process.cwd(), mcpServers: [] });
  const session = a.sessions[sessionId];
  // The session's engine and gate, as createSession would leave them with the gate on.
  session.engine = {
    kill: () => log.push("oldEngine.kill"),
    cleanup: () => log.push("oldEngine.cleanup"),
  };
  session.gateExitHook = { dispose: () => log.push("oldGateExitHook.dispose") };
  session.gate = {
    isTorndown: false,
    bindPty: (p: { name: string }) => log.push(`gate.bindPty(${p.name})`),
    teardown: async () => log.push("gate.teardown"),
  };
  return { a, sessionId, session, log };
}

test("a fresh re-spawn drops the old exit hook, kills the old claude before cleanup, and rebinds the gate", async (t) => {
  const s = await setup(t);
  s.log.length = 0;
  await s.a.respawnSession(s.sessionId, s.session, { agent: "x" });
  const at = (e: string) => s.log.indexOf(e);
  assert.ok(at("oldGateExitHook.dispose") !== -1, "the old PTY's gate exit hook is dropped");
  assert.ok(at("oldEngine.kill") !== -1, "the old claude is killed");
  assert.ok(at("oldGateExitHook.dispose") < at("oldEngine.kill"), "hook dropped before the kill");
  assert.ok(at("oldEngine.kill") < at("oldEngine.cleanup"), "kill before cleanup (kill is inert after)");
  assert.ok(at("gate.bindPty(pty2)") !== -1, "the gate follows the new PTY");
  assert.ok(at("pty2.onExit") > at("gate.bindPty(pty2)"), "the new PTY's exit now tears the gate down");
  assert.equal(at("gate.teardown"), -1, "the gate the new PTY uses is not torn down");
});
