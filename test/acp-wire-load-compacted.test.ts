// ACP-wire: a replay-only `session/load` of a COMPACTED thread that also carries a peer message,
// through the BUILT adapter and the REAL `getSessionMessages` of the pinned SDK (>= 0.3.284).
//
// Two defects ride the same SDK bump, and both are asserted here on the wire:
//   - `getSessionMessages` stops at the last `compact_boundary`, so before `withPrecompactHistory`
//     a reopened compacted thread replayed only what followed the summary (PARITY-REPORT §21.7);
//   - since 0.3.284 it also returns messages from other agents as `is_meta` user messages with an
//     `origin`, which would replay as text the user typed without `isReplayHiddenMetaMessage`.
//
// The transcript is synthetic, shaped after a real compacted one (boundary with `parentUuid: null` +
// `logicalParentUuid`, summary flagged `isCompactSummary`/`isVisibleInTranscriptOnly`, a peer message
// with `isMeta` + `origin.kind: "peer"`), written into a THROWAWAY config dir that `dispose()` removes.
// READ-ONLY: only `initialize` + `loadSession` are issued; no `claude`/PTY is spawned.
//
// Build first: node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/acp-wire-load-compacted.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startZedSim } from "./helpers/zed-sim-client.ts";
import { projectSlug } from "./helpers/plant-transcript.ts";

const SIM_CWD = "/zedsim/compacted";
const SUMMARY = "This session is being continued from a previous conversation that ran out of context.";
const ENVELOPE = 'Another Claude session sent a message:\n<agent-message from="a1">report</agent-message>';

function plantCompacted(sessionId: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zedsim-compacted-"));
  const configDir = path.join(home, ".claude");
  const dir = path.join(configDir, "projects", projectSlug(SIM_CWD));
  fs.mkdirSync(dir, { recursive: true });
  let clock = Date.UTC(2026, 9, 15, 10, 0, 0);
  const base = () => ({
    sessionId,
    cwd: SIM_CWD,
    isSidechain: false,
    userType: "external",
    timestamp: new Date((clock += 1000)).toISOString(),
  });
  const userText = (uuid: string, parentUuid: string | null, text: string, extra = {}) => ({
    ...base(),
    type: "user",
    uuid,
    parentUuid,
    message: { role: "user", content: text },
    ...extra,
  });
  const reply = (uuid: string, parentUuid: string, text: string) => ({
    ...base(),
    type: "assistant",
    uuid,
    parentUuid,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const records = [
    userText("u1", null, "first prompt"),
    reply("a1", "u1", "first answer"),
    userText("u2", "a1", "second prompt"),
    reply("a2", "u2", "second answer"),
    {
      ...base(),
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      uuid: "b1",
      parentUuid: null,
      logicalParentUuid: "a2",
    },
    userText("s1", "b1", SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    userText("u3", "s1", "third prompt"),
    reply("a3", "u3", "third answer"),
    userText("p1", "a3", ENVELOPE, {
      isMeta: true,
      origin: { kind: "peer", from: "a1", senderTaskId: "a1", body: "report" },
    }),
    reply("a4", "p1", "peer acknowledged"),
  ];
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return { configDir, home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, info: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms. Agent stderr:\n${info()}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

test("session/load of a compacted thread replays its full history and no peer envelope", async (t) => {
  const sessionId = crypto.randomUUID();
  const planted = plantCompacted(sessionId);
  const sim = startZedSim({ configDir: planted.configDir, home: planted.home, cleanup: planted.cleanup });
  t.after(() => sim.dispose());
  const stderr = (sim.child as { collectedStderr?: () => string }).collectedStderr ?? (() => "");

  await withTimeout(
    sim.agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }),
    15000,
    stderr,
  );
  await withTimeout(sim.agent.loadSession({ sessionId, cwd: SIM_CWD, mcpServers: [] }), 15000, stderr);

  const textOf = (kind: string) =>
    sim.captured
      .filter((c) => c.sessionId === sessionId && c.update?.sessionUpdate === kind)
      .map((c) => c.update.content?.text);

  assert.deepEqual(
    textOf("user_message_chunk"),
    ["first prompt", "second prompt", SUMMARY, "third prompt"],
    "every prompt replays, the ones before the compaction included, and the peer envelope does not",
  );
  assert.deepEqual(textOf("agent_message_chunk"), [
    "first answer",
    "second answer",
    "third answer",
    "peer acknowledged",
  ]);
});
