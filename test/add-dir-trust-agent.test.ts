// Parity round 26 (item 238): the agent asks the client about the `--add-dir` trust dialog at the
// first prompt, then answers it in the PTY (yes → `2`) or starts claude again without the folder (no).
//
// AGENT INTEGRATION over the startEngine seam (add-dir-fingerprint precedent): a fake PTY replays the
// dialog claude 2.1.330 draws, a fake client answers the permission request, and the session record
// is created by the REAL createSession, so watcher wiring, the request and the answer are exercised
// together. respawnSession is replaced by a recorder: its own behaviour is covered by its suites.
// node:test (build first):
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/add-dir-trust-agent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";
import { TRUST_DIALOG_MARKER } from "../dist/add-dir-trust.js";

function makeFakePty() {
  const listeners: Array<(d: string) => void> = [];
  const written: string[] = [];
  return {
    written,
    emit: (d: string) => listeners.forEach((l) => l(d)),
    onExit: () => ({ dispose() {} }),
    onData: (l: (d: string) => void) => {
      listeners.push(l);
      return { dispose() {} };
    },
    resize: () => {},
    write: (d: string) => written.push(d),
    kill: () => {},
  };
}

async function setup(t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0], choice: string) {
  const pty = makeFakePty();
  const asked: Array<{ title: string; options: Array<{ optionId: string }> }> = [];
  const client = {
    sessionUpdate: async () => {},
    requestPermission: async (p: { toolCall: { title: string }; options: Array<{ optionId: string }> }) => {
      asked.push({ title: p.toolCall.title, options: p.options });
      return choice === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: choice } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const agent = new ClaudeAcpAgent(client, undefined, undefined, {
    // Like defaultStartEngine: the PTY is handed to onSpawn the instant it exists.
    startEngine: (args: { sessionId?: string; cwd: string; onSpawn?: (p: unknown) => void }) => {
      args.onSpawn?.(pty);
      return {
        sessionId: args.sessionId ?? "22222222-2222-4222-8222-222222222222",
        pty,
        watcher: { stop: () => {}, notifyEndOfTurn: () => {} },
        cwd: args.cwd,
      };
    },
  } as never);
  t.after(() => agent.dispose());
  const a = agent as unknown as {
    createSession: (p: unknown) => Promise<{ sessionId: string }>;
    sessions: Record<string, { additionalDirectories?: string[]; addDirTrust?: unknown }>;
    resolveAddDirTrust: (sid: string, s: unknown) => Promise<void>;
    respawnSession: (sid: string, s: unknown, c: unknown) => Promise<void>;
  };
  const respawns: string[][] = [];
  a.respawnSession = async (_sid, s) => {
    respawns.push([...((s as { additionalDirectories?: string[] }).additionalDirectories ?? [])]);
  };
  const { sessionId } = await a.createSession({
    cwd: process.cwd(),
    mcpServers: [],
    additionalDirectories: ["/tmp", process.cwd()],
  });
  return { a, sessionId, record: a.sessions[sessionId], pty, asked, respawns };
}

const dialog = (dir: string) => `\x1b[1;1H ${TRUST_DIALOG_MARKER}\x1b[2;3H${dir}\x1b[8;3H No, exit\x1b[9;3H Yes, add it`;

test("yes: the client is asked once and claude gets `2`", async (t) => {
  const s = await setup(t, "trust");
  s.pty.emit(dialog("/tmp"));
  const resolving = s.a.resolveAddDirTrust(s.sessionId, s.record);
  await new Promise((r) => setImmediate(r));
  s.pty.emit("\x1b[30;1H ? for shortcuts");
  await resolving;
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0].title, /Trust \/tmp for this session\?/);
  assert.deepEqual(s.pty.written, ["2"]);
  assert.deepEqual(s.respawns, []);
  assert.deepEqual(s.record.additionalDirectories, ["/tmp", process.cwd()]);
});

for (const choice of ["refuse", "cancel"]) {
  test(`${choice}: claude starts again without that folder, and nothing is typed`, async (t) => {
    const s = await setup(t, choice);
    s.pty.emit(dialog("/tmp"));
    await s.a.resolveAddDirTrust(s.sessionId, s.record);
    assert.deepEqual(s.pty.written, [], "no keystroke: the re-spawn retires the dialog's process");
    assert.deepEqual(s.respawns, [[process.cwd()]]);
    assert.deepEqual(s.record.additionalDirectories, [process.cwd()]);
  });
}

test("no dialog: the main screen lets the prompt through without asking", async (t) => {
  const s = await setup(t, "trust");
  s.pty.emit("\x1b[30;1H ? for shortcuts");
  await s.a.resolveAddDirTrust(s.sessionId, s.record);
  assert.equal(s.asked.length, 0);
  assert.equal(s.record.addDirTrust, undefined, "a settled watcher is dropped");
});
