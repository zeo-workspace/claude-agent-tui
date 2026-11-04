import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 011 / Task 1.1 — confirm the ACP transport reuses the upstream v0.53.0
// shape: `runAcp` wires `ndJsonStream(stdin/stdout)` + the SDK's agent connection
// with no engine handle threaded into the transport. (Story 071: ACP SDK 2.x removed
// `AgentSideConnection`; the connection is now `acpAgent()…connect(stream)` and the
// agent gets its client through `ClientConnection(connection.client)`.) (Story 038 added an OPTIONAL
// `deps?: AgentDeps` config param to runAcp — usageUpdate resolved from env — passed
// to the agent at constructor position 4; the transport wiring + the no-engine-coupling
// guarantee asserted below are unchanged.) Anchored by SYMBOL, never by
// line number (§3: line numbers are volatile). This is a source-level
// characterization test — `runAcp` binds the real process.stdin/stdout, so driving
// it here would hang the event loop; the durable evidence is the wiring shape of
// the `runAcp` body itself.
//
// Scope note (story 011 decision D2): `acp-agent.ts` legitimately still IMPORTS the
// SDK `query` symbol — the CUT `createSession`/`prompt()` code remains in the module,
// comment-fenced by story 010 (`SEAM(010)` markers) pending the 023 rewrite. So the
// "no engine coupling" assertion is scoped to the `runAcp` transport entrypoint's
// BODY, not the whole-module import graph: the transport itself must not reference
// the cut engine path.

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(join(here, "..", "src", "acp-agent.ts"), "utf8");

// Extract a top-level function body by NAME via brace matching (never by line).
function functionBody(src: string, name: string): string {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = src.match(decl);
  assert.ok(m && m.index !== undefined, `acp-agent.ts: function '${name}' not declared`);
  const open = src.indexOf("{", m.index);
  assert.ok(open !== -1, `acp-agent.ts: no body opening brace for '${name}'`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`acp-agent.ts: unbalanced braces in '${name}'`);
}

const runAcpBody = functionBody(agentSrc, "runAcp");

test("acp transport (reuse 1:1): runAcp wires ndJsonStream over stdin/stdout", () => {
  // stdio transport: stdout is the writable sink, stdin the readable source.
  assert.match(
    runAcpBody,
    /nodeToWebWritable\(\s*process\.stdout\s*\)/,
    "runAcp must wrap process.stdout as the writable side",
  );
  assert.match(
    runAcpBody,
    /nodeToWebReadable\(\s*process\.stdin\s*\)/,
    "runAcp must wrap process.stdin as the readable side",
  );
  assert.match(runAcpBody, /ndJsonStream\(/, "runAcp must build the ND-JSON stream via ndJsonStream(...)");
});

test("acp transport (reuse 1:1): runAcp connects the SDK's agent app with no engine handle", () => {
  assert.match(runAcpBody, /acpAgent\(\)[\s\S]*\.connect\(\s*stream\s*\)/, "runAcp must connect the SDK agent app to the stream");
  // The agent factory threads the ACP `client` plus the bootstrap config `deps`
  // (story 038: usageUpdate resolved from process.env.USAGE_UPDATE) — but constructor
  // positions 2-3 (logger/engine) stay `undefined`, so NO engine handle is coupled into
  // the transport. The 011 engine-agnostic-transport guarantee holds: the engine arg is
  // undefined; only a config-flag bag (AgentDeps) is passed.
  assert.match(
    runAcpBody,
    /new\s+ClaudeAcpAgent\(\s*new\s+ClientConnection\(\s*connection\.client\s*\)\s*,\s*undefined\s*,\s*undefined\s*,\s*deps\s*\)/,
    "runAcp must build ClaudeAcpAgent(new ClientConnection(connection.client), undefined, undefined, deps) — engine (position 3) stays undefined so no engine handle is threaded into the transport; only the bootstrap config deps is passed",
  );
});

test("acp transport (engine-agnostic transport): runAcp body references no cut SDK engine symbol", () => {
  // D2: scoped to the transport entrypoint body — the module still imports the
  // fenced CUT `query` (story 010), but the transport must not touch it.
  for (const engineSym of ["query(", "claudeCliPath", "createSession"]) {
    assert.ok(
      !runAcpBody.includes(engineSym),
      `runAcp transport must not reference the cut engine symbol '${engineSym}'`,
    );
  }
});

test("acp transport: body extractor is real (control)", () => {
  // Proves the body slice is non-vacuous: a positive anchor is present and a bogus
  // token is absent, so the assertions above are meaningful (not vacuously true).
  assert.ok(runAcpBody.includes("ClientConnection"));
  assert.ok(!runAcpBody.includes("thisSymbolIsNeverInRunAcp"));
});
