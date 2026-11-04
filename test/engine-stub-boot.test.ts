import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { agent as acpAgent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, ClientConnection } from "../dist/acp-agent.js";
import { createStubEngine, StubEngine, ENGINE_NOT_IMPLEMENTED_011 } from "../dist/engine.js";

// Story 011 / Task 2 — the agent must boot end-to-end on a TEMPORARY no-op engine so
// the SDK `query()` path stays fully cut (READ-ONLY Degrau 1). Two concerns:
//   2.1 boot      — the stub satisfies the engine seam; the agent + a live
//                   AgentSideConnection start without throwing; initialize is served.
//   2.2 guard     — the stub module reaches no credit-billing SDK `query()` path.
// Behavioral parts import the built tree (dist/) — under `node --test` the source's
// `./x.js` specifiers only resolve once compiled.

const here = dirname(fileURLToPath(import.meta.url));

// Strip comments so module-graph assertions test CODE, not prose (the stub's
// comments deliberately mention the SDK / query() to explain what it avoids).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function within<T>(promise: Promise<T>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((r) => {
    t = setTimeout(r, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

// --- 2.1 boot --------------------------------------------------------------------

test("engine stub boot: constructing the agent with the stub engine boots without throwing", () => {
  const agent = new ClaudeAcpAgent({} as never, console, createStubEngine());
  assert.equal(agent.engine.kind, "stub", "agent must boot on the injected stub engine");
});

test("engine stub boot: the agent's DEFAULT engine is the stub (runAcp boots stubbed)", () => {
  // runAcp builds `new ClaudeAcpAgent(client)` (Task 1.1) — with no engine argument
  // the constructor defaults to the stub, so production boots READ-ONLY in 011.
  const agent = new ClaudeAcpAgent({} as never);
  assert.equal(agent.engine.kind, "stub");
});

test("engine stub boot: initialize is served on the stub engine", async () => {
  const agent = new ClaudeAcpAgent({} as never, console, createStubEngine());
  const res = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);
  assert.equal(res.protocolVersion, 1, "the stubbed agent still serves the initialize handshake");
});

test("engine stub boot: stub work methods reject loudly (cut path is legible, not silent)", async () => {
  const engine = new StubEngine();
  // Exact-message matcher — the message contains literal parens, so a RegExp built
  // from it would mis-read them as a capture group.
  const isStubError = (err: unknown) => err instanceof Error && err.message === ENGINE_NOT_IMPLEMENTED_011;
  await assert.rejects(engine.createSession({}), isStubError);
  await assert.rejects(engine.prompt({}), isStubError);
});

test("engine stub boot: a live agent connection boots on the stub engine without throwing", async () => {
  // In-memory transport: an immediately-ended readable + a discarding writable. The
  // agent is built on the stub right after connect(), as runAcp builds it (story 071:
  // ACP SDK 2.x removed AgentSideConnection); the ended input lets the connection close
  // cleanly so the test can't hang.
  const endedInput = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  const discard = new WritableStream<Uint8Array>({ write() {} });
  const stream = ndJsonStream(discard, endedInput);

  const connection = acpAgent().connect(stream);
  const built: ClaudeAcpAgent | undefined = new ClaudeAcpAgent(
    new ClientConnection(connection.client),
    console,
    createStubEngine(),
  );

  assert.ok(connection, "the agent connection must open over the stub-engine agent");
  assert.ok(built, "the agent must build over the live connection's client");
  assert.equal(built!.engine.kind, "stub", "the live connection's agent boots on the stub engine");
  await within(connection.closed, 2000);
});

// --- 2.2 guard: the stub reaches no credit-billing SDK query() path --------------

test("engine stub guard: src/engine.ts module graph carries no SDK query import", () => {
  const srcCode = stripComments(readFileSync(join(here, "..", "src", "engine.ts"), "utf8"));
  // The stub is a leaf module that imports NOTHING — so no SDK `query` is reachable.
  assert.ok(
    !srcCode.includes("@anthropic-ai/claude-agent-sdk"),
    "src/engine.ts must not import the credit-billing SDK",
  );
  assert.ok(!srcCode.includes("@agentclientprotocol/sdk"), "src/engine.ts must import no SDK at all");
  assert.ok(!/\bquery\b/.test(srcCode), "src/engine.ts code must not reference the SDK query symbol");
});

test("engine stub guard: built dist/engine.js carries no SDK query import", () => {
  const distCode = stripComments(readFileSync(join(here, "..", "dist", "engine.js"), "utf8"));
  assert.ok(!distCode.includes("@anthropic-ai/claude-agent-sdk"), "dist/engine.js must not import the SDK");
  assert.ok(!/\bquery\b/.test(distCode), "dist/engine.js must not reference the SDK query symbol");
});

test("engine stub guard: the stub documents itself as temporary scaffolding (replaced in 013–015/023)", () => {
  // Comments are intentionally retained here — the marker must survive in-source.
  const raw = readFileSync(join(here, "..", "src", "engine.ts"), "utf8");
  assert.match(raw, /013[–-]015\/023|023/, "engine.ts must name the stories that replace the stub");
  assert.match(raw, /read-only|READ-ONLY/, "engine.ts must record the Degrau-1 READ-ONLY posture");
});
