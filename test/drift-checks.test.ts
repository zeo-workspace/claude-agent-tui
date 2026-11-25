// Story 049 / Task 2.1 (R2.1, R2.2, R2.3, R2.4) — unit tests for the pure drift-check functions.
//
// `drift-checks.ts` is the single source of truth for "what binary-drift looks like" across the four
// surfaces the bridge reads (stop_reason taxonomy, @anthropic-ai/sdk content-block coverage, JSONL
// top-level shape, gate allow-keystroke). The functions are PURE (no fs / no spawn): each takes
// already-parsed input and returns a `{surface, ok, detail}` verdict. They are consumed by BOTH the
// offline `drift-detector.test.ts` (fixtures) and the local `experiments/smoke-live.mjs` (live binary).
//
// This file is the UNIT layer: each check PASSes on good input and FAILs on a seeded drift, using
// synthetic inline inputs (NOT the real fixtures — those are the detector's job). It encodes three
// run-time realities the architect map under-specified:
//   1. fixtures legitimately carry `stop_reason:"tool_use"` (non-terminal — the model continues; it
//      hits stop-reason-map.ts's default branch BY DESIGN, so it is KNOWN, not drift);
//   2. the on-disk JSONL is the RAW universal shape (camelCase `sessionId`/`parentUuid`/...), NOT the
//      reduced `getSessionMessages` shape (`session_id` snake_case) that R2.3 literally lists — the
//      check guards the raw shape the bridge actually tails;
//   3. a genuinely NEW stop_reason / block type / top-level key still trips the check.
//
// node:test runner: `node --experimental-strip-types --test test/drift-checks.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStopReasons,
  checkContentBlockCoverage,
  checkJsonlShape,
  checkAllowKeystroke,
  HANDLED_STOP_REASONS,
  KNOWN_NONTERMINAL_STOP_REASONS,
  REQUIRED_JSONL_KEYS,
  EXPECTED_ALLOW_KEYSTROKE,
  KNOWN_JSONL_KEYS,
} from "../src/drift-checks.ts";

/** A minimal valid RAW-shape event line (the on-disk shape, camelCase), overridable per test. */
function rawLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "u1",
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "00000000-0000-0000-0000-000000000000",
    message: {},
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    version: "2.1.185",
    entrypoint: "cli",
    ...over,
  };
}

// === checkStopReasons (R2.1) ====================================================================

test("checkStopReasons: PASS on handled + known-non-terminal (tool_use) stop_reasons (R2.1)", () => {
  const lines = [
    rawLine({ message: { stop_reason: "end_turn" } }),
    rawLine({ message: { stop_reason: "tool_use" } }), // non-terminal — default branch BY DESIGN, not drift
    rawLine({ message: { stop_reason: "max_tokens" } }),
    rawLine({ message: { stop_reason: "stop_sequence" } }),
    rawLine({ message: { stop_reason: "refusal" } }),
    rawLine({ message: { stop_reason: null } }), // absence, not drift — ignored
    rawLine({ message: {} }), // no stop_reason at all — ignored
  ];
  const r = checkStopReasons(lines);
  assert.equal(r.surface, "stop_reason");
  assert.equal(r.ok, true, r.detail);
});

test("checkStopReasons: FAIL on a genuinely new/unmapped stop_reason (R2.1 drift)", () => {
  const lines = [
    rawLine({ message: { stop_reason: "end_turn" } }),
    rawLine({ message: { stop_reason: "pause_turn" } }), // NEW value the map would silently default → drift
  ];
  const r = checkStopReasons(lines);
  assert.equal(r.ok, false);
  assert.match(r.detail, /pause_turn/, "must name the offending stop_reason");
});

// === checkContentBlockCoverage (R2.2) ===========================================================

test("checkContentBlockCoverage: PASS when every SDK block type is a handled case (R2.2)", () => {
  const sdk = ["text", "tool_use", "thinking", "image"];
  const handled = ["text", "tool_use", "thinking", "image", "document", "redacted_thinking"];
  const r = checkContentBlockCoverage(sdk, handled);
  assert.equal(r.surface, "content_block");
  assert.equal(r.ok, true, r.detail);
});

test("checkContentBlockCoverage: FAIL on a new SDK block type not covered by a case (R2.2 drift)", () => {
  const sdk = ["text", "server_tool_use"]; // server_tool_use is NEW and not handled
  const handled = ["text", "tool_use"];
  const r = checkContentBlockCoverage(sdk, handled);
  assert.equal(r.ok, false);
  assert.match(r.detail, /server_tool_use/, "must name the uncovered block type");
});

// === checkJsonlShape (R2.3) — guards the RAW on-disk shape, not the reduced getSessionMessages shape ==

test("checkJsonlShape: PASS on a real raw-shape line with known optionals (R2.3)", () => {
  const lines = [
    rawLine({ promptId: "p1" }),
    rawLine({ requestId: "r1", usage: { input_tokens: 1 }, parentToolUseId: null }),
  ];
  const r = checkJsonlShape(lines);
  assert.equal(r.surface, "jsonl_shape");
  assert.equal(r.ok, true, r.detail);
});

test("checkJsonlShape: FAIL when a required core key is missing (R2.3 drift)", () => {
  const line = rawLine();
  delete line.uuid; // core key removed → drift
  const r = checkJsonlShape([line]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /uuid/, "must name the missing core key");
});

test("checkJsonlShape: FAIL on an unexpected/new top-level key (R2.3 drift)", () => {
  const r = checkJsonlShape([rawLine({ brandNewField: 1 })]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /brandNewField/, "must name the unexpected key");
});

// === checkAllowKeystroke (R2.4) =================================================================

test("checkAllowKeystroke: PASS on the canonical '1\\r' (R2.4)", () => {
  const r = checkAllowKeystroke("1\r");
  assert.equal(r.surface, "allow_keystroke");
  assert.equal(r.ok, true, r.detail);
});

test("checkAllowKeystroke: FAIL when the keystroke drifts away from '1\\r' (R2.4 drift)", () => {
  const r = checkAllowKeystroke("2\r");
  assert.equal(r.ok, false);
  assert.match(r.detail, /1/, "must reference the expected keystroke");
});

// === mirror-honesty guards — the constants must mirror the real source surfaces =================

test("HANDLED_STOP_REASONS mirrors the 4 explicit stop-reason-map.ts cases", () => {
  assert.deepEqual(
    [...HANDLED_STOP_REASONS].sort(),
    ["end_turn", "max_tokens", "refusal", "stop_sequence"],
    "the explicit (non-default) cases of mapStopReason",
  );
});

test("KNOWN_NONTERMINAL_STOP_REASONS records tool_use as expected (not drift)", () => {
  assert.ok(KNOWN_NONTERMINAL_STOP_REASONS.has("tool_use"));
});

test("REQUIRED_JSONL_KEYS is the core every event line must carry", () => {
  for (const k of ["uuid", "type", "timestamp", "sessionId", "message"]) {
    assert.ok(REQUIRED_JSONL_KEYS.has(k), `core key ${k} must be required`);
  }
});

test("EXPECTED_ALLOW_KEYSTROKE mirrors allow-inject.ts KEYSTROKE_YES", () => {
  assert.equal(EXPECTED_ALLOW_KEYSTROKE, "1\r");
});

test("checkJsonlShape knows the top-level keys claude 2.1.330 writes (parity round 26)", () => {
  // Measured 2026-11-25 on local 2.1.330 transcripts: these keys appear on ordinary lines.
  for (const key of ["dataFlowOn", "requestedModel", "permissionDecision", "toolDenialKind", "session_id"]) {
    assert.ok(KNOWN_JSONL_KEYS.has(key), `${key} is a known key`);
  }
  assert.equal(KNOWN_JSONL_KEYS.has("aKeyNoClaudeVersionWrites"), false, "an unknown key is still drift");
});
