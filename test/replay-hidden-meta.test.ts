// SDK >= 0.3.284 (upstream #1208): `getSessionMessages` returns messages delivered from other agents,
// sessions and channels as `is_meta` user messages carrying an `origin`. Their content is the harness
// framing ("Another Claude session sent a message: <agent-message …>"), never text the user typed, so
// they must never become a turn — neither on `session/load` replay nor on the live pump, which read the
// same SDK reader here. Measured 2026-10-15 on a COPY of a real compacted transcript under SDK 0.3.296:
// 34 such envelopes replayed as user text without the filter, 0 with it. Compaction summaries are also
// `is_meta` since that SDK and must stay.
//
// Build first: node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/replay-hidden-meta.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReplayHiddenMetaMessage, linearizeTurns } from "../dist/linearize.js";

const peer = {
  type: "user",
  uuid: "peer-1",
  session_id: "s",
  parent_tool_use_id: null,
  is_meta: true,
  origin: { kind: "peer", from: "a1", senderTaskId: "a1" },
  message: { role: "user", content: "Another Claude session sent a message:\n<agent-message from=\"a1\">hi</agent-message>" },
};

test("isReplayHiddenMetaMessage matches only meta user messages with an inter-agent origin", () => {
  assert.equal(isReplayHiddenMetaMessage(peer), true);
  for (const kind of ["channel", "observer", "observer-activity", "slack-ping"]) {
    assert.equal(isReplayHiddenMetaMessage({ ...peer, origin: { kind } }), true, kind);
  }
  assert.equal(isReplayHiddenMetaMessage({ ...peer, is_meta: undefined }), false, "not meta");
  assert.equal(
    isReplayHiddenMetaMessage({ ...peer, origin: undefined, isCompactSummary: true }),
    false,
    "a compaction summary is meta but stays",
  );
  assert.equal(isReplayHiddenMetaMessage({ ...peer, origin: { kind: "human" } }), false);
  assert.equal(isReplayHiddenMetaMessage({ ...peer, origin: { kind: "task-notification" } }), false);
  assert.equal(isReplayHiddenMetaMessage({ ...peer, type: "assistant" }), false);
  assert.equal(isReplayHiddenMetaMessage(undefined), false);
  assert.equal(isReplayHiddenMetaMessage("peer"), false);
});

test("linearizeTurns drops a peer envelope and keeps the turns and the compaction summary around it", () => {
  const summary = {
    type: "user",
    uuid: "sum",
    is_meta: true,
    isCompactSummary: true,
    message: { role: "user", content: "This session is being continued from a previous conversation..." },
  };
  const prompt = { type: "user", uuid: "u1", message: { role: "user", content: "a prompt" } };
  const answer = { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
  const turns = linearizeTurns([summary, prompt, peer, answer] as never);
  assert.deepEqual(
    turns.map((t: { uuid: string }) => t.uuid),
    ["sum", "u1", "a1"],
  );
});
