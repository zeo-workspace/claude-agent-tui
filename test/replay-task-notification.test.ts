// A persisted `<task-notification>` -- the CLI telling the model that a
// background task stopped -- used to replay on session/load as a raw-XML user
// prompt. Live, the prompt loop never shows it; replay now strips it like the
// local-command markers, keeping any text typed beside it (upstream #1205).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLocalCommandMetadata } from "../dist/acp-agent.js";

const notification =
  "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n" +
  "<summary>Background task finished</summary>\n<result>raw output</result>\n" +
  "</task-notification>";

test("replay: a notification-only record is skipped", () => {
  assert.equal(stripLocalCommandMetadata(notification), null);
});

test("replay: text typed beside a notification survives, the notification does not", () => {
  assert.equal(stripLocalCommandMetadata(`${notification}\nand now summarise it`), "\nand now summarise it");
  const blocks = stripLocalCommandMetadata([
    { type: "text", text: notification },
    { type: "text", text: "and now summarise it" },
  ]);
  assert.deepEqual(blocks, [{ type: "text", text: "and now summarise it" }]);
});
