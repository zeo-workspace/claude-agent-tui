// Story 056 / Task 2.1 — the `default` model advertises effort + parity levels (R2.1, R2.2).
//
// CONTRACT (story.md R2.1/R2.2 + design): the catalog's `default` entry now declares
// `supportsEffort: true` + a `supportedEffortLevels` set that reaches PARITY with the original panel —
// exactly `["low","medium","high","xhigh","max"]` (the five tokens the installed `claude --effort`
// validates, incl. the previously-missing `xhigh` and `max`). Because `default` is the seeded model at
// createSession, the effort configOption must now surface for a fresh session on `default` — it was
// ABSENT before this change (default carried no `supportsEffort`). A genuinely non-effort model
// (`haiku`) must still OMIT the effort option (regression).
//
// Two layers, two precedents:
//   - pure-data asserts on DEFAULT_MODEL_INFO (model-catalog.test.ts precedent).
//   - the surface (buildConfigOptions is module-private, exercised via the agent): the effort option's
//     PRESENCE/levels mirror effort-surface.test.ts; the currentValue-reflects-passed-effort half
//     mirrors effort-apply.test.ts (interacted=true → setSessionConfigOption("effort", <level>)).
// node:test runner (build first):
//   node --experimental-strip-types --test test/model-catalog-effort.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { DEFAULT_MODEL_INFO, MODEL_CATALOG } from "../dist/model-catalog.js";
import { stubModelCatalogSource } from "./helpers/stub-model-catalog.ts";

const PARITY_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// ---- pure data (R2.1, R2.2) ---------------------------------------------------------------------

test("2.1 DEFAULT_MODEL_INFO declares effort support (R2.1)", () => {
  assert.equal(
    DEFAULT_MODEL_INFO.supportsEffort,
    true,
    "the `default` model must now declare supportsEffort:true so the effort selector surfaces (R2.1)",
  );
});

test("2.1 DEFAULT_MODEL_INFO advertises the full parity level set incl. xhigh + max (R2.2)", () => {
  assert.deepEqual(
    DEFAULT_MODEL_INFO.supportedEffortLevels,
    PARITY_LEVELS,
    "the default model's supportedEffortLevels must reach parity: low/medium/high/xhigh/max (R2.2)",
  );
});

// ---- catalog parity (056 v3 / R7) — order + membership mirror the original's /model picker --------

test("catalog order + membership: default, fable, opus, sonnet, haiku", () => {
  // TIER aliases only: `fable` sits right after `default`. The version-numbered `fable51`/`fable5`
  // rows were removed — the CLI rejects both (`[claude-code:unrecognized_model]`), so they were
  // picker entries that could only ever 404. The redundant `sonnet[1m]` alias and the fork-only
  // `opusplan` extra were dropped earlier (Sonnet 5 is natively 1M).
  assert.deepEqual(
    MODEL_CATALOG.map((m) => m.value),
    ["default", "fable", "opus", "sonnet", "haiku"],
    "catalog order must be Default/Fable/Opus/Sonnet/Haiku",
  );
  const byVal = (v: string) => MODEL_CATALOG.find((m) => m.value === v)!;
  assert.equal(byVal("default").displayName, "Default (recommended)", "default label carries (recommended)");
  assert.equal(
    byVal("fable").displayName,
    "Fable 5.1",
    "fallback rows name their concrete version, the way the live CLI rows do",
  );
});

test("supportsAutoMode set on every fallback row, haiku included (Haiku 5.5 supports auto)", () => {
  // Item 93: CLI 2.1.299's live `supportedModels()` marks the `haiku` row (Haiku 5.5) with
  // `supportsAutoMode: true`; the Haiku 4.5 row that lacked it is no longer what `haiku` resolves to.
  const auto = (v: string) => MODEL_CATALOG.find((m) => m.value === v)!.supportsAutoMode === true;
  for (const v of ["default", "fable", "opus", "sonnet", "haiku"]) {
    assert.ok(auto(v), `${v} must declare supportsAutoMode (surfaces the auto permission mode)`);
  }
});

test("item 93: the haiku fallback row is Haiku 5.5 with the full effort set", () => {
  const haiku = MODEL_CATALOG.find((m) => m.value === "haiku")!;
  assert.equal(haiku.displayName, "Haiku 5.5");
  assert.equal(haiku.supportsEffort, true);
  assert.deepEqual(haiku.supportedEffortLevels, PARITY_LEVELS);
});

// ---- the surface via the agent (effort-surface / effort-apply precedents) -------------------------

function makeFakePty() {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: () => {},
    kill: () => {},
  } as never;
}

function makeClient() {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** startEngine seam: call 1 is the createSession spawn; a later call is an effort re-spawn (same id). */
function makeStartEngine() {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    return {
      sessionId: args.sessionId ?? "22222222-2222-4222-8222-222222222222",
      pty: makeFakePty(),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls };
}

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    // Hermetic: never read the host CLI's picker (item 93) — its `haiku` is effort-capable now.
    modelCatalogSource: stubModelCatalogSource,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  const sessions = (
    agent as unknown as {
      sessions: Record<
        string,
        {
          configOptions: Array<{ id: string; currentValue?: unknown; options?: Array<{ value: string }> }>;
          interacted?: boolean;
        }
      >;
    }
  ).sessions;
  return { agent, sessionId: response.sessionId, sessions };
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

const effortOptionOf = (
  sessions: Record<string, { configOptions: Array<{ id: string; currentValue?: unknown; options?: Array<{ value: string }> }> }>,
  id: string,
) => sessions[id].configOptions.find((o) => o.id === "effort");

test("2.1 a fresh session on `default` SURFACES the effort option with the parity levels (R2.1, R2.2)", async (t) => {
  // No model switch — createSession seeds currentModelId === "default", so the effort option must now
  // appear directly. This assertion would FAIL before this change (default had no supportsEffort).
  const { sessions, sessionId } = await newSession(t, makeStartEngine().startEngine);

  const effortOption = effortOptionOf(sessions, sessionId);
  assert.ok(
    effortOption,
    `the effort configOption must surface for the seeded \`default\` model (R2.1); options: ${sessions[sessionId].configOptions.map((o) => o.id).join(", ")}`,
  );
  // Every parity level (incl. xhigh + max) must be advertised among the option's selectable values.
  const advertised = (effortOption!.options ?? []).map((o) => o.value);
  for (const level of PARITY_LEVELS) {
    assert.ok(
      advertised.includes(level),
      `effort level '${level}' must be advertised for default (R2.2), got: ${advertised.join(", ")}`,
    );
  }
});

test("2.1 default effort `currentValue` reflects the passed current effort (R2.2 — incl. `max`)", async (t) => {
  // effort-apply precedent: an effort change re-spawns in place (Probe-B), guarded behind `interacted`.
  // Driving it to a *new parity* level (`max`) proves both the reflection AND that `max` is accepted.
  const { agent, sessions, sessionId } = await newSession(t, makeStartEngine().startEngine);
  sessions[sessionId].interacted = true; // R3.4 guard: a re-spawn is only allowed after the first interaction

  await setOption(agent, sessionId, "effort", "max");

  assert.equal(
    effortOptionOf(sessions, sessionId)?.currentValue,
    "max",
    "after selecting `max`, the default model's effort currentValue must reflect it (R2.2 parity level)",
  );
});

test("2.1 a NON-effort model (`haiku`) still OMITS the effort option (regression)", async (t) => {
  const { agent, sessions, sessionId } = await newSession(t, makeStartEngine().startEngine);
  // Switching to haiku is a /model inject (not a re-spawn); rebuilds configOptions for a no-effort model.
  await setOption(agent, sessionId, "model", "haiku");

  assert.equal(
    effortOptionOf(sessions, sessionId),
    undefined,
    "a non-effort model (haiku) must NOT surface the effort option — non-effort models keep hiding it",
  );
});
