// Story 034 (§9 / R3.3) — runtime wiring of the HYBRID permission gate into the real session path.
//
// Stories 032/033 delivered the gate as STANDALONE, offline-tested seams: the verified-free loopback
// port (gate/port.ts), the non-destructive `--settings` hook writer (gate/settings-writer.ts), the
// fail-closed `PreToolUse` http hook server (hook-server.ts), the `tool_use.id` correlation + ACP
// `session/request_permission` bridge (request-permission.ts), and the #52822 allow keystroke
// mitigation (allow-inject.ts). THIS module is the missing glue: one {@link SessionGate} PER SESSION
// that composes those REAL units (no re-implementation) so `createSession` can:
//
//   1. allocate a free loopback port (`findFreePort`) and start the hook server on it;
//   2. write the per-session SCRATCH settings file carrying the hook (`injectHook`) — NEVER the
//      user's `~/.claude/settings*.json` and NEVER the project `settings.local.json`; the scratch
//      lives in `os.tmpdir()` and is handed to the spawn as `--settings "<file>"` (GATE_FINDINGS
//      blocker c: settings MUST be on disk BEFORE the spawn — claude reads them only at startup);
//   3. decide each `PreToolUse` via the REAL story-033 decider chain: correlate by `tool_use.id`
//      against the JSONL (fed by the pump through {@link SessionGate.correlator}) → raise ACP
//      `session/request_permission` in Zed → enforce (`deny` body intercepts BEFORE the tool runs);
//   4. on `allow`, run the #52822 sweep: if the native TUI prompt still renders, inject the `'1\r'`
//      keystroke RAW into the PTY (allow-inject — deliberately NOT `sendPrompt`, whose leading
//      Ctrl+U clear byte must never touch a pending native dialog); on a stuck prompt WARN and hold;
//   5. tear everything down (close the server, `restore` the scratch) on `teardownSession` AND on
//      PTY exit — idempotently, leaking no port, server, or scratch file.
//
// FAIL CLOSED (PERMISSIONS.md §6): every uncertain path in the chain below already resolves to deny
// (malformed payload / no decider / decider timeout → hook-server; missing/duplicate id, ACP
// transport error, cancelled outcome → request-permission). This module adds two more: a missing
// session binding (no ACP sessionId to prompt with) denies, and a correlation that never appears
// within the bounded wait lets request-permission deny. Nothing here ever approves silently.
//
// OFFLINE: this module spawns NO claude and bills nothing; the http server binds 127.0.0.1 only.

import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { findFreePort } from "../gate/port.js";
import { injectHook, restore, type Backup } from "../gate/settings-writer.js";
import {
  startHookServer,
  type ForwardedToolCall,
  type HookServer,
  type ToolDecision,
} from "./hook-server.js";
import { askUserQuestionDenyReason, isAskUserQuestionTool } from "./deny.js";
import {
  requestPermission,
  ToolUseCorrelator,
  type PermissionClient,
} from "./request-permission.js";
import {
  buildElicitationRequest,
  mapOutcomeToDecision,
  requestElicitation,
  type AskUserQuestionInput,
  type ElicitationClient,
} from "./elicitation-bridge.js";
import { clearNativePrompt, type PtyWriter, type Schedule } from "./allow-inject.js";

/**
 * Substrings that evidence the native TUI permission prompt (the bordered "Do you want to
 * proceed?" box with numbered options), matched case-sensitively against the ANSI-stripped recent
 * PTY output. COPIED VERBATIM from the Degrau-0 billed probe (`experiments/e-gate.ts`
 * `NATIVE_PERMISSION_PROMPT_MARKERS`, claude 2.1.161) — the only empirical characterization of the
 * prompt's rendering we have. ANY hit ⇒ the native prompt is showing (#52822 reproduced).
 */
export const NATIVE_PERMISSION_PROMPT_MARKERS: readonly string[] = [
  "Do you want to proceed",
  "Do you want to allow",
  "Yes, and don't ask again",
  "Yes, allow",
  "1. Yes",
  "No, and tell Claude",
];

/**
 * Story 054 (R6) — the native SUBAGENT permission prompt header. claude renders a subagent tool's
 * permission box with a "Tool use · from the <name> agent" header, distinct from the main-chain
 * "Do you want to proceed?" markers above. Without this marker {@link textShowsNativePrompt} misses
 * the subagent box, {@link clearNativePrompt} returns `'suppressed'` and types nothing, and the inner
 * subagent tool hangs. The substring is specific enough not to match ordinary subagent narration
 * ("the … agent finished its work"). The exact middot/wording is confirmed in the deferred in-Zed
 * proof (task 8); kept separate from the verbatim Degrau-0 probe markers above.
 */
export const SUBAGENT_PROMPT_MARKER = "Tool use · from the";

/** Strip CSI / common ANSI escape sequences so prompt markers match the plain text (e-gate probe). */
function stripAnsiText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** True iff any native-prompt marker — main-chain or the story-054 subagent box — appears in `text`
 *  (after ANSI stripping). */
export function textShowsNativePrompt(text: string): boolean {
  const stripped = stripAnsiText(text);
  return (
    NATIVE_PERMISSION_PROMPT_MARKERS.some((m) => stripped.includes(m)) ||
    stripped.includes(SUBAGENT_PROMPT_MARKER)
  );
}

/** Default bounded wait for the JSONL `tool_use` correlation to land after a hook fires (ms).
 *  The hook fires AFTER claude appended the assistant `tool_use` line, but the fs-watch → pump
 *  re-read is asynchronous — this window absorbs that lag. On expiry the decider proceeds and
 *  request-permission fails closed (deny) on the still-missing correlation. */
export const DEFAULT_CORRELATION_WAIT_MS = 5000;
/** Default poll interval for the correlation wait (ms). */
export const DEFAULT_CORRELATION_POLL_MS = 50;
/** Story 054 — re-nudge cadence inside the correlation wait (ms): a sidechain inner tool_use line can
 *  materialize MID-WAIT (after the first nudge) — periodically re-kicking the pump sources + registers
 *  that lagging row before the wait expires, so the subagent tool reaches a clean match instead of a
 *  fail-closed timeout deny. Tracked separately from the poll interval (the poll is 10-50ms; nudging on
 *  every poll would hammer the pump) — a nudge fires only once ~250ms has elapsed since the last one. */
export const DEFAULT_CORRELATION_RENUDGE_MS = 250;

/**
 * FIX(watchdog-permission): while a permission dialog is pending the claude is BLOCKED and writes
 * nothing to the JSONL, so the end-of-turn watchdog (120s of silence) would mistake a long human
 * decision for a dead turn. Re-arm it every this-many ms via the bound `noteActivity` for as long as
 * the dialog is open. Must stay well under TURN_STALL_WATCHDOG_MS (120_000).
 */
export const DEFAULT_PERMISSION_HEARTBEAT_MS = 30_000;
/** Default window for the native prompt to APPEAR after an allow decision (#52822 sweep, ms).
 *  If no marker renders within it, allow-suppression held (the 2.1.161 case) — nothing to clear. */
export const DEFAULT_PROMPT_APPEAR_MS = 1500;
/** Default poll interval for the sweep's appear/clear phases (ms). */
export const DEFAULT_PROMPT_POLL_MS = 100;
/** Default budget for the keystroke to clear the prompt before the stuck warning (ms). */
export const DEFAULT_INJECT_TIMEOUT_MS = 2000;
/** Default bounded wait for the hook server to close on teardown (ms) — teardown never hangs on a
 *  socket held open by an in-flight decider; on expiry it warns and proceeds (the process-level
 *  close still completes in the background). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
/** Cap on the retained rolling tail of recent PTY output (chars) for the prompt probe. */
const OUTPUT_TAIL_CAP = 16384;

/** Filename prefix of the per-session scratch settings file (diagnosable in `ls /tmp`). */
export const SCRATCH_SETTINGS_PREFIX = "fork-acp-gate-settings-";

/** Story 046 (R3) — the file-edit tools that `acceptEdits` auto-allows, mirroring claude's native
 *  acceptEdits semantics (edits proceed without prompting; every other tool still asks). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The minimal PTY surface the gate needs: a raw writer (allow keystroke) and, when available, an
 *  `onData` tap feeding the native-prompt probe. Structurally satisfied by node-pty's IPty; the
 *  replay-only noop PTY also satisfies it (but replay-only sessions never get a gate). */
export interface GatePty extends PtyWriter {
  onData?(cb: (data: string) => void): { dispose(): void };
}

/**
 * Story 065 — the default hard upper bound (ms) on the AskUserQuestion elicitation round-trip. Generous
 * (a human may take minutes to answer) but DELIBERATELY BELOW the hook-server
 * {@link import("./hook-server.js").DEFAULT_DECIDER_TIMEOUT_MS} (600_000), so the bridge times out FIRST
 * with a legible fail-closed reason rather than the decider being killed out from under it. Injectable
 * via {@link SessionGateOptions.elicitationTimeoutMs} so offline tests use a small value.
 */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;

/** Options for {@link setupSessionGate}. Timing knobs are injectable for offline tests. */
export interface SessionGateOptions {
  /** The ACP client surface. The agent's `AcpClient` satisfies BOTH `requestPermission(params)`
   *  (the story-033 relay) AND `createElicitation(params)` (the story-065 elicitation
   *  bridge), so the field carries both capabilities. */
  client: PermissionClient & ElicitationClient;
  /** Diagnostics sink for every fail-closed / stuck-prompt warning (production: logger.error). */
  onWarn?: (message: string) => void;
  /**
   * Story 065 (R1/R3) — whether the connected ACP client negotiated the elicitation `form` capability
   * (`clientCapabilities.elicitation.form`). When true, AskUserQuestion is driven through a real ACP
   * form elicitation ({@link SessionGateImpl.decideElicitation}); when false/omitted it DEGRADES to the
   * story-064 fail-closed deny-guard. Defaults to false when read, so an existing gate/064 test that
   * omits it keeps the degrade behavior (load-bearing — do NOT make required). */
  clientSupportsElicitationForm?: boolean;
  /** Story 065 — hard upper bound (ms) on the AskUserQuestion elicitation round-trip; default
   *  {@link DEFAULT_ELICITATION_TIMEOUT_MS}. Injectable so offline tests use a small value. */
  elicitationTimeoutMs?: number;
  /** Injectable timer seam (same discipline as allow-inject/end-of-turn). Default: setTimeout. */
  schedule?: Schedule;
  /** Directory for the per-session scratch settings file. Default: `os.tmpdir()`. */
  settingsDir?: string;
  /** Hook timeout written into the scratch settings, in SECONDS (claude default 600). */
  hookTimeoutSeconds?: number;
  /** Hook-server decider budget (ms) before it fails closed; default per hook-server. */
  deciderTimeoutMs?: number;
  /** See {@link DEFAULT_CORRELATION_WAIT_MS}. */
  correlationWaitMs?: number;
  /** See {@link DEFAULT_CORRELATION_POLL_MS}. */
  correlationPollMs?: number;
  /** See {@link DEFAULT_CORRELATION_RENUDGE_MS}. */
  correlationRenudgeMs?: number;
  /** See {@link DEFAULT_PROMPT_APPEAR_MS}. */
  promptAppearMs?: number;
  /** See {@link DEFAULT_PROMPT_POLL_MS}. */
  promptPollMs?: number;
  /** See {@link DEFAULT_INJECT_TIMEOUT_MS}. */
  injectTimeoutMs?: number;
  /** See {@link DEFAULT_CLOSE_TIMEOUT_MS}. */
  closeTimeoutMs?: number;
  /** Injectable port allocator (default: the story-032 `findFreePort`). */
  findPort?: () => Promise<number>;
}

/** Story 054 — the parent-Task relay info for a subagent inner tool, resolved at decide() time. */
export interface SubagentRelay {
  /** The spawning Task/Agent tool_use id to attach the ACP dialog to; null = orphan (no safe target). */
  parentId: string | null;
  /** Best-effort subagent name for the dialog title / the R4 deny line. */
  subagentLabel: string;
}
/** Resolve a subagent inner tool_use id → its relay info, or undefined for a main-chain tool. */
export type ResolveSubagentRelay = (innerToolUseId: string) => SubagentRelay | undefined;

/** The per-session gate runtime handle `createSession` owns and `teardownSession` disposes. */
export interface SessionGate {
  /** The verified-free loopback port the hook server bound (== the port in the scratch hook URL). */
  port: number;
  /** Story 055 (R1.3) — the per-session secret token bound into the hook URL after the marker path.
   *  The hook-server rejects any PreToolUse POST that does not present `${marker}/<token>`. */
  readonly token: string;
  /** Absolute path of the per-session scratch settings file (hand to the spawn as `--settings`). */
  settingsPath: string;
  /** The per-session `tool_use.id` correlation map. The live pump REGISTERS every JSONL `tool_use`
   *  id here (`correlator.register(id)`) so a hook call can be matched before it is approved. */
  correlator: ToolUseCorrelator;
  /**
   * Bind the AUTHORITATIVE ACP session id (known only AFTER the engine spawn on the fresh path)
   * and an optional `nudge` invoked on every hook arrival to force an immediate pump re-read
   * (shrinking the JSONL-correlation race). MUST be called before the first tool call can be
   * approved — an unbound gate fails closed (deny).
   *
   * Story 054 — the third optional arg is a lazy resolver that maps an inner `tool_use.id` to its
   * subagent {@link SubagentRelay} (parent Task id + label) by reading the session's
   * `sidechainParentMap` (populated by the pump). `decide` uses it AFTER the correlation wait to
   * relay a KNOWN subagent tool's dialog under its parent Task id (R1/R2), or to fail LOUD (R4) on
   * an orphan / uncorrelatable subagent. A main-chain tool (no resolver entry) is unchanged (U1).
   */
  bindSession(
    sessionId: string,
    nudge?: () => void,
    resolveSubagentRelay?: ResolveSubagentRelay,
    /** FIX(watchdog-permission) — re-arms the end-of-turn watchdog while a permission dialog is open. */
    noteActivity?: () => void,
  ): void;
  /** Bind the live PTY: stores the raw writer for the allow keystroke and (when the PTY exposes
   *  `onData`) attaches the recent-output tap feeding the native-prompt probe. */
  bindPty(pty: GatePty): void;
  /** Idempotent teardown: close the hook server (bounded) and restore/delete the scratch settings.
   *  Safe to call from BOTH `teardownSession` and the PTY `onExit` hook. */
  teardown(): Promise<void>;
  /** True once {@link teardown} has run. */
  readonly isTorndown: boolean;
}

const defaultSchedule: Schedule = (fn, ms) => {
  setTimeout(fn, ms);
};

/**
 * Story 065 — STRUCTURAL guard that a hook payload's `tool_input` is a usable {@link AskUserQuestionInput}:
 * an object carrying a NON-EMPTY `questions` array, EACH question being an object with a `header` string
 * and a NON-EMPTY `options` array of `{ label: string }`. The runtime zod validators are not importable
 * across the SDK package `exports` map, and the hook payload's `tool_input` is `unknown`, so this narrows
 * before the bridge builder projects it into a form (an empty/garbage form would otherwise reach the
 * client, and a per-question shape the builder walks — `q.options.map(...)`, `q.header` — would otherwise
 * throw).
 *
 * Story 065 / task 4.1 (R4) — the per-question `options`/`header` validation is a BELT-AND-SUSPENDERS
 * addition: {@link SessionGateImpl.decideElicitation} now also wraps the build in a try/catch (the
 * mandatory total-function guarantee), so this guard's job is only to fail closed to the story-064 deny
 * EARLY (with a "malformed tool_input" reason) rather than relying on the catch. Both together mean a
 * malformed per-question input is a legible dismissal, never a crash and never an approve.
 */
function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as { questions: unknown }).questions)
  ) {
    return false;
  }
  const questions = (input as { questions: unknown[] }).questions;
  if (questions.length === 0) return false;
  return questions.every((q) => {
    if (typeof q !== "object" || q === null) return false;
    const question = q as { header?: unknown; options?: unknown };
    if (typeof question.header !== "string") return false;
    if (!Array.isArray(question.options) || question.options.length === 0) return false;
    return question.options.every(
      (o) =>
        typeof o === "object" && o !== null && typeof (o as { label?: unknown }).label === "string",
    );
  });
}

/** Internal mutable state of one session's gate. */
class SessionGateImpl implements SessionGate {
  port = 0;
  /** Story 055 (R1.3) — set in {@link start} to a crypto-random per-session secret. */
  token = "";
  settingsPath = "";
  readonly correlator = new ToolUseCorrelator();

  private server?: HookServer;
  private backup?: Backup;
  private sessionId?: string;
  private nudge?: () => void;
  /** Story 054 — lazy resolver: inner tool_use id → its subagent relay (parent Task id + label). */
  private resolveSubagentRelay?: ResolveSubagentRelay;
  /** FIX(watchdog-permission) — re-arms the end-of-turn watchdog while a permission dialog is open. */
  private noteActivity?: () => void;
  private pty?: PtyWriter;
  private outputTap?: { dispose(): void };
  /** Rolling tail of recent PTY output + absolute count of chars ever appended (probe offsets). */
  private outputTail = "";
  private totalOutput = 0;
  private torndown = false;
  /** Story 054 (R5) — per-session serial queue: the request+sweep critical section runs one at a
   *  time so two parallel subagent dialogs never cross their shared-PTY keystrokes. The wait/
   *  correlate/resolve prelude stays concurrent (only the raise+inject section serializes). */
  private permissionQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SessionGateOptions) {}

  get isTorndown(): boolean {
    return this.torndown;
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  private get schedule(): Schedule {
    return this.opts.schedule ?? defaultSchedule;
  }

  /** Story 054 (R5) — append `fn` to the per-session serial chain so it runs only after the
   *  previous critical section settles (success OR failure), serializing concurrent decides'
   *  request+sweep sections. The chain is kept alive (and its errors swallowed) so one rejected
   *  permission never poisons the next; the returned promise still surfaces `fn`'s own result. */
  private enqueuePermission<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.permissionQueue.then(fn, fn);
    this.permissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * FIX(watchdog-permission): start a heartbeat that re-arms the end-of-turn watchdog (via the bound
   * `noteActivity`) every {@link DEFAULT_PERMISSION_HEARTBEAT_MS} while a permission dialog is open, so
   * the human decision time is never counted as transcript silence. Self-reschedules through the
   * injectable `schedule` (testable). Returns a stop fn; safe/no-op when `noteActivity` is unset.
   */
  private startPermissionHeartbeat(): () => void {
    const note = this.noteActivity;
    if (!note) return () => {};
    let stopped = false;
    const tick = (): void => {
      if (stopped || this.torndown) return;
      try {
        note();
      } catch {
        // heartbeat is best-effort liveness; a failure never affects the decision
      }
      this.schedule(tick, DEFAULT_PERMISSION_HEARTBEAT_MS);
    };
    this.schedule(tick, DEFAULT_PERMISSION_HEARTBEAT_MS);
    return () => {
      stopped = true;
    };
  }

  /** Start the hook server, then write the scratch settings (server first, so the URL the settings
   *  point at is live before claude can ever read them; settings BEFORE the spawn is the caller's
   *  ordering contract — blocker c). */
  async start(): Promise<void> {
    const findPort = this.opts.findPort ?? findFreePort;
    this.port = await findPort();

    // Story 055 (R1.3): a per-session crypto-random secret bound into the hook URL (after the marker
    // path). The hook-server rejects any PreToolUse POST that does not present it — the compensating
    // control for the relaxed JSONL anti-forgery (decide() now seeds the correlator from the payload).
    this.token = randomBytes(24).toString("hex");

    this.server = await startHookServer({
      port: this.port,
      token: this.token,
      deciderTimeoutMs: this.opts.deciderTimeoutMs,
      onWarn: (m) => this.warn(m),
      onToolCall: (call) => this.decide(call),
    });

    const dir = this.opts.settingsDir ?? os.tmpdir();
    this.settingsPath = path.join(dir, `${SCRATCH_SETTINGS_PREFIX}${randomUUID()}.json`);
    try {
      this.backup = await injectHook({
        settingsPath: this.settingsPath,
        port: this.port,
        token: this.token,
        timeout: this.opts.hookTimeoutSeconds,
      });
    } catch (err) {
      // The settings write failed AFTER the server bound — close it before surfacing, so a failed
      // gate setup leaks nothing (the caller aborts createSession; FORK_GATE=off is the escape hatch).
      await this.closeServerBounded();
      throw err;
    }
  }

  bindSession(
    sessionId: string,
    nudge?: () => void,
    resolveSubagentRelay?: ResolveSubagentRelay,
    noteActivity?: () => void,
  ): void {
    this.sessionId = sessionId;
    this.nudge = nudge;
    this.resolveSubagentRelay = resolveSubagentRelay;
    this.noteActivity = noteActivity;
  }

  bindPty(pty: GatePty): void {
    this.pty = pty;
    if (typeof pty.onData === "function") {
      this.outputTap = pty.onData((data: string) => {
        this.totalOutput += data.length;
        this.outputTail = (this.outputTail + data).slice(-OUTPUT_TAIL_CAP);
      });
    }
  }

  /** Bytes received after the absolute output offset `mark` (clipped to the retained tail). */
  private outputSince(mark: number): string {
    const available = Math.min(this.outputTail.length, Math.max(0, this.totalOutput - mark));
    return available === 0 ? "" : this.outputTail.slice(-available);
  }

  /**
   * The REAL decider chain (the hook→ACP connection): nudge the pump → bounded-wait for the JSONL
   * `tool_use.id` correlation → raise ACP `session/request_permission` (story 033, fail-closed) →
   * on `allow`, arm the #52822 native-prompt sweep. Every deny path is request-permission's own.
   */
  private async decide(call: ForwardedToolCall): Promise<ToolDecision> {
    if (this.torndown) return "deny"; // a hook racing teardown is never approved

    // === Story 064/065 — AskUserQuestion handling, BEFORE any mode auto-allow or ACP relay. =========
    // AskUserQuestion renders an interactive multiple-choice picker bound to the hidden PTY's stdin.
    // Over the bridge the Zed user can't see or answer it, so an allow (including the bypass/acceptEdits
    // auto-allow below) would stall the turn until the watchdog fires. This branch stays FIRST (after the
    // torndown check) so AskUserQuestion is always intercepted regardless of permission mode.
    //
    // Story 065 (R1): when the client negotiated the elicitation `form` capability, drive a REAL ACP form
    // elicitation and carry the answer back in a deny reason (a PreToolUse hook cannot synthesize a native
    // tool_result — the tool is ALWAYS denied at the wire). Story 065 (R3): otherwise DEGRADE to the
    // story-064 fail-closed deny-guard so the model proceeds without stalling.
    if (isAskUserQuestionTool(call.toolName)) {
      if (this.opts.clientSupportsElicitationForm) {
        return await this.decideElicitation(call);
      }
      return { decision: "deny", reason: askUserQuestionDenyReason() }; // R3 degrade
    }

    // === Story 046 (R3) — honor the live permission mode BEFORE relaying to Zed. =================
    // The hook payload carries the current mode (probe-d confirmed `permission_mode` matches the
    // selected mode in acceptEdits/bypassPermissions). Without this branch the gate raises
    // session/request_permission for EVERY tool, overriding the panel's mode selector — the user sees
    // a Zed prompt in every mode, even bypass. bypassPermissions auto-allows ALL tools; acceptEdits
    // auto-allows edit-class tools; default/plan/auto/dontAsk fall through to the ACP relay (ask Zed).
    // No #52822 sweep on this path: these modes make claude auto-proceed, so no native prompt renders.
    if (call.permissionMode === "bypassPermissions") return "allow";
    if (call.permissionMode === "acceptEdits" && EDIT_TOOLS.has(call.toolName)) return "allow";

    // Kick the pump so the freshest JSONL (carrying this call's `tool_use` line) is re-read NOW.
    try {
      this.nudge?.();
    } catch {
      // a nudge failure only widens the correlation wait below; never approves/denies by itself
    }

    const sessionId = this.sessionId ?? call.sessionId;
    if (!sessionId) {
      this.warn(
        `[gate §9] FAIL CLOSED: PreToolUse for tool_use ${call.toolUseId} arrived before the gate ` +
          `was bound to an ACP session — denying (cannot raise session/request_permission).`,
      );
      return "deny";
    }

    // FIX(gate-deadlock): the claude flushes the `tool_use` JSONL line only AFTER the hook decision,
    // so correlating against the JSONL deadlocks — the line never reaches the pump during the wait
    // (proven live 2026-06-25: total=9 frozen for 5s, the id only registered post-deny). Seed the
    // correlator from the hook payload, the AUTHORITATIVE tool_use.id source, so the gate decides on
    // the payload (the JSONL stays best-effort enrichment). Mirrors the ACP original's permission
    // callback, which decided directly on the SDK-supplied tool id without a transcript round-trip.
    this.correlator.ensureRegistered(call.toolUseId);

    await this.waitForCorrelation(call.toolUseId);

    // === Story 054/055 (§9 subagent relay) — AFTER the correlation wait, BEFORE the ACP prompt. =====
    // R2.2 — the dialog LABEL is sourced from the payload's `agent_type` (carried by parsePayload,
    // story 055/2.1): transcript-independent and known NOW, so a subagent tool is always attributed
    // even when its parent Task id is not (yet) resolvable. A main-chain payload has no agent_type →
    // `subagentLabel` stays undefined and the requestPermission call below is byte-identical to today
    // (U1: bare tool name, dialog under the inner id).
    //
    // R2.3 — parent-Task GROUPING is BEST-EFFORT. The hook payload carries NO parent id; the only
    // source is the session's sidechainParentMap, read lazily via the bound resolver and populated by
    // the (transcript-lagging) pump. WHEN it resolves a non-null parent, the dialog attaches under that
    // parent Task id Zed already rendered. For a subagent whose row has NOT landed yet, give the pump a
    // brief re-nudged window to register it mid-wait (the join is pump-fed, like the inner correlation);
    // on expiry we relay the LABELLED dialog under the INNER id. An orphan (parentId === null) or an
    // unresolved subagent is therefore PROMPTED (labelled), NEVER silently denied — this REPLACES the
    // story-054 orphan/uncorrelated visible deny. The only deny here is requestPermission's own
    // fail-closed (transport error / cancelled / duplicate id), propagated unchanged.
    let subagentLabel: string | undefined = call.agentType;
    let relay = this.resolveSubagentRelay?.(call.toolUseId);
    if (!relay && call.agentType !== undefined) {
      // A subagent tool (agent_type present) whose parent row may still be in flight: best-effort wait.
      relay = await this.waitForSubagentParent(call.toolUseId);
    }
    let dialogToolCallId: string | undefined;
    if (relay) {
      // Prefer the payload label; fall back to the resolver's best-effort label (a pre-055 caller / a
      // subagent payload that somehow omitted agent_type).
      subagentLabel = call.agentType ?? relay.subagentLabel;
      // Group ONLY under a real, resolvable parent; an orphan (null) falls through to the inner-id relay.
      if (relay.parentId !== null) {
        dialogToolCallId = relay.parentId;
      }
    }

    // === Story 054 (R5) — SERIALIZE only the raise+inject critical section. ========================
    // dialogToolCallId/subagentLabel were computed above in the CONCURRENT prelude, so each enqueued
    // request still carries its own parent Task id regardless of interleaving. Two parallel subagent
    // decides therefore resolve INDEPENDENTLY (distinct inner ids in the correlator) but run their
    // requestPermission + armAllowSweep one at a time — no native-prompt keystroke crossing on the
    // shared PTY. A single sequential main-chain tool is a no-op through the queue (U1).
    return this.enqueuePermission(async () => {
      // FIX(watchdog-permission): the claude is blocked on this response with the JSONL silent, so
      // re-arm the end-of-turn watchdog for as long as the dialog is open (a slow human decision is
      // NOT a dead turn). Always cleared in `finally`, on success or throw.
      const stopHeartbeat = this.startPermissionHeartbeat();
      try {
        const decision = await requestPermission({
          client: this.opts.client,
          sessionId,
          toolCall: {
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            toolInput: call.toolInput,
          },
          correlator: this.correlator,
          onWarn: (m) => this.warn(m),
          dialogToolCallId,
          subagentLabel,
        });

        if (decision === "allow") {
          // Return the allow body FIRST (claude is blocked on this response); sweep out of band.
          this.armAllowSweep(call);
        }
        return decision;
      } finally {
        stopHeartbeat();
      }
    });
  }

  /**
   * Story 065 (R1, R2.1, R2.2) — drive an AskUserQuestion via a REAL ACP form elicitation and map the
   * user's outcome back to a gate decision. ALWAYS returns a `deny`+reason (a PreToolUse hook cannot
   * synthesize a native tool_result): on accept the reason CARRIES the answer (R2.1); on
   * decline/cancel/timeout/transport-error the reason reads as a dismissal (R2.2). Reached ONLY when the
   * client negotiated the elicitation `form` capability (guarded in {@link decide}).
   *
   * FAIL CLOSED (mirrors the whole gate's posture): an elicitation is SESSION-SCOPED, so with no bound
   * ACP session id (nor a payload fallback) we CANNOT raise one → fall back to the story-064 deny. A
   * structurally malformed `tool_input` (not an object with a non-empty `questions` array) likewise falls
   * back — the bridge builder would otherwise project an empty/garbage form. Both are dismissals, never
   * an accept.
   *
   * The turn is BLOCKED awaiting the user exactly like the requestPermission relay, so the end-of-turn
   * watchdog is re-armed via {@link startPermissionHeartbeat} for as long as the elicitation is open
   * (always cleared in `finally`). The round-trip itself is bounded + fail-closed inside
   * {@link requestElicitation} (it never throws and never hangs past the timeout).
   */
  private async decideElicitation(call: ForwardedToolCall): Promise<ToolDecision> {
    const sessionId = this.sessionId ?? call.sessionId;
    if (!sessionId) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion for tool_use ${call.toolUseId} arrived before ` +
          `the gate was bound to an ACP session — cannot raise a session-scoped elicitation; denying ` +
          `(story-064 fallback).`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    }

    if (!isAskUserQuestionInput(call.toolInput)) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion tool_use ${call.toolUseId} carried a malformed ` +
          `tool_input (expected an object with a non-empty "questions" array) — cannot build a form ` +
          `elicitation; denying (story-064 fallback).`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    }

    // The claude is blocked on this response with the JSONL silent, so re-arm the end-of-turn watchdog
    // for as long as the elicitation is open (a slow human decision is NOT a dead turn). Mirror the
    // requestPermission relay's heartbeat; always cleared in `finally`, on success or throw.
    const stopHeartbeat = this.startPermissionHeartbeat();
    try {
      // TOTAL by construction (R4): build + round-trip are wrapped so ANY throw degrades to the
      // story-064 deny with a legible diagnostic, never escaping decideElicitation. buildElicitationRequest
      // itself can throw on a per-question input the structural guard did not catch (e.g. a question with
      // no `options` array → `q.options.map(...)` throws); requestElicitation is fail-closed internally,
      // but this catch is the mandatory total-function guarantee (the hook-server's decideWithTimeout is
      // only the generic defense-in-depth net). A throw here is a dismissal, never an accept.
      const req = buildElicitationRequest(call.toolUseId, sessionId, call.toolInput);
      const resp = await requestElicitation(this.opts.client, req, {
        timeoutMs: this.opts.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS,
        onWarn: (m) => this.warn(m),
      });
      return mapOutcomeToDecision(resp);
    } catch (err) {
      this.warn(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion tool_use ${call.toolUseId} could not be ` +
          `elicited (${err instanceof Error ? err.message : String(err)}) — denying (story-064 ` +
          `fallback); the tool is intercepted, never approved.`,
      );
      return { decision: "deny", reason: askUserQuestionDenyReason() };
    } finally {
      stopHeartbeat();
    }
  }

  /** Bounded poll until the pump has registered `toolUseId` as a clean single JSONL match. On
   *  expiry, resolve anyway — `requestPermission` then fails closed on the missing correlation.
   *
   *  Story 054 — re-nudge the pump on a ~{@link DEFAULT_CORRELATION_RENUDGE_MS} cadence (tracked
   *  SEPARATELY from the poll interval) so a sidechain inner tool_use line materializing MID-WAIT is
   *  sourced + registered before expiry — turning a would-be timeout deny into a clean subagent match.
   *  The nudge is best-effort: a throw never rejects the wait (it only widens the correlation window). */
  private waitForCorrelation(toolUseId: string): Promise<void> {
    const waitMs = this.opts.correlationWaitMs ?? DEFAULT_CORRELATION_WAIT_MS;
    const pollMs = this.opts.correlationPollMs ?? DEFAULT_CORRELATION_POLL_MS;
    const renudgeMs = this.opts.correlationRenudgeMs ?? DEFAULT_CORRELATION_RENUDGE_MS;
    if (this.correlator.isCleanMatch(toolUseId)) return Promise.resolve();
    return new Promise((resolve) => {
      let elapsed = 0;
      let sinceNudge = 0;
      const poll = (): void => {
        if (this.torndown || this.correlator.isCleanMatch(toolUseId)) {
          resolve();
          return;
        }
        elapsed += pollMs;
        // Re-nudge on its own cadence (NOT every poll): a lagging sidechain row gets re-sourced so it
        // can register before the wait elapses. A nudge failure must never reject the wait.
        sinceNudge += pollMs;
        if (sinceNudge >= renudgeMs) {
          sinceNudge = 0;
          try {
            this.nudge?.();
          } catch {
            // a nudge failure only widens the correlation wait; never rejects or decides by itself
          }
        }
        if (elapsed >= waitMs) {
          this.warn(
            `[gate §9] correlation wait expired (${waitMs}ms) for tool_use ${toolUseId} — the JSONL ` +
              `tool_use line never reached the pump; the decision will fail closed (deny).`,
          );
          resolve();
          return;
        }
        this.schedule(poll, pollMs);
      };
      this.schedule(poll, pollMs);
    });
  }

  /**
   * Story 055 (R2.3) — BEST-EFFORT parent grouping for a subagent inner tool. The `agent_id → parent
   * tool_use.id` join lives only in the (transcript-lagging) pump-fed `sidechainParentMap`, so the
   * parent may not be registered at decide()-time. Poll the lazy resolver, re-nudging the pump on the
   * same {@link DEFAULT_CORRELATION_RENUDGE_MS} cadence so a sidechain row landing MID-WAIT is caught,
   * and resolve with the relay AS SOON AS it appears. On expiry resolve `undefined` — the caller then
   * relays the LABELLED dialog under the inner id (never a deny). Bounded by the same correlation
   * window since the join is pump-fed exactly like the inner correlation; a torn-down gate resolves
   * `undefined` immediately. Only ever called for a subagent payload (agent_type present), so a
   * main-chain tool never incurs this wait.
   */
  private waitForSubagentParent(innerToolUseId: string): Promise<SubagentRelay | undefined> {
    const resolveNow = (): SubagentRelay | undefined => this.resolveSubagentRelay?.(innerToolUseId);
    const immediate = resolveNow();
    if (immediate) return Promise.resolve(immediate);
    const waitMs = this.opts.correlationWaitMs ?? DEFAULT_CORRELATION_WAIT_MS;
    const pollMs = this.opts.correlationPollMs ?? DEFAULT_CORRELATION_POLL_MS;
    const renudgeMs = this.opts.correlationRenudgeMs ?? DEFAULT_CORRELATION_RENUDGE_MS;
    return new Promise((resolve) => {
      let elapsed = 0;
      let sinceNudge = 0;
      const poll = (): void => {
        if (this.torndown) {
          resolve(undefined);
          return;
        }
        const r = resolveNow();
        if (r) {
          resolve(r);
          return;
        }
        elapsed += pollMs;
        sinceNudge += pollMs;
        if (sinceNudge >= renudgeMs) {
          sinceNudge = 0;
          try {
            this.nudge?.();
          } catch {
            // best-effort: a nudge failure only widens the grouping window; never rejects or decides
          }
        }
        if (elapsed >= waitMs) {
          resolve(undefined); // best-effort expiry — relay under the inner id (labelled), not a deny
          return;
        }
        this.schedule(poll, pollMs);
      };
      this.schedule(poll, pollMs);
    });
  }

  /**
   * #52822 sweep (allow path, best-effort by design): wait a bounded window for the native TUI
   * prompt to APPEAR in the post-decision PTY output; if it never renders, allow-suppression held
   * (the 2.1.161 case) and nothing is typed. If it renders, clear it via the story-033
   * `clearNativePrompt` — the `'1\r'` keystroke goes RAW through `pty.write` (never `sendPrompt`,
   * whose leading Ctrl+U clear byte must not touch a pending dialog). On a stuck prompt it WARNS
   * and holds — never a silent approve (R3.2).
   *
   * Post-keystroke probe semantics (honest limits): the prompt counts as CLEARED only when NEW
   * output arrives after the keystroke and carries no prompt marker (the TUI re-rendered past the
   * dialog). Zero new output ⇒ still shown ⇒ the stuck warning fires at the timeout. A re-rendered
   * marker ⇒ still shown. This is a byte-stream heuristic over the Degrau-0 markers — the live
   * fidelity check is story 034's acceptance run.
   */
  private armAllowSweep(call: ForwardedToolCall): void {
    const pty = this.pty;
    if (!pty) {
      this.warn(
        `[gate §9] allow for tool_use ${call.toolUseId}: no PTY bound — cannot run the #52822 ` +
          `keystroke sweep; if the native prompt appears it needs a manual keystroke.`,
      );
      return;
    }
    const appearMs = this.opts.promptAppearMs ?? DEFAULT_PROMPT_APPEAR_MS;
    const pollMs = this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS;
    const appearMark = this.totalOutput; // only output AFTER the allow decision is scanned

    let elapsed = 0;
    const pollAppear = (): void => {
      if (this.torndown) return;
      if (textShowsNativePrompt(this.outputSince(appearMark))) {
        void this.runClear(call, pty);
        return;
      }
      elapsed += pollMs;
      if (elapsed >= appearMs) return; // suppressed (the 2.1.161 case) — nothing to clear
      this.schedule(pollAppear, pollMs);
    };
    this.schedule(pollAppear, pollMs);
  }

  /** Drive the story-033 keystroke injection against the live output probe (see armAllowSweep). */
  private async runClear(call: ForwardedToolCall, pty: PtyWriter): Promise<void> {
    let keystrokeMark: number | null = null;
    const isPromptShown = (): boolean => {
      if (keystrokeMark === null) {
        // First probe (pre-keystroke): the appear-poll already proved the prompt is up. Mark the
        // output offset so the post-keystroke probes scan only the TUI's REACTION to the keystroke.
        keystrokeMark = this.totalOutput;
        return true;
      }
      if (this.totalOutput === keystrokeMark) return true; // TUI has not reacted yet — still shown
      return textShowsNativePrompt(this.outputSince(keystrokeMark));
    };

    const result = await clearNativePrompt({
      pty,
      decision: "allow",
      isPromptShown,
      timeoutMs: this.opts.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS,
      pollMs: this.opts.promptPollMs ?? DEFAULT_PROMPT_POLL_MS,
      schedule: this.schedule,
      onWarn: (m) => this.warn(m),
    });
    if (result.status === "stuck") {
      // clearNativePrompt already warned; name the tool here for the session log's correlation.
      this.warn(
        `[gate §9] STUCK PROMPT for tool_use ${call.toolUseId} (tool "${call.toolName}") — the ` +
          `allow keystroke did not clear the native prompt; holding (no silent approve).`,
      );
    }
  }

  /** Close the hook server with a bounded wait so teardown never hangs on an in-flight request. */
  private async closeServerBounded(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const closeTimeoutMs = this.opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    let timedOut = false;
    await Promise.race([
      server.close(),
      new Promise<void>((resolve) =>
        this.schedule(() => {
          timedOut = true;
          resolve();
        }, closeTimeoutMs),
      ),
    ]);
    if (timedOut) {
      this.warn(
        `[gate §9] hook server on 127.0.0.1:${this.port} did not close within ${closeTimeoutMs}ms ` +
          `(an in-flight decider may be holding a request open); teardown proceeds — the close ` +
          `completes in the background.`,
      );
    }
  }

  async teardown(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;

    this.outputTap?.dispose();
    this.outputTap = undefined;

    await this.closeServerBounded();

    const backup = this.backup;
    this.backup = undefined;
    if (backup) {
      try {
        await restore(backup); // scratch was created by injectHook (existed:false) → deleted here
      } catch (err) {
        this.warn(
          `[gate §9] scratch settings restore failed for ${backup.settingsPath} ` +
            `(${err instanceof Error ? err.message : String(err)}) — the file may need manual removal.`,
        );
      }
    }
  }
}

/**
 * Set up the per-session HYBRID gate runtime (story 034 wiring): allocate a verified-free loopback
 * port, start the fail-closed `PreToolUse` hook server with the REAL story-033 decider chain, and
 * write the per-session scratch settings file the spawn consumes via `--settings "<file>"`.
 *
 * ORDERING CONTRACT (GATE_FINDINGS blocker c): the caller MUST `await setupSessionGate(...)` and
 * pass {@link SessionGate.settingsPath} to the spawn BEFORE the claude PTY is spawned — claude reads
 * settings only at startup, so a late write misses the first tool call. After the spawn the caller
 * binds the authoritative session id ({@link SessionGate.bindSession}) and the live PTY
 * ({@link SessionGate.bindPty}), and disposes via {@link SessionGate.teardown} on session teardown
 * AND PTY exit (idempotent).
 *
 * On a setup failure (port exhaustion, bind error, settings write error) the promise REJECTS with
 * everything already cleaned up — the caller fails the session creation LOUDLY rather than spawning
 * an ungated claude that LOOKS gated (the blocker-b hazard). `FORK_GATE=off` is the escape hatch.
 */
export async function setupSessionGate(opts: SessionGateOptions): Promise<SessionGate> {
  const gate = new SessionGateImpl(opts);
  await gate.start();
  return gate;
}
