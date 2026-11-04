// Story 065 / Task 2.1 (Red-first) — the pure elicitation bridge that turns an AskUserQuestion
// tool_input into an ACP `session/request_elicitation` request, maps the user's outcome back to a
// gate `deny`+reason decision, and performs the bounded, fail-closed round-trip.
//
// This is the RED test authored BEFORE the module exists. It imports the bridge from the BUILT tree
// (../dist/permissions/elicitation-bridge.js). Because task 2.2 has not created that module yet, the
// import fails with ERR_MODULE_NOT_FOUND — that IS the intended Red. Everything else in this file
// (the SDK zod validators, the fakes) must resolve cleanly so the Red is unambiguously "the bridge
// module is absent", never a broken import or a syntax error elsewhere.
//
// Import convention (load-bearing): under `--experimental-strip-types`, importing runtime code from
// ../src/... FAILS because src/*.ts uses `./x.js` internal specifiers that only resolve in dist/.
// So ALL tests import runtime code from ../dist/... and the harness runs `npm run build` first:
//   node --experimental-strip-types --test test/elicitation-bridge.test.ts
//
// SDK zod validators (load-bearing): they are NOT re-exported from the package root, and the bare
// deep specifier is BLOCKED by the package `exports` map (ERR_PACKAGE_PATH_NOT_EXPORTED). A direct
// RELATIVE FILE PATH into node_modules bypasses the exports restriction and is verified working.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zCreateElicitationRequest,
  zCreateElicitationResponse,
} from "../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/zod.gen.js";
import {
  buildElicitationRequest,
  mapOutcomeToDecision,
  requestElicitation,
  type AskUserQuestionInput,
  type ElicitationClient,
} from "../dist/permissions/elicitation-bridge.js";

const SESSION = "sess-elicit-1";
const TOOL_USE_ID = "toolu_ask_1";

/** A realistic 2-question AskUserQuestion tool_input (matches the story's worked example). */
function twoQuestionInput(): AskUserQuestionInput {
  return {
    questions: [
      {
        question: "Which environment?",
        header: "Env",
        multiSelect: false,
        options: [
          { label: "dev", description: "d" },
          { label: "prod", description: "p" },
        ],
      },
      {
        question: "Enable cache?",
        header: "Cache",
        multiSelect: false,
        options: [{ label: "yes" }, { label: "no" }],
      },
    ],
  };
}

/** A fake ACP client whose `createElicitation` behaviour is programmable per test. */
function fakeClient(
  impl: (params: unknown) => Promise<unknown>,
): ElicitationClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async createElicitation(params: unknown) {
      calls.push(params);
      return impl(params) as never;
    },
  } as ElicitationClient & { calls: unknown[] };
}

// ---------------------------------------------------------------------------------------------
// buildElicitationRequest — the AskUserQuestion → CreateElicitationRequest projection (R1.1/R1.2/R5)
// ---------------------------------------------------------------------------------------------

test("2.1 buildElicitationRequest projects a form request tied to the session + tool call (R1.1, R5)", () => {
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());

  assert.equal(req.mode, "form", "AskUserQuestion is a structured form elicitation");
  assert.equal(typeof req.message, "string");
  assert.ok(req.message.length > 0, "message must be a non-empty human-readable prompt");
  assert.equal(req.sessionId, SESSION, "the elicitation is scoped to the session");
  assert.equal(req.toolCallId, TOOL_USE_ID, "and tied to the originating tool call by tool_use.id");

  const schema = req.requestedSchema;
  assert.ok(schema, "a requestedSchema must be present for a form elicitation");
  assert.equal(schema.type, "object", "the elicitation schema is always a JSON object schema");
  assert.ok(schema.properties, "the schema must carry per-question properties");
  assert.ok(Array.isArray(schema.required), "the schema must declare a required list");
});

test("2.1 buildElicitationRequest maps each question to a string-enum property keyed by header (R1.2)", () => {
  const input = twoQuestionInput();
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, input);
  const props = req.requestedSchema.properties;

  for (const q of input.questions) {
    const prop = props[q.header];
    assert.ok(prop, `a property must exist for header "${q.header}"`);
    assert.equal(prop.type, "string", "each answer is a single string-enum selection");
    assert.equal(prop.title, q.question, "the property title carries the human question text");
    assert.deepEqual(
      prop.enum,
      q.options.map((o) => o.label),
      "the enum lists exactly the option labels, in order",
    );
  }
});

test("2.1 buildElicitationRequest marks every question header as required (R1.2)", () => {
  const input = twoQuestionInput();
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, input);
  const required: string[] = req.requestedSchema.required;

  for (const q of input.questions) {
    assert.ok(required.includes(q.header), `header "${q.header}" must be required`);
  }
  assert.equal(required.length, input.questions.length, "one required entry per question, no more");
});

// ---------------------------------------------------------------------------------------------
// mapOutcomeToDecision — the outcome → gate decision projection (R2.1 / R2.2)
// Every branch returns a `deny` decision: the gate ALWAYS denies AskUserQuestion at the wire; the
// selection travels back to the model only inside the `reason` string.
// ---------------------------------------------------------------------------------------------

test("2.1 mapOutcomeToDecision: an ACCEPT denies but embeds the chosen answers in the reason (R2.1)", () => {
  const resp: any = { action: "accept", content: { Env: "prod", Cache: "yes" } };
  const decision = mapOutcomeToDecision(resp);

  assert.equal(decision.decision, "deny", "AskUserQuestion is always denied at the gate");
  assert.equal(typeof decision.reason, "string");
  assert.match(
    decision.reason,
    /prod/,
    "the reason must surface the selected value so the model can read the choice",
  );
  assert.match(decision.reason, /yes/, "every selected answer must appear in the reason");
});

test("2.1 mapOutcomeToDecision: a DECLINE denies with a dismissed-style reason (R2.2)", () => {
  const decision = mapOutcomeToDecision({ action: "decline" } as any);
  assert.equal(decision.decision, "deny");
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0, "a dismissal must still carry an explanatory reason");
  assert.match(
    decision.reason,
    /dismiss|declin|cancel|did not|no answer|without/i,
    "the reason must read as a user dismissal, not an answer",
  );
});

test("2.1 mapOutcomeToDecision: a CANCEL denies with a dismissed-style reason (R2.2)", () => {
  const decision = mapOutcomeToDecision({ action: "cancel" } as any);
  assert.equal(decision.decision, "deny");
  assert.equal(typeof decision.reason, "string");
  assert.match(
    decision.reason,
    /dismiss|declin|cancel|did not|no answer|without/i,
    "a cancel is a dismissal, not an answer",
  );
});

// ---------------------------------------------------------------------------------------------
// requestElicitation — the bounded, fail-closed round-trip (R4)
// ---------------------------------------------------------------------------------------------

test("2.1 requestElicitation returns the accept unchanged on the happy path", async () => {
  const accept = { action: "accept", content: { Env: "dev", Cache: "no" } };
  const client = fakeClient(async () => accept);
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());

  const resp: any = await requestElicitation(client, req, { timeoutMs: 1000 });

  assert.equal(resp.action, "accept");
  assert.deepEqual(resp.content, { Env: "dev", Cache: "no" });
  assert.equal(client.calls.length, 1, "the request is forwarded to the client exactly once");
});

test("2.1 requestElicitation is bounded: a client that never resolves fails closed to cancel (R4)", async () => {
  // A client that never settles must not hang the gate: the bridge times out and yields a cancel.
  const client = fakeClient(() => new Promise<unknown>(() => {}));
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());
  let warned = "";

  const started = Date.now();
  const resp: any = await requestElicitation(client, req, {
    timeoutMs: 40,
    onWarn: (m) => (warned = m),
  });
  const elapsed = Date.now() - started;

  assert.equal(resp.action, "cancel", "a timeout is fail-closed as a cancel (dismissal), never an accept");
  assert.ok(elapsed < 2000, `must resolve near the timeout, not hang (elapsed ${elapsed}ms)`);
  assert.ok(warned.length > 0, "a timeout must be surfaced via onWarn");
  // And the fail-closed outcome must map to a deny at the gate.
  assert.equal(mapOutcomeToDecision(resp).decision, "deny");
});

test("2.1 requestElicitation fails closed to cancel when the client throws (R4)", async () => {
  const client = fakeClient(async () => {
    throw new Error("transport exploded");
  });
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());
  let warned = "";

  const resp: any = await requestElicitation(client, req, {
    timeoutMs: 1000,
    onWarn: (m) => (warned = m),
  });

  assert.equal(resp.action, "cancel", "a transport error is fail-closed as a cancel");
  assert.ok(warned.length > 0, "the error must be surfaced via onWarn");
  assert.match(warned, /transport exploded/, "the underlying error text should be reported");
  assert.equal(mapOutcomeToDecision(resp).decision, "deny");
});

test("2.1 requestElicitation fails closed on a malformed response (structural action check) (R4)", async () => {
  // The production module CANNOT import the zod validators (package `exports` blocks the deep
  // specifier), so it guards structurally: action must be one of accept|decline|cancel. A bogus
  // action (or an empty object) is normalized to a fail-closed cancel that maps to a deny.
  const bogus = fakeClient(async () => ({ action: "bogus" }));
  const empty = fakeClient(async () => ({}));
  const req: any = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());

  const r1: any = await requestElicitation(bogus, req, { timeoutMs: 1000 });
  assert.equal(
    mapOutcomeToDecision(r1).decision,
    "deny",
    "an unrecognized action must not be treated as an accept",
  );

  const r2: any = await requestElicitation(empty, req, { timeoutMs: 1000 });
  assert.equal(
    mapOutcomeToDecision(r2).decision,
    "deny",
    "a response with no action must fail closed to a deny",
  );
});

// ---------------------------------------------------------------------------------------------
// Schema conformance against the pinned SDK zod validators (C1) — the version-fragility guard.
// If a future SDK bump changes the elicitation wire shape, these assertions break loudly here.
// ---------------------------------------------------------------------------------------------

test("2.1 (C1) the built request validates against the SDK zCreateElicitationRequest for a 2-question input", () => {
  const req = buildElicitationRequest(TOOL_USE_ID, SESSION, twoQuestionInput());
  const parsed = zCreateElicitationRequest.safeParse(req);
  assert.equal(
    parsed.success,
    true,
    `built request must satisfy the pinned SDK schema; error: ${
      parsed.success ? "" : JSON.stringify(parsed.error?.issues)
    }`,
  );
});

test("2.1 (C1) sample accept/decline/cancel responses each validate against zCreateElicitationResponse", () => {
  const samples = [
    { action: "accept", content: { Env: "prod", Cache: "yes" } },
    { action: "decline" },
    { action: "cancel" },
  ];
  for (const s of samples) {
    const parsed = zCreateElicitationResponse.safeParse(s);
    assert.equal(
      parsed.success,
      true,
      `sample ${JSON.stringify(s)} must satisfy the pinned SDK response schema; error: ${
        parsed.success ? "" : JSON.stringify(parsed.error?.issues)
      }`,
    );
  }
});
