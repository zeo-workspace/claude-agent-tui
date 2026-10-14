// Story 046 / Task 3.1 — the effort selector surfaces from catalog metadata (R2.1, R2.2 surface half).
//
// CONTRACT (story.md R2.1 + design.md §7): the `effort` configOption appears automatically WHERE the
// current model declares `supportsEffort` + `supportedEffortLevels` (catalog metadata from Task 2.1,
// wired through `buildConfigOptions`). For a non-effort model the option is ABSENT. No new emit code —
// this is the regression guard that 2.1's metadata reaches the surface.
//
// The advertised options surface through `session.configOptions`. Switching the model to an
// effort-capable catalog alias rebuilds configOptions (acp-agent applyConfigOptionValue), so this drives
// `setSessionConfigOption("model", <effort-capable alias>)` and asserts the effort option then appears.
//
// AGENT INTEGRATION over fakes (pump-tail-source.test.ts precedent). node:test (build first):
//   node --experimental-strip-types --test test/effort-surface.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { stubModelCatalogSource, STUB_MODEL_CATALOG } from "./helpers/stub-model-catalog.ts";

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

test("3.1 selecting an effort-capable catalog model surfaces the `effort` configOption (R2.1)", async (t) => {
  const effortModel = STUB_MODEL_CATALOG.find((m) => m.supportsEffort === true);
  assert.ok(effortModel, "the catalog must declare at least one effort-capable model (Task 2.1 dependency)");

  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setOption(agent, sessionId, "model", effortModel!.value);

  const effortOption = configOptions(agent, sessionId).find((o) => o.id === "effort");
  assert.ok(
    effortOption,
    `the effort configOption must surface for an effort-capable model (R2.1), options: ${configOptions(agent, sessionId).map((o) => o.id).join(", ")}`,
  );
  // The advertised effort levels must match the model's declared supportedEffortLevels (+ the default).
  const advertised = (effortOption!.options ?? []).map((o) => o.value);
  for (const level of effortModel!.supportedEffortLevels ?? []) {
    assert.ok(advertised.includes(level), `effort level '${level}' must be advertised, got: ${advertised.join(", ")}`);
  }
});

test("3.1 selecting a NON-effort model leaves the `effort` configOption absent (R2.1 — hidden)", async (t) => {
  // Story 056: `default` now advertises effort (v0.52 parity). Item 93: the host CLI's `haiku` is
  // Haiku 5.5, effort-capable since CLI 2.1.293, so the non-effort row comes from the stub catalogue.
  const nonEffort = STUB_MODEL_CATALOG.find((m) => m.value === "haiku") ?? STUB_MODEL_CATALOG.find((m) => m.supportsEffort !== true);
  assert.ok(nonEffort, "the catalog must include a non-effort model (e.g. `haiku`)");

  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  await setOption(agent, sessionId, "model", nonEffort!.value);

  const effortOption = configOptions(agent, sessionId).find((o) => o.id === "effort");
  assert.equal(effortOption, undefined, "no effort option for a non-effort model (R2.1)");
});
