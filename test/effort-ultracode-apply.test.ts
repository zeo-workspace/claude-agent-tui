// Item 84 — the Ultracode switch, applied through the session's terminal (PARITY-REPORT §21.2/§21.7).
//
// The switch is driven with `/effort ultracode on|off` typed into the PTY, exactly as the `fast` option
// drives `/fast on|off`: no re-spawn, no turn, deferred while a turn is in flight. It is independent of
// the effort level — no xhigh is forced, an effort pick leaves it on — and no prompt is prefixed with a
// keyword. `ultracode:true` is mirrored into the scratch `--settings` file only so a re-spawn keeps it;
// the dead `ultracodeKeywordTrigger` key is never written. When the CLI answers with one of its two
// refusals, the switch goes back off with the reason.
//
// Story 060's sentinel design is what these tests replaced; each "never" below is a behaviour it had.
//
// Harness: real createSession over a fake startEngine (one shared `writes[]`, so every inject is
// observable, and an `emit` that plays terminal output into the PTY's onData listeners), an injected
// fake clock, and a STUB model catalogue so nothing reads the host CLI.
//   node --experimental-strip-types --test test/effort-ultracode-apply.test.ts   (build dist/ first)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { applyUltracodeSettings } from "../dist/gate/settings-writer.js";
import { stubModelCatalogSource } from "./helpers/stub-model-catalog.ts";

type Listener = (chunk: string) => void;

/** A fake PTY: captures every `write` and lets the test play terminal output to `onData` listeners. */
function makeFakePty(writes: string[], listeners: Set<Listener>) {
  const pty = {
    onExit: () => ({ dispose() {} }),
    onData: (fn: Listener) => {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    resize: () => {},
    write: (d: string) => {
      writes.push(d);
    },
    kill: () => {},
  };
  return pty as never;
}

function makeClient(updates: unknown[]) {
  return {
    sessionUpdate: async (n: unknown) => {
      updates.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
}

/** Fake clock shared by sendPrompt (the \r delay), the turn resolver and the reply-watch window. */
function makeClock() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, fn, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (!t.cancelled && t.at <= now) {
        t.cancelled = true;
        t.fn();
      }
    }
  };
  return { schedule, advance };
}

function makeStartEngine() {
  const calls: Array<{ resume?: boolean; effortLevel?: string; agent?: string }> = [];
  const writes: string[] = [];
  const listeners = new Set<Listener>();
  const startEngine = (args: {
    sessionId?: string;
    cwd: string;
    resume?: boolean;
    effortLevel?: string;
    agent?: string;
  }) => {
    calls.push({ resume: args.resume, effortLevel: args.effortLevel, agent: args.agent });
    return {
      sessionId: args.sessionId ?? "11111111-1111-4111-8111-111111111111",
      pty: makeFakePty(writes, listeners),
      watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
      cwd: args.cwd,
    };
  };
  const emit = (chunk: string) => {
    for (const fn of [...listeners]) fn(chunk);
  };
  return { startEngine, calls, writes, listeners, emit };
}

type OptionShape = { id: string; type?: string; currentValue?: unknown; description?: string };
type SessionShape = {
  configOptions: OptionShape[];
  ultracodeOn?: boolean;
  turnDetector?: { observe: (m: unknown) => void };
  interacted?: boolean;
  gate?: { settingsPath?: string; teardown?: () => Promise<void>; isTorndown?: boolean };
};

async function newSession(
  t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
  startEngine: unknown,
  schedule: unknown,
  updates: unknown[] = [],
  booleanCapable = true,
) {
  const agent = new ClaudeAcpAgent(makeClient(updates), undefined, undefined, {
    startEngine: startEngine as never,
    schedule: schedule as never,
    modelCatalogSource: stubModelCatalogSource,
  });
  t.after(() => agent.dispose());
  const a = agent as unknown as {
    initialize: (p: unknown) => Promise<unknown>;
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
    sessions: Record<string, SessionShape>;
  };
  await a.initialize({
    protocolVersion: 1,
    clientCapabilities: booleanCapable ? { session: { configOptions: { boolean: {} } } } : {},
  });
  const response = await a.createSession({ cwd: "/work/dir", mcpServers: [] });
  return { agent, sessionId: response.sessionId, sessions: a.sessions };
}

const setOption = (agent: ClaudeAcpAgent, sessionId: string, configId: string, value: unknown) =>
  (
    agent as unknown as {
      setSessionConfigOption: (p: {
        sessionId: string;
        configId: string;
        value: unknown;
      }) => Promise<unknown>;
    }
  ).setSessionConfigOption({ sessionId, configId, value });

const option = (sessions: Record<string, SessionShape>, id: string, configId: string) =>
  sessions[id].configOptions.find((o) => o.id === configId);

const asst = (stop_reason: unknown, uuid: string) => ({
  type: "assistant",
  uuid,
  message: { stop_reason },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Drive a real single-line prompt through the agent and return the OUTGOING PTY payload (the body
 * write that sits between the leading input-clear and the trailing submit `\r`). Resolves the turn via
 * the story-024 detector so no pending promise leaks. `writes` is the shared capture array.
 */
async function sendOnce(
  agent: ClaudeAcpAgent,
  sessionId: string,
  sessions: Record<string, SessionShape>,
  writes: string[],
  advance: (ms: number) => void,
  text: string,
  uuid: string,
): Promise<string> {
  writes.length = 0;
  const p = (
    agent as unknown as {
      prompt: (req: unknown) => Promise<unknown>;
    }
  ).prompt({ sessionId, prompt: [{ type: "text", text }] });
  await Promise.resolve(); // flush prompt()'s synchronous submit prefix
  advance(60); // let the input-clear settle → the body write lands
  advance(60); // submit \r
  // The body is everything written that is not the leading Ctrl+U clear or a bare submit \r.
  const body = writes.filter((w) => w !== "\x15" && w !== "\r").join("");
  // Resolve the turn so the awaited prompt settles.
  sessions[sessionId].turnDetector?.observe(asst("end_turn", uuid));
  advance(200);
  await p;
  return body;
}

test("84.3 toggling on types exactly `/effort ultracode on`, off types `/effort ultracode off` — no xhigh, no re-spawn", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "effort", "low");
  const callsBefore = fake.calls.length;
  fake.writes.length = 0;

  await setOption(agent, sessionId, "ultracode", true);
  const on = fake.writes.join("");
  assert.match(on, /\/effort ultracode on/);
  assert.ok(!/\/effort xhigh/.test(on), `Ultracode no longer forces xhigh; got ${JSON.stringify(on)}`);
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true);
  assert.equal(option(sessions, sessionId, "effort")?.currentValue, "low", "effort is left alone");
  assert.equal(sessions[sessionId].ultracodeOn, true);

  fake.writes.length = 0;
  await setOption(agent, sessionId, "ultracode", false);
  assert.match(fake.writes.join(""), /\/effort ultracode off/);
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, false);
  assert.equal(fake.calls.length, callsBefore, "neither direction re-spawns");
});

test("84.3 the select fallback's on/off strings drive the same commands", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule, [], false);
  assert.equal(option(sessions, sessionId, "ultracode")?.type, "select", "precondition: no boolean capability");
  fake.writes.length = 0;
  await setOption(agent, sessionId, "ultracode", "on");
  assert.match(fake.writes.join(""), /\/effort ultracode on/);
  assert.equal(sessions[sessionId].ultracodeOn, true);
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, "on");
});

test("84.3 a repeated toggle sends nothing", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);
  fake.writes.length = 0;
  await setOption(agent, sessionId, "ultracode", true);
  assert.equal(fake.writes.join(""), "");
});

test("84.4 an effort pick while on types only the level and leaves Ultracode on", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);
  fake.writes.length = 0;

  await setOption(agent, sessionId, "effort", "high");
  const all = fake.writes.join("");
  assert.match(all, /\/effort high/);
  assert.ok(!/ultracode/.test(all), `an effort pick must not touch Ultracode; got ${JSON.stringify(all)}`);
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true);
});

test("84.5 prompts go out as typed — no `ultracode` keyword prefix, on or off", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);
  const body = await sendOnce(agent, sessionId, sessions, fake.writes, clock.advance, "hello", "u-1");
  assert.ok(body.includes("hello"));
  assert.ok(!body.startsWith("ultracode"), `no keyword prefix; got ${JSON.stringify(body)}`);
});

test("84.6 a toggle during a turn is deferred, then typed once the turn settles", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  fake.writes.length = 0;
  const p = (agent as unknown as { prompt: (r: unknown) => Promise<unknown> }).prompt({
    sessionId,
    prompt: [{ type: "text", text: "long task" }],
  });
  await Promise.resolve();
  clock.advance(120);

  await setOption(agent, sessionId, "ultracode", true);
  assert.ok(
    !fake.writes.join("").includes("/effort ultracode"),
    "nothing is typed into the terminal while the turn runs",
  );
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true, "the switch shows the intent");

  sessions[sessionId].turnDetector?.observe(asst("end_turn", "u-turn"));
  clock.advance(200);
  await p;
  assert.match(fake.writes.join(""), /\/effort ultracode on/, "flushed after the turn");
});

test("84.7 a model switch keeps the intent: hidden on a model without xhigh, back on when switching back", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);

  fake.writes.length = 0;
  await setOption(agent, sessionId, "model", "lowcap");
  assert.equal(option(sessions, sessionId, "ultracode"), undefined, "hidden on lowcap");
  assert.equal(sessions[sessionId].ultracodeOn, true, "the intent survives");

  await setOption(agent, sessionId, "model", "sonnet");
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true, "back, still on");
  assert.ok(
    !fake.writes.join("").includes("/effort ultracode"),
    "a model switch types no Ultracode command — the CLI keeps the request itself",
  );
});

test("84.8 the CLI's workflows refusal turns the switch back off, with the reason, and tells the client", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const updates: Array<{ update?: { sessionUpdate?: string; configOptions?: OptionShape[] } }> = [];
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule, updates as never);
  await setOption(agent, sessionId, "ultracode", true);
  updates.length = 0;

  fake.emit("\x1b[2K  \u23bf  Ultracode needs dynamic workflows enabled (see /config). Valid options are: low");
  await flush();

  const ultracode = option(sessions, sessionId, "ultracode");
  assert.equal(ultracode?.currentValue, false, "switched back off");
  assert.match(ultracode?.description ?? "", /Off: Ultracode needs dynamic workflows enabled/);
  assert.equal(sessions[sessionId].ultracodeOn, false);
  const pushed = updates.find((u) => u.update?.sessionUpdate === "config_option_update");
  assert.ok(pushed, "a config_option_update reaches the client");
  assert.equal(
    pushed!.update!.configOptions!.find((o) => o.id === "ultracode")?.currentValue,
    false,
  );
  assert.equal(fake.listeners.size, 0, "the reply watch is gone once answered");

  // A model switch does not clear a workflows refusal: it is not about the model.
  await setOption(agent, sessionId, "model", "sonnet");
  assert.match(option(sessions, sessionId, "ultracode")?.description ?? "", /Off:/);
});

test("84.8 the per-model refusal is cleared by a model switch; a retry clears it too", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);
  fake.emit("Ultracode\x1b[1Cisn't available on claude-opus-4-6. Valid options are: low, medium, high");
  await flush();
  assert.match(
    option(sessions, sessionId, "ultracode")?.description ?? "",
    /Off: Ultracode isn't available on claude-opus-4-6\./,
  );

  await setOption(agent, sessionId, "model", "sonnet");
  assert.ok(!/Off:/.test(option(sessions, sessionId, "ultracode")?.description ?? ""));

  await setOption(agent, sessionId, "model", "default");
  await setOption(agent, sessionId, "ultracode", true);
  fake.emit("Ultracode isn't available on claude-opus-4-6.");
  await flush();
  await setOption(agent, sessionId, "ultracode", true);
  assert.ok(!/Off:/.test(option(sessions, sessionId, "ultracode")?.description ?? ""), "retry clears it");
});

test("84.8 a confirmation, or silence past the window, ends the watch without changing anything", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);

  await setOption(agent, sessionId, "ultracode", true);
  fake.emit("Ultracode on (this session only): dynamic workflows on every task. Effort stays high.");
  await flush();
  assert.equal(fake.listeners.size, 0);
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true);

  await setOption(agent, sessionId, "ultracode", false);
  await setOption(agent, sessionId, "ultracode", true);
  assert.equal(fake.listeners.size, 1, "a new watch per `on`");
  clock.advance(6000);
  assert.equal(fake.listeners.size, 0, "the window closed");
  fake.emit("Ultracode needs dynamic workflows enabled (see /config).");
  await flush();
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true, "a late line is ignored");
});

test("84.9 a re-spawn while on carries the real effort, and the scratch settings carry Ultracode", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-ultracode-respawn-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const scratch = path.join(dir, "settings.local.json");
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  // Only the scratch path matters here; the rest of the gate is inert (no hook server in this test).
  sessions[sessionId].gate = { settingsPath: scratch, teardown: async () => {}, isTorndown: true };
  await setOption(agent, sessionId, "effort", "high");
  await setOption(agent, sessionId, "ultracode", true);
  const written = JSON.parse(await fs.readFile(scratch, "utf8")) as Record<string, unknown>;
  assert.equal(written.ultracode, true, "mirrored for a re-spawn");
  assert.ok(!("ultracodeKeywordTrigger" in written), "the dead key is never written");

  await (
    agent as unknown as {
      respawnSession: (sid: string, s: unknown, c: { agent?: string }) => Promise<void>;
    }
  ).respawnSession(sessionId, sessions[sessionId], { agent: "code-reviewer" });
  assert.equal(fake.calls[fake.calls.length - 1].effortLevel, "high", "no xhigh coercion");

  await setOption(agent, sessionId, "ultracode", false);
  const after = JSON.parse(await fs.readFile(scratch, "utf8")) as Record<string, unknown>;
  assert.ok(!("ultracode" in after), "removed when switched off");
});

test("84.10 applyUltracodeSettings sets/removes only `ultracode` and preserves every other key", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-ultracode-settings-"));
  const file = path.join(dir, "settings.local.json");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const seed = {
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://x/__fork-acp-gate__" }] }] },
  };
  await fs.writeFile(file, `${JSON.stringify(seed, null, 2)}\n`, "utf8");

  await applyUltracodeSettings(file, true);
  const on = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(on).sort(), ["hooks", "ultracode"]);
  assert.equal(on.ultracode, true);
  assert.deepEqual(on.hooks, seed.hooks);

  await applyUltracodeSettings(file, false);
  const off = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(off, seed);
});

test("84.10 applyUltracodeSettings is absence-safe", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-ultracode-absent-"));
  const file = path.join(dir, "settings.local.json");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await applyUltracodeSettings(file, true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { ultracode: true });
  await applyUltracodeSettings(file, false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
});

// Story 063 — the retired `ultracode` effort notch is accepted as deprecated and mapped the way
// claude-agent-plus maps it (applyLegacyUltracodeEffort): effort xhigh plus the Ultracode switch on,
// only where the model's effort select offers xhigh. It is never typed as an effort level.

test("063 legacy `ultracode` effort: accepted, mapped to xhigh + the Ultracode switch, no re-spawn", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "effort", "low");
  const callsBefore = fake.calls.length;
  fake.writes.length = 0;

  await setOption(agent, sessionId, "effort", "ultracode");
  const typed = fake.writes.join("");
  assert.ok(typed.includes("/effort xhigh"), JSON.stringify(typed));
  assert.ok(typed.includes("/effort ultracode on"), JSON.stringify(typed));
  assert.equal(option(sessions, sessionId, "effort")?.currentValue, "xhigh");
  assert.equal(option(sessions, sessionId, "ultracode")?.currentValue, true);
  assert.equal(sessions[sessionId].ultracodeOn, true);
  assert.equal(fake.calls.length, callsBefore, "no re-spawn");
});

test("063 hostile: legacy `ultracode` never reaches the CLI as an effort level", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "effort", "ultracode");
  const typed = fake.writes.join("");
  assert.doesNotMatch(typed, /\/effort ultracode(\r|$)/);
  assert.ok(fake.calls.every((c) => c.effortLevel !== "ultracode"));
});

test("063 hostile: legacy `ultracode` on a model without xhigh is rejected", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "model", "lowcap");
  await assert.rejects(setOption(agent, sessionId, "effort", "ultracode"), /Invalid value/);
});

test("063 hostile: an unknown effort value is still rejected", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId } = await newSession(t, fake.startEngine, clock.schedule);
  await assert.rejects(setOption(agent, sessionId, "effort", "turbo"), /Invalid value/);
});

test("063 unchanged: the five real levels are typed as `/effort <level>` and leave Ultracode alone", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    fake.writes.length = 0;
    await setOption(agent, sessionId, "effort", level);
    assert.ok(fake.writes.join("").includes(`/effort ${level}`), level);
    assert.equal(option(sessions, sessionId, "effort")?.currentValue, level);
  }
  assert.notEqual(sessions[sessionId].ultracodeOn, true);
});

test("billing seam — the Ultracode path introduces no -p/--print/stream-json token", async (t) => {
  const fake = makeStartEngine();
  const clock = makeClock();
  const { agent, sessionId, sessions } = await newSession(t, fake.startEngine, clock.schedule);
  await setOption(agent, sessionId, "ultracode", true);
  await sendOnce(agent, sessionId, sessions, fake.writes, clock.advance, "do work", "u-bill");
  await setOption(agent, sessionId, "ultracode", false);
  const all = fake.writes.join("");
  assert.ok(!/--print|stream-json|(^|\s)-p(\s|$)/.test(all), JSON.stringify(all));
});
