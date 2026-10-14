// The live catalogue read must be INERT: no model turn, no user hooks, no MCP servers, no transcript.
//
// It used to pass `prompt: ""`, which the SDK submits as a real user turn — the model answered it and
// the answer was billed (51 Opus responses in one day, measured 2026-10-14) — with the user's hooks
// loaded, so every read was a full session. These pin the replacement with a mocked SDK `query`:
// no spawn, no CLI.
//
// node:test runner (build first):
//   npm run build && node --experimental-strip-types --import ./test/helpers/test-setup.ts \
//     --test test/live-model-catalog-inert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readSupportedModels,
  catalogQueryOptions,
  silentPrompt,
} from "../dist/live-model-catalog.js";

const ROWS = [{ value: "opus", displayName: "Opus", description: "" }];

/** A fake `query` that records its params and drains the prompt stream like the SDK would. */
function fakeQuery(opts: { fail?: boolean } = {}) {
  const seen: { params?: any; yielded: unknown[]; closed: number; promptEnded: boolean } = {
    yielded: [],
    closed: 0,
    promptEnded: false,
  };
  const queryFn = (params: any) => {
    seen.params = params;
    // The SDK consumes the prompt stream in the background; do the same and record every message.
    void (async () => {
      for await (const message of params.prompt) seen.yielded.push(message);
      seen.promptEnded = true;
    })();
    return {
      supportedModels: async () => {
        if (opts.fail) throw new Error("control request failed");
        return ROWS;
      },
      close: () => {
        seen.closed += 1;
      },
    };
  };
  return { queryFn, seen };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("no prompt is ever submitted: the prompt is a stream that yields nothing", async () => {
  const { queryFn, seen } = fakeQuery();
  const models = await readSupportedModels(queryFn, "/usr/bin/claude");
  await settle();
  assert.deepEqual(models, ROWS);
  assert.notEqual(typeof seen.params.prompt, "string", "a string prompt (even \"\") is a real user turn");
  assert.equal(typeof seen.params.prompt[Symbol.asyncIterator], "function");
  assert.deepEqual(seen.yielded, [], "the stream must never yield a user message");
});

test("the query is closed and the prompt stream released after a successful read", async () => {
  const { queryFn, seen } = fakeQuery();
  await readSupportedModels(queryFn, "/usr/bin/claude");
  await settle();
  assert.equal(seen.closed, 1);
  assert.equal(seen.promptEnded, true, "the never-yielding stream must end once the read is over");
});

test("the query is closed and the stream released when the read fails, and the error propagates", async () => {
  const { queryFn, seen } = fakeQuery({ fail: true });
  await assert.rejects(readSupportedModels(queryFn, "/usr/bin/claude"), /control request failed/);
  await settle();
  assert.equal(seen.closed, 1);
  assert.equal(seen.promptEnded, true);
});

test("a throwing close() does not mask a successful read", async () => {
  const queryFn = (params: any) => {
    void (async () => {
      for await (const _ of params.prompt) void _;
    })();
    return {
      supportedModels: async () => ROWS,
      close: () => {
        throw new Error("teardown failed");
      },
    };
  };
  assert.deepEqual(await readSupportedModels(queryFn, "/usr/bin/claude"), ROWS);
});

test("options: user settings still load, hooks are disabled, no MCP, no transcript, the PATH binary", async () => {
  const { queryFn, seen } = fakeQuery();
  await readSupportedModels(queryFn, "/opt/bin/claude");
  assert.deepEqual(seen.params.options, catalogQueryOptions("/opt/bin/claude"));
  const options = catalogQueryOptions("/opt/bin/claude");
  assert.equal(options.pathToClaudeCodeExecutable, "/opt/bin/claude");
  assert.deepEqual(options.settingSources, ["user"], "user availableModels/env must still shape the list");
  assert.deepEqual(options.settings, { disableAllHooks: true }, "the user's hooks must not run");
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.persistSession, false, "a catalogue read writes no session transcript");
});

test("silentPrompt: ends immediately on an already-aborted signal, otherwise waits for the abort", async () => {
  const done = new AbortController();
  done.abort();
  assert.deepEqual(await silentPrompt(done.signal)[Symbol.asyncIterator]().next(), { value: undefined, done: true });

  const live = new AbortController();
  let settled = false;
  const pending = silentPrompt(live.signal)
    [Symbol.asyncIterator]()
    .next()
    .then((r) => {
      settled = true;
      return r;
    });
  await settle();
  assert.equal(settled, false, "the stream must not end (or yield) on its own");
  live.abort();
  assert.deepEqual(await pending, { value: undefined, done: true });
});
