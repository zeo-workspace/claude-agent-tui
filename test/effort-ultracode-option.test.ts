// Item 84 — Ultracode is its own switch, not a notch in the effort select.
//
// CONTRACT (PARITY-REPORT §21.2, "Tui design"): the `effort` option advertises only the real levels
// (default + low/medium/high/xhigh/max). Ultracode is a separate `ultracode` option, built like the
// `fast` option — `type:"boolean"` when the client advertised boolean config options, an on/off select
// otherwise — placed right after `effort`, and shown only on a model that can run it (one offering
// xhigh). A non-effort model gets neither option.
//
// The surface half drives configOptions through a fake startEngine over a STUB model catalogue, so it
// never reads the host CLI's picker (item 93). The pure half pins the reply classifier against the
// CLI's own strings (claude 2.1.299, `/effort` handler).
//   node --experimental-strip-types --test test/effort-ultracode-option.test.ts   (build dist/ first)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import {
  REASONING_EFFORT_LEVELS,
  ULTRACODE_CONFIG_ID,
  createUltracodeConfigOption,
  classifyUltracodeReply,
  isUltracodeCapableModel,
  resolveUltracodeEnabled,
  ultracodeCommand,
} from "../dist/model-catalog.js";
import { stubModelCatalogSource, STUB_MODEL_CATALOG } from "./helpers/stub-model-catalog.ts";

type Option = {
  id: string;
  type?: string;
  currentValue?: unknown;
  description?: string;
  options?: Array<{ value: string }>;
};

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

const configOptions = (agent: ClaudeAcpAgent, sessionId: string): Option[] =>
  (agent as unknown as { sessions: Record<string, { configOptions: Option[] }> }).sessions[sessionId]
    .configOptions;

async function freshSession(agent: ClaudeAcpAgent, booleanCapable = false): Promise<string> {
  const a = agent as unknown as {
    initialize: (p: unknown) => Promise<unknown>;
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
  };
  await a.initialize({
    protocolVersion: 1,
    clientCapabilities: booleanCapable ? { session: { configOptions: { boolean: {} } } } : {},
  });
  const r = await a.createSession({ cwd: "/work", mcpServers: [] });
  return r.sessionId;
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: unknown) =>
  (agent as unknown as {
    setSessionConfigOption: (p: { sessionId: string; configId: string; value: unknown }) => Promise<unknown>;
  }).setSessionConfigOption({ sessionId, configId, value });

// ---- surface ----------------------------------------------------------------------------------------

test("84.1 the effort select carries only the real levels — no `ultracode` notch", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent);
  await setOption(agent, sessionId, "model", "sonnet");

  const effort = configOptions(agent, sessionId).find((o) => o.id === "effort");
  assert.ok(effort, "sonnet surfaces the effort option");
  assert.deepEqual(
    (effort!.options ?? []).map((o) => o.value),
    ["default", "low", "medium", "high", "xhigh", "max"],
  );
});

test("84.2 a capable model gets a boolean `ultracode` option right after `effort` when the client supports booleans", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent, true);

  const ids = configOptions(agent, sessionId).map((o) => o.id);
  const ultracode = configOptions(agent, sessionId).find((o) => o.id === ULTRACODE_CONFIG_ID);
  assert.ok(ultracode, `the seeded default model offers xhigh, so Ultracode shows; got: ${ids.join(", ")}`);
  assert.equal(ultracode!.type, "boolean");
  assert.equal(ultracode!.currentValue, false, "off until the user turns it on");
  assert.equal(ids.indexOf(ULTRACODE_CONFIG_ID), ids.indexOf("effort") + 1, "placed right after effort");
});

test("84.2 without the boolean capability the option falls back to an on/off select", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent, false);

  const ultracode = configOptions(agent, sessionId).find((o) => o.id === ULTRACODE_CONFIG_ID);
  assert.equal(ultracode?.type, "select");
  assert.equal(ultracode?.currentValue, "off");
  assert.deepEqual(
    (ultracode?.options ?? []).map((o) => o.value),
    ["off", "on"],
  );
});

test("84.2 a model without xhigh hides the option; a non-effort model hides both", async (t) => {
  const agent = makeAgent();
  t.after(() => agent.dispose());
  const sessionId = await freshSession(agent, true);

  await setOption(agent, sessionId, "model", "lowcap");
  let ids = configOptions(agent, sessionId).map((o) => o.id);
  assert.ok(ids.includes("effort"), "lowcap still has effort levels");
  assert.ok(!ids.includes(ULTRACODE_CONFIG_ID), `no xhigh → no Ultracode; got: ${ids.join(", ")}`);

  await setOption(agent, sessionId, "model", "haiku");
  ids = configOptions(agent, sessionId).map((o) => o.id);
  assert.ok(!ids.includes("effort"), "the stub's non-effort row hides effort");
  assert.ok(!ids.includes(ULTRACODE_CONFIG_ID), "and Ultracode");
});

// ---- pure ---------------------------------------------------------------------------------------------

test("84 REASONING_EFFORT_LEVELS stays the real --effort enum", () => {
  assert.deepEqual([...REASONING_EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
});

test("84 the command is always the explicit on|off form", () => {
  assert.equal(ultracodeCommand(true), "/effort ultracode on");
  assert.equal(ultracodeCommand(false), "/effort ultracode off");
});

test("84 capability is xhigh, read from the model row", () => {
  const byValue = (v: string) => STUB_MODEL_CATALOG.find((m) => m.value === v);
  assert.equal(isUltracodeCapableModel(byValue("default")), true);
  assert.equal(isUltracodeCapableModel(byValue("lowcap")), false);
  assert.equal(isUltracodeCapableModel(byValue("haiku")), false);
  assert.equal(isUltracodeCapableModel(undefined), false);
});

test("84 resolveUltracodeEnabled accepts a boolean or the on/off string; anything else is off", () => {
  assert.equal(resolveUltracodeEnabled(true), true);
  assert.equal(resolveUltracodeEnabled(false), false);
  assert.equal(resolveUltracodeEnabled("on"), true);
  assert.equal(resolveUltracodeEnabled("off"), false);
  assert.equal(resolveUltracodeEnabled("ultracode"), false);
});

test("84 a refusal reason rides in the option's description", () => {
  const plain = createUltracodeConfigOption(false, true) as Option;
  const refused = createUltracodeConfigOption(false, true, "Ultracode isn't available on haiku.") as Option;
  assert.ok(!/Off:/.test(plain.description ?? ""));
  assert.match(refused.description ?? "", /Off: Ultracode isn't available on haiku\./);
});

test("84 classifyUltracodeReply reads the CLI's two refusals and its confirmation", () => {
  assert.deepEqual(
    classifyUltracodeReply(
      "\x1b[2K  ⎿  Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium",
    ),
    { kind: "refused", reason: "Ultracode needs dynamic workflows enabled (see /config)." },
  );
  assert.deepEqual(
    classifyUltracodeReply(
      "Ultracode isn't available on claude-haiku-4-5-20251001. Valid options are: low, medium, high",
    ),
    { kind: "refused", reason: "Ultracode isn't available on claude-haiku-4-5-20251001." },
  );
  assert.deepEqual(
    classifyUltracodeReply("Ultracode on (this session only): dynamic workflows on every task. Effort stays high."),
    { kind: "on" },
  );
  assert.deepEqual(classifyUltracodeReply("> /effort ultracode on"), { kind: "pending" });
  assert.deepEqual(classifyUltracodeReply(""), { kind: "pending" });
});

test("84 classifyUltracodeReply survives terminal rendering: cursor-forward spaces and line wraps", () => {
  assert.deepEqual(
    classifyUltracodeReply("Ultracode\x1b[1Cisn't\x1b[1Cavailable\x1b[1Con\x1b[1Chaiku. Valid"),
    { kind: "refused", reason: "Ultracode isn't available on haiku." },
  );
  assert.deepEqual(
    classifyUltracodeReply("Ultracode needs dynamic\r\n   workflows enabled (see /config)."),
    { kind: "refused", reason: "Ultracode needs dynamic workflows enabled (see /config)." },
  );
});

test("84 classifyUltracodeReply: the answer written LAST wins over an older one still in the buffer", () => {
  const older = "Ultracode needs dynamic workflows enabled (see /config). Valid options are: low";
  const newer = "Ultracode on (this session only): dynamic workflows on every task. Effort stays high.";
  assert.deepEqual(classifyUltracodeReply(`${older}\r\n${newer}`), { kind: "on" });
  assert.equal(classifyUltracodeReply(`${newer}\r\n${older}`).kind, "refused");
});
