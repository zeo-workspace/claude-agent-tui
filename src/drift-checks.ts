// === Story 049 / Task 2.1 (R2.1, R2.2, R2.3, R2.4) — pure binary-drift checks (no I/O) ============
//
// Single source of truth for "what binary-drift looks like" across the four surfaces the bridge reads
// from the claude binary. Each check is PURE and referentially transparent: it takes ALREADY-PARSED
// input and returns a `{surface, ok, detail}` verdict. There is NO `fs`, NO `child_process`/`spawn`,
// NO `process` here — the I/O (read fixtures / spawn the live binary) belongs to the OFFLINE detector
// (Task 3) and `smoke:live` (Task 5), which both reuse these verdicts. Keeping this module I/O-free is
// the foundation for Task 3's spawn-import guard.
//
// MIRROR ANCHORS (the constants below mirror these real source surfaces — keep them honest):
//   - stop_reason taxonomy ........ src/stop-reason-map.ts:26-33 (the 4 explicit, non-default cases of
//                                   mapStopReason: end_turn / stop_sequence / max_tokens / refusal)
//   - allow keystroke ............. src/permissions/allow-inject.ts:29 (KEYSTROKE_YES = "1\r")
//   - raw JSONL field set ......... src/jsonl.ts:513-544 (the documented universal + per-type fields)
//
// TWO NON-OBVIOUS DECISIONS (both deliberate reads of the requirements, not oversights):
//   1. `tool_use` is KNOWN-NON-TERMINAL, NOT drift. mapStopReason switches on the 4 terminal cases and
//      DEFAULTS everything else to "end_turn" (with a drift log). `tool_use` legitimately appears in
//      real transcripts — the model pauses to call a tool; that is NOT a turn end — and it hits that
//      default branch BY DESIGN. So it is recorded as expected (KNOWN_NONTERMINAL_STOP_REASONS) and
//      must NOT fail the check. A genuinely NEW value (e.g. `pause_turn`) still fails.
//   2. `checkJsonlShape` guards the RAW on-disk JSONL shape (camelCase `sessionId`, `parentUuid`, ...),
//      NOT the reduced `getSessionMessages` shape (`session_id` snake_case) that R2.3 literally lists.
//      This is a deliberate read of R2.3's intent: the drift we want to detect is in the on-disk JSONL
//      the bridge actually tails, so the check mirrors jsonl.ts's documented raw field set.
//
// node:test runner: `node --experimental-strip-types --test test/drift-checks.test.ts`

/** The verdict a single drift check returns. `surface` names which binary-contact surface was checked. */
export interface CheckResult {
  /** The binary-contact surface this verdict is about (e.g. "stop_reason", "jsonl_shape"). */
  surface: string;
  /** True iff no drift was detected on this surface. */
  ok: boolean;
  /** Human-readable summary; on `ok=false` it NAMES every offending value (the consumers print it). */
  detail: string;
}

// --- mirror constants ---------------------------------------------------------------------------

/**
 * The stop_reason values mapStopReason handles EXPLICITLY (stop-reason-map.ts:26-33). Everything else
 * hits its default branch. These are the "terminal" taxonomy the bridge answers a turn with.
 */
export const HANDLED_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
]);

/**
 * stop_reason values that are NON-TERMINAL but EXPECTED (so not drift): the model pauses mid-turn. They
 * hit mapStopReason's default branch BY DESIGN. `tool_use` is the real one seen in transcripts.
 */
export const KNOWN_NONTERMINAL_STOP_REASONS: ReadonlySet<string> = new Set(["tool_use"]);

/** The core top-level keys EVERY raw JSONL event line must carry (jsonl.ts:513-523 — the required set). */
export const REQUIRED_JSONL_KEYS: ReadonlySet<string> = new Set([
  "uuid",
  "type",
  "timestamp",
  "sessionId",
  "message",
]);

/**
 * Every top-level key a raw JSONL line is ALLOWED to carry = {@link REQUIRED_JSONL_KEYS} ∪ the known
 * optional universal / per-type fields documented in jsonl.ts:528-543 (plus the universal fields seen
 * in real fixtures). A key OUTSIDE this set is a NEW/unexpected field → drift.
 */
export const KNOWN_JSONL_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_JSONL_KEYS,
  // universal fields (present in raw JSONL but absent from the reduced getSessionMessages shape)
  "parentUuid",
  "parentToolUseId",
  "userType",
  "version",
  "isSidechain",
  "entrypoint",
  "cwd",
  "gitBranch",
  "logicalParentUuid",
  "isMeta",
  "isCompactSummary",
  "level",
  "isApiErrorMessage",
  // per-type extras
  "requestId",
  "promptId",
  "usage",
  "toolUseResult",
  "permissionMode",
  // Top-level keys claude 2.1.330/2.1.331 writes that this list did not know (parity round 26):
  // measured 2026-11-25 over 24 local transcripts, 4383 event lines, key NAMES only. Refresh the
  // same way on a CLI bump, so the check flags what is new rather than everything since 2.1.161.
  "advisorModel",
  "apiBlockIndex",
  "attachment",
  "attributionMcpServer",
  "attributionMcpTool",
  "attributionPlugin",
  "attributionSkill",
  "compactMetadata",
  "content",
  "dataFlowOn",
  "durationMs",
  "effort",
  "failedHookErrorIndexes",
  "hasOutput",
  "hookAdditionalContext",
  "hookCount",
  "hookErrors",
  "hookInfos",
  "isVisibleInTranscriptOnly",
  "madeBy",
  "mcpCallNotReadOnly",
  "mcpMeta",
  "messageCount",
  "origin",
  "perTurnEffort",
  "permissionDecision",
  "preventedContinuation",
  "promptCacheRequested",
  "promptSource",
  "queueSkipAttachments",
  "queueSkipSlashCommands",
  "rendered",
  "renderedBesideToolResult",
  "renderedInHumanTurn",
  "renderedRole",
  "requestRef",
  "requestSessionId",
  "requestedModel",
  "rowSource",
  "sandboxed",
  "serverClassifierContext",
  "serverClassifierRequest",
  "session_id",
  "slug",
  "sourceToolAssistantUUID",
  "sourceToolUseID",
  "stopReason",
  "subtype",
  "thinkingDisplay",
  "thinkingDurationMs",
  "toolDenialKind",
  "toolEndsTurn",
  "toolInputStreamMs",
  "toolResultRemedy",
  "toolUseID",
  "turnAttributionKey",
  "turnCompanion",
  "turnOrigin",
  "turnPosition",
  "turnPromptId",
  "wakeupSource",
  "wireIngestContext",
  "wireToolInputs",
]);

/** The keystroke the native TUI permission prompt accepts for Yes — mirror of allow-inject.ts:29. */
export const EXPECTED_ALLOW_KEYSTROKE: string = "1\r";

// --- shared helpers -----------------------------------------------------------------------------

/**
 * Build a verdict from a collected list of offending items: `ok=true` (with a positive summary) when
 * the list is empty, otherwise `ok=false` with a detail that NAMES every offending item (the consumers
 * and the unit tests assert each offending value appears in `detail`).
 */
function verdict(surface: string, offenders: readonly string[], okSummary: string): CheckResult {
  if (offenders.length === 0) {
    return { surface, ok: true, detail: okSummary };
  }
  return { surface, ok: false, detail: `${surface} drift: ${offenders.join(", ")}` };
}

/** Read `line.message?.stop_reason` defensively (the message object is `unknown`). */
function readStopReason(line: Record<string, unknown>): unknown {
  const message = line.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  return (message as { stop_reason?: unknown }).stop_reason;
}

// --- the four checks ----------------------------------------------------------------------------

/**
 * R2.1 — verify every non-null `message.stop_reason` is either HANDLED or a KNOWN non-terminal value.
 *
 * `null`/`undefined`/absent stop_reason is NOT drift (absence) and is ignored. A non-null value outside
 * {@link HANDLED_STOP_REASONS} ∪ {@link KNOWN_NONTERMINAL_STOP_REASONS} (e.g. a new `pause_turn`) trips
 * the check; `detail` names every offending value. Pure: no I/O, depends only on `lines`.
 */
export function checkStopReasons(lines: ReadonlyArray<Record<string, unknown>>): CheckResult {
  const offenders: string[] = [];
  for (const line of lines) {
    const raw = readStopReason(line);
    if (raw === null || raw === undefined) {
      continue; // absence is not drift
    }
    const value = String(raw);
    if (!HANDLED_STOP_REASONS.has(value) && !KNOWN_NONTERMINAL_STOP_REASONS.has(value)) {
      if (!offenders.includes(value)) {
        offenders.push(value);
      }
    }
  }
  return verdict("stop_reason", offenders, "all stop_reasons are handled or known-non-terminal");
}

/**
 * R2.2 — verify every SDK content-block type is covered by a handled `switch` case. A block type in
 * `sdkBlockTypes` but NOT in `handledCases` (e.g. a new `server_tool_use`) is uncovered drift; `detail`
 * names each uncovered type. Pure: depends only on its two iterable arguments.
 */
export function checkContentBlockCoverage(
  sdkBlockTypes: Iterable<string>,
  handledCases: Iterable<string>,
): CheckResult {
  const handled = new Set(handledCases);
  const offenders: string[] = [];
  for (const type of sdkBlockTypes) {
    if (!handled.has(type) && !offenders.includes(type)) {
      offenders.push(type);
    }
  }
  return verdict("content_block", offenders, "every SDK content-block type is a handled case");
}

/**
 * R2.3 — verify each raw JSONL line carries every {@link REQUIRED_JSONL_KEYS} core key and NO key
 * outside {@link KNOWN_JSONL_KEYS}. A missing core key OR a new/unexpected top-level key is drift;
 * `detail` names the offending key(s). Guards the RAW on-disk shape (camelCase), not the reduced
 * getSessionMessages shape. Pure: depends only on `lines`.
 */
export function checkJsonlShape(lines: ReadonlyArray<Record<string, unknown>>): CheckResult {
  const offenders: string[] = [];
  for (const line of lines) {
    for (const required of REQUIRED_JSONL_KEYS) {
      const missing = `missing:${required}`;
      if (!Object.prototype.hasOwnProperty.call(line, required) && !offenders.includes(missing)) {
        offenders.push(missing);
      }
    }
    for (const key of Object.keys(line)) {
      const unexpected = `unexpected:${key}`;
      if (!KNOWN_JSONL_KEYS.has(key) && !offenders.includes(unexpected)) {
        offenders.push(unexpected);
      }
    }
  }
  return verdict("jsonl_shape", offenders, "every line matches the known raw JSONL shape");
}

/**
 * R2.4 — verify the gate's allow keystroke is still the canonical {@link EXPECTED_ALLOW_KEYSTROKE}
 * (`"1\r"`). On mismatch `detail` references both the expected and the actual keystroke. Mirror of
 * allow-inject.ts:29 `KEYSTROKE_YES`. Pure: depends only on `keystroke`.
 */
export function checkAllowKeystroke(keystroke: string): CheckResult {
  if (keystroke === EXPECTED_ALLOW_KEYSTROKE) {
    return {
      surface: "allow_keystroke",
      ok: true,
      detail: "allow keystroke matches the canonical 1\\r",
    };
  }
  return {
    surface: "allow_keystroke",
    ok: false,
    detail: `allow_keystroke drift: expected ${JSON.stringify(EXPECTED_ALLOW_KEYSTROKE)} but got ${JSON.stringify(keystroke)}`,
  };
}
