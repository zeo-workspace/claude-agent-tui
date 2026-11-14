// Story 033 / Task 2.1 — loopback PreToolUse http hook server that forwards tool calls over IPC and
// FAILS CLOSED on any transport/timeout error (R2.1, R2.4).
//
// BINDING Degrau-0 constraint (experiments/GATE_FINDINGS.md blocker b): the `PreToolUse` type:http
// hook is TCP-LOOPBACK ONLY — a unix-socket URL form is silently ignored AND the tool runs ungated. So
// this server MUST bind `127.0.0.1` (loopback) on the story-032 `findFreePort` port, and MUST fail
// closed (respond `permissionDecision:'deny'`) on a malformed payload, a missing decision, or a decider
// timeout — never leave a tool ungated by returning nothing or throwing out of the request handler.
//
// WIRING (IMPLEMENTACAO-FORK-ACP.md §9): claude POSTs the `PreToolUse` payload to
// `http://127.0.0.1:<port>/__fork-acp-gate__` (the story-032 hook URL) BEFORE the tool runs; the server
// parses `{session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input,
// tool_use_id}`, forwards `{toolName, toolInput, toolUseId, …}` to the injected `onToolCall` decider
// (which correlates by tool_use.id + raises ACP session/request_permission — request-permission.ts),
// and writes the decision body back. The decider is INJECTED so the server is unit-testable OFFLINE.
//
// The hook is injected into the TUI via `--settings <scratchFile>` (story 032 injectHook), never the
// user's real config — that wiring is the engine-integration concern; this module is the standalone
// server seam.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { LOOPBACK_HOST } from "../gate/port.js";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, FORK_HOOK_MARKER_PATH } from "../gate/settings-writer.js";
import { allowDecision, denyDecision, type HookResponse } from "./deny.js";

/** The §9 `PreToolUse` http payload shape (GATE_FINDINGS keystone 1.3). All fields optional on parse
 *  so a malformed body fails closed rather than throwing — a missing tool_use_id is itself a deny. */
export interface PreToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  /** Story 055 (R2.1) — present ONLY on a subagent-internal tool: the subagent's own id and type. */
  agent_id?: string;
  agent_type?: string;
}

/** The normalized tool call forwarded to the decider (camelCase, the shape request-permission uses). */
export interface ForwardedToolCall {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  sessionId?: string;
  permissionMode?: string;
  /** Story 055 (R2.1) — the subagent's own id (`agent_id`); undefined for a main-chain tool. */
  agentId?: string;
  /** Story 055 (R2.1/R2.2) — the subagent's type (`agent_type`); the dialog label source. Undefined
   *  for a main-chain tool. There is NO parent tool_use.id in the payload (grouping is best-effort). */
  agentType?: string;
}

/** Story 064 — a deny that carries a custom `permissionDecisionReason` (e.g. the AskUserQuestion
 *  anti-stall reason) instead of the {@link defaultDenyReason}. */
export interface DenyWithReason {
  decision: "deny";
  reason: string;
}

/** The enforced outcome a decider returns: a plain allow/deny, or a deny carrying a custom reason.
 *  Plain `"deny"` and {@link DenyWithReason} both intercept the tool; the latter just names a reason. */
export type ToolDecision = "allow" | "deny" | DenyWithReason;

/** The decider the server forwards each tool call to; returns the enforced {@link ToolDecision}. */
export type ToolCallDecider = (call: ForwardedToolCall) => Promise<ToolDecision> | ToolDecision;

/** The running hook server handle. */
export interface HookServer {
  /** The loopback port the server bound (feeds the story-032 hook URL). */
  port: number;
  /** Register/replace the decider invoked per PreToolUse call. */
  onToolCall(decider: ToolCallDecider): void;
  /** Idempotently close the server. */
  close(): Promise<void>;
}

/** Options for {@link startHookServer}. */
export interface StartHookServerOptions {
  /** The verified-free loopback port (story-032 `findFreePort`). */
  port: number;
  /** Initial decider (may also be set later via {@link HookServer.onToolCall}). */
  onToolCall?: ToolCallDecider;
  /**
   * Max ms to await the decider before failing closed (deny). DISTINCT from the 5583 ms turn watchdog
   * (story 024) and the claude hook timeout (story 032, 600 s) — this is the server's own
   * never-hang-the-request budget. Defaults to a conservative value.
   */
  deciderTimeoutMs?: number;
  /** Injectable http-server factory (defaults to `node:http`'s `createServer`); for tests. */
  createHttpServer?: () => Server;
  /** Optional diagnostics sink for fail-closed events (defaults to no-op). */
  onWarn?: (message: string) => void;
  /**
   * Story 055 (R1.3) — per-session secret token. WHEN set, a POST whose request path is not exactly
   * `${FORK_HOOK_MARKER_PATH}/<token>` FAILS CLOSED (deny) WITHOUT invoking the decider — the
   * compensating control for the relaxed JSONL anti-forgery. WHEN undefined, no token is enforced
   * (the pre-055 behavior, used by the unit tests that construct the server directly).
   */
  token?: string;
}

/** Time left between the decider's deny and claude giving up on the hook, so the deny crosses
 *  loopback first. Item 226: when claude's hook timer wins, it falls back to its own permission flow,
 *  and an allow rule or auto mode then runs the tool with nobody deciding (CLI 2.1.319 and 2.1.325,
 *  measured 2026-11-14). The decider used to wait exactly as long as the hook, and always lost. */
export const HOOK_DEADLINE_MARGIN_MS = 15_000;

/**
 * The decider's budget for a hook of `hookTimeoutSeconds`: whatever was requested, but never past the
 * hook's deadline minus the margin (half the hook, for a hook shorter than twice the margin). A
 * requested budget can only shorten it, so no caller can reopen item 226.
 */
export function deciderBudgetMs(
  hookTimeoutSeconds: number,
  requestedMs: number | undefined,
): number {
  const hookMs = hookTimeoutSeconds * 1000;
  const ceiling = hookMs - Math.min(HOOK_DEADLINE_MARGIN_MS, hookMs / 2);
  return Math.min(requestedMs ?? ceiling, ceiling);
}

/** Default decider timeout (ms) — the default hook's budget: long enough for a person to answer in
 *  Zed, and over before claude would give up on the hook. */
export const DEFAULT_DECIDER_TIMEOUT_MS = deciderBudgetMs(DEFAULT_HOOK_TIMEOUT_SECONDS, undefined);

/** Read a request body fully into a UTF-8 string (bounded by Node's own socket limits). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Write a decision body as the http JSON response (always 200 — the body carries the decision). */
function writeDecision(res: ServerResponse, decision: HookResponse): void {
  const json = JSON.stringify(decision);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(json);
}

/** Map a decider's {@link ToolDecision} to the §9 hook body, honoring a {@link DenyWithReason}'s custom
 *  reason (story 064). A plain allow/deny uses the default allow/deny body. */
function toHookResponse(decision: ToolDecision, call: ForwardedToolCall): HookResponse {
  if (decision === "allow") return allowDecision(call);
  if (decision === "deny") return denyDecision(call);
  return denyDecision(call, decision.reason);
}

/**
 * Parse a PreToolUse payload from raw JSON, normalizing to {@link ForwardedToolCall}. Returns null when
 * the body is unparseable OR lacks a `tool_use_id`/`tool_name` — the caller fails closed on null (a
 * call we cannot identify is denied, never approved).
 */
export function parsePayload(raw: string): ForwardedToolCall | null {
  let parsed: PreToolUsePayload;
  try {
    parsed = JSON.parse(raw) as PreToolUsePayload;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const toolUseId = parsed.tool_use_id;
  const toolName = parsed.tool_name;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    return null;
  }
  if (typeof toolName !== "string" || toolName.length === 0) {
    return null;
  }
  return {
    toolName,
    toolInput: parsed.tool_input,
    toolUseId,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
    permissionMode: typeof parsed.permission_mode === "string" ? parsed.permission_mode : undefined,
    // R2.1 — carry the subagent attribution the §9 payload already ships (today they are dropped). A
    // main-chain payload omits them → both stay undefined.
    agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : undefined,
    agentType: typeof parsed.agent_type === "string" ? parsed.agent_type : undefined,
  };
}

/** Run the decider with a timeout; on timeout or throw, resolve `'deny'` (fail closed). */
async function decideWithTimeout(
  decider: ToolCallDecider,
  call: ForwardedToolCall,
  timeoutMs: number,
  onWarn?: (message: string) => void,
): Promise<ToolDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"deny">((resolve) => {
    timer = setTimeout(() => {
      onWarn?.(
        `[gate §9] FAIL CLOSED: decider timed out after ${timeoutMs}ms for tool_use ` +
          `${call.toolUseId} (tool "${call.toolName}") — denying.`,
      );
      resolve("deny");
    }, timeoutMs);
  });
  try {
    const decided = await Promise.race([Promise.resolve(decider(call)), timeout]);
    return decided;
  } catch (err) {
    onWarn?.(
      `[gate §9] FAIL CLOSED: decider threw for tool_use ${call.toolUseId} ` +
        `(${err instanceof Error ? err.message : String(err)}) — denying.`,
    );
    return "deny";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bind a loopback `PreToolUse` http hook server on `port` and forward each tool call to the decider,
 * FAILING CLOSED on every error path (R2.1, R2.4).
 *
 * The server binds {@link LOOPBACK_HOST} (127.0.0.1) ONLY — never `0.0.0.0` — matching the blocker-b
 * constraint that the transport is loopback TCP. Each request body is parsed by {@link parsePayload};
 * a malformed/identity-less payload, a decider timeout, or a decider throw all write a
 * `permissionDecision:'deny'` body so the tool never runs ungated. A clean `'allow'` writes the allow
 * body (the keystroke mitigation for #52822 is a separate allow-inject.ts concern).
 *
 * @returns a {@link HookServer} once the socket is bound (rejects on a bind error — the spawn path then
 *   fails fast rather than spawning claude with an ungated hook URL).
 */
export function startHookServer(opts: StartHookServerOptions): Promise<HookServer> {
  const {
    port,
    deciderTimeoutMs = DEFAULT_DECIDER_TIMEOUT_MS,
    createHttpServer = createServer,
    onWarn,
    token,
  } = opts;

  let decider: ToolCallDecider | undefined = opts.onToolCall;

  const server = createHttpServer();

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // The tool name is unknown until the body parses; default the fail-closed deny target.
      let call: ForwardedToolCall | null = null;
      try {
        const raw = await readBody(req);
        // DIAGNOSTIC (env-gated, off by default): capture EVERY raw PreToolUse POST the fork's
        // hook-server receives — including the subagent-attributed fields (agent_id/agent_type) that
        // parsePayload drops — so a live run can verify whether subagent-internal tools POST at all.
        if (process.env.FORK_HOOK_LOG_RAW) {
          try {
            appendFileSync(process.env.FORK_HOOK_LOG_RAW, raw + "\n");
          } catch {
            // best-effort diagnostic — never let logging fail the request
          }
        }
        // R1.3 (story 055): validate the per-session token from the request path BEFORE the decider.
        // A POST that does not present `${FORK_HOOK_MARKER_PATH}/<token>` is denied without ever
        // reaching the decider — the forge-resistance that compensates the payload-seeded correlation.
        if (token !== undefined) {
          const urlPath = (req.url ?? "").split("?")[0];
          if (urlPath !== `${FORK_HOOK_MARKER_PATH}/${token}`) {
            onWarn?.(
              `[gate §9] FAIL CLOSED: PreToolUse POST presented a missing/incorrect per-session token ` +
                `(url path "${urlPath}") — denying WITHOUT invoking the decider.`,
            );
            writeDecision(
              res,
              denyDecision({ toolName: "(unauthorized)", toolUseId: "(unauthorized)" }),
            );
            return;
          }
        }
        call = parsePayload(raw);
        if (call === null) {
          onWarn?.(
            `[gate §9] FAIL CLOSED: unparseable or identity-less PreToolUse payload — denying.`,
          );
          // No tool identity: still respond deny so claude intercepts rather than running ungated.
          writeDecision(res, denyDecision({ toolName: "(unknown)", toolUseId: "(unknown)" }));
          return;
        }
        if (decider === undefined) {
          onWarn?.(
            `[gate §9] FAIL CLOSED: no decider registered for tool_use ${call.toolUseId} — denying.`,
          );
          writeDecision(res, denyDecision(call));
          return;
        }
        const decision = await decideWithTimeout(decider, call, deciderTimeoutMs, onWarn);
        writeDecision(res, toHookResponse(decision, call));
      } catch (err) {
        // Any unexpected handler error (body read failure, write failure) → fail closed.
        onWarn?.(
          `[gate §9] FAIL CLOSED: hook request handler error ` +
            `(${err instanceof Error ? err.message : String(err)}) — denying.`,
        );
        try {
          writeDecision(
            res,
            denyDecision(call ?? { toolName: "(unknown)", toolUseId: "(unknown)" }),
          );
        } catch {
          // The response may already be partially sent; nothing else to do but not crash the server.
        }
      }
    })();
  });

  return new Promise<HookServer>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve({
        port,
        onToolCall(next: ToolCallDecider): void {
          decider = next;
        },
        close(): Promise<void> {
          return new Promise((res) => {
            try {
              server.close(() => res());
            } catch {
              res();
            }
          });
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // LOOPBACK ONLY (blocker b) — bind 127.0.0.1, never 0.0.0.0.
    server.listen(port, LOOPBACK_HOST);
  });
}
