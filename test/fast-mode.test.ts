// Story 073 — Fast Mode Toggle.
//
// A `fast` configOption (Off/On) is advertised AFTER the model selector, GATED on an Opus alias
// (`default`/`opus`) AND detected availability (the injectable FastModeProbe seam — production default
// fails closed). Setting it injects `/fast on|off` LIVE (mirroring the `/effort` seam — no re-spawn),
// and a switch to a non-Opus model turns it off + hides it.
//
// The real availability signal is characterized by the story-073 live spike (Task 1); these tests
// inject a fake probe to exercise the advertise/apply/reconcile paths hermetically.
//   node --experimental-strip-types --test test/fast-mode.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent, defaultFastModeProbe, driveFastModeProbe } from "../dist/acp-agent.js";
import {
  isFastModeCapableModel,
  FAST_MODE_MODELS,
  classifyFastModeSignal,
} from "../dist/model-catalog.js";

// ---- Task 2 (R5.1) pure predicate --------------------------------------------------------------

test("R5.1 isFastModeCapableModel: true for default/opus, false for fable/sonnet/haiku", () => {
  for (const v of ["default", "opus"]) {
    assert.ok(isFastModeCapableModel(v), `${v} must be fast-mode capable (Opus)`);
  }
  for (const v of ["fable", "sonnet", "haiku"]) {
    assert.ok(!isFastModeCapableModel(v), `${v} must NOT be fast-mode capable (not Opus)`);
  }
  assert.deepEqual([...FAST_MODE_MODELS].sort(), ["default", "opus"], "the set is exactly {default,opus}");
});

test("R1.2 defaultFastModeProbe fails closed (returns false, writes NOTHING to the pty — R4.3)", async () => {
  const writes: string[] = [];
  assert.equal(await defaultFastModeProbe({ pty: makeFakePty(writes), cwd: "/x" }), false);
  assert.equal(writes.length, 0, "the default probe must NOT write to the pty (read-only invariant)");
});

// ---- Task 1/3.1 (R1) signal classifier — grounded in the live `/fast` panel capture --------------
//
// The GATED capture is verbatim from the story-073 live spike on an Opus 4.8 · Claude Max account with
// no usage credits: opening `/fast` renders the panel header + a gate line instead of an On/Off toggle.
// The AVAILABLE fixture is the same panel WITHOUT the gate line (binary-derived; R7.3 live-confirms).

const GATED_PANEL =
  "↯ Fast mode (research preview)\n" +
  "High-speed mode for Opus 4.8. Draws from usage credits at a higher rate. Separate rate limits apply.\n" +
  "Fast mode requires usage credits · /usage-credits to turn them on\n" +
  "Learn more: https://code.claude.com/docs/en/fast-mode   Esc to cancel";

const AVAILABLE_PANEL =
  "↯ Fast mode (research preview)\n" +
  "High-speed mode for Opus 4.8. Draws from usage credits at a higher rate. Separate rate limits apply.\n" +
  "  ON   OFF   ← fast mode resets when switching models\n" +
  "Learn more: https://code.claude.com/docs/en/fast-mode   Esc to cancel";

const PENDING_PANEL = "Fast mode unavailable: Checking fast mode availability";

// The gated panel wrapped in the kind of CSI/cursor noise the real TUI interleaves — the classifier
// must strip control sequences before matching.
const GATED_PANEL_ANSI =
  "\x1b[2K\x1b[38;5;213m↯ Fast mode (research preview)\x1b[0m\x1b[10;1H" +
  "\x1b[90mFast mode requires usage credits · /usage-credits to turn them on\x1b[0m";

test("R1 classifyFastModeSignal: live gated panel → unavailable", () => {
  assert.equal(classifyFastModeSignal(GATED_PANEL), "unavailable");
});

test("R1 classifyFastModeSignal: available panel (no gate line) → available", () => {
  assert.equal(classifyFastModeSignal(AVAILABLE_PANEL), "available");
});

test("R1 classifyFastModeSignal: pending 'Checking fast mode availability' → pending (keep waiting)", () => {
  assert.equal(classifyFastModeSignal(PENDING_PANEL), "pending");
});

test("R1 classifyFastModeSignal: no panel yet (empty / no fast text) → pending", () => {
  assert.equal(classifyFastModeSignal(""), "pending");
  assert.equal(classifyFastModeSignal("some unrelated TUI output"), "pending");
});

test("R1 classifyFastModeSignal: strips ANSI/CSI noise before matching (gated → unavailable)", () => {
  assert.equal(classifyFastModeSignal(GATED_PANEL_ANSI), "unavailable");
});

test("R1 classifyFastModeSignal: other gate reasons (subscription/org/api-only) → unavailable", () => {
  for (const gate of [
    "Fast mode requires a paid subscription",
    "Fast mode has been disabled by your organization",
    "Fast mode is only available when using the Anthropic API directly",
    "Fast mode is currently unavailable",
  ]) {
    assert.equal(
      classifyFastModeSignal(`↯ Fast mode (research preview)\n${gate}`),
      "unavailable",
      gate,
    );
  }
});

// ---- Story 063 — a model-independent anchor ----------------------------------------------------
//
// CLI 2.1.310 renders ` (research preview)` only for some models (0 occurrences of the joined
// `Fast mode (research preview)` in its strings, 2 in 2.1.302), and the second anchor matched only an
// Opus display name. Both binaries carry `High-speed mode for <name>. Draws from usage credits at a
// higher rate.` (/var/tmp/zeo-r23-E/cli-2.1.3{02,10}.strings), whatever the model.

const PANEL_2_1_310_NO_SUFFIX_SONNET =
  "↯ Fast mode\n" +
  "High-speed mode for Sonnet 5.5. Draws from usage credits at a higher rate. Separate rate limits apply.\n" +
  "  ON   OFF   ← fast mode resets when switching models\n" +
  "Learn more: https://code.claude.com/docs/en/fast-mode   Esc to cancel";

test("063 hostile: a gated panel carrying the new anchor stays unavailable", () => {
  for (const gate of [
    "Fast mode requires usage credits · /usage-credits to turn them on",
    "Fast mode requires a paid subscription",
    "Fast mode has been disabled by your organization",
    "Fast mode is only available when using the Anthropic API directly",
    "Fast mode is currently unavailable",
  ]) {
    const panel = `↯ Fast mode\nHigh-speed mode for Sonnet 5.5. Draws from usage credits at a higher rate.\n${gate}`;
    assert.equal(classifyFastModeSignal(panel), "unavailable", gate);
  }
});

test("063 hostile: the new anchor does not turn a pending panel into a verdict", () => {
  assert.equal(
    classifyFastModeSignal(
      "Fast mode unavailable: Checking fast mode availability\nDraws from usage credits at a higher rate.",
    ),
    "pending",
  );
});

test("063 2.1.310 available panel, non-Opus name, no suffix → available", () => {
  assert.equal(classifyFastModeSignal(PANEL_2_1_310_NO_SUFFIX_SONNET), "available");
});

test("063 the anchor survives ANSI noise between its words", () => {
  const ansi = "\x1b[2K↯ Fast mode\x1b[0m\x1b[3;1HHigh-speed mode for Haiku. Draws from usage\x1b[0m credits at a higher rate.";
  assert.equal(classifyFastModeSignal(ansi), "available");
});

test("063 unchanged: the 2.1.302 panel with the suffix stays available", () => {
  assert.equal(
    classifyFastModeSignal("↯ Fast mode (research preview)\nHigh-speed mode for Opus 4.8.\n  ON   OFF"),
    "available",
  );
});

test("063 unchanged: the Opus 5.5 template stays available", () => {
  assert.equal(classifyFastModeSignal("↯ Fast mode\nHigh-speed mode for Opus 5.5.\n  ON   OFF"), "available");
});

test("063 unchanged: empty buffer and the checking line stay pending", () => {
  assert.equal(classifyFastModeSignal(""), "pending");
  assert.equal(classifyFastModeSignal(PENDING_PANEL), "pending");
});

// ---- Task 3.1 (R1) live-drive probe — exercised offline via a fake signal-emitting pty ------------
//
// A fake pty that, once `/fast` is submitted, feeds `panel` to the probe's onData listener (the real
// TUI's response). This drives the REAL defaultFastModeProbe glue (open panel → collect → classify →
// Esc) without a live binary; R7.3 is the end-to-end proof on a genuinely fast-available account.
function makeSignalPty(panel: string, opts: { emitAfterInjects?: number } = {}) {
  const emitAfter = opts.emitAfterInjects ?? 1;
  let onData: ((d: string) => void) | undefined;
  let injects = 0;
  let emitted = false;
  const writes: string[] = [];
  return {
    onExit: () => ({ dispose() {} }),
    onData: (cb: (d: string) => void) => {
      onData = cb;
      return {
        dispose() {
          onData = undefined;
        },
      };
    },
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
      if (d.includes("/fast")) injects++; // each openPanel() = one `/fast` payload write
      if (!emitted && injects >= emitAfter) {
        emitted = true;
        if (panel) setTimeout(() => onData?.(panel), 5);
      }
    },
    kill: () => {},
    _writes: writes,
  } as never;
}

test("R1 driveFastModeProbe (opt-in) drives `/fast` and returns false on the live gated panel", async () => {
  const pty = makeSignalPty(GATED_PANEL);
  assert.equal(await driveFastModeProbe({ pty, cwd: "/x" }), false);
  const writes = (pty as unknown as { _writes: string[] })._writes.join("");
  assert.match(writes, /\/fast/, "the driver opened the panel via a /fast inject");
  assert.match(writes, /\x1b/, "the driver wrote Esc to dismiss the panel");
});

test("R1 driveFastModeProbe (opt-in) drives `/fast` and returns true on an available panel", async () => {
  const pty = makeSignalPty(AVAILABLE_PANEL);
  assert.equal(await driveFastModeProbe({ pty, cwd: "/x" }), true);
});

test("R1.2 driveFastModeProbe fails closed on a broken pty (returns false)", async () => {
  assert.equal(await driveFastModeProbe({ pty: {} as never, cwd: "/x" }), false);
});

test("R1 driveFastModeProbe re-injects `/fast` when the first inject is swallowed (createSession race)", async () => {
  // The panel renders ONLY after the 2nd `/fast` — models a session-start TUI that was not input-ready
  // for the first inject. The probe must re-open and still resolve `available`.
  const pty = makeSignalPty(AVAILABLE_PANEL, { emitAfterInjects: 2 });
  assert.equal(await driveFastModeProbe({ pty, cwd: "/x" }), true);
  const injects = (pty as unknown as { _writes: string[] })._writes.filter((w) =>
    w.includes("/fast"),
  ).length;
  assert.ok(injects >= 2, `expected a re-inject (>=2 /fast writes), got ${injects}`);
});

// ---- Harness (effort-apply precedent + injected fastModeProbe) ----------------------------------

function makeFakePty(writes: string[]) {
  return {
    onExit: () => ({ dispose() {} }),
    onData: () => ({ dispose() {} }),
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
    },
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

function makeStartEngine() {
  const calls: Array<{ sessionId?: string; resume?: boolean }> = [];
  const writes: string[] = [];
  const startEngine = (args: { sessionId?: string; cwd: string; resume?: boolean }) => {
    calls.push({ sessionId: args.sessionId, resume: args.resume });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(writes),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  return { startEngine, calls, writes };
}

/** Let the fire-and-forget refreshFastMode (createSession + model-switch reconcile) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

type SessionShape = {
  configOptions: Array<{ id: string; currentValue?: unknown; options?: Array<{ value: string }> }>;
  fastModeOn?: boolean;
  fastModeAvailable?: boolean;
};

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
  fastModeProbe: () => boolean | Promise<boolean>,
  extraDeps: Record<string, unknown> = {},
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    fastModeProbe: fastModeProbe as never,
    ...extraDeps,
  });
  t.after(() => agent.dispose());
  const response = await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  await tick(); // the seed model is Opus → let the initial fast probe/advertise settle
  const sessions = (agent as unknown as { sessions: Record<string, SessionShape> }).sessions;
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

const fastOption = (sessions: Record<string, SessionShape>, id: string) =>
  sessions[id].configOptions.find((o) => o.id === "fast");

// ---- Task 4 (R2) advertisement + gating --------------------------------------------------------

test("R2.1 fast toggle surfaces (Off/On) AFTER the model selector on an Opus model when available", async (t) => {
  const fake = makeStartEngine();
  const { sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  const opts = sessions[sessionId].configOptions;
  const fast = opts.find((o) => o.id === "fast");
  assert.ok(fast, "fast option present on the seeded Opus `default` model");
  assert.equal((fast as { type?: string }).type, "select");
  assert.deepEqual((fast!.options ?? []).map((o) => o.value), ["off", "on"], "Off/On options");
  assert.equal(fast!.currentValue, "off", "defaults to off");
  // Tooltip (R7.3 finding): the selector AND each Off/On option carry a description, mirroring `model`
  // (Zed renders the selected option's description as the selector tooltip).
  assert.ok((fast as { description?: string }).description, "selector has a description");
  for (const o of fast!.options ?? []) {
    assert.ok((o as { description?: string }).description, `option ${o.value} has a description`);
  }
  const modelIdx = opts.findIndex((o) => o.id === "model");
  const fastIdx = opts.findIndex((o) => o.id === "fast");
  assert.ok(fastIdx > modelIdx, "the fast toggle is positioned AFTER the model selector");
});

test("R1.2 fast toggle ABSENT when the probe fails closed", async (t) => {
  const fake = makeStartEngine();
  const { sessionId, sessions } = await newSession(t, fake.startEngine, () => false);
  assert.equal(fastOption(sessions, sessionId), undefined, "no toggle when unavailable");
});

test("R2.2 fast toggle ABSENT on a non-Opus model even when available", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "Sonnet (non-Opus) omits the toggle");
});

// ---- Task 5 (R3) live inject -------------------------------------------------------------------

test("R3.1 setting fast On injects `/fast on` live and reflects currentValue", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "on");
  assert.match(fake.writes.join(""), /\/fast on/, "expected a live /fast on inject");
  assert.equal(fastOption(sessions, sessionId)!.currentValue, "on", "currentValue reflects On");
});

test("R3.1 toggling fast back to Off injects `/fast off`", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "fast", "on");
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "off");
  assert.match(fake.writes.join(""), /\/fast off/, "expected a live /fast off inject");
  assert.equal(fastOption(sessions, sessionId)!.currentValue, "off");
});

test("R3.1 a fast inject schedules a confirm Enter for the `/fast` panel (claude 2.1.201)", async (t) => {
  // `/fast on|off` is a local-jsx command that opens a confirmation panel and leaves it open — the arg
  // pre-selects but does NOT auto-apply. Like /model's "Switch?" dialog, injectFastCommand schedules ONE
  // confirm Enter after the command; without it the toggle no-ops (story 073 R7.3 live-proof). An
  // immediate `schedule` runs it synchronously here.
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine, () => true, {
    schedule: (fn: () => void) => fn(),
  });
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "on");
  assert.match(fake.writes.join(""), /\/fast on/, "expected the /fast on write");
  const enters = fake.writes.filter((w) => w === "\r").length;
  assert.equal(enters, 2, `expected a submit \\r + a panel-confirm \\r (2 total), got ${enters}`);
  assert.equal(fake.writes[fake.writes.length - 1], "\r", "the panel-confirm Enter must trail the inject");
});

test("R3.3 a fast change does NOT re-spawn (no new startEngine call)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine, () => true);
  const before = fake.calls.length;
  await setOption(agent, sessionId, "fast", "on");
  assert.equal(fake.calls.length, before, "a /fast inject must not re-spawn the engine");
});

test("R3 a no-op fast change (already off) injects nothing", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId } = await newSession(t, fake.startEngine, () => true);
  fake.writes.length = 0;
  await setOption(agent, sessionId, "fast", "off"); // already off
  assert.equal(fake.writes.join("").includes("/fast"), false, "no /fast write for a same-state select");
});

// ---- Task 6 (R4) reconciliation on model switch ------------------------------------------------

test("R4.1 switching Opus→non-Opus resets fast to off and omits the toggle", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "fast", "on"); // fast ON on Opus
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "toggle gone on Sonnet");
  assert.equal(sessions[sessionId].fastModeOn ?? false, false, "fast state reset to off");
});

test("R4.2 switching back to Opus re-probes and re-advertises the toggle as off", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOption(agent, sessionId, "model", "sonnet");
  await tick();
  assert.equal(fastOption(sessions, sessionId), undefined, "gone on Sonnet");
  await setOption(agent, sessionId, "model", "opus");
  await tick();
  const fast = fastOption(sessions, sessionId);
  assert.ok(fast, "toggle re-advertised on return to Opus");
  assert.equal(fast!.currentValue, "off", "re-advertised as off (switching turned it off)");
});

// ---- Story 074 (#828) — config-option surface reconcile (boolean negotiation, PTY mechanism kept) --
//
// The apply path is unchanged (live `/fast on|off` inject + confirm Enter); story 074 only aligns the
// ACP *type negotiation* and lets set_config_option accept a boolean payload as well as the on/off
// string. These integration tests drive the real agent through the fake pty, so they prove the boolean
// payload reaches the SAME injectFastCommand seam and that a client advertising boolean config options
// gets a `type:"boolean"` fast option whose currentValue tracks the toggle.

/** setSessionConfigOption with a raw (boolean OR string) value — setOption forces `string`. */
const setOptionRaw = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: unknown) =>
  (
    agent as unknown as {
      setSessionConfigOption: (p: {
        sessionId: string;
        configId: string;
        value: unknown;
      }) => Promise<unknown>;
    }
  ).setSessionConfigOption({ sessionId, configId, value });

/** Build a session whose client advertised boolean config options (set before the fast probe rebuild). */
async function newSessionWithBooleanCaps(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
) {
  const agent = new ClaudeAcpAgent(makeClient(), undefined, undefined, {
    startEngine: startEngine as never,
    fastModeProbe: (() => true) as never,
  });
  t.after(() => agent.dispose());
  (agent as unknown as { clientCapabilities?: unknown }).clientCapabilities = {
    session: { configOptions: { boolean: {} } },
  };
  const response = await (
    agent as unknown as { createSession: (p: unknown) => Promise<{ sessionId: string }> }
  ).createSession({ cwd: "/work/dir", mcpServers: [] });
  await tick();
  const sessions = (agent as unknown as { sessions: Record<string, SessionShape> }).sessions;
  return { agent, sessionId: response.sessionId, sessions };
}

test("4.2 a boolean `true` payload injects `/fast on` (same seam as the on/off string)", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  fake.writes.length = 0;
  await setOptionRaw(agent, sessionId, "fast", true);
  assert.match(fake.writes.join(""), /\/fast on/, "boolean true → live /fast on inject");
  assert.equal(sessions[sessionId].fastModeOn, true, "session fast state enabled");
});

test("4.2 a boolean `false` payload injects `/fast off`", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, () => true);
  await setOptionRaw(agent, sessionId, "fast", true);
  fake.writes.length = 0;
  await setOptionRaw(agent, sessionId, "fast", false);
  assert.match(fake.writes.join(""), /\/fast off/, "boolean false → live /fast off inject");
  assert.equal(sessions[sessionId].fastModeOn, false, "session fast state disabled");
});

test("4.2 boolean true and string 'on' resolve to the SAME enabled state", async (t) => {
  const fakeB = makeStartEngine();
  const b = await newSession(t, fakeB.startEngine, () => true);
  await setOptionRaw(b.agent, b.sessionId, "fast", true);

  const fakeS = makeStartEngine();
  const s = await newSession(t, fakeS.startEngine, () => true);
  await setOptionRaw(s.agent, s.sessionId, "fast", "on");

  assert.equal(
    b.sessions[b.sessionId].fastModeOn,
    s.sessions[s.sessionId].fastModeOn,
    "boolean and string payloads converge on the same fast state",
  );
  assert.equal(b.sessions[b.sessionId].fastModeOn, true);
});

test("4.1 a client that advertises boolean config options gets a type:'boolean' fast option", async (t) => {
  const fake = makeStartEngine();
  const { agent, sessionId, sessions } = await newSessionWithBooleanCaps(t, fake.startEngine);
  const fast = fastOption(sessions, sessionId) as any;
  assert.ok(fast, "fast option advertised on the seeded Opus model");
  assert.equal(fast.type, "boolean", "boolean negotiation when the client advertised it");
  assert.equal(fast.currentValue, false, "seeded off, as a boolean");

  await setOptionRaw(agent, sessionId, "fast", true);
  assert.equal(fastOption(sessions, sessionId)!.currentValue, true, "boolean currentValue tracks the toggle");
});
