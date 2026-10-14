// Ported from claude-agent-plus `src/tests/compacted-history.test.ts`, plus the tui-only seams
// (transcript locator, `toolUseResult` hydration). `getSessionMessages` stops at the last
// `compact_boundary`, so a reopened compacted thread replayed only what followed the summary —
// PARITY-REPORT §21.7 measured 21 of 43 and 1 of 19 prompts. Every transcript here is a synthetic
// file written into a fresh temp dir and removed afterwards; no real transcript is read.
//
// Build first: node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/compacted-history.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTranscript,
  precompactMessages,
  withPrecompactHistory,
} from "../dist/compacted-history.js";

const SID = "session-1";
type Rec = Record<string, unknown>;
type Msg = { uuid?: string; message?: unknown; [k: string]: unknown };

const user = (uuid: string, parentUuid: string | null, text: string, extra: Rec = {}): Rec => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (uuid: string, parentUuid: string | null, text: string): Rec => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const boundary = (uuid: string, logicalParentUuid: string | null): Rec => ({
  type: "system",
  subtype: "compact_boundary",
  uuid,
  parentUuid: null,
  logicalParentUuid,
});
const SUMMARY = "This session is being continued from a previous conversation...";
const summary = (uuid: string, parentUuid: string): Rec =>
  user(uuid, parentUuid, SUMMARY, { isCompactSummary: true });

const jsonl = (records: Rec[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const texts = (messages: Msg[]) =>
  messages.map((m) => {
    const content = (m.message as { content: unknown }).content;
    return typeof content === "string" ? content : (content as { text: string }[])[0].text;
  });

describe("precompactMessages", () => {
  test("walks back through logicalParentUuid", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        user("u2", "a1", "second prompt"),
        boundary("b1", "u2"),
        summary("s1", "b1"),
      ]),
    );
    assert.deepEqual(texts(precompactMessages(records, SID)), ["first prompt", "first answer", "second prompt"]);
  });

  test("falls back to position when the logical parent is not in the file", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        boundary("b1", "missing-uuid"),
        summary("s1", "b1"),
      ]),
    );
    assert.deepEqual(texts(precompactMessages(records, SID)), ["first prompt", "first answer"]);
  });

  test("crosses every earlier compaction, not only the last", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "oldest"),
        boundary("b1", "u1"),
        summary("s1", "b1"),
        user("u2", "s1", "middle"),
        boundary("b2", "u2"),
        summary("s2", "b2"),
      ]),
    );
    assert.deepEqual(texts(precompactMessages(records, SID)), ["oldest", SUMMARY, "middle"]);
  });

  test("keeps getSessionMessages' filters: no isMeta, no sidechain", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "prompt"),
        user("m1", "u1", "meta", { isMeta: true }),
        assistant("a1", "m1", "answer"),
        { ...assistant("x1", "a1", "subagent"), isSidechain: true },
        boundary("b1", "a1"),
      ]),
    );
    const messages = precompactMessages(records, SID);
    assert.deepEqual(texts(messages), ["prompt", "answer"]);
    assert.equal(messages[0].session_id, SID);
    assert.equal(messages[0].parent_tool_use_id, null);
    assert.equal(messages[0].is_meta, false);
  });

  test("returns nothing for a transcript that was never compacted", () => {
    const records = parseTranscript(jsonl([user("u1", null, "p"), assistant("a1", "u1", "a")]));
    assert.deepEqual(precompactMessages(records, SID), []);
  });

  test("hydrates toolUseResult only when asked", () => {
    const records = parseTranscript(
      jsonl([user("u1", null, "prompt", { toolUseResult: { filePath: "/x" } }), boundary("b1", "u1")]),
    );
    assert.equal("toolUseResult" in precompactMessages(records, SID)[0], false);
    assert.deepEqual(precompactMessages(records, SID, { hydrateToolUseResult: true })[0].toolUseResult, {
      filePath: "/x",
    });
  });

  test("skips a torn last line", () => {
    const text = jsonl([user("u1", null, "prompt"), boundary("b1", "u1")]) + '{"type":"user","uu';
    assert.deepEqual(texts(precompactMessages(parseTranscript(text), SID)), ["prompt"]);
  });
});

describe("withPrecompactHistory", () => {
  const records = [
    user("u1", null, "first prompt"),
    assistant("a1", "u1", "first answer"),
    boundary("b1", "a1"),
    summary("s1", "b1"),
    user("u2", "s1", "after"),
  ];
  // What SDK >= 0.3.284 returns for that file: it stops at the boundary and flags the summary.
  const sdk: Msg[] = [
    { type: "user", uuid: "s1", is_meta: true, isCompactSummary: true, message: { role: "user", content: SUMMARY } },
    { type: "user", uuid: "u2", message: { role: "user", content: "after" } },
  ];

  function withTranscript(lines: string): { find: (sid: string) => string[]; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-compacted-"));
    const file = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(file, lines, "utf8");
    return {
      find: (sid) => (sid === SID ? [file] : []),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("prepends the history the compaction hid", async (t) => {
    const { find, cleanup } = withTranscript(jsonl(records));
    t.after(cleanup);
    const result = await withPrecompactHistory(SID, sdk, { findTranscript: find });
    assert.deepEqual(texts(result), ["first prompt", "first answer", SUMMARY, "after"]);
  });

  test("does not duplicate a message the compaction preserved on both sides", async (t) => {
    const { find, cleanup } = withTranscript(jsonl(records));
    t.after(cleanup);
    const withPreserved = [sdk[0], { type: "assistant", uuid: "a1", message: records[1].message }, sdk[1]];
    const result = await withPrecompactHistory(SID, withPreserved, { findTranscript: find });
    assert.deepEqual(
      result.map((m: Msg) => m.uuid),
      ["u1", "s1", "a1", "u2"],
    );
  });

  test("returns the SDK messages unchanged when the thread does not start at a summary", async () => {
    let looked = false;
    const plain = [sdk[1]];
    const result = await withPrecompactHistory(SID, plain, {
      findTranscript: () => {
        looked = true;
        return [];
      },
    });
    assert.equal(result, plain);
    assert.equal(looked, false, "an uncompacted session reads nothing");
  });

  test("returns the SDK messages unchanged when the transcript is missing, unreadable or unlocatable", async () => {
    assert.equal(await withPrecompactHistory(SID, sdk, { findTranscript: () => [] }), sdk);
    assert.equal(await withPrecompactHistory(SID, sdk, { findTranscript: () => ["/nonexistent/x.jsonl"] }), sdk);
    assert.equal(
      await withPrecompactHistory(SID, sdk, {
        findTranscript: () => {
          throw new Error("glob failed");
        },
      }),
      sdk,
    );
  });

  test("the default locator reads under CLAUDE_CONFIG_DIR, where the SDK read", async (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-compacted-cfg-"));
    const project = path.join(configDir, "projects", "-some-project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SID}.jsonl`), jsonl(records), "utf8");
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      fs.rmSync(configDir, { recursive: true, force: true });
    });
    const result = await withPrecompactHistory(SID, sdk);
    assert.deepEqual(texts(result), ["first prompt", "first answer", SUMMARY, "after"]);
  });
});
