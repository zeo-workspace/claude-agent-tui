// Story 060 / Task 2.1 — the "ultracode" sentinel surfaces in the effort selector (R1.1, R1.2).
//
// CONTRACT (story.md R1.1 + design.md): the `effort` configOption advertises the five REAL levels
// (default + low/medium/high/xhigh/max) followed by an `ultracode` sentinel LAST. `ultracode` is NOT a
// real `--effort` value (claude 2.1.195 rejects `--effort ultracode`); it is kept OUT of
// REASONING_EFFORT_LEVELS so no real-effort code path can ever emit it (R1.2). The sentinel must only
// appear WHERE the effort option itself appears — a non-effort model (haiku) still gets no effort option.
//
// Modeled on effort-surface.test.ts: AGENT INTEGRATION over fakes, drives configOptions through a fake
// startEngine. node:test (build first):
//   node --experimental-strip-types --test test/effort-ultracode-option.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import {
  REASONING_EFFORT_LEVELS,
  ULTRACODE_EFFORT,
  ULTRACODE_EFFORT_LEVEL,
} from "../dist/model-catalog.js";
import { stubModelCatalogSource } from "./helpers/stub-model-catalog.ts";

function makeAgent() {
  const client = {
    sessionUpdate: async () => {},
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
  return new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: startEngine as never,
    // Hermetic: never read the host CLI's picker (item 93).
    modelCatalogSource: stubModelCatalogSource,
  });
}

const configOptions = (agent: ClaudeAcpAgent, sessionId: string) =>
  (agent as unknown as {
    sessions: Record<string, { configOptions: Array<{ id: string; options?: Array<{ value: string }> }> }>;
  }).sessions[sessionId].configOptions;

async function freshSession(agent: ClaudeAcpAgent): Promise<string> {
  const r = await (agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  }).createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (agent as unknown as {
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: string }) => Promise<unknown>;
  }).setSessionConfigOption({ sessionId, configId, value });

test("2.1 effort-capable model surfaces the 5 real levels then `ultracode` LAST (R1.1)", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setOption(agent, sessionId, "model", "sonnet");

  const effortOption = configOptions(agent, sessionId).find((o) => o.id === "effort");
  assert.ok(
    effortOption,
    `the effort configOption must surface for sonnet (R1.1), options: ${configOptions(agent, sessionId).map((o) => o.id).join(", ")}`,
  );

  const advertised = (effortOption!.options ?? []).map((o) => o.value);
  // Exactly the 5 real levels in order, prefixed by `default`, with the `ultracode` sentinel LAST.
  assert.deepEqual(
    advertised,
    ["default", "low", "medium", "high", "xhigh", "max", ULTRACODE_EFFORT],
    `effort option values must be the 5 real levels then ultracode last, got: ${advertised.join(", ")}`,
  );
  // Defensive: ultracode is the trailing entry, never interleaved with the real levels.
  assert.equal(advertised[advertised.length - 1], ULTRACODE_EFFORT, "ultracode must be the LAST option");
});

test("2.1 REASONING_EFFORT_LEVELS does NOT include `ultracode` — real --effort enum intact (R1.2)", () => {
  assert.ok(
    !(REASONING_EFFORT_LEVELS as readonly string[]).includes(ULTRACODE_EFFORT),
    `the real --effort enum must never contain ultracode (R1.2), enum: ${REASONING_EFFORT_LEVELS.join(", ")}`,
  );
  // The enum stays exactly the five claude 2.1.195-accepted levels.
  assert.deepEqual([...REASONING_EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
});

test("2.1 sentinel constants: ULTRACODE_EFFORT === 'ultracode', maps to xhigh", () => {
  assert.equal(ULTRACODE_EFFORT, "ultracode");
  assert.equal(ULTRACODE_EFFORT_LEVEL, "xhigh");
});

test("2.1 a NON-effort model (haiku) still surfaces NO effort option (sentinel did not leak)", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setOption(agent, sessionId, "model", "haiku");

  const effortOption = configOptions(agent, sessionId).find((o) => o.id === "effort");
  assert.equal(effortOption, undefined, "no effort option for a non-effort model — ultracode must not leak it");
});
