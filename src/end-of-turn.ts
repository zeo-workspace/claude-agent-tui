// === Story 024 — End-of-turn detector (E3 augmented predicate + Δt quiescence + turn watchdog) ===
//
// The forked engine drives the real `claude` TUI in a PTY and reads turns from the JSONL transcript
// (story 023). The pure TUI never emits `session_state_changed:state='idle'`, so there is NO native
// end-of-turn signal. This module implements the E3-derived heuristic that tells the rewritten
// `prompt()` loop when a turn ends, so it can resolve the ACP `PromptResponse{stopReason}` exactly
// once per turn (§5 BLOCKER, R2). Δt, the predicate, and the turn watchdog are consumed VERBATIM
// from the Degrau-0 E3 binding decision (experiments/DEGRAU0-RESULTS.md, Binding decision 2) — this
// module IMPLEMENTS them, it does NOT re-derive them.
//
// Task 1.1 — the terminal-stop predicate: the pure core that identifies the single terminal-stop
// `assistant` boundary candidate per turn.

import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import { TURN_WATCHDOG_MS } from "./linearize.js";
import { FILE_DISCOVERY_WATCHDOG_MS } from "./jsonl.js";
import { mapStopReason, type StopReasonLogger } from "./stop-reason-map.js";

// Re-export the two watchdog windows from their OWNING modules so the detector exposes a single
// source of truth: the turn watchdog (5583 ms) lives in linearize.ts (story 017), the file-discovery
// watchdog (2000 ms) in jsonl.ts. Re-exporting — never re-declaring — guarantees the two windows can
// neither drift apart nor be conflated (the §13 R2-vs-R3 Constraint the story forbids breaking).
export { TURN_WATCHDOG_MS, FILE_DISCOVERY_WATCHDOG_MS };

// === Story 034 (live-acceptance fix) — STALL semantics ============================================
//
// The G1 live acceptance (2026-06-11, session 9cedb4c2) faulted a REAL first turn at 5583 ms: E3
// calibrated that window on trivial Degrau-0 turns as a TOTAL-turn cap, but live turns legitimately
// exceed it (cold start, thinking, long tools) and the JSONL writes whole blocks, so long silent
// gaps are normal mid-turn. Corrected semantics: the watchdog re-arms on every observed event
// (activity = liveness) and trips only after `watchdogMs` of total SILENCE. TURN_WATCHDOG_MS stays
// exported as the E3 constant (story 017 cadence + explicit option), but is no longer the default.

/**
 * Default STALL window (ms): the watchdog trips only after this much transcript silence while a
 * turn is in flight. Generous on purpose — a long text block or tool run writes nothing for tens of
 * seconds; the watchdog exists to fail a DEAD turn loudly (R5.2), not to cap a slow one.
 */
export const TURN_STALL_WATCHDOG_MS = 120_000;

/** Env var overriding the default stall window per process (positive integer ms). */
export const TURN_WATCHDOG_ENV = "FORK_TURN_WATCHDOG_MS";

/** The default stall window: the {@link TURN_WATCHDOG_ENV} override when valid, else the constant. */
function resolveDefaultWatchdogMs(): number {
  const raw = process.env[TURN_WATCHDOG_ENV];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TURN_STALL_WATCHDOG_MS;
}

/**
 * The TERMINAL `message.stop_reason` values (E3 augmented predicate, Binding decision 2). An
 * `assistant` event whose stop_reason is one of these is an end-of-turn boundary CANDIDATE; a
 * `tool_use` pause (or `null`) is mid-turn and NOT a boundary. Typed `ReadonlySet` so the set
 * cannot drift at a call site.
 */
export const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

/**
 * The minimal structural shape the predicate reads off a story-015/016 typed `JsonlEvent` (only
 * `.type` and `.message` are inspected). Kept structural — and every field `unknown` — so the
 * predicate stays defensive: it never assumes a fixed `.type` set and never throws on a string-or-
 * array `message.content` (§6 tolerant parser, R1.2/R3 forward-compat).
 */
export interface StopReasonEvent {
  readonly type?: unknown;
  readonly message?: unknown;
  /** Sidechain (subagent) back-pointer, SDK snake_case — non-null marks a sidechain row (R4.1). */
  readonly parent_tool_use_id?: unknown;
  /** Sidechain back-pointer, story-015 typed alias — read alongside the snake_case form (R4.1). */
  readonly parentToolUseId?: unknown;
}

/** True iff `value` is a non-null, non-array object — the guard before any property read. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `event` is a sidechain (subagent) row (story 041, R4.1). A subagent's transcript rows
 * carry a non-null `parent_tool_use_id` (SDK snake_case) / `parentToolUseId` (story-015 typed name)
 * pointing up to the spawning Task `tool_use` — the SAME canonical signal `linearize.ts`
 * (`isSidechainMsg`) uses. A sidechain assistant row's OWN `stop_reason:'end_turn'` is the
 * SUBAGENT's turn ending, NOT the parent's, so it must be excluded from terminal candidacy: it can
 * never resolve the parent turn even if it reaches the detector.
 */
function isSidechain(event: StopReasonEvent): boolean {
  if (!isObject(event)) return false;
  const pid = event.parent_tool_use_id ?? event.parentToolUseId;
  return pid !== null && pid !== undefined;
}

// === Story 041 / Task 4.2 — an in-flight Task/Agent tool_use holds the turn OPEN (R4.2) ===========
//
// A main-chain `Task`/`Agent` `tool_use` spawns a sub-agent whose work can run silently for a long
// time (cold start, long tools, deep nesting). While that `tool_use` has NO matching `tool_result`
// yet, the turn is IN-FLIGHT: the silence watchdog must NOT trip and no end-of-turn may resolve,
// however long the sub-agent runs. The detector feed is main-chain-only (the pump never advances the
// detector cursor for sidechain rows — R4.1 structural), so this open-Task scan runs over main-chain
// rows: it reads `tool_use` blocks named `Task`/`Agent` off assistant rows and the `tool_result`
// blocks (`tool_use_id`) that close them off user rows.

/** The sub-agent-spawning tool names whose open `tool_use` holds the parent turn open (R4.2). */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent"]);

/** The `message.content[]` array of an event when present, else `[]` — read defensively (§6). */
function contentBlocksOf(event: StopReasonEvent): readonly unknown[] {
  const message = (event as { message?: unknown }).message;
  if (!isObject(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * The ids of sub-agent-spawning (`Task`/`Agent`) `tool_use` blocks in `event` (R4.2). A non-assistant
 * row, a string/missing `content`, or any non-`Task`/`Agent` `tool_use` (e.g. `Bash`) yields none —
 * so an ordinary tool call never holds the turn. Pure; never throws.
 */
function subagentToolUseIds(event: StopReasonEvent): string[] {
  if (!isObject(event) || event.type !== "assistant") return [];
  const ids: string[] = [];
  for (const block of contentBlocksOf(event)) {
    if (
      isObject(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      SUBAGENT_TOOL_NAMES.has(block.name)
    ) {
      ids.push(block.id);
    }
  }
  return ids;
}

/**
 * The `tool_use_id`s closed by `tool_result` blocks in `event` (R4.2) — the back-reference the SDK
 * writes on the user row that carries a sub-agent's result (`tool_result.tool_use_id === id`, the
 * same field `event-switch.ts` models). A non-object/string `content` yields none. Pure; never throws.
 */
function closedToolUseIds(event: StopReasonEvent): string[] {
  const ids: string[] = [];
  for (const block of contentBlocksOf(event)) {
    if (isObject(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

/**
 * The E3 augmented predicate (Binding decision 2): is `event` an `assistant` event whose
 * `message.stop_reason` is a TERMINAL value? Reads everything defensively — a non-`assistant`
 * `.type`, a missing/string `message`, or a `null`/`undefined`/`tool_use` stop_reason all yield
 * `false`. Pure and total: never throws.
 *
 * Story 041 (R4.1): a SIDECHAIN row (non-null `parent_tool_use_id`) is EXCLUDED — its terminal stop
 * is the subagent's own turn ending and must never end the parent turn.
 */
export function isTerminalStop(event: StopReasonEvent | null | undefined): boolean {
  if (!isObject(event)) return false;
  if (event.type !== "assistant") return false;
  if (isSidechain(event)) return false; // R4.1: a sidechain terminal stop never ends the parent turn
  const message = event.message;
  if (!isObject(message)) return false;
  const stopReason = message.stop_reason;
  return typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason);
}

/**
 * The LAST event in `events` satisfying {@link isTerminalStop} — the single per-turn boundary
 * candidate (E3 picks the LAST terminal `assistant`, so a turn that streamed several assistant
 * blocks collapses to one boundary). Returns `undefined` when no event is terminal (e.g. a
 * `tool_use`-only turn still in flight). Pure; never throws on an unknown `.type` or string content.
 */
export function findTerminalCandidate<E extends StopReasonEvent>(
  events: readonly E[],
): E | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isTerminalStop(events[i])) return events[i];
  }
  return undefined;
}

// === Task 2 — Δt quiescence window + queued-prompt confirmation ===================================

/**
 * The Δt quiescence window (ms) — E3 binding decision 2: the SMALLEST zero-false-positive window
 * (Δt sweep, experiments/DECISION.md). A terminal candidate is confirmed only after Δt of silence
 * with no further user/assistant write. Consumed VERBATIM from E3 — NOT re-derived here.
 */
export const DELTA_T_MS = 200;

/**
 * Injectable timer seam: schedule `fn` after `ms`, returning a cancel function. The detector takes
 * it as an option so tests drive a deterministic fake clock (mirrors `bindEndOfTurnReparse`); the
 * default wraps `setTimeout`/`clearTimeout`.
 */
export type DetectorSchedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: DetectorSchedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  // Don't let an armed turn timer keep the process alive on its own.
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
};

/** Diagnostics carried by a {@link TurnTimeoutError} — the last-seen event and the elapsed window. */
export interface TurnTimeoutDiagnostics {
  /** The turn-watchdog window that elapsed (ms). */
  readonly elapsedMs: number;
  /** The `.type` of the last event the detector saw before the watchdog tripped, if any. */
  readonly lastEventType?: string;
  /** The `message.stop_reason` of that last event, if any. */
  readonly lastStopReason?: string;
  /** The session whose turn stalled, if known. */
  readonly sessionId?: string;
}

/**
 * Typed error surfaced when no end-of-turn is detected within the 5583 ms turn watchdog (R5.2). It
 * carries the elapsed window plus last-seen-event diagnostics so the §5 stall is observable for R2
 * runtime telemetry instead of hanging the ACP protocol silently.
 */
export class TurnTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly lastEventType?: string;
  readonly lastStopReason?: string;
  readonly sessionId?: string;
  constructor(diag: TurnTimeoutDiagnostics) {
    super(
      `end-of-turn not detected within ${diag.elapsedMs}ms turn watchdog` +
        (diag.sessionId ? ` (session ${diag.sessionId})` : "") +
        (diag.lastEventType
          ? `; last event type=${diag.lastEventType} stop_reason=${diag.lastStopReason ?? "null"}`
          : ""),
    );
    this.name = "TurnTimeoutError";
    this.elapsedMs = diag.elapsedMs;
    this.lastEventType = diag.lastEventType;
    this.lastStopReason = diag.lastStopReason;
    this.sessionId = diag.sessionId;
  }
}

/** Options for {@link createEndOfTurnDetector}. */
export interface EndOfTurnDetectorOptions {
  /** Invoked exactly once per confirmed turn boundary, with the terminal candidate event. */
  onEndOfTurn: (boundary: StopReasonEvent) => void;
  /** Invoked when the turn watchdog trips before any end-of-turn (R5.2). */
  onTurnTimeout?: (error: TurnTimeoutError) => void;
  /** Timer seam (default wraps setTimeout). */
  schedule?: DetectorSchedule;
  /** Δt quiescence window (ms); defaults to {@link DELTA_T_MS}. */
  deltaTMs?: number;
  /**
   * STALL window (ms): silence tolerated between observed events while a turn is in flight.
   * Defaults to the {@link TURN_WATCHDOG_ENV} env override when valid, else
   * {@link TURN_STALL_WATCHDOG_MS}. Pass {@link TURN_WATCHDOG_MS} explicitly for the E3 cap.
   */
  watchdogMs?: number;
  /** The session whose turns this detector watches — carried in {@link TurnTimeoutError}. */
  sessionId?: string;
  /** Telemetry sink for a stalled turn (R2). The timeout is also surfaced via `onTurnTimeout`. */
  logger?: { error: (...args: unknown[]) => void };
}

/** Handle returned by {@link createEndOfTurnDetector}. */
export interface EndOfTurnDetector {
  /** Arm the turn watchdog — call when a turn becomes in-flight (the prompt loop, story 023). */
  beginTurn(): void;
  /** Feed the next watched event, in arrival order. */
  observe(event: StopReasonEvent): void;
  /**
   * Liveness-only kick (story 044, Option B): re-arm the stall watchdog iff a turn is in flight (the
   * watchdog is armed). Registers NO event, touches NO boundary/openTaskIds/diagnostics state — it is
   * purely "the turn is still alive". Called by the sub-agent watcher on observed sub-agent progress
   * so a silent main chain with an active sub-agent never trips the watchdog (R1.2). No-op when
   * stopped, cancelled, or not armed (replay/load never starts a stall clock).
   */
  noteActivity(): void;
  /**
   * Cancel seam (the Degrau-2 story 030 calls this): set the single-resolution latch and clear both
   * the Δt timer and the turn watchdog, so the detector cannot also fire an end-of-turn for this turn
   * (no double-resolve, R3.4). Read-only — it does NOT resolve the ACP session/prompt here.
   */
  markCancelled(): void;
  /** Tear down: cancel any armed timer and suppress further signals. Idempotent. */
  stop(): void;
}

/** The `uuid` of an event when it is a non-empty string — the per-turn `fired` latch key. */
function eventUuid(event: StopReasonEvent): string | undefined {
  const uuid = (event as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}

/** True for a `user` or `assistant` write — the only events that confirm a queued boundary (R4). */
function isUserOrAssistantWrite(event: StopReasonEvent): boolean {
  return isObject(event) && (event.type === "user" || event.type === "assistant");
}

/** Last-seen-event diagnostics for a {@link TurnTimeoutError} (`.type` + `message.stop_reason`). */
function eventDiag(event: StopReasonEvent | undefined): {
  lastEventType?: string;
  lastStopReason?: string;
} {
  if (!isObject(event)) return {};
  const lastEventType = typeof event.type === "string" ? event.type : undefined;
  const message = event.message;
  const lastStopReason =
    isObject(message) && typeof message.stop_reason === "string" ? message.stop_reason : undefined;
  return { lastEventType, lastStopReason };
}

/**
 * The end-of-turn detector: feed it the linearized turn events via {@link EndOfTurnDetector.observe}
 * and it emits exactly one end-of-turn per turn. A terminal candidate (Task 1) arms a Δt timer; the
 * boundary is confirmed on Δt quiescence (here) or immediately on a queued follow-up write (Task 2.2).
 * A `fired` latch keyed on the boundary uuid prevents the same terminal event from firing twice.
 */
export function createEndOfTurnDetector(opts: EndOfTurnDetectorOptions): EndOfTurnDetector {
  const schedule = opts.schedule ?? defaultSchedule;
  const deltaTMs = opts.deltaTMs ?? DELTA_T_MS;
  const watchdogMs = opts.watchdogMs ?? resolveDefaultWatchdogMs();

  let pendingCandidate: StopReasonEvent | undefined;
  let cancelDelta: (() => void) | undefined;
  let cancelWatchdog: (() => void) | undefined;
  let lastEvent: StopReasonEvent | undefined; // last event seen — diagnostics for a watchdog timeout
  const firedUuids = new Set<string>();
  // Story 041 (R4.2): main-chain `Task`/`Agent` `tool_use` ids with no matching `tool_result` yet.
  // While this set is non-empty a sub-agent is in flight, so the silence watchdog HOLDS (re-arms)
  // instead of tripping — a long, silent sub-agent run must not cause a false end-of-turn.
  const openTaskIds = new Set<string>();
  let stopped = false;
  let cancelled = false; // single-resolution cancel latch (markCancelled — story 030 seam)

  function clearDelta(): void {
    cancelDelta?.();
    cancelDelta = undefined;
  }

  /** Clear the armed turn watchdog so it cannot fire for a turn that already resolved (R5.3). */
  function clearWatchdog(): void {
    cancelWatchdog?.();
    cancelWatchdog = undefined;
  }

  function confirmBoundary(): void {
    if (cancelled) return; // cancel latch (R3.4): never emit an end-of-turn for a cancelled turn
    const boundary = pendingCandidate;
    if (!boundary) return;
    // Latch BEFORE emit: clear the pending candidate so a re-entrant observe() inside the
    // onEndOfTurn callback cannot double-confirm the same turn.
    pendingCandidate = undefined;
    clearDelta();
    clearWatchdog(); // end-of-turn resolved → the watchdog must not fire for this turn (R5.3)
    openTaskIds.clear(); // R4.2: a resolved turn starts the next one with no stale open Task
    const uuid = eventUuid(boundary);
    if (uuid) firedUuids.add(uuid);
    opts.onEndOfTurn(boundary);
  }

  function armDelta(): void {
    clearDelta();
    cancelDelta = schedule(() => {
      cancelDelta = undefined;
      confirmBoundary();
    }, deltaTMs);
  }

  /**
   * (Re)arm the stall watchdog: if no end-of-turn confirms within `watchdogMs` of SILENCE, the turn
   * is failed loudly (Task 3.2 / story-034 stall semantics) instead of hanging the ACP protocol
   * (§5 BLOCKER, R5.2). Called at turn start and again on every observed event (activity = liveness).
   */
  function armWatchdog(): void {
    clearWatchdog();
    cancelWatchdog = schedule(() => {
      cancelWatchdog = undefined;
      // Story 041 (R4.2): a main-chain `Task`/`Agent` `tool_use` is still open (no `tool_result`),
      // so a sub-agent is in flight. The silence is EXPECTED — HOLD the turn by re-arming the
      // watchdog instead of failing it. Without this, a long, silent sub-agent run would falsely
      // trip the stall watchdog and resolve the turn early. The hold is bounded by the eventual
      // `tool_result` (which empties `openTaskIds`) or a real main-chain terminal stop.
      if (openTaskIds.size > 0) {
        armWatchdog();
        return;
      }
      const error = new TurnTimeoutError({
        elapsedMs: watchdogMs,
        sessionId: opts.sessionId,
        ...eventDiag(lastEvent),
      });
      // R2 runtime telemetry — surface loudly via both channels; never swallow the stall.
      opts.logger?.error("[end-of-turn] turn watchdog tripped:", error.message);
      opts.onTurnTimeout?.(error);
    }, watchdogMs);
  }

  return {
    beginTurn(): void {
      if (stopped || cancelled) return;
      armWatchdog();
    },
    observe(event: StopReasonEvent): void {
      if (stopped || cancelled) return;
      lastEvent = event; // track for watchdog-timeout diagnostics (Task 3.2)
      // Story 041 (R4.2): track open main-chain `Task`/`Agent` `tool_use`s. A sub-agent-spawning
      // `tool_use` ADDS its id (the turn is now in flight on a sub-agent); a `tool_result` REMOVES
      // every id it closes (`tool_use_id`). While `openTaskIds` is non-empty the watchdog HOLDS
      // rather than trips (see armWatchdog). Order matters only across events, not within one row, so
      // closing first then opening is fine: a row is never both the open and its own close.
      for (const id of closedToolUseIds(event)) openTaskIds.delete(id);
      for (const id of subagentToolUseIds(event)) openTaskIds.add(id);
      // Story-034 stall semantics: a watched event is transcript ACTIVITY — the turn is alive, so
      // push the silence deadline out. Only while in flight (armed): replay/load observes with no
      // beginTurn and must never start a stall clock, and a cleared watchdog must stay cleared.
      if (cancelWatchdog !== undefined) armWatchdog();
      // Queued-prompt / back-to-back (R4): a NEW user/assistant write arriving while a candidate is
      // still pending (before Δt) confirms the PRIOR boundary immediately — cancelling the Δt timer —
      // then a fresh detection cycle begins for `event` below. This is what keeps two back-to-back
      // turns from merging into a single boundary.
      if (pendingCandidate && event !== pendingCandidate && isUserOrAssistantWrite(event)) {
        confirmBoundary();
      }
      if (isTerminalStop(event)) {
        const uuid = eventUuid(event);
        if (uuid && firedUuids.has(uuid)) return; // duplicate of an already-fired turn → idempotent
        pendingCandidate = event;
        armDelta(); // (re)arm the Δt quiescence timer
      }
    },
    noteActivity(): void {
      // Story 044 (R1.2, Option B): liveness-only kick from the sub-agent watcher. Mirrors the
      // activity re-arm inside observe() but registers NO event — no lastEvent, no openTaskIds
      // mutation, no pendingCandidate/Δt bookkeeping. Re-arms only while in flight (armed): a
      // replay/load kick never starts a stall clock, and a stopped/cancelled detector stays silent.
      if (stopped || cancelled) return;
      if (cancelWatchdog !== undefined) armWatchdog();
    },
    markCancelled(): void {
      // Single-resolution cancel seam (R3.4): set the latch and clear both timers so the detector
      // cannot also fire an end-of-turn for this turn. Read-only — the ACP session/cancel →
      // PromptResponse{stopReason:'cancelled'} resolution and its §8 wiring are story 030, which
      // calls this seam (latch here, resolution there — the two halves stay traceable).
      cancelled = true;
      clearDelta();
      clearWatchdog();
      pendingCandidate = undefined;
      openTaskIds.clear(); // R4.2: a cancelled turn drops any in-flight Task hold
    },
    stop(): void {
      stopped = true;
      clearDelta();
      clearWatchdog();
      pendingCandidate = undefined;
      openTaskIds.clear(); // R4.2: teardown drops any in-flight Task hold
    },
  };
}

// === Task 4.2 — resolve the pending session/prompt once per boundary =============================

/** Read `event.message.stop_reason` defensively — the raw value {@link mapStopReason} consumes. */
function readStopReason(event: StopReasonEvent): unknown {
  const message = (event as { message?: unknown }).message;
  return isObject(message) ? message.stop_reason : undefined;
}

/** Options for {@link createTurnResolver} — forwarded to the underlying detector. */
export interface TurnResolverOptions {
  schedule?: DetectorSchedule;
  sessionId?: string;
  logger?: StopReasonLogger;
  deltaTMs?: number;
  watchdogMs?: number;
  /**
   * Story 056 (#812) — fired EXACTLY ONCE, ONLY on a real end-of-turn boundary (NOT on cancel, NOT
   * on watchdog timeout), AFTER the prompt resolves. Fire-and-forget; the callback MUST NOT
   * throw/block.
   */
  onTurnResolved?: () => void;
}

/** A detector paired with the awaitable {@link PromptResponse} the prompt() loop returns. */
export interface TurnResolver {
  /** Feed events here (and arm the turn via `beginTurn`). */
  detector: EndOfTurnDetector;
  /** Settles once: resolves with the mapped PromptResponse, or rejects with a TurnTimeoutError. */
  promise: Promise<PromptResponse>;
  /**
   * Story 031 (R2.1, R2.2, R3.1) — claim the story-024 single-resolution latch to resolve the
   * prompt as `{ stopReason: "cancelled" }`, then call `detector.markCancelled()` to clear its Δt +
   * watchdog. A no-op if the turn already settled (the latch is the arbiter): a racing detector
   * boundary, a watchdog trip, or a second `cancel()` cannot produce a second resolution. This is
   * story-031 wiring that CALLS the latch — it does NOT re-implement it.
   */
  cancel(): void;
}

/**
 * Wrap the end-of-turn detector in the awaitable the rewritten `prompt()` loop (story 023) returns
 * (R2). The promise stays pending across every mid-turn event and settles EXACTLY ONCE — resolving
 * with `{ stopReason: mapStopReason(boundary.message.stop_reason) }` on the confirmed boundary, or
 * rejecting with the surfaced {@link TurnTimeoutError} on a watchdog trip. A single-resolution latch
 * makes a detector/watchdog/cancel race settle the prompt exactly once (and stops the detector so a
 * late boundary cannot produce a second settlement).
 */
export function createTurnResolver(opts: TurnResolverOptions = {}): TurnResolver {
  let settled = false;
  let resolveFn!: (response: PromptResponse) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<PromptResponse>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  // Single-resolution latch: a detector/watchdog/cancel race settles the prompt EXACTLY ONCE. The
  // detector's own latches already clear its timers on confirm/timeout, so any late callback that
  // still reaches `settle` is a harmless no-op.
  function settle(action: () => void): void {
    if (settled) return;
    settled = true;
    action();
  }

  const detector = createEndOfTurnDetector({
    onEndOfTurn: (boundary) =>
      // Story 056 (#812): fire onTurnResolved inside the SAME settle, AFTER the prompt resolves, so it
      // runs EXACTLY ONCE per real end-of-turn. cancel() and onTurnTimeout intentionally do NOT call
      // it — the settle latch + the detector's firedUuids guarantee a single call per turn.
      settle(() => {
        resolveFn({ stopReason: mapStopReason(readStopReason(boundary), opts.logger) });
        opts.onTurnResolved?.();
      }),
    onTurnTimeout: (error) => settle(() => rejectFn(error)),
    schedule: opts.schedule,
    sessionId: opts.sessionId,
    logger: opts.logger,
    deltaTMs: opts.deltaTMs,
    watchdogMs: opts.watchdogMs,
  });

  return {
    detector,
    promise,
    cancel(): void {
      // Claim the single-resolution latch FIRST (R2.2) so a racing detector boundary cannot also
      // resolve, then mark the detector cancelled (story-024 seam, R3.1) to clear its Δt + watchdog.
      settle(() => resolveFn({ stopReason: "cancelled" }));
      detector.markCancelled();
    },
  };
}
