import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthMethod,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallContent,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  LogoutRequest,
  LogoutResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  AvailableCommand,
} from "@agentclientprotocol/sdk";
import {
  deleteSession,
  getSessionInfo,
  listSessions,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionUpdate,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { SettingsManager } from "./settings.js";
import {
  applyTaskCreate,
  applyTaskUpdate,
  ClaudePlanEntry,
  parseTaskCreateOutput,
  parseTaskListOutput,
  parseTaskUpdateOutput,
  applyTaskList,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, unreachable } from "./utils.js";
// === SEAM(011): engine boundary — inject a temporary no-op engine so the agent
// boots without the cut SDK query() path; the real PTY engine arrives in 013–015/023.
// See fork/SEAM-MAP.md (createSession/prompt CUT→023) and src/engine.ts. ===
import { type Engine, createStubEngine } from "./engine.js";
// === SEAM(023) Group 1: the real PTY + JSONL-tail engine wiring for createSession.
// createSession spawns the subscription `claude` TUI under a PTY (story 013) managed by a
// per-session engine (story 014), tails its JSONL transcript (story 015) as the single source
// of truth, and locates that transcript by sessionId glob + reads the runtime cwd from inside
// it (story 015 jsonl.ts). NO SDK `query()` is on this path. See IMPLEMENTACAO-FORK-ACP §2/§5/§6.
import type { IPty } from "node-pty";
import { createSessionEngine, spawnResumePty, SessionEngine } from "./engine-lifecycle.js";
import type { SessionWatcher } from "./engine-lifecycle.js";
import { createJsonlWatcher } from "./engine-watcher.js";
import type { JsonlWatcher, GetMessages, SessionMessage } from "./engine-watcher.js";
import { resolveWatchTarget } from "./jsonl.js";
import type { LocateOptions } from "./jsonl.js";
import { linearizeTurns, readOrderedMessages, defaultGetMessages } from "./linearize.js";
import { createDiffEnrichedReader } from "./diff-enriched-reader.js";
import type { DiffEnrichedReaderOptions } from "./diff-enriched-reader.js";
import {
  sourceSubagentRows,
  defaultListSubagents,
  defaultGetSubagentMessages,
  hasSubagentSpawn,
  spawnIdsOpen,
} from "./subagent-source.js";
import type { ListSubagents, GetSubagentMessages } from "./subagent-source.js";
import {
  collectSidechainToolUses,
  registerSidechainGateToolUses,
  type SidechainToolUse,
} from "./subagent-gate.js";
import { createSubagentWatcher } from "./subagent-watcher.js";
import type { SubagentWatcher } from "./subagent-watcher.js";
import { classifyDiffSource, diffToolCallUpdate } from "./diff-source.js";
import { guardEvent } from "./billing/entrypoint-guard.js";
import type { WatchedMessage } from "./billing/entrypoint-guard.js";
import { usageUpdatesFor, type UsageCarrier } from "./usage.js";
import { createTurnResolver } from "./end-of-turn.js";
import type { DetectorSchedule, EndOfTurnDetector } from "./end-of-turn.js";
import { sendPrompt } from "./engine-pty.js";
import {
  MODEL_CONTEXT_WINDOWS,
  MODEL_ID_CONTEXT_WINDOWS,
  modelSelectorDescription,
  DEFAULT_MODEL_INFO,
  resolveCatalogValueFromModelId,
  isFastModeCapableModel,
  classifyFastModeSignal,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  createFastModeConfigOption,
  clientSupportsBooleanConfigOptions,
  resolveFastModeEnabled,
  ULTRACODE_EFFORT,
  ULTRACODE_EFFORT_LEVEL,
  ULTRACODE_EFFORT_LABEL,
} from "./model-catalog.js";
import { resolveModelCatalog } from "./live-model-catalog.js";
// Story 060 (R2.2/R2.3/R3.2) — the declarative spawn-time complement to the live ultracode keyword:
// toggle the {ultracode,ultracodeKeywordTrigger} keys in the gate's per-session scratch settings file
// (preserving the hook + every other key). Lives in the gate's settings-writer so it reuses durableWrite.
import { applyUltracodeSettings } from "./gate/settings-writer.js";
import { discoverAgents, type AgentCatalogEntry } from "./agent-catalog.js";
// Story 063 (R1) — OFFLINE disk discovery of the `available_commands` set (custom slash-commands +
// skills + enabled-plugin surfaces + built-ins), keyed on the session cwd. Populates the
// `available_commands_update` the session emits at creation in place of the old unconditional `[]`.
import { discoverCommands } from "./command-catalog.js";
import { setupSessionGate } from "./permissions/gate-wiring.js";
import type { GatePty, SessionGate, SessionGateOptions } from "./permissions/gate-wiring.js";
// Story 057 / Task 2.3 — MCP scratch-file lifecycle (translate ACP servers → claude `--mcp-config`
// JSON, durable 0600 write, idempotent teardown removal). Mirrors the gate's settings-scratch
// lifecycle: written BEFORE spawn, threaded as a flag, removed on failure + teardown — with the added
// re-spawn regeneration (R2.4). The module never logs the scratch contents/path-with-secrets (R2.3).
import { translateMcpServers, writeMcpScratch, removeMcpScratch } from "./mcp-config-writer.js";
import { materializeImage, cleanupMaterializedImages } from "./image-input.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/**
 * Task 3.2 (#984) — the ISO 8601 form of a `getSessionInfo` record's `lastModified` (epoch ms), or
 * `undefined` when the record carries no usable one.
 *
 * Total by construction, and that is the whole point: `new Date(x).toISOString()` THROWS on an
 * out-of-range value, and its only caller runs inside a catch that swallows — so an unguarded
 * conversion would not surface a bad timestamp, it would silently drop the entire title push.
 * Missing / NaN / out-of-range therefore degrades to "no timestamp" (ACP's `updatedAt` is optional),
 * never to "no title".
 *
 * All three checks earn their place. `Number.isFinite` (unlike the global `isFinite`) does NOT
 * coerce, so it rejects NaN, ±Infinity and anything a loosely-typed fake passes that is not a
 * number — but it does not narrow the type, which is what the `undefined` test is for. And finite
 * is not the same as representable: `new Date(1e20)` takes a finite input and yields Invalid Date,
 * whose `toISOString()` is exactly the throw this function exists to prevent.
 */
function isoLastModified(lastModified: number | undefined): string | undefined {
  if (lastModified === undefined || !Number.isFinite(lastModified)) return undefined;
  const at = new Date(lastModified);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

export const DEFAULT_CONTEXT_WINDOW = 200000;

type Session = {
  // === SEAM(023) Group 1: PTY-backed session record (migrated OFF the SDK Query, story C9). ===
  /** The live PTY handle (story 013/014) running the subscription `claude` TUI for this session. */
  pty: IPty;
  /**
   * The per-session JSONL tail watcher (story 015); the single source of truth for state (§2).
   * OPTIONAL (story 028, sub-task 2.1): a FRESH session returns BEFORE its transcript exists, so the
   * watcher is armed later — out of band — once the transcript appears on the user's first
   * interaction. It is `undefined` between create and that first appearance.
   */
  watcher?: JsonlWatcher | SessionWatcher;
  /** Emit-once guard: uuids already surfaced to the client (Group 2 wires the pump that fills it). */
  emitted: Set<string>;
  /**
   * Story 041 (R2.3) — emit-once guard for NESTED sub-agent (sidechain) rows, kept PARALLEL to and
   * DECOUPLED from `emitted`. The nested pass dedups per sub-agent row uuid here so a late-arriving
   * sidechain row still emits after its spawning turn's uuid is already in `emitted` (the parent turn
   * was surfaced in an earlier pump). Per-session — sub-agent row uuids are session-scoped.
   */
  emittedNested: Set<string>;
  /**
   * Story 056 (#812) — the last session title pushed to the client via `session_info_update` at the
   * story-024 turn boundary. Used to DEDUP: `emitSessionTitleUpdate` skips the push when the freshly
   * sanitized `getSessionInfo().summary` equals this. Undefined until the first non-empty title is
   * pushed; per-session (titles are session-scoped).
   */
  lastEmittedTitle?: string;
  /** Story 054 — per-session dedup Set of sidechain inner tool_use ids already fed to the gate
   *  correlator (R3 exactly-once). Lazy-init on the gated pump path; absent on a no-gate session. */
  registeredSidechain?: Set<string>;
  /** Story 054 — maps a sidechain inner tool_use id → its SidechainToolUse (parentId/toolName/
   *  toolInput), for the decide()-time parent-Task dialog relay (Tasks 3/4). */
  sidechainParentMap?: Map<string, SidechainToolUse>;
  /** The managed engine that owns the PTY + watcher; used for idempotent teardown (story 014). */
  engine?: SessionEngine;
  cancelled: boolean;
  cwd: string;
  /**
   * Story 057 (R1.3) — the RESOLVED additional-directory list for this session (the request's
   * `additionalDirectories`, else `_meta.additionalRoots`, else `[]`), stored so sub-task 2.3's
   * {@link respawnSession} can re-thread the SAME `--add-dir` scope into the in-place re-spawn. This
   * is the RAW list (per-dir sanitization is the engine's job); absent on pre-057 / replay records.
   */
  additionalDirectories?: string[];
  /**
   * Story 057 (R2.3/R2.4, sub-task 2.3) — the CURRENT MCP scratch path ({@link writeMcpScratch})
   * threaded into this session's spawn as `--mcp-config "<file>"`. Retained so {@link teardownSession}
   * can REMOVE it (R2.3, no orphan/secret leak) and {@link respawnSession} can REGENERATE it (R2.4:
   * write-new-then-remove-old, swapping this to the new path). Absent when the session declared no
   * MCP servers (and on replay-only records, which spawn nothing).
   */
  mcpConfigFile?: string;
  /**
   * Story 057 (R2.4, sub-task 2.3) — the RAW ACP `mcpServers` array the client declared at create
   * time, retained so {@link respawnSession} can RE-translate ({@link translateMcpServers}) and
   * regenerate the scratch for the re-spawned `claude`. (The translation output is not stored —
   * re-translating from the source keeps the regenerated scratch faithful to the original request.)
   * Absent/empty when no MCP servers were declared.
   */
  mcpServers?: NewSessionRequest["mcpServers"];
  /** Serialized snapshot of session-defining params (cwd, mcpServers, additionalDirectories) used to
   *  detect when loadSession/resumeSession is called with changed values. */
  sessionFingerprint: string;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  modes: SessionModeState;
  modelInfos: ModelInfo[];
  /**
   * Upstream #1165: whether this session may offer/enter `bypassPermissions` — {@link ALLOW_BYPASS}
   * AND not disabled by `permissions.disableBypassPermissionsMode` ({@link sessionAllowsBypass}).
   * Decided once at createSession; the model-change catalog rebuild reads it. Absent (hand-built
   * test sessions) falls back to the process-wide {@link ALLOW_BYPASS}.
   */
  allowBypass?: boolean;
  /**
   * Story 056 (R3.2) — the main-thread agent personas discovered for this session's cwd at
   * create time ({@link discoverAgents}, glob-only). Stored so the model-change reconcile in
   * {@link setSessionConfigOption} can REBUILD the `agent` configOption without re-globbing the
   * disk. The CURRENT agent is NOT held here — it lives in the `agent` configOption's
   * `currentValue` (mirroring `currentEffort`); `[]`/absent means no personas were discovered and
   * the `agent` option is omitted entirely (upstream #794 `agents.length > 0` gate).
   */
  agents?: AgentCatalogEntry[];
  configOptions: SessionConfigOption[];
  /** Context window size for the session, carried across prompts so mid-stream
   *  usage_update notifications report a correct `size` before the turn's first
   *  result message arrives. Seeded by `inferContextWindowFromModel` (the static
   *  `MODEL_CONTEXT_WINDOWS` curation) and re-resolved when the user switches the
   *  session's model. NOTE (story 068): there is NO `result.modelUsage` refresh —
   *  the JSONL `usage` block carries only token counts, never a window; the window
   *  comes from static curation (the Models API `max_input_tokens` is the real
   *  authority, which this PTY/JSONL fork does not call). */
  contextWindowSize: number;
  /** Accumulated task list for the session, keyed by task ID. Task IDs are
   *  per-session, so this state must not be shared across sessions. */
  taskState: TaskState;
  /** Per-session tool_use cache so the pump's tool_call→tool_call_update lifecycle stays correct
   *  across LIVE re-reads (story 023 Groups 2-3). Per-session — tool_use ids are session-scoped. */
  toolUseCache: ToolUseCache;
  /** Set once the §10 billing guard-rail (story 022) has inspected the first batch (Group 4.1). */
  guardChecked: boolean;
  /** Story 025 (R3.3, R8) — latched true once the client rejects a usage_update; suppresses all
   *  further usage_update emission for the session (the surrounding stream keeps flowing). */
  usageDisabled: boolean;
  /**
   * Story 030 (R5.1) — the in-flight turn's end-of-turn detector for the current `session/prompt`.
   * `prompt()` sets it (via {@link createTurnResolver}) for the duration of one turn so the live pump
   * can feed raw JSONL messages to it and the cancel path can reach it; cleared in `prompt()`'s
   * `finally`. The detector — never the writer — resolves the pending prompt (R5.1).
   */
  turnDetector?: EndOfTurnDetector;
  /**
   * Story 031 (R2.1, R2.2) — the in-flight turn's cancel handle from {@link createTurnResolver}.
   * `prompt()` sets it for the turn's duration so the cancel path resolves the pending prompt as
   * `cancelled` through the story-024 latch; cleared in `prompt()`'s catch + finally. Undefined when
   * no turn is in flight (cancel is then a no-op).
   */
  turnCancel?: () => void;
  /**
   * Story 030 (R5.1) — per-session high-water cursor into the monotonic ordered superset
   * {@link readOrderedMessages} returns, so each raw message is fed to {@link turnDetector} exactly
   * once and a prior turn's terminal boundary is never re-observed.
   */
  detectorCursor?: number;
  /**
   * Story 046 (R1.3, design §5/§9) — a model-switch (`/model <alias>`) requested WHILE a turn is in
   * flight is deferred here (last-write-wins, §9 coalescing) and flushed as a side-channel PTY write
   * once the turn settles (prompt()'s finally → {@link flushPendingControlInjections}). Undefined when
   * nothing is queued.
   */
  pendingModelInjection?: string;
  /**
   * Story 056 v4 — an effort change (`/effort <level>`) requested WHILE a turn is in flight is deferred
   * here (last-write-wins) and flushed as a side-channel PTY write once the turn settles (mirrors
   * {@link pendingModelInjection}). Undefined when nothing is queued.
   */
  pendingEffortInjection?: string;
  /**
   * Story 060 (R2.1/R2.2) — true WHILE the "ultracode" effort-selector sentinel is selected for this
   * session. The LIVE activation it drives is a keyword prefix on the OUTGOING prompt (the binary's
   * documented per-turn Workflow opt-in) — Option A, no re-spawn. Cleared when a real effort level (or
   * `default`) is re-selected. The declarative spawn-time complement is {@link applyUltracodeSettings}.
   */
  ultracodeActive?: boolean;
  /**
   * Story 073 (R2.3/R3.2) — the session's CURRENT fast-mode on/off state (default off). Set by
   * {@link applyFastModeChange} and read by {@link buildConfigOptions} for the `fast` option's
   * `currentValue`. Reset to `false` on a switch away from an Opus model (R4.1).
   */
  fastModeOn?: boolean;
  /**
   * Story 073 (R1.3) — cached fast-mode availability for this session (the {@link FastModeProbe}
   * result). `undefined` = not yet probed; `false` = unavailable/non-Opus (option omitted); `true` =
   * available (option advertised). Re-probed on a return to an Opus model (R4.2).
   */
  fastModeAvailable?: boolean;
  /**
   * Story 073 (R3.1) — a `/fast on|off` inject requested WHILE a turn is in flight is deferred here
   * (last-write-wins) and flushed once the turn settles (mirrors {@link pendingEffortInjection}).
   */
  pendingFastInjection?: boolean;
  /**
   * Story 046 (R3.8) — true WHILE an in-place re-spawn (R3.4 dontAsk/bypass switch) is between the old
   * PTY teardown and the new PTY being ready. Selector changes arriving in this window are rejected
   * rather than written to a dead PTY.
   */
  respawning?: boolean;
  /**
   * Story 046 (R3.4 LIVE FIX) — true once the session's transcript has materialised (the watcher armed
   * and pumped at least once, i.e. the FIRST interaction happened). An in-place re-spawn reattaches via
   * `claude --resume <id>`, which needs that transcript to exist; before it, --resume falls back
   * (buildResumeArgv `|| claude`) to a NEW untracked id and stalls. {@link respawnSession} refuses while
   * this is falsy — a boot-time default_config_options dontAsk/bypass stays at the fresh spawn's mode
   * until the user sends the first prompt.
   */
  interacted?: boolean;
  /**
   * Story 034 (§9 / R3.3) — the per-session HYBRID permission-gate runtime: loopback `PreToolUse`
   * hook server + scratch `--settings` backup + `tool_use.id` correlator. Present only when the
   * gate is enabled AND the session spawned fresh (resume/replay paths carry no gate). The live
   * pump REGISTERS every JSONL `tool_use` id into `gate.correlator`; `teardownSession` and the PTY
   * `onExit` hook both call `gate.teardown()` (idempotent).
   */
  gate?: SessionGate;
  /**
   * Story 044 (R2.2/R2.3) — the per-session Option-B sub-agent watcher: polls the story-041 SDK
   * sidechain readers while a `Task`/`Agent` spawn is OPEN on the main chain, feeding turn liveness
   * + the incremental nested render. Armed by the pump ONLY while such a spawn is open AND the
   * `liveSubagentWatch` flag is ON; stopped when every spawn id closes (R2.2), when the turn ends
   * (prompt finally), and on session teardown (R2.3). Undefined whenever no watcher is armed.
   */
  subagentWatcher?: SubagentWatcher;
  /**
   * Story 044 (R3.1) — the latest main chain the pump read. The watcher's `onActivity` re-emits
   * from it, so an incremental nested render needs NO main-chain re-read: the sidechain rows are
   * sourced fresh inside `emitLinearizedWithNested`; the main chain is whatever the last pump saw.
   */
  lastMessages?: SessionMessage[];
  /**
   * Story 058 (R2.1/R2.2) — the temp image files materialized for the in-flight turn (pushed by
   * {@link promptToClaude}'s sink when the prompt is assembled, BEFORE it is sent), unlinked at turn
   * settle (prompt()'s catch + finally, covering resolve AND cancel) via {@link cleanupMaterializedImages}
   * and again on teardown as an idempotent backstop. Undefined when the turn materialized no image.
   */
  turnTempImagePaths?: string[];
};

// === SEAM(023) Group 1: the createSession injection seam ======================================
//
// Tests must drive createSession WITHOUT spawning the real `claude` binary or touching ~/.claude.
// `StartEngine` is the single seam: it spawns the PTY engine (story 013/014), starts the JSONL tail
// watcher (story 015), locates the transcript by sessionId glob, and reads the runtime cwd from
// inside it (story 015 jsonl.ts). It defaults to {@link defaultStartEngine} (the production wiring);
// tests inject a fake that returns sentinel handles. The watcher's `onEvent` pump does NOT exist in
// Group 1 — Group 2 wires it; here onEvent is a no-op placeholder.

/** What {@link StartEngine} returns: the authoritative session id (engine-spawn-generated for a
 *  fresh session, the resumed id otherwise), the live PTY, the started watcher, the owning engine,
 *  and the runtime cwd discovered from inside the JSONL (may be undefined until the first line). */
export interface StartedEngine {
  sessionId: string;
  pty: IPty;
  /**
   * The started watcher. OPTIONAL (story 028, sub-task 2.1): the FRESH path now returns BEFORE the
   * transcript exists, so it returns `watcher: undefined` and arms the watcher in the background
   * once the transcript appears (it sets `engine.watcher` then). The RESUME path still returns the
   * armed watcher synchronously.
   */
  watcher?: JsonlWatcher | SessionWatcher;
  engine?: SessionEngine;
  cwd?: string;
}

/** Arguments passed to {@link StartEngine}. `sessionId` is the requested id for resume/fork; for a
 *  fresh session it is undefined and the engine's spawn generates the authoritative id. */
export interface StartEngineArgs {
  /** Requested session id (resume/fork). Undefined for a fresh session (engine generates it). */
  sessionId?: string;
  /** Host working directory the TUI spawns in. */
  cwd: string;
  /** True when reattaching to a prior session (story 014 robust resume argv). */
  resume?: boolean;
  /** Base environment to sanitize (defaults to process.env in the production wiring). */
  baseEnv?: Record<string, string | undefined>;
  /** The live session registry the engine registers into / deletes from on cleanup. */
  sessions?: Map<string, SessionEngine>;
  /**
   * Group 2 pump trigger: invoked with the RESOLVED session id on every watcher signal so the
   * tail-driven update pump re-reads the JSONL and emits. Absent in pure-spawn unit tests.
   */
  onEvent?: (sessionId: string) => void;
  /**
   * Story 027 (live-acceptance regression): Degrau-1 read-only loadSession path. When true, the
   * engine LOCATES the existing transcript for replay but does NOT spawn a live `claude --resume`
   * (no PTY, no tail watcher, no live engine). A live resume would (a) re-emit the whole history
   * through the tail pump (double render in the Agent Panel) and (b) run with the fork process cwd
   * (≠ the session cwd), writing a duplicate-basename transcript that makes the sessionId glob
   * ambiguous → resourceNotFound on the next load. Default false: fresh/resume spawn is unchanged.
   */
  replayOnly?: boolean;
  /**
   * Story 028 (sub-task 2.1): injectable node-pty spawn. Forwarded to {@link createSessionEngine}
   * (fresh) and {@link spawnResumePty} (resume) so a test can drive the REAL {@link
   * defaultStartEngine} without launching a real `claude` TUI. Production passes nothing → the real
   * `pty.spawn`.
   */
  spawn?: typeof import("node-pty").spawn;
  /**
   * Story 028 (sub-task 2.1): injectable transcript-discovery seams (glob/clock/etc.) forwarded to
   * the internal {@link resolveWatchTarget} calls so a test injects ONLY the `glob` (and, in a Red
   * probe, a finite `watchdogMs`) without re-masking the bug by stubbing discovery wholesale. On the
   * FRESH path the internal `watchdogMs: Infinity` and `signal` are applied AROUND this (signal last,
   * so the cancellation handle always wins). Production passes nothing → real glob + real clock.
   */
  locateOptions?: LocateOptions;
  /**
   * Story 034 (§9 hybrid gate): the per-session SCRATCH settings file (story-032 `injectHook`)
   * carrying the fork's `PreToolUse` hook, appended to the FRESH spawn as `--settings "<file>"`.
   * Already written BEFORE startEngine is called (blocker c ordering). Absent → ungated spawn.
   * Fresh-path only — mirroring the story-029 `planMode` precedent, the resume argv
   * (`buildResumeArgv`) is NOT extended here; the replay-only load path spawns nothing.
   */
  settingsFile?: string;
  /**
   * Story 046 (R3.2, choose-before-start): the seeded permission mode, forwarded to the spawn as
   * `--permission-mode <mode>` (non-"default" only). Threaded to BOTH the fresh ({@link
   * createSessionEngine}) and resume ({@link spawnResumePty}) paths so the R3.4 re-spawn carries it too.
   */
  permissionMode?: string;
  /**
   * Story 046 (R2.2): the seeded/re-spawn reasoning effort, forwarded to the spawn as `--effort
   * <level>` (non-"default" only). Threaded to BOTH the fresh and resume spawn paths.
   */
  effortLevel?: string;
  /**
   * Story 056 (R3.2): the seeded/re-spawn main-thread agent persona, forwarded to the spawn as
   * `--agent "<name>"` (non-"default" only — the spawn layer drops the literal "default" sentinel,
   * exactly like `--effort`/`--permission-mode`). Threaded to BOTH the fresh ({@link
   * createSessionEngine}) and resume ({@link spawnResumePty}) paths so the agent-selecting re-spawn
   * carries it. The persona name is allowlist-safe at the catalog boundary ({@link discoverAgents}).
   */
  agent?: string;
  /**
   * Story 046 (R3.4 LIVE FIX): this resume is an IN-PLACE re-spawn ({@link respawnSession} for a
   * dontAsk/bypass mode or an effort change), NOT a fork/resume of an already-lived session. An
   * in-place re-spawn can fire BEFORE the first interaction (e.g. a boot-time `bypassPermissions`
   * switch driven by Zed's `default_config_options`), when the re-spawned `claude` has NOT written its
   * transcript yet. So this branch DEFERS discovery like the fresh path (`watchdogMs: Infinity`,
   * arm-on-appearance) instead of the resume default's 2000ms FATAL watchdog — which would otherwise
   * throw not-found and stall the next turn until the 120s turn watchdog. The fork/resume path (flag
   * absent) keeps its blocking 2000ms watchdog (R2.1, resume-discovery-unchanged.test.ts).
   */
  inPlaceRespawn?: boolean;
  /**
   * Story 057 (R1.3/R3.1): the RESOLVED additional-directory list (session `additionalDirectories`,
   * else `_meta.additionalRoots`), forwarded to BOTH the fresh ({@link createSessionEngine}) and
   * resume ({@link spawnResumePty}) spawn paths so a re-spawn re-threads it. Each safe entry becomes
   * one `--add-dir "<dir>"` on the interactive TUI argv; sanitization (per-dir drop of unsafe paths)
   * is the ENGINE's job ({@link buildAddDirFlags}/`isSafeDir`, sub-task 1.1), so the list threaded
   * here is RAW. ALWAYS-ON (no `FORK_*` opt-in gate, R3.1). Interactive-only — never on a `-p`/
   * `stream-json` invocation (the fork has no headless path).
   */
  additionalDirectories?: string[];
  /**
   * Story 057 (R2.2/R2.3, sub-task 2.3): the fork-controlled uuid-namespaced MCP scratch path
   * ({@link writeMcpScratch}), forwarded to BOTH the fresh ({@link createSessionEngine}) and resume
   * ({@link spawnResumePty}) spawn paths and emitted as `--mcp-config "<file>"` (never `--strict` —
   * R2.2 MERGE: claude folds these servers IN alongside any project/user `.mcp.json` rather than
   * replacing them). Written BEFORE the spawn — claude reads it at startup, exactly like
   * {@link settingsFile}, so it gates the first MCP use. ALWAYS-ON (no `FORK_*` gate); present only
   * when the session declared ≥1 MCP server. The scratch may carry MCP auth headers/env (0600 +
   * never logged, R2.3); the caller removes it on teardown ({@link removeMcpScratch}) and regenerates
   * it on re-spawn ({@link respawnSession}, R2.4).
   */
  mcpConfigFile?: string;
}

/** The createSession injection seam: spawn the PTY engine + JSONL watcher + locate the transcript. */
export type StartEngine = (args: StartEngineArgs) => Promise<StartedEngine> | StartedEngine;

/** Context passed to a {@link FastModeProbe}: enough to drive/observe the live PTY when the real
 *  detector is wired (story 073 Task 1), without exposing the private `Session` type. */
export interface FastModeProbeContext {
  pty: IPty;
  cwd: string;
}

/**
 * Story 073 (R1) — the fast-mode availability-detection seam. Returns whether fast mode (`/fast`) is
 * available for THIS session's account. The production default {@link defaultFastModeProbe} fails CLOSED
 * (returns `false`): the live spike (Task 1) found that OBTAINING the signal requires DRIVING `/fast`
 * over the PTY (there is no passive signal when gated — verified live), and an unsolicited session-start
 * PTY write violates the fork's read-only-load (R4.3) and no-Ctrl+U-in-closed-loop invariants. The live
 * driver therefore ships as the OPT-IN {@link driveFastModeProbe} (wired via `deps.fastModeProbe` after
 * the R7.3 live-proof), not as the default. Tests inject a fake returning `true` to exercise the
 * advertise/apply/reconcile paths (R2–R4).
 */
export type FastModeProbe = (ctx: FastModeProbeContext) => Promise<boolean> | boolean;

/** Production default — fail-closed (R1.2), invariant-safe: performs NO PTY write, so it preserves the
 *  read-only-load (R4.3) and no-unsolicited-Ctrl+U invariants. The live signal is characterized (see
 *  {@link classifyFastModeSignal}) and the live driver is {@link driveFastModeProbe}; wiring it as the
 *  default is deferred to the R7.3 live-proof + a non-intrusive (idle-gated) wiring follow-up. */
export const defaultFastModeProbe: FastModeProbe = () => false;

/** Story 073 (R1) — bounded window the live driver waits for the `/fast` panel to render before failing
 *  closed, polled every {@link FAST_PROBE_POLL_MS}. Generous because at session start the TUI needs a
 *  beat to become input-ready. While still pending, the `/fast` inject is re-sent every
 *  {@link FAST_PROBE_REINJECT_MS} — a session-start TUI can swallow the first inject before it is
 *  input-ready (the createSession race the R7.3 live-proof surfaced), so a single inject would miss it. */
const FAST_PROBE_WINDOW_MS = 6000;
const FAST_PROBE_POLL_MS = 150;
const FAST_PROBE_REINJECT_MS = 2000;

/**
 * Story 073 (R1) — the OPT-IN live fast-mode detector (Task 1 spike + Task 3.1 parser). Opens the
 * `/fast` panel via the SAME live PTY inject as `/effort` (no re-spawn, no `-p`/credit path — R3.3),
 * collects the panel text on a temporary onData listener, classifies it with {@link classifyFastModeSignal},
 * then writes Esc to dismiss the panel. Fails CLOSED (returns `false`) on timeout, a broken/dead PTY, or
 * any throw (R1.2).
 *
 * NOT the production default: it writes to the PTY at probe time, which is safe only when the input box
 * is idle. Wiring it as {@link defaultFastModeProbe} would break the read-only-load (R4.3) and
 * no-Ctrl+U-in-closed-loop invariants (an unsolicited session-start write). It is exported so it can be
 * injected via `deps.fastModeProbe` once the R7.3 live-proof validates it on a fast-available account and
 * a non-intrusive (idle-gated) wiring lands. The pure classifier it delegates to IS unit-tested against
 * the spike's live capture; this thin live-drive glue is exercised offline via a fake signal-emitting pty.
 */
export const driveFastModeProbe: FastModeProbe = async ({ pty }) => {
  let sub: { dispose(): void } | undefined;
  try {
    let buffer = "";
    sub = pty.onData((d) => {
      buffer += d;
    });
    // Open the panel with the SAME seam every live inject uses (Ctrl+U clear + `/fast` + \r). Safe ONLY on
    // an idle input box; interactive-only, so billing is untouched (R3.3).
    const openPanel = () => {
      sendPrompt(pty, "/fast", (fn) => fn());
    };
    openPanel();
    const deadline = Date.now() + FAST_PROBE_WINDOW_MS;
    let nextReinject = Date.now() + FAST_PROBE_REINJECT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, FAST_PROBE_POLL_MS));
      const verdict = classifyFastModeSignal(buffer);
      if (verdict === "available") return true;
      if (verdict === "unavailable") return false;
      // "pending" → the panel has not rendered a decisive line yet. A session-start TUI may have swallowed
      // the inject before it was input-ready, so re-open periodically until it takes. We ONLY re-inject
      // while pending (no panel rendered), so an already-open panel is never disturbed.
      if (Date.now() >= nextReinject) {
        openPanel();
        nextReinject = Date.now() + FAST_PROBE_REINJECT_MS;
      }
    }
    return false; // window elapsed without a decisive panel → fail closed (R1.2)
  } catch {
    return false; // dead/broken PTY or any inject error → fail closed (R1.2)
  } finally {
    try {
      pty.write("\x1b"); // Esc — dismiss the `/fast` panel (raw escape, NEVER via sendPrompt — GOTCHA)
    } catch {
      /* pty already gone — nothing to dismiss */
    }
    try {
      sub?.dispose();
    } catch {
      /* listener already disposed */
    }
  }
};

/**
 * No-op {@link IPty} stub for the Degrau-1 replay-only load path: there is no live `claude` process,
 * but the session record's `pty` field is typed `IPty`. Every method is inert — teardown's `kill()`
 * is a no-op and a read-only load never writes/resizes it.
 */
const REPLAY_ONLY_NOOP_PTY = {
  onExit: () => ({ dispose() {} }),
  onData: () => ({ dispose() {} }),
  resize() {},
  write() {},
  kill() {},
} as unknown as IPty;

/** Optional bundle of injectable dependencies for {@link ClaudeAcpAgent} (Degrau-1 PTY engine). */
export interface AgentDeps {
  /** Override the PTY-engine + JSONL-watcher start (production default: {@link defaultStartEngine}). */
  startEngine?: StartEngine;
  /** Override the live JSONL reader the pump re-reads on each signal (default: SDK getSessionMessages). */
  getMessages?: GetMessages;
  /**
   * Story 041 — override the sidechain readers the pump sources nested sub-agent rows from
   * (defaults: SDK `listSubagents` / `getSubagentMessages` via {@link defaultListSubagents} /
   * {@link defaultGetSubagentMessages}). Injected by the deterministic unit tests as stubs/spies.
   */
  listSubagents?: ListSubagents;
  getSubagentMessages?: GetSubagentMessages;
  /**
   * Story 025 / Task 3.1 (R3.1) — opt IN to the UNSTABLE `usage_update` notification. Defaults
   * OFF: the pump constructs and emits no usage_update at all, so the session/update stream is
   * byte-for-byte unaffected. Kept OFF in production until the live-Zed acceptance probe
   * (Task 3.3, R8) confirms the user's Zed tolerates it.
   */
  usageUpdate?: boolean;
  /**
   * Story 043 (R2.1/R2.2/R5.1) — opt IN to the live Edit/Write diff. When ON, `this.getMessages` is
   * wrapped in the diff-enriched reader (getSessionMessages + uuid→`toolUseResult` hydration), which
   * restores the story-021 structuredPatch diff on BOTH the live pump and the session/load replay
   * (both read `this.getMessages` once). Defaults OFF at THIS constructor seam (the story-038
   * `usageUpdate` two-layer pattern) so directly-constructed test agents get the byte-for-byte pre-043
   * reduced reader for determinism; the entrypoint (index.ts) is what defaults it ON (LIVE_DIFF, ON
   * unless `LIVE_DIFF=0`/`false`). OFF → byte-for-byte the pre-043 reduced reader (R5.1).
   */
  liveDiff?: boolean;
  /**
   * Story 043 — test seam: the injectable {@link DiffEnrichedReaderOptions} forwarded to the
   * diff-enriched reader when `liveDiff` is ON, so a unit test drives the reader's
   * `findTranscript`/`readRawLines` deterministically WITHOUT touching the real `~/.claude` transcript
   * tree (without it the pump-integration test would hit the real filesystem). Production passes
   * nothing → the reader uses its billing-free `~/.claude` glob + `fs` read defaults.
   */
  diffEnrichOptions?: DiffEnrichedReaderOptions;
  /**
   * Story 044 (R4.1/R4.2) — opt IN to the live sub-agent watcher: the Option-B 2nd watcher that
   * POLLs the SDK sidechain readers while a turn is in flight, feeding the story-024 detector's
   * `noteActivity()` seam + the incremental nested render so a long-running sub-agent (rows in
   * subagents/*.jsonl, MAIN transcript silent) no longer false-stalls the turn watchdog. Defaults
   * OFF at THIS constructor seam (the story-038 `usageUpdate` two-layer pattern) so
   * directly-constructed test agents arm no 2nd watcher for determinism; the entrypoint (index.ts)
   * is what defaults it ON (FORK_LIVE_SUBAGENT_WATCH, ON unless "0"/"false"). OFF → byte-for-byte
   * today's pull-only path: NO 2nd watcher armed (R4.2).
   */
  liveSubagentWatch?: boolean;
  /**
   * Story 030 (R1.2, R5.1) — the single timer seam shared by `sendPrompt` (the §8 write→\r delay)
   * and `createTurnResolver` (the detector's Δt + watchdog). Injecting ONE schedule lets a unit test
   * drive both with one fake clock. Defaults to a `setTimeout`/`clearTimeout` wrapper.
   */
  schedule?: DetectorSchedule;
  /**
   * Story 031 (R1.2) — the short LOCAL escalation window (ms) between cancel-ladder rungs:
   * Ctrl+C → wait → Esc → wait → kill. DISTINCT from the 5583 ms turn watchdog (story 024), which
   * is NOT re-derived here. Injected so a unit test drives the ladder with a fake clock; defaults to
   * a conservative production value. Live in-Zed cancel tuning is out of scope (story 031).
   */
  cancelEscalationMs?: number;
  /**
   * Story 034 (§9 / R3.3) — enable the per-session HYBRID permission gate wiring: free loopback
   * port + `PreToolUse` hook server + scratch `--settings` inject on every FRESH spawn, with the
   * decider raising ACP `session/request_permission` correlated by `tool_use.id`. Resolved by the
   * production bootstrap (index.ts) from `FORK_GATE` — ON unless `FORK_GATE=off` (the v1 policy is
   * the hybrid gate, PERMISSIONS.md §1; the env var is the diagnostic escape hatch). Defaults OFF
   * at THIS constructor seam (the story-038 `usageUpdate` two-layer pattern) so directly-constructed
   * test agents spin no servers and write no files unless they opt in.
   */
  gate?: boolean;
  /**
   * Story 034 — gate timing/placement knobs forwarded to {@link setupSessionGate} (correlation
   * wait, #52822 sweep windows, scratch dir, port allocator). `client`/`onWarn` are agent-owned and
   * cannot be overridden. Tests inject short windows here; production passes nothing.
   */
  gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
  /**
   * Story 056 (R3.2) — override the main-thread agent-persona discovery `createSession` seeds the
   * `agent` configOption from (default: the glob-only {@link discoverAgents}). Injected by the unit
   * tests with an in-memory fake so the surface is exercised hermetically, never touching the real
   * `~/.claude/agents`. Production passes nothing → the real disk glob.
   */
  discoverAgents?: (cwd: string) => AgentCatalogEntry[];
  /**
   * Story 063 (R1/R1.1) — override the offline command discovery `sendAvailableCommandsUpdate` sources
   * the `available_commands_update` set from (default: the disk-only {@link discoverCommands}, keyed on
   * the session cwd). Injected by the wiring test with an in-memory fake so the surface is exercised
   * hermetically, never touching the real `~/.claude`. Production passes nothing → the real disk scan.
   */
  discoverCommands?: (cwd: string) => AvailableCommand[];
  /**
   * Story 056 (#812) — override the SDK session-metadata reader the end-of-turn `session_info_update`
   * push sources the title from (default: the pure {@link getSessionInfo} from the agent SDK, which
   * resolves the session's `summary` from its JSONL — custom title, auto-summary, or first prompt).
   * Injected by the unit tests with an in-memory fake so the push is exercised hermetically, never
   * touching the real `~/.claude` transcript tree. Production passes nothing → the real SDK reader.
   *
   * Task 3.2 (#984): the push reads the record's `lastModified` as well, published as ACP
   * `updatedAt`. OPTIONAL here even though the SDK's own `SDKSessionInfo` always sets it — an
   * injected fake may legitimately supply a summary alone, and {@link ClaudeAcpAgent} treats a
   * missing timestamp as "no timestamp", never as a reason to withhold the title.
   */
  getSessionInfo?: (
    sessionId: string,
    options?: { dir?: string },
  ) => Promise<{ summary: string; lastModified?: number } | undefined>;
  /**
   * Story 073 (R1) — override the fast-mode availability probe (default: {@link defaultFastModeProbe},
   * which fails closed until the live spike wires the real detector). Tests inject a fake returning
   * `true`/`false` to exercise the toggle's advertise/apply/reconcile paths hermetically.
   */
  fastModeProbe?: FastModeProbe;
}

/**
 * Production default for the {@link StartEngine} seam. Spawns the subscription `claude` TUI under a
 * managed PTY engine (story 013/014), starts the read-only JSONL tail watcher (story 015) bound to
 * that PTY, then locates the transcript by sessionId glob and reads the runtime cwd from INSIDE it
 * (story 015 jsonl.ts; the cwd→dir encoding is irreversible, so we never decode the dir name).
 *
 * Fresh session: {@link createSessionEngine} spawns the PTY and generates the authoritative session
 * id internally (story 013) — that id becomes the session key. Resume/fork: {@link spawnResumePty}
 * reattaches to the requested id with the §5 robust-resume argv, wrapped in a {@link SessionEngine}.
 *
 * The watcher's `onEvent` is a no-op placeholder in Group 1 — the ACP pump that forwards new JSONL
 * messages to the client is Group 2. NO SDK `query()` is reachable here.
 */
export async function defaultStartEngine(args: StartEngineArgs): Promise<StartedEngine> {
  // Each watcher signal triggers the caller's pump (story 023 Group 2) with the RESOLVED session id;
  // the per-message payload is unused — the JSONL tail is the source, the signal just says "re-read".
  // `args.onEvent` is absent in pure-spawn unit tests, so the watcher is a no-op there.

  if (args.replayOnly && args.sessionId) {
    // === SEAM(027): Degrau-1 read-only loadSession is REPLAY-ONLY. LOCATE the existing transcript
    // for replay, but do NOT spawn `claude --resume`. A live resume would (a) re-emit the whole
    // history through the tail pump (double render in the Agent Panel) and (b) run with the fork
    // process cwd (≠ the session cwd), writing a duplicate-basename transcript that makes the
    // sessionId glob ambiguous → resourceNotFound on the next load. A missing/ambiguous transcript
    // throws here → createSession's resume catch maps it to resourceNotFound (unchanged client
    // contract). No PTY, no tail watcher, no live engine — the only emission is replaySessionHistory.
    const { cwd } = await resolveWatchTarget(args.sessionId, { ...args.locateOptions });
    return {
      sessionId: args.sessionId,
      pty: REPLAY_ONLY_NOOP_PTY,
      watcher: undefined,
      engine: undefined,
      cwd,
    };
  }

  if (args.resume && args.sessionId) {
    // Resume/fork: reattach to the requested id with the §5 robust-resume argv, then discover the
    // (already-existing) transcript by glob and tail it. The engine owns the PTY + watcher teardown.
    const handle = spawnResumePty({
      sessionId: args.sessionId,
      cwd: args.cwd,
      baseEnv: args.baseEnv,
      spawn: args.spawn,
      // Story 046 (R3.4/R2.2): the in-place re-spawn (dontAsk/bypass or an effort change) reattaches the
      // SAME sessionId carrying its mode/effort flags through the resume argv (buildResumeArgv).
      permissionMode: args.permissionMode,
      effortLevel: args.effortLevel,
      // Story 056 (R3.2): an agent-selecting re-spawn carries the persona through too (--agent).
      agent: args.agent,
      // Story 057 (R1.3/R3.1): re-thread the resolved additional-directory list so an in-place
      // re-spawn keeps the SAME `--add-dir` scope (this resume call also serves respawnSession).
      additionalDirectories: args.additionalDirectories,
      // Story 057 (R2.2/R2.4): re-thread the CURRENT MCP scratch path so the re-spawned `claude`
      // carries `--mcp-config "<file>"`; respawnSession regenerates the scratch before this call.
      mcpConfigFile: args.mcpConfigFile,
    });
    if (args.inPlaceRespawn) {
      // === SEAM(046 R3.4 LIVE FIX): DEFER discovery for an in-place re-spawn ======================
      // An in-place re-spawn (respawnSession: dontAsk/bypass or effort) can fire BEFORE the first
      // interaction — e.g. Zed sends set_config_option(mode:bypassPermissions) at boot from
      // default_config_options, so the re-spawned `claude` has not written its transcript yet. The
      // blocking 2000ms watchdog below would then throw not-found, fail the re-spawn, and the next
      // turn would stall until the 120s turn watchdog. Mirror the fresh path: return as soon as the
      // PTY is live and discover in the BACKGROUND under watchdogMs:Infinity (cancellable), arming the
      // watcher + firing the first onEvent only when the transcript APPEARS (the first interaction).
      const engine = new SessionEngine({ handle, watcher: undefined, sessions: args.sessions });
      const ac = new AbortController();
      engine.setPendingDiscovery(ac);
      void (async () => {
        try {
          const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId!, {
            watchdogMs: Infinity,
            ...args.locateOptions,
            signal: ac.signal,
          });
          const watcher = createJsonlWatcher({
            sessionId: args.sessionId!,
            transcriptPath,
            dir: cwd ?? args.cwd,
            onEvent: () => args.onEvent?.(args.sessionId!),
          });
          engine.watcher = watcher;
          args.onEvent?.(args.sessionId!);
        } catch (err) {
          // Swallow ONLY the abort sentinel (the session was torn down before any interaction).
          // SURFACE everything else (multi-match ambiguity, IO error) — never silently drop it.
          if ((err as { name?: string } | undefined)?.name === "AbortError") return;
          console.error(
            `[acp-agent] in-place re-spawn transcript discovery failed for ${args.sessionId}:`,
            err,
          );
        }
      })();
      return {
        sessionId: args.sessionId,
        pty: handle.pty,
        watcher: undefined,
        engine,
        cwd: args.cwd,
      };
    }

    const { transcriptPath, cwd } = await resolveWatchTarget(args.sessionId, {
      ...args.locateOptions,
    });
    const watcher = createJsonlWatcher({
      sessionId: args.sessionId,
      transcriptPath,
      dir: cwd,
      onEvent: () => args.onEvent?.(args.sessionId!),
    });
    const engine = new SessionEngine({ handle, watcher, sessions: args.sessions });
    return { sessionId: args.sessionId, pty: handle.pty, watcher, engine, cwd };
  }

  // Fresh session: the engine spawns the PTY and generates the authoritative session id (story 013).
  //
  // === SEAM(028) sub-task 2.1: BACKGROUND-DEFER the fresh-path transcript discovery ===============
  // The Claude Code TUI writes `<sessionId>.jsonl` only on the user's FIRST interaction, so for a
  // fresh session the transcript is ABSENT at create time. The old blocking
  // `await resolveWatchTarget(engine.sessionId)` therefore threw not-found after the 2000ms FATAL
  // file-discovery watchdog → every new Zed session aborted (R1.1). The fix: return as soon as the
  // PTY is live, discover the transcript in the BACKGROUND under `watchdogMs: Infinity` (cancellable
  // via a signal), and arm the watcher + fire the first onEvent only when the transcript APPEARS.
  const engine = createSessionEngine({
    cwd: args.cwd,
    baseEnv: args.baseEnv,
    sessions: args.sessions,
    spawn: args.spawn,
    // Story 056 v4: a FRESH in-place re-spawn (a pre-interaction selector change) reuses the session's
    // existing id; a normal createSession passes none here (inPlaceRespawn absent) → fresh randomUUID.
    sessionId: args.inPlaceRespawn ? args.sessionId : undefined,
    // Story 046 (R3.2/R2.2): the seeded permission mode + effort → `--permission-mode`/`--effort` on
    // the fresh spawn (non-"default" only; "default"/undefined keep the byte-for-byte pre-046 argv).
    permissionMode: args.permissionMode,
    effortLevel: args.effortLevel,
    // Story 056 (R3.2): the agent-selecting re-spawn's persona → `--agent "<name>"` (non-"default").
    agent: args.agent,
    // Story 034 (§9): the per-session gate scratch settings, already on disk — claude reads them at
    // startup, so the hook gates the FIRST tool call (blocker c). Absent → ungated (pre-034) spawn.
    settingsFile: args.settingsFile,
    // Story 057 (R1.3/R3.1): the resolved additional-directory list → one `--add-dir "<dir>"` per
    // safe entry on the fresh interactive spawn (always-on; engine sanitizes per-dir). Empty/absent
    // keeps the pre-057 argv byte-for-byte.
    additionalDirectories: args.additionalDirectories,
    // Story 057 (R2.2): the fork's MCP scratch path → `--mcp-config "<file>"` (never `--strict`,
    // R2.2 merge); written on disk BEFORE this call so claude reads it at startup. Absent (no MCP
    // servers declared) keeps the pre-057 argv byte-for-byte.
    mcpConfigFile: args.mcpConfigFile,
  });

  // Hand the engine the cancellation handle for the background poll. STORE-ONLY here — the
  // cleanup→`.abort()` wiring (so tearing a never-interacted session down cancels this dangling poll)
  // is sub-task 3.1. The `signal` is threaded into resolveWatchTarget below so 3.1's abort unblocks it.
  const ac = new AbortController();
  engine.setPendingDiscovery(ac);

  // Kick the discovery off in the BACKGROUND — do NOT await it on the create path. An unbounded
  // (`watchdogMs: Infinity`) poll resolves only once the transcript materializes (R1.3). `watchdogMs:
  // Infinity` is set FIRST, then `args.locateOptions` is spread (a test injects `glob`/clock here),
  // then `signal: ac.signal` LAST so the internal cancellation signal always wins (a test must not
  // override it). Its own try/catch keeps the unawaited promise from ever rejecting unhandled.
  void (async () => {
    try {
      const { transcriptPath, cwd } = await resolveWatchTarget(engine.sessionId, {
        watchdogMs: Infinity,
        ...args.locateOptions,
        signal: ac.signal,
      });
      // The transcript appeared (first interaction): arm the read-only tail watcher against the REAL
      // resolved path, bind it to the engine so cleanup() stops it (story 014), and fire onEvent ONCE
      // so the pump ingests the content already present (R1.3 — not merely "a file exists").
      const watcher = createJsonlWatcher({
        sessionId: engine.sessionId,
        transcriptPath,
        dir: cwd ?? args.cwd,
        onEvent: () => args.onEvent?.(engine.sessionId),
      });
      engine.watcher = watcher;
      args.onEvent?.(engine.sessionId);
    } catch (err) {
      // Swallow ONLY the abort sentinel: the session was torn down before any interaction, so the
      // never-resolving poll was cancelled — that is expected, not a fault. SURFACE everything else
      // (the multi-match ambiguity fault, an IO error): defaultStartEngine has no logger, so a
      // prefixed console.error is acceptable — NEVER silently drop it, or the ambiguity diagnostic is
      // lost on the fresh path.
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      console.error(
        `[acp-agent] fresh-session transcript discovery failed for ${engine.sessionId}:`,
        err,
      );
    }
  })();

  // Return IMMEDIATELY — the PTY is live; the watcher arms later, out of band. `watcher: undefined`
  // until the transcript appears; the cwd falls back to the known host `args.cwd` (the inside-cwd is
  // not known until the first JSONL line lands).
  return {
    sessionId: engine.sessionId,
    pty: engine.pty,
    watcher: undefined,
    engine,
    cwd: args.cwd,
  };
}

/**
 * Story 057 (R1.3/R3.1): resolve the session's additional-directory list from the request — the
 * top-level `additionalDirectories` (the ACP field), else the legacy `_meta.additionalRoots`, else
 * `[]`. ALWAYS-ON (no `FORK_*` opt-in gate). Both the fingerprint and the spawn must resolve through
 * THIS single helper so the stored fingerprint and the recomputed one agree for identical inputs
 * (the compare path in {@link getOrCreateSession} vs the store path in {@link createSession}).
 */
function resolveAdditionalDirs(p: {
  additionalDirectories?: string[];
  _meta?: NewSessionRequest["_meta"];
}): string[] {
  // `_meta` is the loose ACP index-signature bag (`{ [k]: unknown } | null`); the additionalRoots
  // fallback lives at the `NewSessionMeta` top level, so narrow through that shape (the same cast the
  // newSession handler uses for `_meta.claudeCode.options`) rather than introducing `any`.
  const roots = (p._meta as NewSessionMeta | null | undefined)?.additionalRoots;
  return p.additionalDirectories ?? roots ?? [];
}

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process.  MCP servers are sorted by name
 *  so that ordering differences don't trigger unnecessary recreations.
 *  Story 057 (R1.3): the resolved additional-directory set is folded in (SORTED, so input order is
 *  irrelevant) — a changed `--add-dir` set therefore changes the fingerprint and forces a re-spawn,
 *  while a reordered-but-equal set does not. */
function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  additionalDirectories?: string[];
  _meta?: NewSessionRequest["_meta"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const dirs = [...resolveAdditionalDirs(params)].sort();
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers, additionalDirectories: dirs });
}

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     * Those parameters will be ignored and managed by ACP:
     *   - cwd
     *   - includePartialMessages
     *   - allowDangerouslySkipPermissions
     *   - permissionMode
     *   - canUseTool
     *   - executable
     * Those parameters will be used and updated to work with ACP:
     *   - hooks (merged with ACP's hooks)
     *   - mcpServers (merged with ACP's mcpServers)
     *   - disallowedTools (merged with ACP's disallowedTools)
     *   - tools (passed through; defaults to claude_code preset if not provided)
     */
    options?: Options;
    /**
     * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
     * in addition to normal processing.
     * - true: emit all messages
     * - false/undefined: emit nothing (default)
     * - SDKMessageFilter[]: emit only messages matching at least one filter
     */
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   */
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
    /* For Skill tool calls: the name of the skill being loaded (e.g. "commits").
       Lets clients render a "Load skill: <name>" block without parsing the title. */
    skill?: string;
    /* For Skill tool calls: absolute path of that skill's SKILL.md, when it could be
       located on disk. Lets clients turn the rendered skill name into a link to it. */
    skillPath?: string;
  };
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

/**
 * Upstream #986 (v0.67.0) — build the `_meta.claudeCode` bag for one tool_use.
 * Extracted from the four inline literals that used to build it so the Skill
 * fields cannot land on some call sites and not others.
 */
function claudeCodeMetaFromToolUse(
  toolUse: { name: string; input?: unknown },
  cwd?: string,
): NonNullable<ToolUpdateMeta["claudeCode"]> {
  const skillName =
    toolUse.name === "Skill"
      ? (toolUse.input as { skill?: string } | null | undefined)?.skill
      : undefined;
  const skillPath = skillName ? resolveSkillPath(skillName, cwd) : undefined;
  return {
    toolName: toolUse.name,
    ...(skillName ? { skill: skillName } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}

/** Roots a skill's directory may sit under, relative to the directory the scope resolves to. */
const SKILL_CONTAINER_DIRS = [".claude/skills", ".agents/skills"] as const;

/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the
 * layouts skills actually use: project- and user-level `.claude/skills` (plus `.agents/skills`),
 * and for a `<prefix>:<name>` spelling either a plugin (`.claude/plugins/<prefix>/skills/<name>`)
 * or a directory-scoped skill (`<prefix>/.claude/skills/<name>`), which share that spelling. Only
 * a path that exists on disk is returned, so a wrong guess costs nothing and clients never render
 * a link to a missing file.
 */
function resolveSkillPath(skillName: string, cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const colon = skillName.indexOf(":");
  const scope = colon < 0 ? undefined : skillName.slice(0, colon);
  const name = colon < 0 ? skillName : skillName.slice(colon + 1);
  if (!name) {
    return undefined;
  }
  const candidates: string[] = [];
  const addCandidates = (base: string) => {
    for (const container of SKILL_CONTAINER_DIRS) {
      candidates.push(path.join(base, container, name, "SKILL.md"));
    }
  };
  if (scope) {
    // A `<prefix>:<name>` skill is either directory-scoped or a plugin's; both look identical.
    addCandidates(path.join(cwd, scope));
    candidates.push(path.join(cwd, ".claude/plugins", scope, "skills", name, "SKILL.md"));
  }
  addCandidates(cwd);
  addCandidates(os.homedir());
  return candidates.find((candidate) => existsSync(candidate));
}

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

// === SEAM(012/023): the engine binary is resolved from the user's PATH. After the 023 rewrite,
// createSession no longer passes the SDK `pathToClaudeCodeExecutable`; the PTY engine (story 013)
// spawns the subscription `claude` through the login shell (`bash -lc 'claude …'`), so it resolves
// from PATH — the same E1 keystone (experiments/DEGRAU0-RESULTS.md), via the shell rather than an
// explicit resolveClaudePath() call here. resolveClaudePath() (story 012) is retained for the
// `--cli` auth spawn in index.ts. See fork/src/claude-path.ts, fork/SEAM-MAP.md, IMPLEMENTACAO §3/§5. ===

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

/**
 * Ported from upstream #1165 (281e47e): Claude Code refuses `bypassPermissions` when any settings
 * tier (user, project, local, managed) sets `permissions.disableBypassPermissionsMode` to
 * `"disable"`. The key can only take a permission away, so it is honoured from every tier, project
 * included. Decided once per session and fed to every gate that used the process-wide
 * {@link ALLOW_BYPASS}: the mode catalog, the `defaultMode` seed, and (through the catalog) the
 * set_mode / set_config_option re-spawn into `--permission-mode bypassPermissions`.
 */
export function sessionAllowsBypass(permissions: Settings["permissions"] | undefined): boolean {
  return ALLOW_BYPASS && permissions?.disableBypassPermissionsMode !== "disable";
}

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

// Commands whose marker-only transcript records are client-local UI noise, not
// model-visible user prompts (port of upstream #1035, 97394d9). Marker-only
// custom slash skills are not in this list, so replay can reconstruct them from
// `<command-name>`/`<command-args>`. `/effort` and `/fast` are the tui's own:
// the config-option applies and the fast-mode probe type them into the PTY, and
// the CLI records them like any user-typed command — without an entry every
// config change would surface in the thread as a prompt the user never sent.
// `/model` is injected the same way and is already covered upstream.
const REPLAY_HIDDEN_COMMANDS = new Set([
  ...LOCAL_ONLY_COMMANDS,
  "/compact",
  "/model",
  "/status",
  "/usage",
  "/effort",
  "/fast",
]);

// The Claude SDK persists local slash command invocations (e.g. `/model`) and
// their output as user messages in the session transcript, wrapping the
// payload in these XML-like markers that the CLI uses for its own display.
// The live prompt loop drops them; replay must strip them too or they leak
// into the UI on session/load. A `task-notification` is the CLI telling the
// model a background task stopped -- live it is never shown either -- and is
// stripped the same way, keeping any text typed beside it (upstream #1205's
// replay half).
const LOCAL_COMMAND_MARKERS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "task-notification",
].map((tag) => ({ open: `<${tag}>`, close: `</${tag}>` }));

// Single-pass scanner that removes each `<tag>…</tag>` marker (matching the nearest
// closing tag of the same name, like a lazy regex would) in O(n) — no polynomial
// backtracking (CodeQL js/polynomial-redos #1).
function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = LOCAL_COMMAND_MARKERS.find(
        (m) => !dead.has(m.open) && text.startsWith(m.open, i),
      );
      if (marker) {
        const end = text.indexOf(marker.close, i + marker.open.length);
        if (end !== -1) {
          result += text.slice(copiedUpTo, i);
          i = copiedUpTo = end + marker.close.length;
          continue;
        }
        // No closing marker remains anywhere ahead, and `indexOf` only ever
        // searches forward from here on, so stop treating this tag as an
        // opener — that avoids rescanning the tail for it on every match.
        dead.add(marker.open);
      }
    }
    i++;
  }
  return result + text.slice(copiedUpTo);
}

function markerTagText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return text.slice(start + open.length, end);
}

function hasMarkerTag(text: string, tag: string): boolean {
  return markerTagText(text, tag) !== undefined;
}

function commandInvocationFromMarkerOnlyText(text: string): string | null {
  if (hasMarkerTag(text, "local-command-stdout") || hasMarkerTag(text, "local-command-stderr")) {
    return null;
  }
  const commandName = markerTagText(text, "command-name")?.trim();
  if (!commandName?.startsWith("/")) return null;
  if (REPLAY_HIDDEN_COMMANDS.has(commandName.split(" ", 1)[0])) return null;

  const commandArgs = markerTagText(text, "command-args")?.trim();
  return commandArgs ? `${commandName} ${commandArgs}` : commandName;
}

function stripLocalCommandMetadataText(text: string): string | null {
  const stripped = stripMarkerTags(text);
  if (stripped.trim() !== "") return stripped;
  return commandInvocationFromMarkerOnlyText(text);
}

/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`. A marker-only
 * slash-skill record is reconstructed as `/name args` unless it is client-local
 * (see REPLAY_HIDDEN_COMMANDS) or carries local stdout/stderr.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    return stripLocalCommandMetadataText(content);
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripLocalCommandMetadataText((block as { text: string }).text);
      if (stripped === null) continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  // Ported from upstream #1004 (REBASE-AND-DRIFT.md §15.5). Claude Code 2.1.200 renamed
  // the "default" mode to "Manual" and accepts `"defaultMode": "manual"` in settings.json.
  // This matters more here than upstream: the engine drives whatever `claude` is on PATH,
  // which is far newer than the 2.1.159 provenance pin, so a settings file written by the
  // current CLI can already say "manual". Without this row it resolved to "default" via
  // the unknown-value branch — same outcome, but with a spurious error logged every load.
  manual: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: Logger = console,
  allowBypass: boolean = ALLOW_BYPASS,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !allowBypass) {
    logger.error(
      ALLOW_BYPASS
        ? "Ignoring permissions.defaultMode from settings: bypassPermissions is disabled by permissions.disableBypassPermissionsMode."
        : "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}

/**
 * Story 046 (R3.3): the permission modes the TUI cycles through with Shift+Tab (`\x1b[Z`), reachable
 * by the closed-loop driver by stepping. `dontAsk`/`bypassPermissions` are NOT on this cycle — they
 * are applied by an in-place re-spawn instead (R3.4).
 */
const CYCLABLE_MODES = new Set<string>(["default", "acceptEdits", "plan", "auto"]);

/** Story 046 (R3.3): the raw Shift+Tab bytes that cycle the TUI permission mode. Written DIRECTLY to
 *  the PTY — NEVER via sendPrompt, whose leading Ctrl+U clear would corrupt the escape (design GOTCHA). */
const MODE_CYCLE_KEY = "\x1b[Z";

/** Story 046 (R3.3): per-step budget for the closed-loop to see the confirming permission-mode
 *  transcript event before aborting (no hang, story-044 awareness); polled every MODE_CYCLE_POLL_MS. */
const MODE_CYCLE_STEP_TIMEOUT_MS = 2000;
const MODE_CYCLE_POLL_MS = 50;

/** Story 046 (hang fix): claude 2.1.176 opens a blocking "Switch model?" confirm dialog on a mid-
 *  conversation `/model <alias>` (GrowthBook `tengu_immediate_model_command=false`). Delay before the
 *  blind confirm Enter so the dialog has rendered first; the dialog stays open until confirmed, so a
 *  late Enter still lands while an early (pre-render) one would be lost. 800 ms validated headless
 *  (experiments/probe-c-model-then-prompt.mjs: the dialog rendered + the switch applied within it). */
const MODEL_CONFIRM_DELAY_MS = 800;

/**
 * Builds the label for the "Always Allow" permission option so the user can see
 * the exact scope they are committing to. Uses the SDK-provided suggestions
 * when available (e.g. `Bash(npm test:*)`) and falls back to naming the whole
 * tool so "Always Allow" is never a blank check without disclosure.
 */
export function describeAlwaysAllow(
  suggestions: PermissionUpdate[] | undefined,
  toolName: string,
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  const ruleLabels: string[] = [];
  const directories: string[] = [];

  for (const update of suggestions) {
    if (update.type === "addRules" && update.behavior === "allow") {
      for (const rule of update.rules) {
        ruleLabels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : `all ${rule.toolName}`,
        );
      }
    } else if (update.type === "addDirectories") {
      directories.push(...update.directories);
    }
  }

  const parts: string[] = [];
  if (ruleLabels.length > 0) {
    parts.push(ruleLabels.join(", "));
  }
  if (directories.length > 0) {
    parts.push(`access to ${directories.join(", ")}`);
  }

  if (parts.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  return `Always Allow ${parts.join(" and ")}`;
}

// Implement the ACP Agent interface
/**
 * Story 034 (§9): register every assistant `tool_use` block id from one RAW JSONL message into the
 * session gate's correlation map ({@link SessionGate.correlator}). Defensive walk over the reduced
 * getSessionMessages shape — non-assistant rows, absent content, and id-less blocks are skipped.
 * Double-registration of the SAME id (the message re-appearing in a later raw row) marks it
 * duplicate, which the story-033 correlator then fails closed on — exactly the §9 id-reuse posture.
 */
function registerGateToolUses(raw: unknown, gate: SessionGate): void {
  const msg = raw as { type?: unknown; message?: { content?: unknown } };
  if (msg === null || typeof msg !== "object" || msg.type !== "assistant") return;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      typeof (block as { id?: unknown }).id === "string" &&
      (block as { id: string }).id.length > 0
    ) {
      gate.correlator.register((block as { id: string }).id);
    }
  }
}

/**
 * Story 054 — best-effort label for the subagent that spawned a sidechain inner tool, for the ACP
 * dialog title + the R4 visible-deny line. `parentId` is the spawning `Task`/`Agent` tool_use id; we
 * scan the MAIN chain `messages` for the assistant `tool_use` block with `id === parentId` whose `name`
 * is `Task`/`Agent`, and return its `input.subagent_type ?? input.description` when a string, else
 * undefined. An orphan (`parentId === null`) has no spawn to name → undefined. Tolerant of the reduced
 * shape in the {@link hasSubagentSpawn} style: non-object rows/messages and non-array content are skipped.
 */
function deriveSubagentLabel(
  messages: SessionMessage[],
  parentId: string | null,
): string | undefined {
  if (parentId === null) return undefined;
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const inner = (msg as { message?: unknown }).message;
    if (inner === null || typeof inner !== "object") continue;
    const content = (inner as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || b.id !== parentId) continue;
      if (b.name !== "Task" && b.name !== "Agent") continue;
      const input = b.input;
      if (input === null || typeof input !== "object") return undefined;
      const i = input as { subagent_type?: unknown; description?: unknown };
      if (typeof i.subagent_type === "string") return i.subagent_type;
      if (typeof i.description === "string") return i.description;
      return undefined;
    }
  }
  return undefined;
}

export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;
  /**
   * Story 065 (R1/R3) — did the client advertise `clientCapabilities.elicitation.form`
   * at initialize? Presence-based (a present `form` may legitimately be an empty `{}`,
   * so this is derived with `!= null`, NOT property truthiness). The 065 gate (task 3.1)
   * reads this to decide relay-via-elicitation (R1) vs the story-064 deny fallback (R3).
   * Defaults `false` so a client that never advertised elicitation falls back safely.
   */
  clientSupportsElicitationForm: boolean = false;
  logger: Logger;
  gatewayAuthRequest?: GatewayAuthRequest;
  // === SEAM(011): the injected engine — a no-op stub by default (READ-ONLY Degrau 1);
  // the PTY + JSONL-tail engine replaces the default in 013–015/023. `initialize`
  // does NOT touch this field (story 011 Task 1.2). See fork/SEAM-MAP.md. ===
  engine: Engine;
  // === SEAM(023) Group 1: the createSession PTY-engine start seam. Defaults to the production
  // wiring (defaultStartEngine: PTY spawn + JSONL watcher + transcript discovery); tests inject a
  // fake so createSession never spawns the real `claude` binary or touches ~/.claude. ===
  private readonly startEngine: StartEngine;
  /** Override for the live JSONL reader the pump re-reads (default: SDK getSessionMessages). */
  private readonly getMessages?: GetMessages;
  /** Story 041 — the sidechain readers the pump sources nested sub-agent rows from; default to the
   *  SDK's pure `listSubagents` / `getSubagentMessages` (tests inject stubs). */
  private readonly listSubagents: ListSubagents;
  private readonly getSubagentMessages: GetSubagentMessages;
  /** Story 025 (R3.1) — UNSTABLE usage_update feature flag; defaults OFF. */
  private readonly usageUpdate: boolean;
  /** Story 044 (R4.1/R4.2) — live sub-agent watcher flag; see {@link AgentDeps.liveSubagentWatch}. */
  private readonly liveSubagentWatch: boolean;
  /**
   * Story 030 (R1.2, R5.1) — the single timer seam shared by `sendPrompt` (the §8 write→\r delay)
   * and `createTurnResolver` (Δt + watchdog), so one injected fake clock drives both in unit tests.
   */
  private readonly schedule: DetectorSchedule;
  /** Story 031 (R1.2) — cancel-ladder escalation window (ms); see {@link AgentDeps.cancelEscalationMs}. */
  private readonly cancelEscalationMs: number;
  /** Story 034 (§9) — hybrid permission-gate wiring flag; see {@link AgentDeps.gate}. */
  private readonly gateEnabled: boolean;
  /** Story 034 — gate tuning knobs forwarded to setupSessionGate; see {@link AgentDeps.gateOptions}. */
  private readonly gateOptions?: Omit<SessionGateOptions, "client" | "onWarn">;
  /** Story 056 (R3.2) — main-thread agent-persona discovery seam; see {@link AgentDeps.discoverAgents}. */
  private readonly discoverAgents: (cwd: string) => AgentCatalogEntry[];
  /** Story 063 (R1/R1.1) — offline `available_commands` discovery seam; see {@link AgentDeps.discoverCommands}. */
  private readonly discoverCommands: (cwd: string) => AvailableCommand[];
  /** Story 056 (#812) — SDK session-metadata reader for the end-of-turn title push; see
   *  {@link AgentDeps.getSessionInfo}. Task 3.2 (#984) reads its `lastModified` too. */
  private readonly getSessionInfo: (
    sessionId: string,
    options?: { dir?: string },
  ) => Promise<{ summary: string; lastModified?: number } | undefined>;
  /** Story 073 (R1) — fast-mode availability probe seam; see {@link AgentDeps.fastModeProbe}. */
  private readonly fastModeProbe: FastModeProbe;
  /** Live PTY-engine registry shared with the per-session engines (story 014 cleanup map). */
  private readonly engines: Map<string, SessionEngine> = new Map();

  constructor(
    client: AgentSideConnection,
    logger?: Logger,
    engine: Engine = createStubEngine(),
    deps: AgentDeps = {},
  ) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.logger = logger ?? console;
    this.engine = engine;
    this.startEngine = deps.startEngine ?? defaultStartEngine;
    this.fastModeProbe = deps.fastModeProbe ?? defaultFastModeProbe;
    // Story 043 (R2.1): when liveDiff is ON, the live JSONL reader is the diff-enriched reader
    // (getSessionMessages + uuid→toolUseResult hydration), which restores the story-021 Edit/Write
    // diff on BOTH the live pump and the session/load replay (both read this.getMessages once). The
    // constructor default stays reduced (deps.liveDiff ?? false) for test determinism — the entrypoint
    // (index.ts) is what defaults it ON. OFF → byte-for-byte the pre-043 reduced reader (R5.1).
    this.getMessages =
      (deps.liveDiff ?? false)
        ? createDiffEnrichedReader(deps.getMessages ?? defaultGetMessages, deps.diffEnrichOptions)
        : deps.getMessages;
    this.listSubagents = deps.listSubagents ?? defaultListSubagents;
    this.getSubagentMessages = deps.getSubagentMessages ?? defaultGetSubagentMessages;
    this.usageUpdate = deps.usageUpdate ?? false;
    // Story 044 (R4.1): live sub-agent watcher — bootstrap-resolved (index.ts: ON unless
    // FORK_LIVE_SUBAGENT_WATCH=0/false); OFF at this seam so directly-constructed test agents arm
    // no 2nd watcher unless they opt in (R4.2: OFF → byte-for-byte today's pull-only path).
    this.liveSubagentWatch = deps.liveSubagentWatch ?? false;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    // Story 031 (R1.2): conservative default escalation window; tests inject their own via deps.
    this.cancelEscalationMs = deps.cancelEscalationMs ?? 1000;
    // Story 034 (§9): hybrid gate wiring — bootstrap-resolved (index.ts: ON unless FORK_GATE=off);
    // OFF at this seam so directly-constructed test agents spin no gate unless they opt in.
    this.gateEnabled = deps.gate ?? false;
    this.gateOptions = deps.gateOptions;
    // Story 056 (R3.2): main-thread agent-persona discovery — defaults to the glob-only
    // discoverAgents; tests inject an in-memory fake so the `agent` surface is hermetic.
    this.discoverAgents = deps.discoverAgents ?? discoverAgents;
    // Story 063 (R1/R1.1): offline `available_commands` discovery — defaults to the disk-only
    // discoverCommands; tests inject an in-memory fake so the surface is hermetic (no real ~/.claude read).
    this.discoverCommands = deps.discoverCommands ?? discoverCommands;
    // Story 056 (#812): end-of-turn session_info_update title source — defaults to the pure SDK
    // getSessionInfo; tests inject an in-memory fake so the push is hermetic (no real ~/.claude read).
    this.getSessionInfo = deps.getSessionInfo ?? getSessionInfo;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    // Story 065 (R1/R3): capability negotiation — a present (non-null) `elicitation.form`
    // means the client supports form elicitation. Presence-based detection is deliberate: both
    // `undefined` and `null` are unsupported, and an empty `{}` `form` IS supported (the UNSTABLE
    // ElicitationFormCapabilities type carries only an optional `_meta`, so a present `form` is
    // legitimately `{}` — detection MUST be presence-based, not truthiness). Written as explicit
    // `!== undefined && !== null` (not `!= null`) to satisfy the eqeqeq lint rule.
    const elicitationForm = request.clientCapabilities?.elicitation?.form;
    this.clientSupportsElicitationForm = elicitationForm !== undefined && elicitationForm !== null;
    // Story 065 (Task 6.1 live-probe): make the negotiated capability observable in the Zed logs so
    // the in-Zed verdict (form rendered vs. gated-dormant behind the 064 deny) is deterministic. Goes
    // to STDERR via logger.error — NEVER stdout, which carries the ACP ndJson stream.
    this.logger.error(
      `[065] clientCapabilities.elicitation.form advertised: ${this.clientSupportsElicitationForm}`,
    );

    // Bypasses standard auth by routing requests through a custom Anthropic-protocol gateway.
    // Only offered when the client advertises `auth._meta.gateway` capability.
    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    // Detect remote environments where the OAuth browser redirect to localhost
    // won't work. This matches the SDK's internal isRemote check. In these cases,
    // the `auth login` subcommand would fall back to a device-code-like manual
    // flow, which doesn't work well over ACP, so we offer the TUI login instead.
    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent TUI",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const response = await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Degrau-1 read-only: replay-only — locate the transcript and replay it, but do NOT spawn a live
    // `claude --resume` (story 027 live regression: a live resume re-emits the history through the
    // tail pump → double render, and writes a wrong-cwd duplicate transcript → ambiguous glob).
    const result = await this.getOrCreateSession(params, { replayOnly: true });

    await this.replaySessionHistory(params.sessionId);

    // Send available commands after replay so it doesn't interleave with history
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sdk_sessions = await listSessions({ dir: params.cwd ?? undefined });
    const sessions = [];

    for (const session of sdk_sessions) {
      if (!session.cwd) continue;
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: sanitizeTitle(session.summary),
        updatedAt: new Date(session.lastModified).toISOString(),
      });
    }
    return {
      sessions,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  /**
   * ACP `logout` (acp-sdk 1.0.0, acp.d.ts:1646). Under the PTY engine the bridge
   * authenticates lazily and only tracks an in-memory `gatewayAuthRequest`; the
   * interactive `claude` TUI owns the on-disk credential lifecycle. So `logout`
   * here drops the in-memory auth intent and re-offers a clean handshake on the
   * next `initialize()` (authMethods are recomputed there, unconditioned by this
   * field). It does NOT read/write/delete `~/.claude` (billing seam — story 062
   * R2) and never bridges `/logout` to the PTY (R3). Idempotent with no prior
   * authenticate() (R4); active sessions are untouched (R6).
   */
  async logout(_params: LogoutRequest): Promise<LogoutResponse | void> {
    // Story 062 live-proof seam. The unit suite calls this method DIRECTLY and can only
    // SIMULATE the SDK bind (acp.js:999), so it cannot prove the real client reaches the
    // handler over the wire — the one risk Task 2.1 recorded ("the name must be exactly
    // `logout` for SDK dispatch"). This opt-in probe makes that dispatch observable: run
    // the agent with FORK_AUTH_PROBE=1 and the line below appears iff the client actually
    // called it. OFF by default, so production and the hermetic suite stay silent.
    //
    // stderr, never stdout — stdout is the ACP wire (same rule as agent-catalog.ts). The
    // payload is NEVER logged: `_params` may carry gateway credentials.
    if (process.env.FORK_AUTH_PROBE === "1") {
      process.stderr.write("[auth-probe] logout dispatched by the client\n");
    }
    this.gatewayAuthRequest = undefined;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      throw new Error("Session not found");
    }
    // Story 034 (R2.3 fix): a prompt into a dead engine must fail FAST and legibly. sendPrompt is
    // post-exit-safe (story 014), so without this guard the write would silently no-op and the turn
    // would hang until the stall watchdog — exactly the orphaned-prompt failure the G2 live run hit.
    if (sessionRecord.engine?.isDisposed) {
      throw new Error(
        `session engine disposed — the claude PTY for session ${params.sessionId} has exited; ` +
          "reload or recreate the session to continue",
      );
    }

    // === SEAM(030) — Degrau-2 ACP-side input (R1, R1.2, R5, R5.1, R5.2). The Degrau-1 read-only
    // no-op is replaced by the real prompt loop: assemble the §8 PTY payload, submit it, and resolve
    // the pending `session/prompt` SOLELY through the story-024 end-of-turn detector — never by this
    // writer guessing completion (R5.1). The §10 entrypoint=='cli' billing guard-rail in pumpUpdates
    // stays untouched: enabling input does not weaken it.
    //
    // Everything from `promptToClaude` through `sendPrompt` and `turnDetector = detector` runs
    // SYNCHRONOUSLY before the `await promise`, so the PTY write is committed (and the detector is
    // reachable by the live pump and the cancel path) the instant the turn begins.

    // (1) Assemble the PTY text payload from the ContentBlock[] (Task 1 rewrote this to return text).
    // Story 058 (R2.1/R2.2): pass a fresh sink so every image promptToClaude materializes is recorded
    // on the session BEFORE the prompt is sent — so the turn-settle + teardown cleanups can unlink it
    // and leave no orphan temp image.
    const turnTempImagePaths: string[] = [];
    // Bind the sink to the session BEFORE calling promptToClaude (same array by reference): even if a
    // future promptToClaude were to throw mid-materialize, the teardown cleanup still reaches the paths.
    sessionRecord.turnTempImagePaths = turnTempImagePaths;
    const payload = promptToClaude(params, this.logger, turnTempImagePaths);

    // Story 060 (R2.2) — while ultracode is active, prefix the OUTGOING prompt with the `ultracode`
    // keyword (the binary's per-turn Workflow opt-in). This is the LIVE activation that needs no
    // re-spawn (Option A) and works pre- AND post-first-interaction; the scratch settings keys are the
    // declarative spawn-time complement. NEVER emitted as a `/effort` value (R1.2).
    const outgoing = sessionRecord.ultracodeActive ? `${ULTRACODE_EFFORT} ${payload}` : payload;

    // (2) Register the turn with the story-024 resolver: the detector that the live pump feeds, and
    // the awaitable that settles ONCE with { stopReason: mapStopReason(...) } on the terminal
    // boundary (or rejects on the watchdog). One shared `schedule` drives sendPrompt + the resolver.
    const { detector, promise, cancel } = createTurnResolver({
      schedule: this.schedule,
      sessionId: params.sessionId,
      logger: this.logger,
      // Story 056 (#812): on a REAL end-of-turn boundary (never cancel, never watchdog), push the
      // sanitized session title via session_info_update. `void` = fire-and-forget — the async method
      // is never awaited, so it cannot delay the `return await promise` below (R5.1).
      onTurnResolved: () => void this.emitSessionTitleUpdate(params.sessionId),
    });
    sessionRecord.turnDetector = detector;
    sessionRecord.turnCancel = cancel;
    detector.beginTurn();

    // (3) Submit with the §8 convention (single-line: write→delayed \r; multi-line: bracketed-paste).
    // On a PTY-write failure, reject the pending prompt via the throw — markCancelled clears the
    // detector's Δt + watchdog timers so nothing is left hung — rather than swallowing the error.
    try {
      sendPrompt(sessionRecord.pty, outgoing, this.schedule);
    } catch (e) {
      detector.markCancelled();
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      // Story 058 (R2.1): the turn never reached the model — drop its materialized temp images now.
      cleanupMaterializedImages(sessionRecord.turnTempImagePaths);
      sessionRecord.turnTempImagePaths = undefined;
      throw e;
    }

    // (4) Resolve ONLY via the detector's terminal boundary. The pump feeds raw JSONL messages to
    // `sessionRecord.turnDetector`; this method emits NO `client.sessionUpdate` (the pump owns that).
    try {
      return await promise;
    } finally {
      sessionRecord.turnDetector = undefined;
      sessionRecord.turnCancel = undefined;
      // Story 058 (R2.1/R2.2): the turn is over — resolved OR cancelled (both settle this same
      // promise, per the comment below) — so unlink the temp images materialized for it. No orphans.
      cleanupMaterializedImages(sessionRecord.turnTempImagePaths);
      sessionRecord.turnTempImagePaths = undefined;
      // Story 044 (R2.3): the turn is over — resolved OR cancelled, both settle this same promise —
      // so the in-turn sub-agent watcher dies with it (covers turn-resolve AND markCancelled paths).
      sessionRecord.subagentWatcher?.stop();
      sessionRecord.subagentWatcher = undefined;
      // Story 046 (R1.3): the session is idle again — flush any model switch deferred mid-turn.
      this.flushPendingControlInjections(sessionRecord);
    }
  }

  // ─── Task 3.2 (R5.2, R5.3) — the session title, and what this port does NOT deliver ──────────
  //
  // WHAT IT DELIVERS. Upstream #984 titles a session from two sources, tried in order: first
  // `query.generateSessionTitle`, a model-WRITTEN title asked for on the live SDK `Query`; and, when
  // that is unavailable, `getSessionInfo(sessionId, { dir })`, which reads the session's own record
  // off disk. Only the second one ports, because only the second one exists here — `createSession`
  // is a CUT seam (SEAM-MAP), so there is no `Query` to ask, and disk is what this engine already
  // reads. A record is a summary AND the moment it was written, so both travel: the sanitized
  // summary as `title`, its `lastModified` as ACP's `updatedAt`. Dropping the timestamp would take
  // the string from disk without the record it came from, leaving a client holding titles it has no
  // way to order.
  //
  // WHAT IT DOES NOT DELIVER. Stated here on purpose: the difference between a port and a claim of
  // parity is whether the code admits its own gap (REBASE-AND-DRIFT.md §15.7).
  //
  //   • `query.generateSessionTitle` IS CUT — no model ever writes a title in this adapter. What is
  //     published is whatever the transcript already held: a `/rename`, the CLI's own auto-summary,
  //     or the first prompt verbatim. That is upstream's FALLBACK — the degraded branch it takes
  //     when the generator is unreachable — so a session that upstream would have titled in words
  //     gets its raw first prompt instead.
  //   • AND THAT DEGRADATION IS VISIBLE. Unlike the per-model usage of §15.6, this surface IS
  //     consumed: `session_info_update` is what a client renders as the session's name. The gap
  //     above reaches a user rather than sitting inert.
  //   • `updatedAt` IS THE TITLE'S TIMESTAMP, NOT THE SESSION'S. ACP defines the field as "last
  //     activity", but the push is deduped on the title, so a record whose `lastModified` moved
  //     while its summary did not emits nothing and that newer time is never sent. What a client
  //     receives is the mtime of the record that produced the CURRENT title. Widening the dedup to
  //     the timestamp would match ACP's wording and re-push an identical title every turn — the
  //     louder bug of the two; the narrower claim is the honest one.

  /**
   * Story 056 (#812) — push the sanitized session title to the client via `session_info_update`,
   * fired (fire-and-forget) by the story-024 end-of-turn boundary ONLY (never on cancel/watchdog,
   * via {@link TurnResolverOptions.onTurnResolved}). DEDUPED against {@link Session.lastEmittedTitle}
   * so an unchanged title is not re-emitted, and silent when `getSessionInfo` finds no transcript /
   * the title is empty. Every error is swallowed and logged — this MUST NEVER reject the turn (it is
   * never awaited in `prompt()`), and a slow/never-resolving reader cannot delay the PromptResponse.
   *
   * Task 3.2 (#984): the record's `lastModified` rides along as ACP `updatedAt` whenever it is
   * usable. See the block above for what this port does NOT deliver (R5.3).
   */
  private async emitSessionTitleUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    try {
      const info = await this.getSessionInfo(sessionId, { dir: session.cwd });
      if (!info) return; // no transcript / not found → nothing to push
      const title = sanitizeTitle(info.summary);
      // Deduped on the TITLE alone, never on the record: two summaries that sanitize to the same
      // string are ONE title, and a record touched without its summary changing is not a new one.
      if (!title || title === session.lastEmittedTitle) return; // dedup + never push empty
      session.lastEmittedTitle = title;
      // #984: publish the disk record the title came from, not only the string it yielded. The key
      // is OMITTED rather than sent as null when unknown — ACP reads a null `updatedAt` as "clear
      // it", which would assert an absence this port has not established.
      const updatedAt = isoLastModified(info.lastModified);
      await this.client.sessionUpdate({
        sessionId,
        update: updatedAt
          ? { sessionUpdate: "session_info_update", title, updatedAt }
          : { sessionUpdate: "session_info_update", title },
      });
    } catch (err) {
      // Swallow — never reject the turn (this method is never awaited from prompt()).
      this.logger.error("[acp-agent] session title push (#812) failed:", err);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionRecord = this.sessions[params.sessionId];
    if (!sessionRecord) {
      return;
    }
    // === SEAM(023→031): the SDK `query.interrupt()` body is REMOVED. Cancel is re-implemented
    // against the PTY (§3 CORTAR), in two halves: (Task 1) RESOLUTION via the story-024 latch, then
    // (Task 2) the PTY interrupt ESCALATION via the story-014 primitives. ===

    // Task 1 (R2.1, R2.2, R3.1): resolve the in-flight prompt as 'cancelled' via the story-024 latch
    // (the resolver claims the latch + calls markCancelled). No-op when no turn is in flight.
    const hadInFlightTurn = sessionRecord.turnCancel !== undefined;
    sessionRecord.cancelled = true;
    sessionRecord.turnCancel?.();

    // Task 2 (R1.1, R1.2, R1.3) — revised by the story-034 live acceptance (R2.3): best-effort STOP
    // the underlying claude TUI via the story-014 PTY primitives. Only when a turn was actually in
    // flight (R1.3: no-op with no turn) AND the engine is still alive (R1.3: inert after PTY exit).
    // Ctrl+C first; Esc only if the PTY has not exited within a short LOCAL window. The ladder ENDS
    // at Esc: the G2 live run (sessions 22e2672c/6262610a) proved the TUI aborts the turn on Ctrl+C
    // WITHOUT exiting, so `isDisposed` can never read as "yielded" on a live session — the former
    // p.kill() rung therefore killed EVERY live cancelled session and orphaned the next prompt
    // (an R2.3 violation; §8 asked only for \x03). kill() stays a teardown concern, never a cancel
    // rung; a genuinely zombie TUI is surfaced by the next turn's stall watchdog and removed by
    // teardown. Each primitive is itself post-exit-safe (story 014), so the isDisposed guards are
    // belt-and-suspenders against writing to a dead handle.
    if (!hadInFlightTurn) {
      return;
    }
    const engine = sessionRecord.engine;
    if (!engine || engine.isDisposed) {
      return;
    }
    engine.interrupt(); // \x03 (Ctrl+C), synchronously, before any escalation
    this.schedule(() => {
      if (engine.isDisposed) return; // PTY exited meanwhile → nothing left to escalate to
      engine.escape(); // \x1b (Esc) — a no-op on an idle TUI; the ladder ends here
    }, this.cancelEscalationMs);
  }

  /** Cleanly tear down a session: cancel in-flight work, dispose resources,
   *  and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    await this.cancel({ sessionId });
    // Story 058 (R2.1): idempotent backstop — unlink any temp images that survived a turn whose
    // prompt-finally never ran (e.g. a session torn down between turns or before the finally fired).
    // The cancel above may have already cleared them; cleanupMaterializedImages never throws on a
    // gone file, so a double-cleanup is a safe no-op.
    cleanupMaterializedImages(session.turnTempImagePaths);
    session.turnTempImagePaths = undefined;
    // Story 044 (R2.3): stop the sub-agent watcher on teardown — idempotent with the prompt-finally stop.
    session.subagentWatcher?.stop();
    session.subagentWatcher = undefined;
    session.settingsManager.dispose();
    // === SEAM(023) Group 1: tear down via the engine handle (cleanup/kill), never the SDK Query
    // (story 014) idempotently kills the PTY and stops the JSONL watcher; if no engine handle is
    // present (e.g. an injected fake), fall back to stopping the watcher directly. ===
    if (session.engine) {
      session.engine.cleanup();
      session.engine.kill();
    } else {
      // `watcher` is now OPTIONAL (story 028, sub-task 2.1): a fresh session may be torn down before
      // its transcript appeared, so no watcher was ever armed — null-guard the no-engine fallback.
      // (The 3.1 task text attributes this guard to 3.1; the type-widening in 2.1 forces it here so
      // the build stays green. 3.1 adds the cleanup→discovery-abort logic and its own tests.)
      session.watcher?.stop();
    }
    // Story 034 (§9): dispose the per-session permission gate AFTER the PTY is gone (no live claude
    // can fire a hook into the closing server): close the hook server (bounded — never hangs on an
    // in-flight decider) and restore/delete the scratch settings. Idempotent with the PTY onExit
    // teardown hook, so a crashed-TUI session that already tore the gate down is a no-op here.
    if (session.gate) {
      await session.gate.teardown();
    }
    // Story 057 (R2.3): remove the MCP scratch on teardown so no secret-bearing file (auth headers/
    // env) is orphaned. Idempotent + never throws + never logs the contents; a no-op when the session
    // declared no MCP servers (mcpConfigFile undefined) or after a re-spawn already swapped/removed it.
    if (session.mcpConfigFile) {
      await removeMcpScratch(session.mcpConfigFile);
    }
    this.engines.delete(sessionId);
    delete this.sessions[sessionId];
  }

  /** Tear down all active sessions. Called when the ACP connection closes. */
  async dispose(): Promise<void> {
    // Drop the in-memory auth intent on teardown (story 062 R7) — same clear as logout().
    this.gatewayAuthRequest = undefined;
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.teardownSession(params.sessionId);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    // Validate the requested mode against the session's availableModes (throws on an unknown/unavailable
    // mode — preserved). No state change here (Degrau-1 shim); the drive/re-spawn below applies it.
    await this.applySessionMode(params.sessionId, params.modeId);
    // Drive the validated mode INTO the claude TUI (shared with the set_config_option path, Bug A fix).
    await this.driveModeIntoTui(params.sessionId, session, params.modeId);
    await this.updateConfigOption(params.sessionId, "mode", params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // Story 074 (#828, R4.3): the `fast` option may be advertised as a boolean (when the client
    // advertised boolean config options) OR as the on/off select. A boolean payload has no select
    // `options` to validate against and would trip the string-only guard below — resolve it directly and
    // apply it via the SAME PTY `/fast on|off` inject (mechanism unchanged), then reflect the toggle in
    // the option's currentValue (boolean or on/off, matching how it was advertised). The on/off STRING
    // payload still flows through the generic select validation below. NO createSession/prompt touch.
    if (params.configId === FAST_MODE_CONFIG_ID && typeof params.value === "boolean") {
      const option = session.configOptions.find((o) => o.id === FAST_MODE_CONFIG_ID);
      if (!option) {
        throw new Error(`Unknown config option: ${params.configId}`);
      }
      const enabled = resolveFastModeEnabled(params.value);
      this.applyFastModeChange(session, enabled);
      session.configOptions = session.configOptions.map((o) =>
        o.id === FAST_MODE_CONFIG_ID
          ? o.type === "boolean"
            ? { ...o, currentValue: enabled }
            : { ...o, currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF }
          : o,
      );
      return { configOptions: session.configOptions };
    }
    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    let validValue = allValues.find((o) => o.value === params.value);

    // For model options, fall back to resolveModelPreference when the exact
    // value doesn't match.  This lets callers use human-friendly aliases like
    // "opus" or "sonnet" instead of full model IDs like "claude-opus-4-6".
    if (!validValue && params.configId === "model") {
      const modelInfos: ModelInfo[] = allValues.map((o) => ({
        value: o.value,
        displayName: o.name,
        description: o.description ?? "",
      }));
      const resolved = resolveModelPreference(modelInfos, params.value);
      if (resolved) {
        validValue = allValues.find((o) => o.value === resolved.value);
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    // Use the canonical option value so downstream code always receives the
    // model ID rather than the caller-supplied alias.
    const resolvedValue = validValue.value;

    if (params.configId === "mode") {
      await this.applySessionMode(params.sessionId, resolvedValue);
      // Story 056 v4 (OPTIMISTIC notify) — for a CYCLABLE mode, push `current_mode_update` to the panel
      // BEFORE driving the (slower) closed-loop Shift+Tab cycle, so the selector reflects the choice
      // INSTANTLY instead of waiting out the cycle. Safe: the permission gate reads the mode from the
      // transcript (tail-as-truth), NOT this notification, and a cyclable drive never re-spawns (no R3.7
      // rollback to honor). dontAsk/bypass (a re-spawn that CAN fail) keep the notify AFTER the drive so
      // a failed switch does not leave the panel showing a mode that never applied.
      const cyclable = CYCLABLE_MODES.has(resolvedValue);
      if (cyclable) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: resolvedValue },
        });
      }
      // Bug A fix (Story 046 R3) — Zed sends mode changes via set_config_option(configId:"mode"), so
      // the DRIVE must happen HERE too. This path used to only validate (read-only), leaving claude
      // stuck on its spawn mode — the live permission mode never changed (bypass/acceptEdits no-op'd).
      await this.driveModeIntoTui(params.sessionId, session, resolvedValue);
      if (!cyclable) {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: resolvedValue },
        });
      }
    }
    // === SEAM(023→046) Group 1: the dropped SDK `query.setModel` is replaced by a PTY side-channel.
    // `/model <alias>` is a LOCAL TUI command (no assistant turn, no stop_reason) — inject it as a
    // write that resolves immediately; NEVER route it through prompt()/the turn-resolver (it would
    // hang forever) and never set turnDetector (R1.4). Idle-guard on turnDetector === undefined
    // (design §5): mid-turn, defer behind pendingModelInjection and flush when the turn settles (R1.3).
    // resolvedValue is already the canonical catalog alias. ===
    if (params.configId === "model") {
      this.applyModelSwitch(session, resolvedValue);
    } else if (params.configId === "effort") {
      // Story 056 v4: effort is now a LIVE `/effort <level>` injection (claude 2.1.195 has the command),
      // mirroring /model — no re-spawn, works before the first interaction. Mid-turn it defers; it never
      // throws, so applyConfigOptionValue below always commits the new currentValue (optimistic, like
      // /model). The flag path stays only to seed/preserve effort across mode/agent re-spawns.
      // Story 060 (R2/R3.2): route through applyEffortSelection so the `ultracode` sentinel is
      // special-cased (activate keyword + scratch keys + /effort xhigh) while real levels deselect it.
      await this.applyEffortSelection(session, resolvedValue);
    } else if (params.configId === "agent") {
      // Story 056 (R3.3/R3.4): the agent persona has no live mid-session path either — apply it by an
      // in-place re-spawn carrying `--agent` (mirrors effort). On throw, applyConfigOptionValue below is
      // skipped so the prior currentValue stays unchanged (R3.7-style failure path).
      await this.applyAgentChange(params.sessionId, session, resolvedValue);
    } else if (params.configId === FAST_MODE_CONFIG_ID) {
      // Story 073 (R3): fast mode is a LIVE `/fast on|off` inject (mirrors /effort — no re-spawn, works
      // pre-first-interaction, defers mid-turn). It never throws, so applyConfigOptionValue below always
      // commits the new currentValue (optimistic, like /effort). This is the SELECT (on/off string)
      // path; a boolean payload is resolved earlier (story 074, R4.3). resolveFastModeEnabled unifies both.
      this.applyFastModeChange(session, resolveFastModeEnabled(resolvedValue));
    }

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, resolvedValue);

    return { configOptions: session.configOptions };
  }

  /**
   * Story 046 (R3, Bug A fix) — drive a permission-mode change INTO the claude TUI (the load-bearing
   * half). Cyclable modes (default/acceptEdits/plan/auto) drive via closed-loop Shift+Tab; dontAsk/
   * bypassPermissions re-spawn with `--permission-mode`. Idle-guarded (R3.8); a no-op change applies
   * nothing. SHARED by setSessionMode AND setSessionConfigOption(configId:"mode") — Zed sends mode
   * changes via the latter, so the driving MUST live on both paths (it previously lived only on
   * setSessionMode, while the config-option path was read-only → claude stuck on its spawn mode). The
   * caller has already validated `target` via {@link applySessionMode}.
   */
  private async driveModeIntoTui(
    sessionId: string,
    session: Session,
    target: string,
  ): Promise<void> {
    if (target === session.modes.currentModeId) return; // no-op change applies nothing to the TUI
    // Idle-guard (design §9 / R3.8): driving/re-spawning is mutually exclusive with a turn in flight
    // (incl. the story-031 cancel ladder, observed as a live turnDetector) and with a re-spawn already
    // underway. Reject rather than write to a busy/dead PTY — the user retries when idle.
    if (session.turnDetector !== undefined || session.respawning) {
      throw new Error(
        "Cannot change permission mode while the session is busy (a turn is in flight or a re-spawn is underway); retry when idle",
      );
    }
    if (CYCLABLE_MODES.has(target)) {
      // R3.3: drive the TUI with closed-loop raw Shift+Tab until the transcript confirms `target`.
      await this.driveCyclableMode(sessionId, session, target);
    } else {
      // R3.4: dontAsk/bypassPermissions are not on the Shift+Tab cycle — re-spawn in place.
      await this.respawnSession(sessionId, session, { permissionMode: target });
    }
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }

    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

    // === SEAM(023) Group 1: read-only Degrau-1 shim — validate the mode against local availableModes
    // above; the local currentModeId is updated by applyConfigOptionValue and the notification is
    // emitted by the caller. No SDK `query.setPermissionMode`.
    // Degrau 2 (030/032): PTY-backed control — drive the TUI to apply the permission mode. ===
  }

  /**
   * Story 046 (R1.2–R1.4, design §5) — apply a live model switch by injecting `/model <alias>` into
   * the PTY as a SIDE-CHANNEL write. `/model` is a local TUI command: no assistant turn, no
   * stop_reason — so it is NEVER routed through prompt()/createTurnResolver (that would hang) and
   * never sets turnDetector (R1.4). The write goes through sendPrompt for its Ctrl+U input-clear but
   * with a SYNCHRONOUS schedule so the command + `\r` commit immediately (resolves now; it awaits no
   * turn). Idle-guard: inject only when no turn is in flight; otherwise defer (last-write-wins, §9)
   * and flush when the turn settles (R1.3).
   */
  private applyModelSwitch(session: Session, alias: string): void {
    if (session.turnDetector !== undefined) {
      // A turn is in flight — injecting mid-turn corrupts the PTY input. Defer (coalesce, §9).
      session.pendingModelInjection = alias;
      return;
    }
    // Re-selecting the model the session is already on is a no-op: claude shows no "Switch model?"
    // dialog for it, so skip the redundant /model (and its confirm Enter) entirely.
    const current = session.configOptions.find((o) => o.id === "model")?.currentValue;
    if (current === alias) return;
    this.injectModelCommand(session, alias);
  }

  /**
   * Side-channel `/model <alias>` write — synchronous, resolves immediately (never a turn). claude
   * 2.1.176 (GrowthBook `tengu_immediate_model_command=false`) does NOT apply `/model` inline mid-
   * conversation: it opens a blocking **"Switch model?" → 1. Yes / 2. No** dialog and leaves it OPEN.
   * Unconfirmed, the dialog survives until the NEXT prompt — whose `\r` then confirms the switch AND
   * discards the prompt text, so no turn is born and the story-024 stall watchdog trips (the live
   * 39a93bfc hang; root cause proved headless by experiments/probe-c-model-then-prompt.mjs). So after
   * the command we schedule ONE Enter to accept the default "Yes, switch" once the dialog has rendered;
   * if no dialog appears (same model / flag flipped on) Enter-on-empty-input is a harmless no-op.
   */
  private injectModelCommand(session: Session, alias: string): void {
    sendPrompt(session.pty, `/model ${alias}`, (fn) => fn());
    // Confirm the "Switch model?" dialog — blind + scheduled, like the story-031 cancel ladder's Esc.
    this.schedule(() => {
      if (session.engine?.isDisposed) return; // PTY exited meanwhile → nothing to confirm
      session.pty.write("\r");
    }, MODEL_CONFIRM_DELAY_MS);
  }

  /**
   * Story 046 (R1.3) — flush a deferred model-switch once the session is idle again (called from
   * prompt()'s finally, the moment the turn settles). Last-write-wins: only the most recent queued
   * alias is injected; the field is cleared so a settled session with nothing queued injects nothing.
   */
  private flushPendingControlInjections(session: Session): void {
    if (session.turnDetector !== undefined) return; // still not idle (defensive)
    const alias = session.pendingModelInjection;
    if (alias !== undefined) {
      session.pendingModelInjection = undefined;
      this.injectModelCommand(session, alias);
    }
    // Story 056 v4 — flush a deferred effort `/effort <level>` injection too (last-write-wins).
    const effort = session.pendingEffortInjection;
    if (effort !== undefined) {
      session.pendingEffortInjection = undefined;
      this.injectEffortCommand(session, effort);
    }
    // Story 073 (R3.1) — flush a deferred `/fast on|off` injection too (last-write-wins).
    const fast = session.pendingFastInjection;
    if (fast !== undefined) {
      session.pendingFastInjection = undefined;
      this.injectFastCommand(session, fast);
    }
  }

  /**
   * Story 046 (R3.3, design §6b) — drive the TUI to `target` with closed-loop raw Shift+Tab. Writes
   * `\x1b[Z` DIRECTLY to the PTY (NOT sendPrompt — its Ctrl+U clear corrupts the escape), then awaits
   * the confirming `permission-mode` transcript event (the tail-as-truth fence: mode is read from the
   * transcript, NEVER from p.onData). A per-step Δt budget + a one-full-cycle safety stop guarantee the
   * loop ABORTS rather than hangs/false-stalls (Probe A gated this; story-044 awareness).
   */
  private async driveCyclableMode(
    sessionId: string,
    session: Session,
    target: string,
  ): Promise<void> {
    const cyclableCount = session.modes.availableModes.filter((m) =>
      CYCLABLE_MODES.has(m.id),
    ).length;
    const maxSteps = Math.max(cyclableCount, 1) + 1; // one-full-cycle safety stop
    for (let step = 0; step < maxSteps; step++) {
      if (session.modes.currentModeId === target) return; // converged
      const before = session.modes.currentModeId;
      session.pty.write(MODE_CYCLE_KEY); // raw \x1b[Z (Shift+Tab) — never via sendPrompt
      const observed = await this.awaitModeChange(sessionId, session, before);
      if (observed === undefined) return; // Δt elapsed with no confirming event → abort (no hang)
      session.modes.currentModeId = observed; // reconcile local state from the transcript truth
    }
  }

  /**
   * Story 046 (R3.3) — poll the transcript (the pump's getMessages seam) for a `permission-mode` event
   * whose mode differs from `before`, up to MODE_CYCLE_STEP_TIMEOUT_MS. Returns the new mode, or
   * undefined on the Δt timeout (the caller aborts rather than hangs). The confirming event is usually
   * already present right after the TUI processes the keystroke, so this returns at once in tests.
   */
  private async awaitModeChange(
    sessionId: string,
    session: Session,
    before: string,
  ): Promise<string | undefined> {
    let waited = 0;
    for (;;) {
      const mode = await this.readLatestPermissionMode(sessionId, session);
      if (mode !== undefined && mode !== before) return mode;
      if (waited >= MODE_CYCLE_STEP_TIMEOUT_MS) return undefined;
      await new Promise<void>((resolve) => this.schedule(() => resolve(), MODE_CYCLE_POLL_MS));
      waited += MODE_CYCLE_POLL_MS;
    }
  }

  /** Story 046 (R3.3/R4.1) — the most recent `permission-mode` event's mode from the transcript (the
   *  same getMessages seam the pump reads), or undefined when none is present yet. */
  private async readLatestPermissionMode(
    sessionId: string,
    session: Session,
  ): Promise<string | undefined> {
    // Mirror the pump's seam resolution: this.getMessages is the injectable reader, defaulting to
    // defaultGetMessages when not overridden (it is optional at the constructor seam).
    const read = this.getMessages ?? defaultGetMessages;
    const messages = await read(sessionId, { dir: session.cwd });
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; permissionMode?: unknown };
      if (m.type === "permission-mode" && typeof m.permissionMode === "string")
        return m.permissionMode;
    }
    return undefined;
  }

  /**
   * Story 046 (R3.4/R3.7/R3.8, design §6c) — apply a non-cyclable mode (dontAsk/bypassPermissions) by
   * re-spawning the SAME sessionId in place with a flag-carrying resume argv, preserving the transcript.
   * Order is load-bearing for R3.7: re-spawn FIRST, and swap in + tear down the old PTY ONLY once the new
   * one is live — so a failed re-spawn leaves the prior PTY/currentValue intact (never
   * torn-down-without-replacement). Re-spawn runs only while idle, so the old PTY has no pending turn to
   * double-resolve. The `respawning` latch defers concurrent selector changes (R3.8). Re-spawning for
   * ONE selector preserves the OTHER two (mode / effort / agent — Story 056 added agent) by reading
   * their current values, so the resume argv always carries all three flags.
   */
  private async respawnSession(
    sessionId: string,
    session: Session,
    change: { permissionMode?: string; effortLevel?: string; agent?: string },
  ): Promise<void> {
    // Story 046 (R3.4 LIVE FIX guard): a re-spawn reattaches via `claude --resume <id>`, which needs the
    // transcript to ALREADY exist. Before the first interaction it is absent, so --resume falls back
    // (buildResumeArgv `|| claude`) to a NEW id the fork no longer tracks — stalling the turn until the
    // 120s watchdog AND discarding the live fresh PTY. Refuse until the session has interacted at least
    // once. The user/Zed retries after the first prompt; a boot-time default_config_options dontAsk/
    // bypass therefore stays at the fresh spawn's mode (use a fresh-spawn --permission-mode seed for
    // start-in-bypass, a documented follow-up). The OTHER selector's currentValue is left unchanged.
    // Story 056 v4 — before the first interaction there is NO transcript to `--resume`, so the re-spawn
    // is FRESH (reusing the SAME sessionId — LIVE-VERIFIED: claude accepts a reused --session-id once the
    // prior PTY exits). After the first interaction, `--resume` reattaches the transcript (R3.4). This is
    // what lets the agent/effort/mode selectors apply BEFORE the first prompt — the live gap the user hit
    // (previously this threw and the selector silently reverted). NOTE: effort no longer reaches here
    // (it is a live `/effort` inject now); the fresh path serves agent and the dontAsk/bypass modes.
    const fresh = !session.interacted;
    session.respawning = true;
    try {
      const oldEngine = session.engine;
      // Preserve the OTHER selectors' current values so re-spawning for one (mode, effort, OR agent)
      // does not reset the others — the argv carries all three flags. There are three selectors now
      // (Story 056 added agent): a mode re-spawn keeps effort+agent, an agent re-spawn keeps mode+effort.
      const permissionMode = change.permissionMode ?? session.modes.currentModeId;
      // Story 060 (R1.2 fix): the preserved currentEffort can be the `ultracode` SENTINEL (it is the
      // committed configOption value while active). It is NOT a real `--effort` enum value — the binary
      // rejects `--effort ultracode` (story-060 probe), so a mode/agent re-spawn-while-active would
      // silently degrade effort to default. Map the sentinel to its real component (xhigh) at THIS spawn
      // seam (it feeds BOTH buildClaudeCmd and buildResumeArgv); the scratch `ultracode:true` already
      // carries the orchestration activation declaratively at spawn.
      const preservedEffort = change.effortLevel ?? this.currentEffort(session);
      const effortLevel =
        preservedEffort === ULTRACODE_EFFORT ? ULTRACODE_EFFORT_LEVEL : preservedEffort;
      const agent = change.agent ?? this.currentAgent(session);
      // Story 057 (R2.4): REGENERATE the MCP scratch so the re-spawned `claude` reads the CURRENT MCP
      // config at startup (its `--mcp-config` is bound only at spawn). Re-translate from the stored raw
      // ACP servers (kept faithful to the original request). Write the NEW scratch BEFORE removing the
      // OLD so a write failure leaves the prior scratch intact (the still-running old PTY already read
      // its config at startup, so removing the old file does not disturb it). removeMcpScratch is
      // idempotent + never throws + never logs the contents (R2.3).
      if (session.mcpServers && session.mcpServers.length > 0) {
        const old = session.mcpConfigFile;
        session.mcpConfigFile = await writeMcpScratch(translateMcpServers(session.mcpServers));
        if (old) await removeMcpScratch(old);
      }
      // FRESH re-spawn (pre-interaction): retire the old fresh PTY FIRST to free the reused sessionId —
      // there is no transcript to preserve. RESUME re-spawn: keep the R3.7 order (bring the new PTY up
      // BEFORE retiring the old, so a failed re-spawn leaves the prior PTY + currentValue intact).
      if (fresh) {
        oldEngine?.cleanup();
        oldEngine?.kill();
      }
      // Re-spawn through the SAME startEngine seam createSession uses, reusing the sessionId so the
      // transcript is reattached on resume (R3.4) or freshly created on the pre-interaction path; the
      // flags flow into the flag-carrying spawn argv (fresh `buildClaudeCmd` or `buildResumeArgv`).
      const started = await this.startEngine({
        sessionId,
        cwd: session.cwd,
        resume: !fresh,
        // Story 046 (R3.4 LIVE FIX): an in-place re-spawn may run before the first interaction, so DEFER
        // discovery instead of the 2000ms fatal watchdog — see defaultStartEngine.
        inPlaceRespawn: true,
        permissionMode,
        effortLevel,
        agent,
        // Story 057 (R1.3/R3.1): re-thread the SAME `--add-dir` scope into the re-spawn (sub-task 1.2
        // wired only the fresh createSession path; the in-place re-spawn must preserve it too).
        additionalDirectories: session.additionalDirectories,
        // Story 057 (R2.4): the freshly-regenerated MCP scratch path (see above) → `--mcp-config` on
        // the re-spawned `claude`, so it carries the current MCP config.
        mcpConfigFile: session.mcpConfigFile,
        sessions: this.engines,
        onEvent: (sid) => void this.pumpUpdates(sid),
      });
      if (!fresh) {
        // New PTY is live — only now retire the old one (idle ⇒ no pending turn to double-resolve).
        oldEngine?.cleanup();
        oldEngine?.kill();
      }
      session.pty = started.pty;
      session.engine = started.engine;
      session.watcher = started.watcher;
      if (change.permissionMode) {
        session.modes = { ...session.modes, currentModeId: change.permissionMode };
      }
    } finally {
      session.respawning = false;
    }
  }

  /** Story 046 — the session's current effort configOption value (undefined when no effort option). */
  private currentEffort(session: Session): string | undefined {
    const opt = session.configOptions.find((o) => o.id === "effort");
    return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
  }

  /** Story 056 — the session's current agent configOption value (undefined when no agent option). */
  private currentAgent(session: Session): string | undefined {
    const opt = session.configOptions.find((o) => o.id === "agent");
    return typeof opt?.currentValue === "string" ? opt.currentValue : undefined;
  }

  /**
   * Story 060 (R2/R3.2) — apply an effort-selector choice, special-casing the `ultracode` sentinel.
   *
   * Selecting `ultracode` (Option A — keyword + scratch, NO re-spawn): activate the session flag (which
   * makes {@link prompt} prefix the OUTGOING prompt with the `ultracode` keyword — the binary's per-turn
   * Workflow opt-in, the effective live mechanism), write the scratch ultracode keys via
   * {@link applyUltracodeSettings} (the declarative spawn-time complement), and set the effort to xhigh
   * through the SAME live `/effort` inject as every other level — NEVER `/effort ultracode` (R1.2). The
   * `already` guard suppresses a redundant `/effort xhigh` re-inject when ultracode is re-selected while
   * already active.
   *
   * Selecting a real level (or `default`) DEACTIVATES ultracode: clear the flag, remove the scratch keys,
   * then apply that level through {@link applyEffortChange} (whose own no-op guard handles a same-level
   * pick). `applyConfigOptionValue` (the caller, after this returns) commits the selector's currentValue,
   * which for `ultracode` correctly stays `"ultracode"` (the {@link buildConfigOptions} `includes` guard
   * keeps it valid across rebuilds).
   */
  private async applyEffortSelection(session: Session, value: string): Promise<void> {
    if (value === ULTRACODE_EFFORT) {
      const already = session.ultracodeActive === true;
      session.ultracodeActive = true;
      // The gate's per-session SCRATCH settings file is the spawn's `--settings` target; on a live
      // Session it is reachable via `session.gate?.settingsPath` (the value createSession also threads
      // into StartEngineArgs.settingsFile). Absent on a no-gate / resume / replay session → keyword-only.
      const scratchPath = session.gate?.settingsPath;
      if (scratchPath) {
        // Declarative scratch keys for any future (re-)spawn (NOT a re-spawn trigger — Option A).
        await applyUltracodeSettings(scratchPath, true);
      }
      // Effort component is xhigh, applied via the live /effort inject — but only when not already active
      // (re-selecting ultracode must not re-inject `/effort xhigh`). applyEffortChange's own no-op guard
      // also short-circuits if xhigh already equals the current effort.
      if (!already) {
        this.applyEffortChange(session, ULTRACODE_EFFORT_LEVEL);
      }
      return;
    }
    // A real level (or `default`) was chosen → deactivate ultracode before applying it.
    if (session.ultracodeActive) {
      session.ultracodeActive = false;
      const scratchPath = session.gate?.settingsPath;
      if (scratchPath) {
        await applyUltracodeSettings(scratchPath, false);
      }
    }
    this.applyEffortChange(session, value);
  }

  /**
   * Story 046 (R2.2) + Story 056 v4 — apply a reasoning-effort change LIVE via `/effort <level>`.
   * SUPERSEDES the 046 Probe-B re-spawn: `claude` 2.1.195 DOES have a live `/effort <level>` local TUI
   * command (LIVE-VERIFIED — "Set effort level to high…", applied inline, NO "Switch?" dialog unlike
   * /model). So effort now mirrors {@link applyModelSwitch}: a side-channel write, no re-spawn, no turn —
   * which means it ALSO works BEFORE the first interaction (the re-spawn's --resume idle-guard was why
   * effort silently failed pre-first-prompt). Mid-turn it defers (pendingEffortInjection) and flushes
   * when the turn settles. A no-op change applies nothing; effort stays preserved across mode/agent
   * re-spawns (currentEffort → --effort flag), so the spawn-flag path remains as the seed/preserve route.
   */
  private applyEffortChange(session: Session, level: string): void {
    if (level === this.currentEffort(session)) return; // no value change → no-op
    if (session.turnDetector !== undefined) {
      // A turn is in flight — injecting mid-turn corrupts the PTY input. Defer (coalesce, mirrors /model).
      session.pendingEffortInjection = level;
      return;
    }
    this.injectEffortCommand(session, level);
  }

  /**
   * Side-channel `/effort <level>` write — synchronous, resolves immediately (never a turn). Unlike
   * `/model`, `/effort` applies INLINE with no blocking "Switch?" dialog (LIVE-VERIFIED 2.1.195), so
   * sendPrompt's own submit `\r` is sufficient and NO confirm Enter is scheduled.
   */
  private injectEffortCommand(session: Session, level: string): void {
    sendPrompt(session.pty, `/effort ${level}`, (fn) => fn());
  }

  /**
   * Story 073 (R3) — apply a fast-mode toggle LIVE via `/fast on|off`, mirroring {@link applyEffortChange}
   * exactly: a side-channel PTY write, no re-spawn, no turn, works before the first interaction. A no-op
   * (same on/off state) applies nothing; mid-turn it defers (pendingFastInjection) and flushes when the
   * turn settles. `enabled` is the resolved boolean state (story 074 R4.3 — resolveFastModeEnabled maps
   * a boolean payload OR the on/off string to it). NO billing/spawn/credential change (R3.3).
   */
  private applyFastModeChange(session: Session, enabled: boolean): void {
    if (enabled === (session.fastModeOn ?? false)) return; // no state change → no-op
    session.fastModeOn = enabled;
    if (session.turnDetector !== undefined) {
      // A turn is in flight — injecting mid-turn corrupts the PTY input. Defer (mirrors /effort, /model).
      session.pendingFastInjection = enabled;
      return;
    }
    this.injectFastCommand(session, enabled);
  }

  /**
   * Side-channel `/fast on|off` write — synchronous, resolves immediately (never a turn). In claude
   * 2.1.201 `/fast` is a `local-jsx` command: `/fast on|off` opens the "Fast mode (research preview)"
   * confirmation panel (`tengu_fast_mode_picker_shown`) and leaves it OPEN — the arg pre-selects the
   * target but does NOT auto-apply. So, exactly like {@link injectModelCommand}'s "Switch model?"
   * dialog, schedule ONE blind confirm Enter once the panel has rendered; if no panel appears (same
   * state / flag flipped) Enter-on-empty-input is a harmless no-op. (Superseded the earlier INLINE
   * assumption, which left the panel unconfirmed so the toggle never took — story 073 R7.3 live-proof.)
   */
  private injectFastCommand(session: Session, on: boolean): void {
    sendPrompt(session.pty, on ? "/fast on" : "/fast off", (fn) => fn());
    // Confirm the fast-mode panel — blind + scheduled, mirroring the /model "Switch?" confirm.
    this.schedule(() => {
      if (session.engine?.isDisposed) return; // PTY exited meanwhile → nothing to confirm
      session.pty.write("\r");
    }, MODEL_CONFIRM_DELAY_MS);
  }

  /**
   * Story 073 (R1) — (re-)probe fast-mode availability for a session and reconcile the `fast` toggle.
   * On a non-Opus model it forces the toggle OFF/absent WITHOUT probing (R4.1); on an Opus model it
   * consults the injectable {@link FastModeProbe} (production default fails closed), caches the result
   * (R1.3), rebuilds `configOptions`, and emits a `config_option_update` only when the visible option
   * set changes. Fire-and-forget from createSession + the model-switch reconcile (R4.2).
   */
  private async refreshFastMode(sessionId: string, session: Session): Promise<void> {
    const modelOpt = session.configOptions.find((o) => o.id === "model");
    const modelId =
      typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : DEFAULT_MODEL_INFO.value;

    let available: boolean;
    if (!isFastModeCapableModel(modelId)) {
      available = false; // non-Opus → never advertise, never probe (R2.2/R4.1)
    } else {
      try {
        available = await this.fastModeProbe({ pty: session.pty, cwd: session.cwd });
      } catch {
        available = false; // a throwing probe fails CLOSED (R1.2)
      }
    }

    const before = session.fastModeAvailable ?? false;
    session.fastModeAvailable = available;
    if (available === before) return; // no visible change → no rebuild/emit

    session.configOptions = this.rebuildConfigOptionsPreserving(session, modelId);
    // The session may have been torn down while the probe was awaited — guard the emit.
    if (!this.sessions[sessionId]) return;
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
    });
  }

  /** Story 073 — rebuild `configOptions` from the session's current selections (model/effort/agent) plus
   *  the fast-mode state, without re-globbing agents. Used by {@link refreshFastMode}. */
  private rebuildConfigOptionsPreserving(session: Session, modelId: string): SessionConfigOption[] {
    const effortOpt = session.configOptions.find((o) => o.id === "effort");
    const currentEffort =
      typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
    const agentOpt = session.configOptions.find((o) => o.id === "agent");
    const currentAgent =
      typeof agentOpt?.currentValue === "string" ? agentOpt.currentValue : undefined;
    return buildConfigOptions(
      session.modes,
      modelId,
      session.modelInfos,
      currentEffort,
      session.agents ?? [],
      currentAgent,
      session.fastModeAvailable ?? false,
      session.fastModeOn ?? false,
      clientSupportsBooleanConfigOptions(this.clientCapabilities),
    );
  }

  /**
   * Story 056 (R3.3/R3.4) — apply a main-thread agent-persona change. Like effort, the persona has no
   * live mid-session mechanism (`--agent "<name>"` is a spawn flag), so a change re-spawns in place
   * carrying the flag (mirroring {@link applyEffortChange}), idle-guarded, with the R3.7 failure path
   * and the R3.8 latch. A no-op change (same persona, with the "default" sentinel as the no-persona
   * baseline) applies nothing. Throwing here leaves the caller's applyConfigOptionValue unrun, so the
   * prior currentValue is left unchanged on failure (R3.7). Optimistic-on-apply, like effort: there is
   * no transcript drift event for the agent persona, so it is NOT reconciled afterward (R4.3).
   */
  private async applyAgentChange(
    sessionId: string,
    session: Session,
    agent: string,
  ): Promise<void> {
    if (agent === (this.currentAgent(session) ?? "default")) return; // no value change → no-op
    if (session.turnDetector !== undefined || session.respawning) {
      throw new Error(
        "Cannot change agent while the session is busy (a turn is in flight or a re-spawn is underway); retry when idle",
      );
    }
    await this.respawnSession(sessionId, session, { agent });
  }

  /**
   * Story 046 (R4.1/R4.2/R4.3, design §8) — reconcile the `mode` configOption from the latest
   * permission-mode event in the exactly-once `messages` slice. Emits current_mode_update EXACTLY ONCE
   * and only when the transcript's mode differs from the advertised currentModeId (no spurious emit when
   * already in sync, or when no permission-mode event is present). Model/effort have no transcript drift
   * event, so they are NOT reconciled here — optimistic-on-apply only (R4.3).
   */
  private async reconcileModeFromTranscript(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
  ): Promise<void> {
    let latestMode: string | undefined;
    for (const m of messages) {
      const w = m as { type?: string; permissionMode?: unknown };
      if (w.type === "permission-mode" && typeof w.permissionMode === "string") {
        latestMode = w.permissionMode;
      }
    }
    if (latestMode === undefined || latestMode === session.modes.currentModeId) return;
    session.modes = { ...session.modes, currentModeId: latestMode };
    session.configOptions = session.configOptions.map((o) =>
      o.id === "mode" && typeof o.currentValue === "string"
        ? { ...o, currentValue: latestMode }
        : o,
    );
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: latestMode },
    });
  }

  private async replaySessionHistory(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return; // load was torn down before replay (defensive; loadSession just created it)
    // Read via the SAME seam + ordering the live tail pump uses (readOrderedMessages → getSessionMessages,
    // then linearizeTurns), so a LOADED thread orders identically to a LIVE one (story 026 R4.1/R4.2) and
    // an R1.3 SDK-drift error is surfaced loudly rather than swallowed.
    const messages = await readOrderedMessages(sessionId, session.cwd, {
      getMessages: this.getMessages,
    });

    // Emit through the SHARED source+merge+linearize+emit loop the live pump runs — top-level turns
    // (toAcpNotifications + structuredPatch diff + optional usage_update) AND the nested sub-agent rows
    // (story 041) on their spawning Task id. Factoring this single loop is what GUARANTEES loaded == live
    // with no replay-only divergence (R3.2): the replay path cannot drift from the pump because it IS the
    // pump's loop (the same lesson as the story-026 diff and story-038 usage moves into the shared emit).
    //
    // The story-027 anti-double-emit seeding is INHERENT to that loop: it adds each emitted top-level
    // turn's uuid to `session.emitted` and each emitted nested row's uuid to `session.emittedNested`, so a
    // tail pump armed by a resumed/loaded session re-reads the SAME transcript and emits NOTHING new (the
    // gates already hold every replayed uuid). We therefore do NOT pre-seed `emitted` before the loop —
    // doing so would make the loop's own `emitted` gate SUPPRESS replay's main-turn rendering.
    await this.emitLinearizedWithNested(sessionId, session, messages);
  }

  /**
   * Shared per-turn ACP emission used by BOTH the `session/load` replay ({@link replaySessionHistory})
   * and the live tail pump ({@link pumpUpdates}). Emits the message's `toAcpNotifications` updates with
   * `registerHooks:false`; when the turn carries a `toolUseResult`, the story-021 structuredPatch diff
   * (`{type:'diff'}`) attached to the open tool call; and finally the optional, default-OFF UNSTABLE
   * `usage_update` (story 025) with its R8 per-session reject latch. Factoring all three here is what
   * guarantees a LOADED thread renders byte-for-byte like a LIVE one (story 026 R3.3/R4.2): the
   * validate-026 gap was the diff-emission block living only in pumpUpdates, so a replay-only load (no
   * live pump) rendered Edit/Write WITHOUT a diff; story 038 moved usage_update HERE for the SAME
   * reason (loaded==live for usage). Only dedup and the billing guard-rail stay with the callers.
   */
  private async emitTurnUpdates(
    sessionId: string,
    turn: { message: unknown },
    toolUseCache: ToolUseCache,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    const source = turn.message as { message?: { role?: string; content?: unknown } };
    const role = source.message?.role;
    let content: unknown = source.message?.content;
    if (role === "user") {
      content = stripLocalCommandMetadata(content);
      // Pure command-metadata payloads strip to null — nothing to render.
      if (content === null) return;
    }

    // Story 079 (R4): the same JSONL-hydrated `toolUseResult` the diff block reads below, handed to
    // the translator so Read/Bash/Agent/WebSearch render from the structured Output. Undefined on a
    // transcript line that carries no such field — the translator then keeps the raw rendering.
    const turnToolUseResult = (turn.message as { toolUseResult?: unknown }).toolUseResult;

    for (const notification of toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
        toolUseResult: turnToolUseResult,
      },
    )) {
      await this.client.sessionUpdate(notification);
    }

    // Edit/Write diffs (story 021/026): the SDK PostToolUse hook that produced diffs is GONE in the PTY
    // path, so source the diff DIRECTLY from the JSONL `toolUseResult` (structuredPatch + originalFile /
    // content) and emit a `tool_call_update` attached to the already-open tool call (story 019 seam).
    // No-op when the message carries no `toolUseResult` (e.g. the getSessionMessages reduced shape — see
    // the getsessionmessages-reduced-shape follow-up) or the tool is not a renderable Edit/Write. The
    // tool NAME is recovered from the per-pass/per-session toolUseCache.
    const toolUseResult = (turn.message as { toolUseResult?: unknown }).toolUseResult;
    if (toolUseResult !== undefined && Array.isArray(content)) {
      for (const block of content) {
        if (
          block !== null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result" &&
          typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
        ) {
          const toolCallId = (block as { tool_use_id: string }).tool_use_id;
          const name = toolUseCache[toolCallId]?.name;
          const diffUpdate = diffToolCallUpdate(
            classifyDiffSource(name, toolUseResult),
            toolCallId,
          );
          if (diffUpdate) {
            await this.client.sessionUpdate({
              sessionId,
              update: diffUpdate as unknown as SessionNotification["update"],
            });
          }
        }
      }
    }

    // Story 025 (R3.1/R3.2): optional UNSTABLE usage_update, gated OFF by default. A no-op unless
    // the usageUpdate flag is ON and the message carries usage tokens; `size` comes from the
    // session's context window. The flag stays OFF until the live-Zed acceptance probe (Task 3.3).
    // Story 025 (R3.3, R8): once the client rejects a usage_update, latch it off for the session
    // and never re-throw — the surrounding text/thinking/tool-call stream must keep flowing.
    // Story 038: emitted HERE (after toAcpNotifications + diff) — i.e. trailing the turn's content
    // exactly as the live pump did — so a LOADED thread carries usage_update byte-for-byte like a
    // LIVE one (symmetric to the story-026 diff move; the validate-038 gap was that usage lived only
    // in pumpUpdates, so the replay-only load never emitted it).
    if (session && !session.usageDisabled) {
      const carrier = (turn.message as { message?: unknown }).message ?? {};
      // Story 069 (R1) — refine the window from the turn's REAL model (the JSONL `model`), authoritatively
      // correcting the alias seed (e.g. default → claude-opus-4-8[1m] → 1M). A missing / non-string model or
      // an unknown id leaves the current value unchanged (R1.3 — never overwrite with null).
      const realModel = (carrier as { model?: unknown }).model;
      if (typeof realModel === "string" && realModel.length > 0) {
        session.contextWindowSize =
          inferContextWindowFromModelId(realModel) ?? session.contextWindowSize;
      }
      for (const usageUpdate of usageUpdatesFor(carrier as unknown as UsageCarrier, {
        usageUpdate: this.usageUpdate,
        contextWindowSize: session.contextWindowSize,
      })) {
        try {
          await this.client.sessionUpdate({
            sessionId,
            update: usageUpdate as unknown as SessionNotification["update"],
          });
        } catch (err) {
          // R8 detection: an ACP client error on the UNSTABLE notification. Latch off, log once
          // for drift telemetry, and stop — never propagate the rejection into the turn loop.
          session.usageDisabled = true;
          this.logger.error(
            `usage_update rejected by client (R8) — suppressing further usage_update for session ${sessionId}: ${String(err)}`,
          );
          break;
        }
      }
    }

    // Story 081 (R1.1) — reseed the model selector from the turn's REAL model, so a RESUMED session
    // stops advertising `Default` when its transcript ran on another alias. Reads the SAME JSONL
    // `model` story 069 reads three lines up (R3.1 — no new seam); kept OUTSIDE the usage block on
    // purpose, since the selector has nothing to do with whether usage_update is latched off.
    if (session) {
      const modelCarrier = (turn.message as { message?: unknown }).message ?? {};
      await this.reconcileModelSelector(
        sessionId,
        session,
        (modelCarrier as { model?: unknown }).model,
      );
    }
  }

  /**
   * Story 081 — align the `model` configOption with the model a turn ACTUALLY ran on.
   *
   * Same compare-then-rebuild-then-emit-only-on-change shape as {@link refreshFastMode}: an
   * unresolvable id leaves the current seed alone (R2.1), and an id denoting the model already
   * selected emits NOTHING (R1.3). That silence matters — this runs on the LIVE pump as well as the
   * `session/load` replay, so an unguarded version would emit a config_option_update every turn.
   *
   * `default` and `opus` are the SAME model (`model-catalog.ts` — "`default` resolves to the
   * recommended Opus"), so they compare EQUAL here: a `default` seed facing a `claude-opus-*`
   * transcript is already correct, and rewriting it to `opus` would change the visible label without
   * any model having changed.
   */
  private async reconcileModelSelector(
    sessionId: string,
    session: Session,
    rawModel: unknown,
  ): Promise<void> {
    if (typeof rawModel !== "string" || rawModel.length === 0) return;
    const resolved = resolveCatalogValueFromModelId(rawModel);
    if (resolved === null) return; // unknown family → keep the existing seed (R2.1)

    const modelOpt = session.configOptions.find((o) => o.id === "model");
    const current = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : undefined;
    if (current === undefined) return;

    // `default` is an ALIAS for opus — normalise before comparing so the two never fight (R1.3).
    const family = (v: string): string => (v === "default" ? "opus" : v);
    if (family(current) === family(resolved)) return; // same model → nothing visible changed

    session.configOptions = this.rebuildConfigOptionsPreserving(session, resolved);
    // The session may have been torn down mid-await — same guard refreshFastMode uses.
    if (!this.sessions[sessionId]) return;
    await this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
    });
  }

  /**
   * Story 041 (R2.1, R2.2) — build the ACP `tool_call_update`(s) that render ONE nested sub-agent
   * row UNDER its spawning Task tool_call. The nested row's `parent_tool_use_id` is the SPAWNING
   * Task's `tool_use.id`; Zed merges `tool_call_update`s by `tool_call_id` and APPENDS their content
   * (ZED-CLIENT-STUDY §Q2 ev.6: tool calls correlate by id with field-by-field merge, `ContentBlock::append`
   * is pure concatenation), so emitting on the parent id nests the sub-agent's output under the Task.
   *
   * The block→content mapping is NOT re-implemented here: it REUSES the story-018/019/020 translator
   * `toAcpNotifications` (text → agent_message_chunk, thinking → agent_thought_chunk, the sub-agent's
   * own tool_use → tool_call, its tool_result → tool_call_update). We then RE-TARGET that translated
   * output as `ToolCallContent` items on the PARENT id. Consequently the sub-agent's own tool_use /
   * tool_result render as summarized markdown content WITHIN the parent Task tool_call (the tool's
   * title/translated content), NOT as separate top-level `tool_call`s.
   *
   * Returns `[]` (no emission) when `parent_tool_use_id` is missing/null — there is no parent to nest
   * under (a non-sidechain or malformed row). The caller does the dedup / arrival ordering (story 017's
   * uuid-sorted `Turn.nested`); this is a pure builder.
   */
  private nestedUpdatesFor(
    sessionId: string,
    message: SessionMessage,
    toolUseCache: ToolUseCache,
  ): SessionNotification[] {
    const parentId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    // No spawning Task → nothing to nest under. R2: only sidechain rows (those claimed by a Task
    // tool_use) render nested; a row without a parent id is not one.
    if (typeof parentId !== "string" || parentId.length === 0) return [];

    const session = this.sessions[sessionId];
    const source = (message as { message?: { role?: string; content?: unknown } }).message;
    const role = source?.role === "user" ? "user" : "assistant";
    const content = source?.content;
    // No content blocks to translate (reduced shape may omit them) → nothing to emit.
    if (content === undefined || content === null) return [];

    // REUSE the 018/019/020 translators. `registerHooks:false` — replay/nested emission must not arm
    // live PostToolUse hooks (same contract as emitTurnUpdates). The sub-agent's own tool_use/tool_result
    // pass through their OWN cache so the translator's tool_call→tool_call_update lifecycle is internally
    // consistent; we discard the cache afterwards (it is never the parent's cache — the sub-agent's ids
    // are not surfaced top-level).
    const translated = toAcpNotifications(
      // @ts-expect-error - message.content/role are untyped in the reduced SDK shape
      content,
      role,
      sessionId,
      toolUseCache,
      this.client,
      this.logger,
      {
        registerHooks: false,
        clientCapabilities: this.clientCapabilities,
        cwd: session?.cwd,
        taskState: session?.taskState,
        // Story 079 (R4): a nested sidechain row carries its own hydrated `toolUseResult`, so the
        // sub-agent's Read/Bash results render structured too.
        toolUseResult: (message as { toolUseResult?: unknown }).toolUseResult,
      },
    );

    // Re-target every translated update as `ToolCallContent` on the PARENT id. A `tool_call_update`
    // replaces the content collection (ToolCallUpdate.content semantics), and Zed APPENDS across
    // successive updates by id — so emit one nesting `tool_call_update` per translated update to
    // preserve arrival order without clobbering earlier nested content.
    const out: SessionNotification[] = [];
    for (const notification of translated) {
      const nestedContent = this.toNestedContent(notification.update);
      if (nestedContent.length === 0) continue;
      out.push({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: parentId,
          content: nestedContent,
          _meta: { claudeCode: { parentToolUseId: parentId } },
        } as unknown as SessionNotification["update"],
      });
    }
    return out;
  }

  /**
   * Story 041 (R2.2) — fold one translated nested update into `ToolCallContent[]` for nesting under
   * the parent Task. Message/thought chunks contribute their ContentBlock directly. The sub-agent's
   * OWN tool_use/tool_result (a `tool_call`/`tool_call_update` from the translator) are SUMMARIZED as
   * markdown content within the parent — never re-emitted as a separate top-level tool_call: we take
   * the tool's human-readable `title` (a bold markdown line) plus any `content` the story-019 translator
   * already produced. `plan` and other non-content updates carry nothing renderable as nested content
   * and are dropped.
   */
  private toNestedContent(update: SessionNotification["update"]): ToolCallContent[] {
    const u = update as {
      sessionUpdate?: string;
      content?: unknown;
      title?: unknown;
    };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk":
        // `content` here is a single ContentBlock ({type:"text",text} etc.) — wrap it as ToolCallContent.
        return u.content ? [{ type: "content", content: u.content } as ToolCallContent] : [];
      case "tool_call":
      case "tool_call_update": {
        // The sub-agent's own tool — summarize as markdown WITHIN the parent. Bold the tool title
        // (e.g. the Bash command surfaced by toolInfoFromToolUse) and append any translated content
        // (e.g. a tool_use's `prompt`, or a tool_result's rendered output).
        const acc: ToolCallContent[] = [];
        if (typeof u.title === "string" && u.title.length > 0) {
          acc.push({
            type: "content",
            content: { type: "text", text: `**${u.title}**` },
          } as ToolCallContent);
        }
        if (Array.isArray(u.content)) {
          for (const item of u.content) acc.push(item as ToolCallContent);
        }
        return acc;
      }
      default:
        // plan / current_mode_update / usage_update / … — not renderable as nested content.
        return [];
    }
  }

  /**
   * Tail-driven update pump (story 023 Groups 2-3). Fired on each watcher signal: re-reads the
   * transcript LIVE via getSessionMessages (E5 REUSE-live, billing-free), linearizes via story 017,
   * and emits each not-yet-emitted turn through the reused `toAcpNotifications` (Edit/Write diffs are
   * sourced from `structuredPatch` by tools.ts — story 021). Ordering is the linear order story 017
   * returns (no re-ordering); idempotency across overlapping/prefix re-reads comes from the
   * per-session `emitted` uuid set (R3.3/R3.4). The JSONL tail is the single source of truth — there
   * is NO SDK message stream. The end-of-turn predicate is story 024; this only consumes the signal.
   */
  private async pumpUpdates(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return; // watcher fired before the handle was registered, or after teardown

    // Story 046 (R3.4 LIVE FIX): the pump only fires once the watcher has armed against the REAL
    // transcript, so reaching here proves the transcript exists (the first interaction happened). Mark
    // it idempotently — respawnSession gates the --resume re-spawn on this (a pre-interaction re-spawn
    // would --resume a non-existent transcript and fall back to a new untracked id).
    session.interacted = true;

    const messages = await readOrderedMessages(sessionId, session.cwd, {
      getMessages: this.getMessages,
    });

    // §10 billing guard-rail (story 022, Group 4.1), GOOD-FAITH: on the first batch, assert the
    // observed `entrypoint` is the subscription `cli` class and ABORT the session on a credit/`sdk-*`
    // entrypoint. We only act when the JSONL actually CARRIES an entrypoint — getSessionMessages'
    // reduced shape frequently omits it, and the PRIMARY protection is the spawn-time env-sanitize
    // (story 013). The entrypoint is NEVER rewritten/forced (forging it to 'cli' would be evasion).
    if (!session.guardChecked) {
      session.guardChecked = true;
      const firstBilling = messages.find((m) => {
        const w = m as WatchedMessage;
        return (
          (w.type === "assistant" || w.type === "user") &&
          typeof w.entrypoint === "string" &&
          w.entrypoint.length > 0
        );
      });
      if (firstBilling) {
        let aborted = false;
        guardEvent(firstBilling as WatchedMessage, {
          alert: (m) => this.logger.error(m),
          stopSession: () => {
            aborted = true;
          },
        });
        if (aborted) {
          await this.teardownSession(sessionId);
          return; // billed entrypoint — abort the session, emit nothing
        }
      }
    }

    // === SEAM(030) — feed the in-flight turn detector (R5.1). `readOrderedMessages` returns the FULL
    // monotonic ordered superset on every re-read (engine-watcher.ts), so we slice past a per-session
    // high-water cursor to feed each raw message to the detector exactly once, in order — a prior
    // turn's terminal boundary is never re-observed. The detector reads `message.stop_reason` off raw
    // assistant messages and resolves the pending `session/prompt`. Purely additive: this does NOT
    // change the emit loop below or the §10 guard-rail above.
    const fed = messages.slice(session.detectorCursor ?? 0);
    session.detectorCursor = messages.length;
    if (session.turnDetector) {
      for (const m of fed) session.turnDetector.observe(m as never);
    }

    // === SEAM(034) §9 — feed the gate's tool_use.id correlation map from the SAME exactly-once
    // slice the detector consumes: every newly-observed assistant `tool_use` block registers its id
    // so a PreToolUse hook call can be matched to a REAL transcript tool_use before it is approved
    // (request-permission fails closed on a missing/duplicate id). Registration is additive — it
    // emits nothing and never blocks the pump.
    if (session.gate) {
      for (const m of fed) registerGateToolUses(m, session.gate);
    }

    // === SEAM(046) §8 — reconcile the `mode` configOption from transcript permission-mode events.
    // `permission-mode` is lifecycle-classified (event-switch.ts) and emits no SessionUpdate of its own,
    // and there is no other transcript-driven mode consumer — so intercept it HERE, over the SAME
    // exactly-once `fed` slice the detector/gate consume. If the latest permission-mode event's mode
    // differs from the advertised currentModeId, reconcile the mode configOption currentValue and emit
    // current_mode_update EXACTLY ONCE (covers a manual Shift+Tab in a mirrored TUI, plan-approval, and
    // the R3.4 re-spawn). Model and effort have NO transcript drift event — they stay optimistic-on-apply
    // (R4.3, documented). Additive: it never blocks the emit loop below.
    await this.reconcileModeFromTranscript(sessionId, session, fed);

    // === SEAM(041) §sidechain — source + merge + linearize + emit (BOTH main turns and nested
    // sub-agent rows). Factored into the shared {@link emitLinearizedWithNested} so the `session/load`
    // replay path (`replaySessionHistory`) runs the IDENTICAL loop — loaded == live with no replay-only
    // divergence (R3.2; mirrors why the story-026 diff and story-038 usage moved into `emitTurnUpdates`).
    // The merge MUST NOT reach the detector / §10 guard / §9 gate above — those already consumed the
    // un-merged `messages` slice exactly-once (R4.1 structural: sub-agent rows never advance
    // `detectorCursor` nor register as gate tool_uses).
    await this.emitLinearizedWithNested(sessionId, session, messages);

    // === SEAM(054) — feed the gate correlator from the sidechain rows (R3). Gated + LIVE-ONLY: runs
    // only with a present, non-torndown gate, and NEVER inside the shared emitLinearizedWithNested that
    // session/load replay also calls — so replay stays pure (U3). Additive: touches only the correlator +
    // the per-session dedup Set/parentMap, never emittedNested nor the detector cursor (U2/U5).
    if (session.gate && !session.gate.isTorndown) {
      const subagentRows = await sourceSubagentRows(sessionId, messages, {
        dir: session.cwd,
        listSubagents: this.listSubagents,
        getSubagentMessages: this.getSubagentMessages,
      });
      session.registeredSidechain ??= new Set<string>();
      session.sidechainParentMap ??= new Map<string, SidechainToolUse>();
      registerSidechainGateToolUses(
        collectSidechainToolUses(subagentRows),
        session.gate.correlator,
        session.registeredSidechain,
        session.sidechainParentMap,
      );
    }

    // === SEAM(044) — Option-B sub-agent watcher: arm/refresh/teardown rides the MAIN-CHAIN spawn
    // signal (`hasSubagentSpawn` + `spawnIdsOpen` over the FULL pumped messages — design key
    // decision 4: NOT the detector's `openTaskIds`, the very inference that failed live in the
    // 041 R4.2 acceptance; scanning the full chain each pump is robust to cursor/slice effects).
    // While armed, the watcher polls the story-041 SDK sidechain readers; its `onActivity` (fired
    // only on a NEW-uuid sub-agent row) feeds BOTH liveness — the in-flight detector's
    // `noteActivity()` (R1.1) — and the incremental render: a re-run of the UNCHANGED idempotent
    // {@link emitLinearizedWithNested}, whose per-row `emittedNested` dedup guarantees at-most-once
    // nested emit (R3.1/R3.2). `this.schedule` is the story-030 single timer seam, so ONE fake
    // clock drives prompt + detector + watcher in tests. Flag OFF → nothing arms: byte-for-byte
    // today's pull-only path (R4.2).
    session.lastMessages = messages;
    if (this.liveSubagentWatch) {
      if (!session.subagentWatcher && hasSubagentSpawn(messages) && spawnIdsOpen(messages)) {
        session.subagentWatcher = createSubagentWatcher({
          sessionId,
          dir: session.cwd,
          mainChain: messages,
          listSubagents: this.listSubagents,
          getSubagentMessages: this.getSubagentMessages,
          schedule: this.schedule,
          onActivity: async () => {
            session.turnDetector?.noteActivity();
            await this.emitLinearizedWithNested(
              sessionId,
              session,
              session.lastMessages ?? messages,
            );
          },
        });
      } else if (session.subagentWatcher) {
        session.subagentWatcher.update(messages);
        if (!spawnIdsOpen(messages)) {
          // R2.2: every spawn id on the chain is CLOSED — the sidechain is finished; stop polling.
          session.subagentWatcher.stop();
          session.subagentWatcher = undefined;
        }
      }
    }
  }

  /**
   * Story 041 (R3.1, R3.2) — the SHARED source+merge+linearize+emit loop run by BOTH the live tail pump
   * ({@link pumpUpdates}) and the `session/load` replay ({@link replaySessionHistory}), so a LOADED
   * thread emits the nested sub-agent rows BYTE-IDENTICALLY to a LIVE one (no replay-only divergence —
   * the validate-026 lesson: any emit path living only in the pump silently diverges on a replay-only
   * load). Steps:
   *
   *   1. `sourceSubagentRows` — GUARDED (R5.2): returns `[]` WITHOUT touching disk when the main chain
   *      carries no `Task`/`Agent` `tool_use`, so the common no-subagent turn pays nothing and
   *      `forLinearize === messages` (identical-to-pre-change behavior).
   *   2. Merge the sidechain rows onto the main chain ONLY for linearization — story 017 groups each
   *      sub-agent row onto its spawning turn's uuid-sorted `Turn.nested`.
   *   3. Per turn: emit the main content behind the UNCHANGED `emitted` gate (a not-yet-emitted
   *      top-level turn renders through `emitTurnUpdates` — toAcpNotifications + structuredPatch diff +
   *      the optional usage_update); then the DECOUPLED nested pass (per-row `emittedNested` dedup, R2.3)
   *      emits each sub-agent row's `tool_call_update`s on the spawning Task's id (R3.1) — this runs EVEN
   *      when the parent uuid is already in `emitted`, so a late-arriving sub-agent row still surfaces.
   *
   * The detector / §10 guard / §9 gate feed is NOT part of this helper — it is pump-only and stays on the
   * un-merged main chain in the caller (sub-agent rows must never advance the detector cursor or register
   * as gate tool_uses). The replay caller has no detector/gate feed, so it simply does not run one.
   */
  private async emitLinearizedWithNested(
    sessionId: string,
    session: Session,
    messages: SessionMessage[],
  ): Promise<void> {
    const subagentRows = await sourceSubagentRows(sessionId, messages, {
      dir: session.cwd,
      listSubagents: this.listSubagents,
      getSubagentMessages: this.getSubagentMessages,
    });
    const forLinearize = subagentRows.length ? messages.concat(subagentRows) : messages;

    for (const turn of linearizeTurns(forLinearize)) {
      // Main content — UNCHANGED `emitted` gate: a not-yet-emitted top-level turn renders through the
      // shared per-turn emission (toAcpNotifications + structuredPatch diff + the optional usage_update),
      // so live and loaded render byte-for-byte the same (story 026 R3.3; story 038 moved usage_update
      // into the shared emit).
      if (!(turn.uuid && session.emitted.has(turn.uuid))) {
        await this.emitTurnUpdates(sessionId, turn, session.toolUseCache);
        if (turn.uuid) session.emitted.add(turn.uuid);
      }

      // Nested sub-agent rows — DECOUPLED dedup (R2.3). This pass runs EVEN when `turn.uuid` is already
      // in `session.emitted`, so a sub-agent row that arrived AFTER its spawning turn was emitted (in an
      // earlier pump) still surfaces. Dedup is per-row via `emittedNested`, independent of the parent
      // gate. Each nested row's `tool_call_update`s (built by the pure `nestedUpdatesFor`, story 041 task
      // 2.1) target the spawning Task's id so the sub-agent renders UNDER the Task (R3.1).
      for (const nested of turn.nested ?? []) {
        const nuid = (nested as { uuid?: string }).uuid;
        if (nuid && session.emittedNested.has(nuid)) continue;
        for (const note of this.nestedUpdatesFor(sessionId, nested, session.toolUseCache))
          await this.client.sessionUpdate(note);
        if (nuid) session.emittedNested.add(nuid);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    // === SEAM(023) Group 1: `available_commands_update`. Historically the SDK
    // `query.supportedCommands()` was dropped (slash commands are owned by the interactive TUI and are
    // not enumerable over the read-only JSONL path), so Degrau-1 emitted a static empty set.
    // Story 063 (R1/R1.1) now POPULATES this set OFFLINE from disk — `discoverCommands(session.cwd)`
    // scans the cwd/user `.claude/{commands,skills}`, the enabled-plugin surfaces, and the built-in
    // tier — instead of the unconditional `[]`. Discovery is SYNCHRONOUS but the 4 call-sites invoke
    // this method fire-and-forget (`setTimeout(0)`), so it never blocks session creation (R4).
    // Degrau 2 (030/032): PTY-backed control — surface the TUI's real live command set. ===
    let availableCommands: AvailableCommand[];
    try {
      availableCommands = this.discoverCommands(session.cwd);
    } catch {
      availableCommands = []; // R4 — discovery must NEVER crash the session; degrade to []
    }
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === "mode") {
      session.modes = { ...session.modes, currentModeId: value };
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === "model") {
      // Model state lives in the configOptions "model" option (the legacy
      // SessionModel surface was removed in the 0.25.0 migration). Read the
      // previous value from that option before the rebuild below repoints it.
      const modelOption = session.configOptions.find((o) => o.id === "model");
      const previousModelId =
        typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined;
      if (previousModelId !== value) {
        // The cached context window was learned for the previous model; reset
        // to the new model's heuristic so mid-stream updates between now and
        // the next `result` reflect the user's selection instead of the old
        // model's window.
        session.contextWindowSize = inferContextWindowFromModel(value) ?? DEFAULT_CONTEXT_WINDOW;
      }

      // Recompute availableModes for the new model and clamp the current
      // mode if the SDK no longer offers it (today: "auto" on Haiku).
      // `ModelInfo.supportsAutoMode` is the canonical SDK signal.
      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      const newAvailableModes = buildAvailableModes(
        newModelInfo,
        session.allowBypass ?? ALLOW_BYPASS,
      );
      // Capture BEFORE mutating session.modes so the log message reflects
      // the invalidated mode rather than "default".
      const previousModeId = session.modes.currentModeId;
      let modeDowngraded = false;
      if (!newAvailableModes.some((m) => m.id === previousModeId)) {
        session.modes = {
          availableModes: newAvailableModes,
          currentModeId: "default",
        };
        // === SEAM(023) Group 1: read-only Degrau-1 shim — local-state downgrade only; the SDK
        // `query.setPermissionMode("default")` sync is dropped.
        // Degrau 2 (030/032): PTY-backed control. ===
        modeDowngraded = true;
      } else {
        session.modes = { ...session.modes, availableModes: newAvailableModes };
      }

      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === "effort");
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      // Story 056 (R3.2): preserve the `agent` option across a model switch — re-read its current
      // value and rebuild from the session's stored catalog (no re-glob). `session.agents ?? []`
      // keeps the option absent when none were discovered (the gate).
      const agentOpt = session.configOptions.find((o) => o.id === "agent");
      const currentAgent =
        typeof agentOpt?.currentValue === "string" ? agentOpt.currentValue : undefined;
      // Story 073 (R4.1) — a model switch turns fast mode OFF and drops its availability (mirroring the
      // CLI's "switching to other models turns off fast mode"). The rebuild below therefore omits the
      // toggle; if the new model is Opus, refreshFastMode (kicked off after) re-probes and re-advertises.
      if (previousModelId !== value) {
        session.fastModeOn = false;
        session.fastModeAvailable = false;
      }
      session.configOptions = buildConfigOptions(
        session.modes,
        value,
        session.modelInfos,
        currentEffort,
        session.agents ?? [],
        currentAgent,
        session.fastModeAvailable ?? false,
        session.fastModeOn ?? false,
        clientSupportsBooleanConfigOptions(this.clientCapabilities),
      );

      // Story 073 (R4.2) — on a switch TO an Opus model, re-run availability detection out of band and
      // re-advertise the toggle (as off) when available. Fire-and-forget: the synchronous response above
      // ships without the toggle; refreshFastMode emits a follow-up config_option_update once it settles.
      if (previousModelId !== value && isFastModeCapableModel(value)) {
        void this.refreshFastMode(sessionId, session);
      }

      // === SEAM(023) Group 1: the SDK effort sync (query.applyFlagSettings) after a model switch is
      // dropped — configOptions already reflects the new effort locally.
      // Degrau 2 (030/032): PTY-backed control. ===

      // Emit current_mode_update only after session.modes AND
      // session.configOptions have been fully reconciled. This way, a failure
      // in the configOptions/effort rebuild above can't leave the client with
      // a clamped currentModeId but stale configOptions, and the notification
      // still precedes the caller's config_option_update so order-sensitive
      // clients update currentModeId before re-rendering the option list.
      if (modeDowngraded) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      // === SEAM(023) Group 1: read-only Degrau-1 shim — local config update only; the SDK
      // `query.applyFlagSettings` effort sync is dropped.
      // Degrau 2 (030/032): PTY-backed control. ===
    }
  }

  private async getOrCreateSession(
    params: {
      sessionId: string;
      cwd: string;
      mcpServers?: NewSessionRequest["mcpServers"];
      additionalDirectories?: NewSessionRequest["additionalDirectories"];
      _meta?: NewSessionRequest["_meta"];
    },
    opts: { replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        };
      }

      // Session-defining params changed (e.g. cwd pointed at a git worktree,
      // or MCP servers reconfigured). Tear down the existing session and
      // recreate it so the underlying Query process picks up the new values.
      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        replayOnly: opts.replayOnly,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    };
  }

  // === SEAM(023) Group 1 (REWRITE): createSession — PTY engine + JSONL tail, NOT the SDK query().
  //
  // Spawns the subscription `claude` TUI under a managed PTY (story 013/014), starts the read-only
  // JSONL tail watcher (story 015), locates the transcript by sessionId glob (file-discovery
  // watchdog 2000ms) and reads the runtime cwd from INSIDE the JSONL (never decoding the dir name).
  // Builds models/modes/configOptions from STATIC Degrau-1 defaults (no SDK initializationResult).
  // Registers a per-session handle (pty + watcher + emitted Set + engine) and returns the ACP
  // NewSessionResponse shape. NO SDK `query()`/`getAvailableModels`/`q.*`/SDK-embedded binary path here.
  // The ACP pump that forwards new JSONL messages to the client is Group 2. ====================
  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean; replayOnly?: boolean } = {},
  ): Promise<NewSessionResponse> {
    // Allocate the REQUESTED session id (resume/fork branching preserved). For a fresh session this
    // is a freshly-generated v4 id, but the engine's PTY spawn (story 013) generates the
    // AUTHORITATIVE id that correlates to the JSONL transcript basename — that engine-spawn id wins
    // and becomes the session key (see `startedSessionId` below). A resume reattaches to the prior id.
    let requestedSessionId: string;
    const isResume = !!creationOpts.resume && !creationOpts.forkSession;
    if (creationOpts.forkSession) {
      requestedSessionId = randomUUID();
    } else if (creationOpts.resume) {
      requestedSessionId = creationOpts.resume;
    } else {
      requestedSessionId = randomUUID();
    }

    // Story 057 (R1.3/R3.1): resolve the additional-directory list ONCE (always-on, no env gate) so
    // the SAME value threads to the spawn AND is stored on the session record (sub-task 2.3's
    // respawnSession re-threads it). The fingerprint resolves through the same helper — see below.
    const additionalDirs = resolveAdditionalDirs(params);

    // Story 057 (R2.2/R2.3, sub-task 2.3): WRITE the MCP scratch BEFORE the spawn when the session
    // declared ≥1 MCP server. Mirrors the gate's settings-scratch ordering (GATE_FINDINGS blocker c):
    // the file must be ON DISK before claude starts, because claude reads `--mcp-config` only at
    // startup. A replay-only load spawns nothing → no scratch. Always-on (no `FORK_*` gate, R3.1);
    // the ONLY condition is "mcpServers non-empty". The path is threaded into startEngine below and
    // stored on the session record (teardown removal + re-spawn regeneration). Awaited so a write
    // failure surfaces here (loudly) rather than racing the spawn. Never logged (R2.3).
    let mcpConfigFile: string | undefined;
    if (!creationOpts.replayOnly && params.mcpServers && params.mcpServers.length > 0) {
      mcpConfigFile = await writeMcpScratch(translateMcpServers(params.mcpServers));
    }

    // SettingsManager is retained (kept methods read it; teardown disposes it). The PTY TUI reads
    // the user's settings from disk itself — we no longer translate them into SDK `Options`.
    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    // Story 046 (R3.1/R3.6, choose-before-start): seed the permission mode from
    // settings.permissions.defaultMode, normalized through resolvePermissionMode (returns "default"
    // on undefined/invalid AND strips bypassPermissions under the root guard — so R3.1 reconciles
    // with R3.6). Drives both the spawn flag (--permission-mode, fresh path) and the advertised
    // currentModeId, replacing the old hardcoded "default".
    // Upstream #1165: bypass is also off when any settings tier sets
    // permissions.disableBypassPermissionsMode to "disable" (the CLI refuses it then too). Decided
    // once here: it gates the defaultMode seed, the advertised catalog, and therefore every later
    // set_mode / set_config_option request for bypass (applySessionMode checks the catalog).
    const allowBypass = sessionAllowsBypass(settingsManager.getSettings().permissions);
    const seededMode = resolvePermissionMode(
      settingsManager.getSettings().permissions?.defaultMode,
      this.logger,
      allowBypass,
    );

    // Per-session task state — still surfaced via plan notifications by the Group 2 pump / hooks.
    const taskState: TaskState = new Map();

    // === SEAM(034) §9 hybrid gate: set up the per-session permission gate BEFORE the spawn =======
    // FRESH spawns only (the resume argv is not extended — the story-029 planMode precedent — and a
    // replay-only load spawns nothing). Ordering is load-bearing (GATE_FINDINGS blocker c): the
    // loopback hook server must be LIVE and the scratch settings ON DISK before claude starts,
    // because claude reads settings only at startup — a late write misses the first tool call.
    // Setup is fast (one port bind + one tmp-file write) so the story-028 fast-boot contract holds.
    // On a setup failure createSession FAILS LOUDLY rather than spawning an ungated claude that
    // looks gated (the blocker-b hazard); `FORK_GATE=off` is the documented escape hatch.
    const isFreshSpawn = !isResume && !creationOpts.forkSession && !creationOpts.replayOnly;
    let gate: SessionGate | undefined;
    if (this.gateEnabled && isFreshSpawn) {
      gate = await setupSessionGate({
        ...this.gateOptions,
        client: this.client,
        // Story 065 (R1/R3): negotiated in initialize() from clientCapabilities.elicitation.form. When
        // true the gate drives AskUserQuestion through a real ACP form elicitation; when false it keeps
        // the story-064 fail-closed deny-guard. this.client (AgentSideConnection) already satisfies the
        // broadened client type (it has createElicitation).
        clientSupportsElicitationForm: this.clientSupportsElicitationForm,
        onWarn: (m) => this.logger.error(m),
      });
    }

    // Spawn the PTY engine + start the JSONL watcher + locate the transcript via the injectable
    // seam. For a fresh session `sessionId` is undefined so the engine's spawn generates it; for
    // resume/fork we hand it the requested id. A failed resume (transcript never found by the
    // file-discovery watchdog) surfaces as resourceNotFound so the client can recover.
    let started: StartedEngine;
    try {
      started = await this.startEngine({
        sessionId: isResume || creationOpts.forkSession ? requestedSessionId : undefined,
        cwd: params.cwd,
        resume: isResume || !!creationOpts.forkSession,
        replayOnly: creationOpts.replayOnly,
        sessions: this.engines,
        onEvent: (sid) => void this.pumpUpdates(sid),
        // Story 046 (R3.1/R3.2): seed the fresh spawn with the resolved permission mode (the resume
        // path's mode is carried by the R3.4 re-spawn argv, not here).
        permissionMode: seededMode,
        // Story 034: the gate's scratch settings file, consumed as `--settings "<file>"` (fresh path).
        settingsFile: gate?.settingsPath,
        // Story 057 (R1.3/R3.1): the resolved additional-directory list → `--add-dir` on the spawn
        // (always-on; the engine sanitizes per-dir). Same list stored on the session record below.
        additionalDirectories: additionalDirs,
        // Story 057 (R2.2): the MCP scratch path (written above) → `--mcp-config "<file>"` on the
        // spawn. Same path stored on the session record below (teardown removal + re-spawn regen).
        mcpConfigFile,
      });
    } catch (error) {
      // A failed spawn must not leak the gate's server/scratch (story 034). teardown() is
      // idempotent and self-catching; the original spawn error stays the surfaced one.
      // The settingsManager leaks here too (pre-existing: its fs.watch subscriptions held the
      // process open — exposed by the story-034 gate-wiring spawn-failure test): the session never
      // reaches the map, so teardownSession can never dispose it. Dispose it on this path.
      settingsManager.dispose();
      await gate?.teardown();
      // Story 057 (R2.3): a failed spawn must likewise leave NO MCP scratch behind (it was written
      // before startEngine). removeMcpScratch is idempotent + never throws, so it cannot mask the
      // original spawn error rethrown below.
      if (mcpConfigFile) {
        await removeMcpScratch(mcpConfigFile);
      }
      if (creationOpts.resume && error instanceof Error) {
        throw RequestError.resourceNotFound(requestedSessionId);
      }
      throw error;
    }

    const startedSessionId = started.sessionId;
    if (started.engine) {
      this.engines.set(startedSessionId, started.engine);
    }

    // === SEAM(034): bind the gate to the AUTHORITATIVE session id (engine-spawn-generated) and the
    // live PTY. The nudge forces a pump re-read on every hook arrival, shrinking the JSONL
    // tool_use-correlation race; the PTY binding powers the #52822 allow keystroke + prompt probe.
    // Binding happens BEFORE this method returns the sessionId to Zed, so no `session/prompt` (and
    // therefore no PreToolUse) can ever observe an unbound gate. PTY exit also tears the gate down
    // (idempotent with teardownSession) so a crashed TUI leaks no port/server/scratch.
    if (gate) {
      const boundGate = gate;
      // Story 054 — the third arg is a LAZY subagent relay resolver: at decide()-time it reads the
      // session's sidechainParentMap (populated by the pump) to map an inner tool_use id to its parent
      // Task id + a derived label, so the gate relays a subagent tool's dialog under the parent Task
      // (R1/R2) or fails loud (R4). A main-chain id (no map entry) returns undefined → unchanged (U1).
      boundGate.bindSession(
        startedSessionId,
        () => void this.pumpUpdates(startedSessionId),
        (innerId) => {
          const s = this.sessions[startedSessionId];
          const entry = s?.sidechainParentMap?.get(innerId);
          if (!entry) return undefined;
          return {
            parentId: entry.parentId,
            subagentLabel: deriveSubagentLabel(s?.lastMessages ?? [], entry.parentId) ?? "subagent",
          };
        },
        // FIX(watchdog-permission): re-arm the end-of-turn watchdog while a permission dialog is open,
        // so a slow human decision (JSONL silent meanwhile) is not mistaken for a dead turn.
        () => this.sessions[startedSessionId]?.turnDetector?.noteActivity(),
      );
      boundGate.bindPty(started.pty as unknown as GatePty);
      started.pty.onExit(() => void boundGate.teardown());
    }

    // Story 046: advertise the full curated model catalog (was a single static "Default" entry),
    // with the current model seeded to the safe `default`. Populating the catalog also unlocks the
    // effort selector via buildConfigOptions (§5/§7). The current MODE is still seeded "default" here;
    // Task 4.1 reseeds it from settings.permissions.defaultMode.
    // The picker is READ FROM THE CLI, not curated here: the catalogue is served by
    // the backend and was measured changing shape twice in one day, so any list
    // written down goes stale silently. Falls back to the static MODEL_CATALOG on
    // any failure — see live-model-catalog.ts. `default` is present in both, which
    // is why the seed below can stay a constant.
    const liveModelCatalog = await resolveModelCatalog(this.logger);
    const availableModes = buildAvailableModes(DEFAULT_MODEL_INFO, allowBypass);
    const modes: SessionModeState = {
      currentModeId: seededMode,
      availableModes,
    };
    // Story 056 (R3.2): discover the main-thread agent personas for THIS session's cwd (glob-only via
    // the injectable seam). When ≥1 is found, buildConfigOptions surfaces the 4th `agent` dropdown
    // (seeded "default" = no persona at fresh create); when none, the option is omitted. The catalog
    // is stored on the session record below so the model-change reconcile rebuilds it WITHOUT
    // re-globbing.
    const agents = this.discoverAgents(params.cwd);
    const configOptions = buildConfigOptions(
      modes,
      DEFAULT_MODEL_INFO.value,
      liveModelCatalog,
      settingsManager.getSettings().effortLevel,
      agents,
      undefined,
    );

    // Runtime cwd is read from inside the JSONL (story 015); fall back to the requested host cwd
    // until the first transcript line carries `.cwd` (the seam may return cwd === undefined early).
    const runtimeCwd = started.cwd ?? params.cwd;

    this.sessions[startedSessionId] = {
      pty: started.pty,
      watcher: started.watcher,
      emitted: new Set<string>(),
      emittedNested: new Set<string>(),
      toolUseCache: {},
      guardChecked: false,
      usageDisabled: false,
      engine: started.engine,
      cancelled: false,
      cwd: runtimeCwd,
      // Story 057 (R1.3): the resolved additional-directory list, stored so sub-task 2.3's
      // respawnSession can re-thread the SAME `--add-dir` scope into the in-place re-spawn.
      additionalDirectories: additionalDirs,
      // Story 057 (R2.3/R2.4): the CURRENT MCP scratch path (for teardown removal + re-spawn regen)
      // and the RAW ACP server array (so respawnSession can re-translate + regenerate the scratch).
      mcpConfigFile,
      mcpServers: params.mcpServers,
      sessionFingerprint: computeSessionFingerprint(params),
      settingsManager,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes,
      modelInfos: liveModelCatalog,
      allowBypass,
      agents,
      configOptions,
      contextWindowSize:
        inferContextWindowFromModel(DEFAULT_MODEL_INFO.value) ?? DEFAULT_CONTEXT_WINDOW,
      taskState,
      gate,
    };

    // Story 073 (R1) — the seed model is Opus (`default`), so probe fast-mode availability out of band
    // and advertise the toggle when available. Fire-and-forget (like sendAvailableCommandsUpdate): the
    // response below ships the seed options; refreshFastMode emits a follow-up config_option_update. The
    // production probe fails closed, so today's stream is byte-for-byte unaffected until the spike wires it.
    void this.refreshFastMode(startedSessionId, this.sessions[startedSessionId]);

    return {
      sessionId: startedSessionId,
      modes,
      configOptions,
    };
  }
}

/**
 * Build the list of permission modes the agent will advertise for the given
 * model. `auto` is gated by `ModelInfo.supportsAutoMode === true`, which is
 * the SDK's model-level availability signal. `undefined`/`false` both exclude
 * `auto`. `bypassPermissions` is gated by the per-session `allowBypass`
 * ({@link sessionAllowsBypass}: `ALLOW_BYPASS` and not disabled by settings).
 */
function buildAvailableModes(
  modelInfo: ModelInfo | undefined,
  allowBypass: boolean,
): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  // `_meta.kind` is ported from upstream #1025 (REBASE-AND-DRIFT.md §15.5): a coarse
  // classification a client can style or group by, alongside the free-text description.
  // Only the CATALOGUE ports — upstream applies the mode through `query.setPermissionMode`,
  // which is CUT here (SEAM-MAP); this engine keeps its own story-032 gate path.
  //
  // Names and descriptions are deliberately NOT taken from upstream. Upstream renamed
  // "Default" to "Manual" in the same commit; adopting that here would change the label
  // Zed already shows without changing behaviour, and the alias row above already accepts
  // "manual" on the way in. Wire ids are what both sides agree on.

  // Only advertise "auto" when the SDK reports the model supports it.
  if (modelInfo?.supportsAutoMode === true) {
    modes.push({
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts",
      _meta: { kind: "auto_review" },
    });
  }

  modes.push(
    {
      id: "default",
      name: "Default",
      description: "Standard behavior, prompts for dangerous operations",
      _meta: { kind: "standard" },
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
      _meta: { kind: "standard" },
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
      _meta: { kind: "plan" },
    },
    {
      // No `_meta.kind`, matching the decision `claude-agent-fork` reached independently
      // for the same mode: upstream's four kinds all describe a mode that ASKS or
      // AUTO-APPROVES, and `dontAsk` DENIES instead. Claiming any of them would assert a
      // semantic upstream has not defined. `dontAsk` is absent from upstream's catalogue
      // entirely — it is a Claude Code mode, and omitting the key is how that shows.
      id: "dontAsk",
      name: "Don't Ask",
      description:
        "Don't prompt for permissions, deny if not pre-approved. Selecting this restarts the session.",
    },
  );

  if (allowBypass) {
    modes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks. Selecting this restarts the session.",
      _meta: { kind: "full_access" },
    });
  }

  return modes;
}

// Translate a UI effort value into the flag-layer payload. The SDK
// shallow-merges `applyFlagSettings`, drops `undefined` during JSON transport,
// and only clears a key when an explicit `null` is sent — see
// `applyFlagSettings` in @anthropic-ai/claude-agent-sdk. Mapping both the
// `"default"` sentinel and `undefined` (effort option absent for the model) to
// `null` ensures any previously-applied flag is actually cleared.

function buildConfigOptions(
  modes: SessionModeState,
  currentModelId: string,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentCatalogEntry[] = [],
  currentAgent?: string,
  fastAvailable = false,
  currentFast = false,
  fastUsesBooleanOption = false,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      // `_meta` rides along with the mode (upstream #1025, §15.5). The config-option and
      // `session/set_mode` surfaces describe the SAME catalogue, so a client that reads the
      // kind from one must find it on the other; dropping it here would make the mode's
      // classification depend on which surface Zed happened to read.
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
        _meta: m._meta,
      })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: modelInfos.map((m) => ({
        value: m.value,
        name: m.displayName,
        // Story 072 — prepend the version/context label ("Opus 5.5 with 1M context · <tagline>"),
        // mirroring the live `/model` picker; bare tagline when no label (e.g. opusplan).
        description: modelSelectorDescription(m) || undefined,
      })),
    },
  ];

  // Story 073 (R2) — the fast-mode toggle, positioned right after the model selector. GATED on an
  // Opus alias (R2.2, isFastModeCapableModel) AND detected availability (R1, fastAvailable): fast mode
  // is Opus-only and account-gated, so a non-Opus model or an unavailable account omits it entirely.
  // Story 074 (#828, R4.1): the option is emitted as `type:"boolean"` when the client advertised
  // boolean config options (fastUsesBooleanOption), else the `on`/`off` select fallback — via the
  // model-catalog helper. currentValue mirrors the session's fast-mode state.
  if (isFastModeCapableModel(currentModelId) && fastAvailable) {
    options.push(createFastModeConfigOption(currentFast, fastUsesBooleanOption));
  }

  // Add effort level option based on the currently selected model
  const currentModelInfo = modelInfos.find((m) => m.value === currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];

  if (supportedLevels.length > 0) {
    const effortOptions = [
      { value: "default", name: "Default" },
      ...supportedLevels.map((level) => ({
        value: level,
        name: level
          .split(/[_-]/)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
          .join(" "),
      })),
      // Story 060 (R1.1) — the "ultracode" sentinel, LAST and after the five real levels. NOT a real
      // `--effort` value (claude rejects `--effort ultracode`); it maps to xhigh + orchestration (Task 3).
      { value: ULTRACODE_EFFORT, name: ULTRACODE_EFFORT_LABEL },
    ];

    // `ultracode` is a valid current value so a configOptions rebuild (e.g. after a re-spawn) does not
    // reset a selected ultracode back to "default". It stays OUT of supportedLevels (real --effort enum).
    const includes = (l: string) =>
      l === "default" || l === ULTRACODE_EFFORT || (supportedLevels as string[]).includes(l);
    const validEffort =
      currentEffortLevel && includes(currentEffortLevel) ? currentEffortLevel : "default";

    options.push({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  // Story 056 (R3.2) — the `agent` (main-thread persona) selector, mirroring the effort option but
  // with a "default" no-persona sentinel. GATED on `agents.length > 0` (upstream #794): when nothing
  // is discovered the option is OMITTED entirely. The "default" entry = no persona (the spawn layer
  // already drops the literal "default", exactly like --effort/--permission-mode). The current value
  // is validated against the discovered set and falls back to "default".
  if (agents.length > 0) {
    const agentValues = new Set(agents.map((a) => a.value));
    const validAgent = currentAgent && agentValues.has(currentAgent) ? currentAgent : "default";
    options.push({
      id: "agent",
      name: "Agent",
      description: "Main-thread agent persona",
      category: "model",
      type: "select",
      currentValue: validAgent,
      options: [
        { value: "default", name: "Default" },
        ...agents.map((a) => ({ value: a.value, name: a.displayName, description: a.description })),
      ],
    });
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

// Captures a model family version such as `4-6` or `4.7` so we can keep
// `claude-opus-4-6` from being copied onto the SDK's `opus` alias when that
// alias currently resolves to a different family version (e.g. Opus 4.7).
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)[-.](\d+)\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = s.match(MODEL_FAMILY_VERSION_PATTERN);
  return match ? `${match[1]}.${match[2]}` : null;
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token === contextHint ? 3 : 1;
    }
  }
  return score;
}

function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Exact match on value or display name
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      model.value.toLowerCase() === lower ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  // Substring match
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  // Tokenized matching for aliases like "opus[1m]"
  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

/**
 * Inline-vs-reference threshold for an embedded `resource` block, in characters
 * of `resource.text`.
 *
 * Content at or above this size is referenced by `@<path>` so the TUI re-reads
 * the file from disk instead of receiving its bytes over the PTY (avoids
 * flooding the terminal with a large paste). Content below it is inlined so a
 * tiny snippet of context is not lost when there is no point round-tripping
 * through the filesystem.
 *
 * This is the SINGLE source of truth: both the `@<path>` and the inline outcomes
 * key off this one constant — no duplicated magic numbers.
 */
export const EMBEDDED_RESOURCE_INLINE_THRESHOLD = 2048;

/**
 * Derive a filesystem path from a `file://` URI, or `null` when the URI is not a
 * resolvable file path. Shared by the `resource_link` and embedded `resource`
 * branches of {@link promptToClaude} so the `file://` → path derivation lives in
 * exactly one place. Never throws.
 */
function filePathFromUri(uri: string): string | null {
  return uri.startsWith("file://") ? uri.slice("file://".length) : null;
}

/**
 * Convert an ACP ContentBlock[] (session/prompt) into a PTY text payload string.
 *
 * Reverse-flow (IMPLEMENTACAO-FORK-ACP.md §8): instead of constructing an
 * SDKUserMessage for the core SDK, we assemble the text the TUI should receive
 * over the PTY. Each block yields a fragment; empty fragments are dropped and the
 * survivors are joined with a single space.
 *
 *   - text          → injected verbatim (with the legacy /mcp: slash-command
 *                     normalization preserved, since the TUI understands it).
 *   - resource_link → `@<path>` for file:// URIs (the TUI re-reads the file), or a
 *                     `[name](uri)` markdown link for any non-path URI.
 *   - resource (text) → large content (≥ EMBEDDED_RESOURCE_INLINE_THRESHOLD) with
 *                     a file:// path becomes `@<path>` so the TUI re-reads it;
 *                     anything below the threshold — or large but path-less — is
 *                     inlined directly so the context is not lost.
 *
 *   - image → materialize the base64 to a uuid-named temp file (extension from mimeType)
 *             and emit `@<temp-path>` (Story 058 / R1.1). Once at least one image is
 *             materialized, a single Read-inducing directive is appended after the loop so
 *             the TUI's Read tool fires and vision-encodes it (R1.2). Each temp path is
 *             pushed into `materializedSink` (when provided) so the caller can clean it up.
 *
 * `resource` (blob) / `audio` blocks are SILENT no-ops here (R4.1): they emit no PTY bytes
 * and are NOT logged — they are expected-but-unsupported media in v1, not errors. An UNKNOWN
 * block `type` (the `default` branch) and any block whose mapping THROWS are treated as
 * malformed: skipped, recorded via the `logger`, and the remaining valid blocks still map —
 * one bad block never aborts the whole prompt (R1.3). A `materializeImage` failure is caught
 * by that same per-block isolation, so a broken image is skipped, never aborting the prompt.
 *
 * `materializedSink`, when passed, receives every materialized temp path (in order) so the
 * caller owns their lifecycle (cleanup is a later task). The return type stays `string`.
 */
export function promptToClaude(
  prompt: PromptRequest,
  logger: Logger = console,
  materializedSink?: string[],
): string {
  const fragments: string[] = [];
  // Set once any image block is materialized, so exactly ONE Read-inducing directive is
  // appended after the loop regardless of how many images the prompt carries (R1.2).
  let materializedAnyImage = false;

  for (const chunk of prompt.prompt) {
    // R1.3: isolate every block. A malformed block — even one whose `type` getter
    // throws — is SKIPPED and RECORDED, never allowed to abort the remaining blocks.
    // Reading `chunk.type` happens INSIDE the try so a throwing accessor is caught too.
    try {
      switch (chunk.type) {
        case "text": {
          let text = chunk.text;
          // change /mcp:server:command args -> /server:command (MCP) args
          const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
          if (mcpMatch) {
            const [, server, command, args] = mcpMatch;
            text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
          }
          fragments.push(text);
          break;
        }
        case "resource_link": {
          const path = filePathFromUri(chunk.uri);
          if (path !== null) {
            // @<path> so the TUI re-reads the file (do not inline its bytes).
            fragments.push(`@${path}`);
          } else {
            // Non-path uri (http(s)://, zed://, …): markdown link, never a bare @.
            const label = chunk.name ?? chunk.uri;
            fragments.push(`[${label}](${chunk.uri})`);
          }
          break;
        }
        case "resource": {
          // Only text resources are handled here; a blob resource (no `text`) is a
          // SILENT no-op — it is ignored media (R4.1), not malformed, so NO log.
          // Never throw on a missing field.
          if (chunk.resource && "text" in chunk.resource) {
            const content = chunk.resource.text;
            const path = filePathFromUri(chunk.resource.uri);
            if (content.length >= EMBEDDED_RESOURCE_INLINE_THRESHOLD && path !== null) {
              // Large + resolvable path → reference by @<path>, TUI re-reads (R3.1).
              fragments.push(`@${path}`);
            } else {
              // Below threshold (R3.2), or large but path-less (R3.3) → inline the
              // raw content rather than emit a broken @ mention.
              fragments.push(content);
            }
          }
          break;
        }
        case "image": {
          // R1.1: an ACP image carries base64 `data` + `mimeType` (NOT `source`/`media_type`).
          // Materialize it to a uuid-named temp file and reference it with `@<path>` so the TUI
          // re-reads (and vision-encodes) it — mirroring the `resource_link` @<path> idiom. A
          // single Read-inducing directive is appended AFTER the loop (R1.2). If materialize
          // throws, the surrounding per-block try/catch isolates it (R1.3): this image is skipped.
          //
          // R1.3 (shell-safety): the path is uuid-named + fork-controlled and the prompt body reaches
          // the PTY via bracketed-paste (engine-pty `sendPrompt` → `p.write`), NOT the `bash -lc` spawn
          // string — so no shell ever parses `@<path>` and the prompt has no injection surface. extFor
          // maps mimeType to a CLOSED extension set, so a hostile mimeType cannot reach the filename.
          const tempPath = materializeImage(chunk.data, chunk.mimeType);
          materializedSink?.push(tempPath);
          fragments.push(`@${tempPath}`);
          materializedAnyImage = true;
          break;
        }
        // audio → SILENT no-op (R4.1): expected-but-unsupported media in v1. It emits no PTY
        // bytes and is NOT logged (it is not an error).
        case "audio":
          break;
        default:
          // An unrecognized block type is malformed: skip it AND record the skip,
          // consistent with the throwing-block path (R1.3). Still no throw.
          logger.error(
            "promptToClaude: skipped an unknown content block",
            (chunk as { type?: unknown }).type,
          );
          break;
      }
    } catch (err) {
      // R1.3: a block whose mapping threw is isolated — record the skip and continue
      // to the next block. The function still returns the payload from the valid blocks.
      logger.error("promptToClaude: skipped a malformed content block", err);
      continue;
    }
  }

  // R1.2: exactly one Read-inducing directive per prompt when ≥1 image was materialized, so the
  // TUI's Read tool fires on the @<path>(s) above and vision-encodes them (the proven 2.1.195 path).
  if (materializedAnyImage) {
    fragments.push("Read the attached image(s) above and use them to answer.");
  }

  return fragments.filter((fragment) => fragment.length > 0).join(" ");
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    // Story 079 (R4): the message-level `toolUseResult` from the JSONL transcript — the structured
    // Output object of the tool_result this message carries (shape is per-tool). Used to render
    // Read/Bash/Agent/WebSearch results from the structured value instead of the model-facing raw
    // text (which carries <system-reminder> blocks, abort/truncation suffixes, and the Agent/Task
    // agentId+usage trailer).
    toolUseResult?: unknown;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    // Story 074 (#841): an empty full-string content block must emit NO message chunk
    // (an empty agent_message_chunk breaks strict ACP clients — e.g. JetBrains Air
    // freezes the transcript). Mirrors the empty-thinking guard (#793). The
    // `case "text"`/`text_delta` block path stays DEAD (no content_block_delta, 034).
    if (content.length === 0) return [];
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  // Story 079 (R3/R4): `toolUseResult` is message-level and carries no tool_use_id of its own — it
  // describes "the" tool_result block of the message it rode in on. If several tool_result blocks
  // were ever batched into one message it couldn't be attributed, so it is only honored when the
  // message carries exactly one.
  const toolUseResult =
    options?.toolUseResult !== undefined &&
    content.filter((c) => typeof c === "object" && c !== null && c.type === "tool_result")
      .length === 1
      ? options.toolUseResult
      : undefined;

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta":
        // Story 056 (#793): a signature-only thinking block (thinking.display "omitted") carries empty
        // text — suppress the agent_thought_chunk rather than emit an empty one (update stays null → no
        // push at the `if (update)` guard). A non-empty thinking block emits exactly as before.
        if (chunk.thinking.length > 0) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (
          chunk.name === "TaskCreate" ||
          chunk.name === "TaskUpdate" ||
          chunk.name === "TaskList" ||
          chunk.name === "TaskGet"
        ) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                const toolUse = toolUseCache[toolUseId];
                if (toolUse) {
                  // Both `Edit` and `Write` produce a structuredPatch in their
                  // PostToolUse tool_response. For Edit the diff replaces the
                  // optimistic content built at tool_use time. For Write the
                  // optimistic content (built from `input.content` alone with
                  // `oldText: null`) shows "creation" semantics regardless of
                  // whether the file existed; the structuredPatch from the
                  // hook lets us emit the real diff for `type: "update"`. The
                  // helper returns `{}` if the response shape isn't usable.
                  const editDiff =
                    toolUse.name === "Edit" || toolUse.name === "Write"
                      ? toolUpdateFromDiffToolResponse(toolResponse)
                      : {};
                  const update: SessionNotification["update"] = {
                    _meta: {
                      claudeCode: {
                        ...claudeCodeMetaFromToolUse(toolUse, options?.cwd),
                        toolResponse,
                      },
                    } satisfies ToolUpdateMeta,
                    toolCallId: toolUseId,
                    sessionUpdate: "tool_call_update",
                    ...editDiff,
                  };
                  await client.sessionUpdate({
                    sessionId,
                    update,
                  });
                } else {
                  logger.error(
                    `[claude-agent-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`,
                  );
                }
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          if (alreadyCached) {
            // Second encounter (full assistant message after streaming) —
            // send as tool_call_update to refine the existing tool_call
            // rather than emitting a duplicate tool_call.
            update = {
              _meta: {
                claudeCode: claudeCodeMetaFromToolUse(chunk, options?.cwd),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call_update",
              rawInput,
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          } else {
            // First encounter (streaming content_block_start or replay) —
            // send as tool_call with terminal_info for Bash tools.
            update = {
              _meta: {
                claudeCode: claudeCodeMetaFromToolUse(chunk, options?.cwd),
                ...(chunk.name === "Bash" && supportsTerminalOutput
                  ? { terminal_info: { terminal_id: chunk.id } }
                  : {}),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call",
              rawInput,
              status: "pending",
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (
          toolUse.name === "TaskCreate" ||
          toolUse.name === "TaskUpdate" ||
          toolUse.name === "TaskList" ||
          toolUse.name === "TaskGet"
        ) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list; TaskList
          // RECONCILES it against the SDK's authoritative snapshot (upstream #974),
          // which is what repairs a resumed or compacted session whose creating
          // calls are no longer in replay history. TaskGet stays read-only and
          // suppressed. The plan update is emitted as a snapshot of the accumulated
          // state, mirroring the legacy TodoWrite behavior.
          //
          // Each parser is offered the structured `toolUseResult` FIRST and the
          // model-facing `chunk.content` second. That order is not cosmetic: the
          // measured transcripts put the structured object only in `toolUseResult`
          // and a short sentence in `content`, so reading `content` alone (as this
          // arm did before) parsed nothing at all.
          const isError = "is_error" in chunk && chunk.is_error;
          let shouldEmitTaskPlan = false;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(toolUseResult) ?? parseTaskCreateOutput(chunk.content),
              );
              shouldEmitTaskPlan = true;
            } else if (toolUse.name === "TaskUpdate") {
              const input = toolUse.input as Parameters<typeof applyTaskUpdate>[1];
              const output =
                parseTaskUpdateOutput(toolUseResult, input?.taskId) ??
                parseTaskUpdateOutput(chunk.content, input?.taskId);
              // Older transcripts carry no structured output, so the input-based
              // path is retained. When an output IS available, only a confirmed
              // update for the same task is applied — a TaskUpdate can fail
              // logically (unknown id) without the result being flagged is_error.
              if (!output || (output.success && output.taskId === input?.taskId)) {
                applyTaskUpdate(taskState, input);
                shouldEmitTaskPlan = true;
              }
            } else if (toolUse.name === "TaskList") {
              const output =
                parseTaskListOutput(toolUseResult) ?? parseTaskListOutput(chunk.content);
              if (output) {
                applyTaskList(taskState, output);
                shouldEmitTaskPlan = true;
              }
            }
          }
          if (shouldEmitTaskPlan) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
            toolUseResult,
          );

          // When terminal output is supported, send terminal_output as a
          // separate notification to match codex-acp's streaming lifecycle:
          //   1. tool_call       → _meta.terminal_info  (already sent above)
          //   2. tool_call_update → _meta.terminal_output (sent here)
          //   3. tool_call_update → _meta.terminal_exit  (sent below with status)
          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: claudeCodeMetaFromToolUse(toolUse, options?.cwd),
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "fallback":
        // `fallback`: model-routing marker (@anthropic-ai/sdk >= 0.104) — from/to
        // model hops, no renderable content. No-op like the control blocks above.
        //
        // `mid_conv_system` sat in this list until @anthropic-ai/sdk 0.120.0, whose
        // changelog removes it as an "unsupported content block" — the API never
        // emitted one. The case and the bump had to move together: the switch is
        // exhaustive against `unreachable`, so keeping the case fails to compile on
        // 0.120.0 (TS2678) and dropping it fails on 0.117.1 (TS2345).
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
  },
): SessionNotification[] {
  const event = message.event;
  switch (event.type) {
    case "content_block_start":
      return toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
        },
      );
    case "content_block_delta":
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
          taskState: options?.taskState,
        },
      );
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return [];

    default:
      unreachable(event, logger);
      return [];
  }
}

export function runAcp(deps?: AgentDeps) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  let agent!: ClaudeAcpAgent;
  const connection = new AgentSideConnection((client) => {
    // Positions 2-3 (logger/engine) default; `deps` carries the bootstrap-resolved flags
    // (story 038: usageUpdate from process.env.USAGE_UPDATE, default OFF).
    agent = new ClaudeAcpAgent(client, undefined, undefined, deps);
    return agent;
  }, stream);
  return { connection, agent };
}

/** Resolve a model alias's context window (the usage_update `size` denominator).
 *  NOTE (story 068): there is NO `result.modelUsage` window to refresh from — the
 *  JSONL `usage` carries only token counts; the window comes from static curation
 *  (the Models API `max_input_tokens` is the real authority, which this fork does
 *  not call), as detailed below.
 *
 *  Story 068 (R1, R1.1, R1.2): consults the static {@link MODEL_CONTEXT_WINDOWS}
 *  alias→window map FIRST (an exact catalog-`value` hit — `default`/`fable`/`opus`/
 *  `sonnet`=1M, `haiku`=200K). This fixes `opus` having wrongly reported 200K, and
 *  `sonnet` now seeds 1M (Sonnet 5 is native 1M). An alias absent from the map then
 *  falls back to the legacy `\b1m\b` inference: Anthropic 1M-context variants
 *  encode "1m" as a distinct token in the SDK model ID (e.g., "claude-opus-4-6-1m"),
 *  which `\b1m\b` catches without also matching "10m" or embedded substrings.
 *  `null` (fully unknown) is intentional — the two call sites apply
 *  `?? DEFAULT_CONTEXT_WINDOW`. */
export function inferContextWindowFromModel(model: string): number | null {
  const mapped = MODEL_CONTEXT_WINDOWS[model];
  if (mapped !== undefined) return mapped; // exact alias hit (!== undefined, NOT truthiness)
  if (/\b1m\b/i.test(model)) return 1_000_000; // unknown alias that still encodes a 1m token
  // A LIVE picker value is often a full wire id (`claude-fable-5-1`), which the
  // curated alias map cannot contain and the `1m` token does not mark. Reuse the
  // id-shaped resolver rather than duplicating its family/version table — without
  // this, every live row seeds 200K and Fable/Opus under-report until the first
  // turn corrects them.
  return inferContextWindowFromModelId(model);
}

/** Story 069 (R1) — AUTHORITATIVE context window from a turn's REAL model ID (the JSONL `model`
 *  field), used by the pump to refine the alias seed once the model is known. Exact-ID lookup first
 *  (MODEL_ID_CONTEXT_WINDOWS), then a family+version heuristic for dated snapshots / future variants
 *  (Opus is NOT uniform: 4.6 and earlier = 200K, 4.7+ = 1M; Sonnet 4.x = 200K but Sonnet 5+ = 1M;
 *  haiku = 200K; fable = 1M — story 071), then a
 *  `\b1m\b` suffix, then null (R1.3: a missing / non-string id never refines). */
export function inferContextWindowFromModelId(id: string): number | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const exact = MODEL_ID_CONTEXT_WINDOWS[id];
  if (exact !== undefined) return exact;
  // An explicit long-context `[1m]`/`-1m` suffix wins over the family heuristic
  // (`claude-sonnet-…[1m]` = 1M, not 200K; `/model default` resolves to `claude-opus-4-8[1m]`).
  if (/\b1m\b/i.test(id)) return 1_000_000;
  const opus = id.match(/claude-opus-(\d+)-(\d+)/);
  if (opus) {
    const major = Number(opus[1]);
    const minor = Number(opus[2]);
    return major > 4 || (major === 4 && minor >= 7) ? 1_000_000 : 200_000;
  }
  if (/claude-fable/.test(id)) return 1_000_000;
  // Sonnet is NOT uniform across generations (story 071): the subscription CLI serves Sonnet 4.x
  // at 200K but Sonnet 5+ natively at 1M (Sonnet 5 has no smaller context variant). Version-aware,
  // like the Opus 4-6 vs 4-7/4-8 split above; dated snapshots (`claude-sonnet-5-<date>`) match too.
  const sonnet = id.match(/claude-sonnet-(\d+)/);
  if (sonnet) return Number(sonnet[1]) >= 5 ? 1_000_000 : 200_000;
  if (/claude-haiku/.test(id)) return 200_000;
  return null;
}
