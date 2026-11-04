// Story 063 / Task 2.1 (R1, R1.1, R4) — the `available_commands_update` the agent emits at session
// creation must carry the DISK-DISCOVERED command set (keyed on the session cwd), not the old
// unconditional `[]`. AGENT INTEGRATION over fakes (config-options-agent.test.ts precedent): the
// `discoverCommands` deps seam is injected so this never touches the real `~/.claude`, and a capturing
// fake client records every `session/update` so we can assert the emitted `available_commands_update`.
//
// node:test (build first — imports the compiled agent):
//   node --experimental-strip-types --test test/available-commands-wiring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";

type CapturedUpdate = { sessionUpdate: string; availableCommands?: AvailableCommand[] };

function makeAgent(discoverCommands: (cwd: string) => AvailableCommand[]) {
  const updates: CapturedUpdate[] = [];
  const client = {
    sessionUpdate: async (n: { update: CapturedUpdate }) => {
      updates.push(n.update);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const startEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pty: {
      onExit: () => ({ dispose() {} }),
      onData: () => ({ dispose() {} }),
      resize() {},
      write() {},
      kill() {},
    } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: startEngine as never,
    discoverCommands,
  } as never);
  return { agent, updates };
}

const createSession = (agent: ClaudeAcpAgent, cwd: string) =>
  (agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }).createSession(
    { cwd, mcpServers: [] },
  );

const emitCommands = (agent: ClaudeAcpAgent, sessionId: string) =>
  (agent as unknown as { sendAvailableCommandsUpdate: (id: string) => Promise<void> })
    .sendAvailableCommandsUpdate(sessionId);

const availableCommandsBatches = (updates: CapturedUpdate[]) =>
  updates.filter((u) => u.sessionUpdate === "available_commands_update");

test("2.1 the session emits available_commands_update with the discovered set, not [] (R1)", async (t) => {
  const discovered: AvailableCommand[] = [
    { name: "help", description: "List available slash commands" },
    { name: "ship", description: "ship it", input: { hint: "<target>" } },
  ];
  const { agent, updates } = makeAgent(() => discovered);
  t.after(() => agent.dispose());

  const { sessionId } = await createSession(agent, "/work");
  await emitCommands(agent, sessionId);

  const batches = availableCommandsBatches(updates);
  assert.equal(batches.length, 1, "exactly one available_commands_update emitted");
  assert.deepEqual(batches[0].availableCommands, discovered);
});

test("2.1 discovery is keyed on the session cwd (R1.1)", async (t) => {
  let seenCwd: string | undefined;
  const { agent } = makeAgent((cwd) => {
    seenCwd = cwd;
    return [{ name: "x", description: "x" }];
  });
  t.after(() => agent.dispose());

  const { sessionId } = await createSession(agent, "/some/project");
  await emitCommands(agent, sessionId);

  assert.equal(seenCwd, "/some/project", "discoverCommands must be called with the session cwd");
});

test("2.1 discovery failure degrades to [] and never crashes the session (R4)", async (t) => {
  const { agent, updates } = makeAgent(() => {
    throw new Error("boom");
  });
  t.after(() => agent.dispose());

  const { sessionId } = await createSession(agent, "/work");
  await emitCommands(agent, sessionId); // must NOT throw

  const batches = availableCommandsBatches(updates);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].availableCommands, []);
});
