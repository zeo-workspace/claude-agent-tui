// Item 226 (PARITY-REPORT §25.2) — the gate's fail-closed deny must reach claude BEFORE claude gives
// up on the hook. When a PreToolUse http hook times out, claude falls back to its own permission
// flow, and an allow rule or auto mode then runs the tool with nobody deciding (measured on CLI
// 2.1.319 and 2.1.325, 2026-11-14). The decider used to wait 600_000 ms against a 600 s hook, so
// claude's timer always fired first. The decider's budget is now derived from the hook timeout.
//
// OFFLINE: a REAL gate (hook server + scratch settings) and a fake ACP client whose permission
// request never answers — the operator who walked away. No claude, no Zed.
//
// node:test: build first, then
//   node --experimental-strip-types --import ./test/helpers/test-setup.ts --test test/gate-decider-budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setupSessionGate } from "../dist/permissions/gate-wiring.js";
import { DEFAULT_DECIDER_TIMEOUT_MS, deciderBudgetMs } from "../dist/permissions/hook-server.js";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, FORK_HOOK_MARKER_PATH } from "../dist/gate/settings-writer.js";

const ACP_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("the default decider budget ends before the default hook timeout", () => {
  const hookMs = DEFAULT_HOOK_TIMEOUT_SECONDS * 1000;
  const budget = deciderBudgetMs(DEFAULT_HOOK_TIMEOUT_SECONDS, undefined);
  assert.ok(budget < hookMs, `decider ${budget} ms must end before the ${hookMs} ms hook`);
  assert.equal(budget, hookMs - 15_000, "15 s left for the deny to cross loopback");
  assert.ok(DEFAULT_DECIDER_TIMEOUT_MS < hookMs, "the exported default obeys the same rule");
});

test("an explicit budget is kept when shorter, and clamped when it would outlive the hook", () => {
  assert.equal(deciderBudgetMs(600, 300_000), 300_000);
  assert.equal(deciderBudgetMs(600, 600_000), 585_000);
  assert.equal(deciderBudgetMs(600, 900_000), 585_000);
});

test("a short hook leaves half its time as the margin", () => {
  assert.equal(deciderBudgetMs(2, undefined), 1_000);
  assert.equal(deciderBudgetMs(20, undefined), 10_000);
});

function post(port: number, body: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `${FORK_HOOK_MARKER_PATH}/${token}`,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data ? JSON.parse(data) : null));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("an unanswered permission is denied before a 2 s hook would time out", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-budget-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const client = {
    sessionUpdate: async () => {},
    // The operator never answers.
    requestPermission: () => new Promise(() => {}),
    createElicitation: () => new Promise(() => {}),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as never;
  const gate = await setupSessionGate({
    client,
    settingsDir: dir,
    hookTimeoutSeconds: 2,
    onWarn: () => {},
    correlationWaitMs: 250,
    correlationPollMs: 10,
    promptAppearMs: 50,
    promptPollMs: 5,
    injectTimeoutMs: 200,
    closeTimeoutMs: 1000,
  });
  t.after(() => gate.teardown());
  gate.bindSession(ACP_SESSION_ID);
  gate.correlator.register("toolu_unanswered");

  const started = Date.now();
  const answer = await Promise.race([
    post(
      gate.port,
      JSON.stringify({
        session_id: "tui-side",
        transcript_path: "/tmp/x.jsonl",
        cwd: "/tmp",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "touch /tmp/should-not-run" },
        tool_use_id: "toolu_unanswered",
      }),
      gate.token,
    ),
    new Promise((resolve) => setTimeout(() => resolve("no answer within 3 s"), 3000)),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(answer?.hookSpecificOutput?.permissionDecision, "deny", `got ${JSON.stringify(answer)}`);
  assert.ok(elapsed < 2000, `the deny took ${elapsed} ms; the hook gives up at 2000 ms`);
});
