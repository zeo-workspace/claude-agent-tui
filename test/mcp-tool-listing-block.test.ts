// @anthropic-ai/sdk 0.131.0 adds `mcp_tool_listing` to BetaContentBlock: the tool list an
// MCP server returned while a response was produced, carried so the API can reuse it when
// the message is sent back. It is a cache for the API, not content for the user, so the
// translator must emit NOTHING for it — and must not reach `unreachable()`, which logs an
// error for every block type it was not told about.
//
// Build first — imports resolve against ../dist:
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/mcp-tool-listing-block.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAcpNotifications } from "../dist/lib.js";

function translate(content: any[]): { notifs: any[]; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const logger = { log() {}, error: (...args: unknown[]) => errors.push(args) } as any;
  const notifs = toAcpNotifications(content, "assistant", "sess-mcp-listing", {}, {} as any, logger, {
    registerHooks: false,
  }) as any[];
  return { notifs, errors };
}

const listing = {
  type: "mcp_tool_listing",
  mcp_server_name: "github",
  tools: [{ name: "search_issues", description: "Search issues", input_schema: { type: "object" } }],
};

test("an mcp_tool_listing block emits no notification and logs no error", () => {
  const { notifs, errors } = translate([listing]);
  assert.deepEqual(notifs, [], "a tool listing is not rendered");
  assert.deepEqual(errors, [], "the block is handled, not routed to unreachable()");
});

test("an mcp_tool_listing block does not swallow the text around it", () => {
  const { notifs, errors } = translate([
    { type: "text", text: "before" },
    listing,
    { type: "text", text: "after" },
  ]);
  const texts = notifs
    .filter((n) => n?.update?.sessionUpdate === "agent_message_chunk")
    .map((n) => n.update.content.text);
  assert.deepEqual(texts, ["before", "after"]);
  assert.deepEqual(errors, []);
});
