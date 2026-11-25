// Story 032 / Task 2.1 — build the TCP-loopback PreToolUse http hook entry (R2.3).
//
// buildHookEntry(port) returns a PreToolUse type:http hook group whose URL targets 127.0.0.1 on the
// given dynamic free port (story 007 transport shape), carrying a fork-owned marker so it can later
// be surgically removed (Task 3.2). An invalid port throws. Fully OFFLINE — pure construction.
//
// node:test: build first, then
//   node --experimental-strip-types --test test/gate-hook-entry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as SW from "../dist/gate/settings-writer.js";

test("2.1 buildHookEntry produces a PreToolUse type:http hook on 127.0.0.1:<port>", () => {
  const port = 45678;
  const group = SW.buildHookEntry(port);
  // matcher group shape
  assert.equal(typeof group.matcher, "string", "group must carry a matcher");
  assert.ok(Array.isArray(group.hooks), "group.hooks must be an array");
  assert.equal(group.hooks.length, 1, "exactly one http hook entry");
  const entry = group.hooks[0];
  assert.equal(entry.type, "http", "entry must be type:http (the story-007 transport)");
  assert.equal(typeof entry.url, "string", "entry must carry a url");
  assert.match(entry.url, /^http:\/\/127\.0\.0\.1:45678\b/, "url must target 127.0.0.1 on the given port");
  assert.equal(typeof entry.timeout, "number", "entry must carry a numeric timeout (seconds)");
});

test("2.1 the entry carries the fork-owned marker (surgically identifiable later)", () => {
  const group = SW.buildHookEntry(45678);
  // The fork group is recognizable via isForkHookGroup AND a user's plain group is not.
  assert.equal(SW.isForkHookGroup(group), true, "the fork's own group must be identifiable");
  const userGroup = { matcher: "Bash", hooks: [{ type: "http", url: "http://127.0.0.1:9/u" }] };
  assert.equal(SW.isForkHookGroup(userGroup), false, "a user's unrelated group must NOT be flagged");
  // The marker survives in the URL path too (authoritative marker), not only a side key.
  assert.match(group.hooks[0].url, new RegExp(SW.FORK_HOOK_MARKER_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("2.1 the timeout is honored (default seconds, and an override passes through)", () => {
  assert.equal(SW.buildHookEntry(45678).hooks[0].timeout, SW.DEFAULT_HOOK_TIMEOUT_SECONDS);
  assert.equal(SW.buildHookEntry(45678, 30).hooks[0].timeout, 30, "an explicit timeout passes through");
});

test("2.1 an invalid port throws (no malformed/ungated hook is ever produced)", () => {
  for (const bad of [0, -1, 1.5, NaN, 70000]) {
    assert.throws(
      () => SW.buildHookEntry(bad as number),
      /port must be a positive integer/,
      `port ${String(bad)} must throw`,
    );
  }
});

test("the hook fails closed: onFailure is \"block\" (a dead server must not hand the call to claude's own flow)", () => {
  // CLI 2.1.330: a failing http hook counts as a block only where onFailure is "block"; without it a
  // dead, unreachable or malformed hook leaves the call to claude's allow rules / auto mode.
  assert.equal(SW.buildHookEntry(45678).hooks[0].onFailure, "block");
  assert.equal(SW.buildHookEntry(45678, { token: "t", timeout: 30 }).hooks[0].onFailure, "block");
});
