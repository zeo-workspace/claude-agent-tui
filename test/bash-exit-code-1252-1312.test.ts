// Item 92 — port of upstream claude-agent-acp #1252 (report the exit code the result says) and #1312
// (keep a backgrounded command's terminal running until its task ends), adapted to Zeo.
//
// What Zeo reads: `_meta.terminal_exit.exit_code` as an optional integer, and it marks a command failed
// only on a NON-NULL non-zero code (or a failed tool status). So, unlike upstream, a failure whose code
// the result does not name keeps the conventional 1 instead of null: null would read as "not failed".
//
//   - a failed command whose text starts with `Exit code N` exits with N (was always 1);
//   - a failed command that names no code (a denial, a spawn error) keeps 1;
//   - a backgrounded command does NOT exit at its tool result while it still runs on the live pump;
//     the pump sends the exit when the task's `<task-notification>` reaches the transcript, with the
//     code its summary names;
//   - on replay (or any caller without the live hold) a backgrounded command exits at its result:
//     with the task's code when the transcript holds its notification, else null (unknown, NOT 0).
//
// node:test (build first): node --experimental-strip-types --import ./test/helpers/test-setup.ts \
//   --test test/bash-exit-code-1252-1312.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolUpdateFromToolResult } from "../dist/tools.js";
import { backgroundTaskEnds } from "../dist/background-task-end.js";
import { ClaudeAcpAgent } from "../dist/acp-agent.js";

const failed = (content: unknown) =>
  ({ type: "tool_result", tool_use_id: "toolu_B", is_error: true, content }) as any;
const ok = (text: string) =>
  ({ type: "tool_result", tool_use_id: "toolu_B", content: [{ type: "text", text }] }) as any;
const BASH = { name: "Bash", id: "toolu_B" };
const exitOf = (u: any) => u?._meta?.terminal_exit;

// --- #1252: the exit code ------------------------------------------------------------------------

test("#1252: a failure whose text starts with `Exit code N` exits with N, not 1", () => {
  const u: any = toolUpdateFromToolResult(failed("Exit code 2\nboom"), BASH, true);
  assert.equal(exitOf(u).exit_code, 2);
  const arr: any = toolUpdateFromToolResult(failed([{ type: "text", text: "Exit code 127\nnot found" }]), BASH, true);
  assert.equal(exitOf(arr).exit_code, 127, "array content is parsed the same way");
  const bare: any = toolUpdateFromToolResult(failed("Exit code 3"), BASH, true);
  assert.equal(exitOf(bare).exit_code, 3, "a code with no output after it");
});

test("#1252: a failure that names no code keeps 1 — never null, which Zeo would not mark failed", () => {
  const denial: any = toolUpdateFromToolResult(failed("Permission to use Bash has been denied."), BASH, true);
  assert.equal(exitOf(denial).exit_code, 1);
  const midText: any = toolUpdateFromToolResult(failed("output\nExit code 9"), BASH, true);
  assert.equal(exitOf(midText).exit_code, 1, "only a LEADING `Exit code N` is Claude Code's own line");
  const zero: any = toolUpdateFromToolResult(failed("Exit code 0\nodd"), BASH, true);
  assert.equal(exitOf(zero).exit_code, 1, "a failure never reports 0, which would read as success");
});

test("#1252: a success still exits 0 and an interrupted command still exits 1", () => {
  assert.equal(exitOf(toolUpdateFromToolResult(ok("done"), BASH, true)).exit_code, 0);
  const aborted: any = toolUpdateFromToolResult(ok("partial"), BASH, true, {
    stdout: "partial",
    stderr: "",
    interrupted: true,
  });
  assert.equal(exitOf(aborted).exit_code, 1);
});

// --- #1312: the backgrounded command ---------------------------------------------------------------

const BG_RESULT = ok("Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output");
const BG_STRUCTURED = { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "bg1" };

test("#1312: on the live hold a backgrounded command leaves the exit out; its output still goes", () => {
  const u: any = toolUpdateFromToolResult(BG_RESULT, BASH, true, BG_STRUCTURED, {
    ended: () => undefined,
    holdRunning: true,
  });
  assert.equal(exitOf(u), undefined, "no terminal_exit while the command still runs");
  assert.match(String(u._meta.terminal_output.data), /running in background/);
  assert.equal(u.content[0].type, "terminal");
});

test("#1312: without the live hold a backgrounded command exits at its result with null, not an invented 0", () => {
  const u: any = toolUpdateFromToolResult(BG_RESULT, BASH, true, BG_STRUCTURED);
  assert.equal(exitOf(u).exit_code, null);
});

test("#1312: a backgrounded command whose task already ended exits at its result with the task's code", () => {
  for (const holdRunning of [true, false]) {
    const u: any = toolUpdateFromToolResult(BG_RESULT, BASH, true, BG_STRUCTURED, {
      ended: (id: string) => (id === "toolu_B" ? { status: "failed", exitCode: 3 } : undefined),
      holdRunning,
    });
    assert.equal(exitOf(u).exit_code, 3, `holdRunning=${holdRunning}`);
  }
});

// --- the transcript parser -------------------------------------------------------------------------

const note = (id: string, status: string, summary: string) =>
  `<task-notification>\n<task-id>t-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

test("backgroundTaskEnds reads the notification from each record Claude Code writes it into", () => {
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: note("toolu_q", "completed", 'Background command "a" completed (exit code 0)') }),
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: note("toolu_a", "failed", 'Background command "b" failed with exit code 3') } }),
    JSON.stringify({ type: "user", message: { role: "user", content: note("toolu_u", "killed", 'Background command "c" was stopped') } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: note("toolu_t", "completed", "done") }] } }),
    "",
    "{not json",
  ];
  const ends = backgroundTaskEnds(lines);
  assert.deepEqual(ends.get("toolu_q"), { status: "completed", exitCode: 0 });
  assert.deepEqual(ends.get("toolu_a"), { status: "failed", exitCode: 3 });
  assert.deepEqual(ends.get("toolu_u"), { status: "killed", exitCode: 1 }, "a stopped task with no code is not a success");
  assert.deepEqual(ends.get("toolu_t"), { status: "completed", exitCode: 0 }, "completed with no code reads 0");
  assert.equal(ends.size, 4);
});

test("backgroundTaskEnds ignores notification text inside a tool_result (e.g. `cat` of a transcript)", () => {
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cat", content: note("toolu_fake", "failed", "exit code 9") }] },
    }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: note("toolu_fake2", "failed", "exit code 9") }] } }),
  ];
  assert.equal(backgroundTaskEnds(lines).size, 0);
});

// --- the live pump and the replay ------------------------------------------------------------------

const BG_TOOL_USE = {
  uuid: "b1",
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_BG", name: "Bash", input: { command: "sleep 5", run_in_background: true } }],
  },
};
const BG_TOOL_RESULT = {
  uuid: "b2",
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_BG", content: "Command running in background with ID: bgx." }],
  },
};
const REDUCED = [BG_TOOL_USE, BG_TOOL_RESULT];
const RAW_RUNNING = [
  JSON.stringify(BG_TOOL_USE),
  JSON.stringify({ ...BG_TOOL_RESULT, toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "bgx" } }),
];
const RAW_ENDED = [
  ...RAW_RUNNING,
  JSON.stringify({ type: "queue-operation", operation: "enqueue", content: note("toolu_BG", "failed", 'Background command "sleep" failed with exit code 4') }),
];

function makeAgent(raw: { lines: string[] }) {
  const captured: any[] = [];
  const client = {
    sessionUpdate: async (n: any) => {
      captured.push(n);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as never;
  const fakeStartEngine = (args: { sessionId?: string; cwd: string }) => ({
    sessionId: args.sessionId ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    pty: { onExit: () => ({ dispose() {} }), onData: () => ({ dispose() {} }), resize() {}, write() {}, kill() {} } as never,
    watcher: { stop() {}, notifyEndOfTurn() {} },
    cwd: args.cwd,
  });
  const agent: any = new ClaudeAcpAgent(client, undefined, undefined, {
    startEngine: fakeStartEngine,
    getMessages: async () => REDUCED as never,
    liveDiff: true,
    diffEnrichOptions: { findTranscript: () => ["/fake.jsonl"], readRawLines: () => raw.lines },
  });
  agent.clientCapabilities = { _meta: { terminal_output: true } };
  const exits = () =>
    captured
      .filter((c) => c.update?._meta?.terminal_exit?.terminal_id === "toolu_BG")
      .map((c) => c.update._meta.terminal_exit.exit_code);
  return { agent, exits };
}

test("#1312 live pump: no exit at launch, one exit with the task's code when its notification lands", async (t) => {
  const raw = { lines: RAW_RUNNING };
  const { agent, exits } = makeAgent(raw);
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);

  await agent.pumpUpdates(sessionId);
  assert.deepEqual(exits(), [], "the terminal must not exit while the backgrounded command runs");

  await agent.pumpUpdates(sessionId);
  assert.deepEqual(exits(), [], "a re-read without the notification still sends no exit");

  raw.lines = RAW_ENDED;
  await agent.pumpUpdates(sessionId);
  assert.deepEqual(exits(), [4], "the task's end sends exactly one exit, with the code its summary names");

  await agent.pumpUpdates(sessionId);
  assert.deepEqual(exits(), [4], "the exit is sent once");
});

test("#1312 live pump: a command whose task ended before the pump read it exits at its result", async (t) => {
  const { agent, exits } = makeAgent({ lines: RAW_ENDED });
  t.after(() => agent.dispose());
  const sessionId = await agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await agent.pumpUpdates(sessionId);
  await agent.pumpUpdates(sessionId);
  assert.deepEqual(exits(), [4]);
});

test("#1312 replay: a backgrounded command exits at its result — the task's code, else null", async (t) => {
  const ended = makeAgent({ lines: RAW_ENDED });
  t.after(() => ended.agent.dispose());
  const sid1 = await ended.agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await ended.agent.replaySessionHistory(sid1);
  assert.deepEqual(ended.exits(), [4]);

  const running = makeAgent({ lines: RAW_RUNNING });
  t.after(() => running.agent.dispose());
  const sid2 = await running.agent.createSession({ cwd: "/w", mcpServers: [] }).then((r: any) => r.sessionId);
  await running.agent.replaySessionHistory(sid2);
  assert.deepEqual(running.exits(), [null], "a replayed command no longer runs here; its code is unknown");
});
