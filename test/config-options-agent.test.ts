// Story 056 / Task 3.2 (R3.2) — the `agent` (main-thread persona) configOption surfaces as the 4th
// dropdown ONLY when ≥1 persona is discovered, seeded to the "default" no-persona sentinel.
//
// CONTRACT (story.md R3.2 + upstream #794 `agents.length > 0` gate): a fresh session's
// `session.configOptions` carries an `id:"agent"` option AFTER mode/model/effort iff discovery
// returns ≥1 persona; its `options` start with the `{value:"default"}` sentinel then the personas, and
// the seeded `currentValue` is "default" (no persona chosen at fresh create). When discovery returns
// `[]` the option is ABSENT entirely. A later model switch must PRESERVE the option (the reconcile
// rebuilds it from the session's stored catalog, no re-glob).
//
// HERMETIC: discovery is the injected `discoverAgents` deps seam, so this never touches the real
// `~/.claude/agents`. AGENT INTEGRATION over fakes (effort-surface.test.ts precedent). node:test
// (build first):
//   node --experimental-strip-types --test test/config-options-agent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { STUB_MODEL_CATALOG, stubModelCatalogSource } from "./helpers/stub-model-catalog.ts";

type FakeAgentEntry = { value: string; displayName: string; description?: string };

function makeAgent(agents: FakeAgentEntry[]) {
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
  // The R3.2 hermetic seam: inject discovery so the surface is exercised WITHOUT the real disk glob.
  return new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: startEngine as never,
    discoverAgents: () => agents,
    // Hermetic picker: the switch target below is taken from these rows, not the host CLI's.
    modelCatalogSource: stubModelCatalogSource,
  } as never);
}

type Opt = {
  id: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string; description?: string }>;
};

const configOptions = (agent: ClaudeAcpAgent, sessionId: string): Opt[] =>
  (agent as unknown as { sessions: Record<string, { configOptions: Opt[] }> }).sessions[sessionId]
    .configOptions;

async function freshSession(agent: ClaudeAcpAgent): Promise<string> {
  const r = await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: string) =>
  (
    agent as unknown as {
      setSessionConfigOption: (p: {
        sessionId: string;
        configId: string;
        value: string;
      }) => Promise<unknown>;
    }
  ).setSessionConfigOption({ sessionId, configId, value });

const TWO_PERSONAS: FakeAgentEntry[] = [
  { value: "code-reviewer", displayName: "Code Reviewer" },
  { value: "planner", displayName: "Planner", description: "Plans the work" },
];

test("3.2 ≥1 discovered persona → `agent` follows mode/model/effort/ultracode, sentinel-first, currentValue 'default' (R3.2)", async (t) => {
  const agent = makeAgent(TWO_PERSONAS);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  const opts = configOptions(agent, sessionId);
  const ids = opts.map((o) => o.id);

  // It must be PRESENT and come last (after mode, model, effort). The fork seeds `default`, which
  // advertises effort (v0.52 parity) including xhigh, so the Ultracode switch (item 84) sits right
  // after effort and all five are present in order.
  assert.deepEqual(
    ids,
    ["mode", "model", "effort", "ultracode", "agent"],
    `agent must come after mode/model/effort/ultracode, got: ${ids.join(", ")}`,
  );

  const agentOpt = opts.find((o) => o.id === "agent");
  assert.ok(agentOpt, "the agent configOption must be present when ≥1 persona is discovered (R3.2)");

  // No persona chosen at fresh create → the no-persona sentinel.
  assert.equal(agentOpt!.currentValue, "default", "fresh create seeds the 'default' no-persona sentinel");

  // The options list starts with the `{value:"default"}` sentinel, THEN the discovered personas.
  const optionValues = (agentOpt!.options ?? []).map((o) => o.value);
  assert.deepEqual(
    optionValues,
    ["default", "code-reviewer", "planner"],
    `agent options must be the 'default' sentinel then the personas, got: ${optionValues.join(", ")}`,
  );
  assert.equal((agentOpt!.options ?? [])[0]?.name, "Default", "the sentinel's label is 'Default'");
  // The persona display name + description are surfaced from the catalog entry.
  const planner = (agentOpt!.options ?? []).find((o) => o.value === "planner");
  assert.equal(planner?.name, "Planner");
  assert.equal(planner?.description, "Plans the work");
});

test("3.2 zero discovered personas → the `agent` option is ABSENT (the gate) (R3.2)", async (t) => {
  const agent = makeAgent([]);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  const opts = configOptions(agent, sessionId);
  const agentOpt = opts.find((o) => o.id === "agent");
  assert.equal(
    agentOpt,
    undefined,
    `no agent option when discovery is empty (the agents.length > 0 gate), got ids: ${opts
      .map((o) => o.id)
      .join(", ")}`,
  );
});

test("3.2 a model switch PRESERVES the `agent` option (reconcile rebuilds from the stored catalog) (R3.2)", async (t) => {
  // Pick a second, distinct catalog model to switch to (any real alias other than the seeded default).
  const target = STUB_MODEL_CATALOG.find((m) => m.value !== "default") ?? STUB_MODEL_CATALOG[0];
  assert.ok(target, "the catalog must have at least one model to switch to");

  const agent = makeAgent(TWO_PERSONAS);
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);

  // Sanity: present before the switch.
  assert.ok(
    configOptions(agent, sessionId).some((o) => o.id === "agent"),
    "precondition: agent option present at fresh create",
  );

  await setOption(agent, sessionId, "model", target!.value);

  const agentOpt = configOptions(agent, sessionId).find((o) => o.id === "agent");
  assert.ok(
    agentOpt,
    `the agent option must survive a model switch (reconcile preserves it), got ids: ${configOptions(
      agent,
      sessionId,
    )
      .map((o) => o.id)
      .join(", ")}`,
  );
  // The reconcile rebuilds from session.agents (no re-glob) → the personas are intact.
  const optionValues = (agentOpt!.options ?? []).map((o) => o.value);
  assert.deepEqual(optionValues, ["default", "code-reviewer", "planner"]);
  // No agent was chosen, so currentValue stays the sentinel across the switch.
  assert.equal(agentOpt!.currentValue, "default");
});
