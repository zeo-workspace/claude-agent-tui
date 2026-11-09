// Story 033 / Task 2.2 — correlate by tool_use.id and raise ACP session/request_permission, failing
// CLOSED (deny) on a missing/duplicate id or an ACP transport error (R2.2).
//
// FLOW (IMPLEMENTACAO-FORK-ACP.md §9): the loopback hook server (hook-server.ts) forwards a tool call
// over IPC; the fork correlates it against the JSONL `tool_use` event by `tool_use.id` (the SAME id
// claude wrote into the transcript and into the hook payload — §9 "correlacionar por tool_use.id"),
// raises `session/request_permission` in Zed with options [allow, deny], awaits the user's
// `RequestPermissionResponse`, and maps the chosen option back to `'allow'`/`'deny'`.
//
// FAIL CLOSED (the load-bearing safety posture — design.md "Fail closed everywhere"):
//   - a tool_use_id NOT seen in the JSONL correlation map → deny (an uncorrelated call is never
//     approved — it might be a spoofed/stale id);
//   - a DUPLICATE tool_use_id (already pending or already decided) → deny (re-entrancy / id reuse must
//     not silently ride a prior approval);
//   - an ACP transport error (client.requestPermission throws) → deny;
//   - a `cancelled` outcome from Zed → deny (a cancel is NOT an approval).
//
// This module owns NO server and NO PTY; it is a pure correlation + ACP-bridge unit driven by an
// injectable client surface so a unit test runs it OFFLINE against a fake ACP client.

/** The kind hint on a permission option (ACP `PermissionOptionKind`). */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** One permission option offered to the user (the ACP `PermissionOption` subset the gate emits). */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** The tool-call detail carried in the ACP request (`RequestPermissionRequest.toolCall`). */
export interface ToolCallUpdateLike {
  toolCallId: string;
  title?: string;
  rawInput?: unknown;
}

/** The ACP `session/request_permission` params the gate sends. */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdateLike;
  options: PermissionOption[];
}

/** The ACP `RequestPermissionResponse` outcome union. */
export type RequestPermissionOutcome =
  { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

/** The ACP `RequestPermissionResponse` the client returns. */
export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}

/**
 * The minimal ACP client surface the bridge needs — structurally satisfied by the agent's
 * `AcpClient` (`client.requestPermission(params)`). Injected so a unit test drives the bridge
 * with a fake client OFFLINE (no ACP connection, no Zed).
 */
export interface PermissionClient {
  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
}

/** The forwarded tool call (hook payload subset) the bridge correlates + asks permission for. */
export interface PermissionToolCall {
  /** The correlation key: hook `tool_use_id` == JSONL `tool_use.id`. */
  toolUseId: string;
  /** The tool name (`tool_use.name`) — shown in the Zed prompt title. */
  toolName: string;
  /** The tool input (`tool_use.input`) — forwarded as `rawInput` for the Zed prompt. */
  toolInput?: unknown;
}

/** The two option ids the gate offers. Fixed so the response mapping is unambiguous. */
export const ALLOW_OPTION_ID = "allow";
export const DENY_OPTION_ID = "deny";

/** Build the fixed [allow, deny] option set the gate presents in Zed (R2.2). */
export function buildPermissionOptions(): PermissionOption[] {
  return [
    { optionId: ALLOW_OPTION_ID, name: "Allow", kind: "allow_once" },
    { optionId: DENY_OPTION_ID, name: "Deny", kind: "reject_once" },
  ];
}

/**
 * A correlation map keyed by `tool_use.id`: the JSONL `tool_use` events the story-015 watcher has
 * observed, so a hook tool call can be matched to a REAL transcript tool_use before it is approved.
 *
 * `register(id)` is idempotency-aware: it records each id ONCE and flags a re-registration so a
 * DUPLICATE id (id reuse / re-entrancy) can be detected and failed closed. `decide(id)` consumes the
 * correlation: a missing OR duplicate id yields `deny`, a clean single match yields `allow-eligible`
 * (the call may proceed to the ACP prompt). The map is per-session (tool_use ids are session-scoped).
 */
export class ToolUseCorrelator {
  /** ids observed in the JSONL `tool_use` stream, with a count so duplicates are detectable. */
  private readonly seen = new Map<string, number>();
  /** ids already consumed by a permission decision — a second consume is a duplicate (re-entrancy). */
  private readonly consumed = new Set<string>();

  /**
   * Record a JSONL `tool_use.id` from the story-015 watcher. Increments its count so a second
   * observation marks it duplicate. Returns true on the FIRST registration, false on a duplicate.
   */
  register(toolUseId: string): boolean {
    const count = this.seen.get(toolUseId) ?? 0;
    this.seen.set(toolUseId, count + 1);
    return count === 0;
  }

  /**
   * FIX(gate-deadlock): seed the correlator from the AUTHORITATIVE PreToolUse hook payload when the
   * JSONL has not observed the id yet. The claude buffers the `tool_use` line and only flushes it to
   * the transcript AFTER the hook decision, so waiting on the JSONL deadlocks (the line never arrives
   * during the wait). Idempotent and safe: marks count=1 ONLY when unseen (0) — it never pushes an
   * already-clean (1) id to duplicate (2), nor touches a genuine duplicate (>1). The pump's later
   * observation of the same id (post-decision) is harmless: the id is already consumed by then.
   */
  ensureRegistered(toolUseId: string): void {
    if ((this.seen.get(toolUseId) ?? 0) === 0) this.seen.set(toolUseId, 1);
  }

  /** True iff `toolUseId` was observed EXACTLY once in the JSONL and has not yet been consumed. */
  isCleanMatch(toolUseId: string): boolean {
    return this.seen.get(toolUseId) === 1 && !this.consumed.has(toolUseId);
  }

  /**
   * Consume the correlation for `toolUseId` and decide whether the call may proceed to the ACP prompt.
   * FAIL CLOSED: a missing id (never seen in the JSONL), a DUPLICATE id (seen >1× → id reuse), or an
   * already-consumed id (re-entrancy) all yield `'deny'`. A clean single, first-time match yields
   * `'proceed'`. Marks the id consumed so a later re-ask is treated as a duplicate.
   */
  decide(toolUseId: string): "proceed" | "deny" {
    const count = this.seen.get(toolUseId) ?? 0;
    if (count !== 1 || this.consumed.has(toolUseId)) {
      // Missing (0), duplicate (>1), or re-entrant (already consumed) → never approve.
      return "deny";
    }
    this.consumed.add(toolUseId);
    return "proceed";
  }
}

/** Options for {@link requestPermission}. */
export interface RequestPermissionOptions {
  client: PermissionClient;
  sessionId: string;
  toolCall: PermissionToolCall;
  /** The per-session correlator seeded from the JSONL `tool_use` events (story 015). */
  correlator: ToolUseCorrelator;
  /** Optional sink for the fail-closed diagnostics (defaults to no-op; production wires the logger). */
  onWarn?: (message: string) => void;
  /** Story 054 — when set, the ACP prompt attaches to this PARENT Task tool_call id (the id Zed already
   *  rendered) instead of the inner tool_use id; the correlator STILL decides on the inner id. */
  dialogToolCallId?: string;
  /** Story 054 — the subagent's label, named in the prompt title alongside the inner tool. */
  subagentLabel?: string;
}

/**
 * Correlate a forwarded tool call by `tool_use.id` and raise ACP `session/request_permission`,
 * resolving to the enforced decision (R2.2). FAILS CLOSED to `'deny'` on a missing/duplicate id, an
 * ACP transport error, or a `cancelled`/unrecognized outcome — never approves an uncorrelated call.
 *
 * @returns `'allow'` ONLY when the id is a clean single JSONL match AND Zed returns the allow option;
 *   `'deny'` otherwise.
 */
export async function requestPermission(opts: RequestPermissionOptions): Promise<"allow" | "deny"> {
  const { client, sessionId, toolCall, correlator, onWarn, dialogToolCallId, subagentLabel } = opts;

  // 1) Correlate by tool_use.id BEFORE asking — an uncorrelated/duplicate call is denied, not prompted.
  const correlation = correlator.decide(toolCall.toolUseId);
  if (correlation === "deny") {
    onWarn?.(
      `[gate §9] FAIL CLOSED: tool_use ${toolCall.toolUseId} (tool "${toolCall.toolName}") is not a ` +
        `clean single match in the JSONL correlation map (missing or duplicate) — denying rather than ` +
        `approving an uncorrelated call.`,
    );
    return "deny";
  }

  // 2) Raise session/request_permission in Zed with [allow, deny]; await the user's choice.
  let result: RequestPermissionResult;
  try {
    result = await client.requestPermission({
      sessionId,
      toolCall: {
        // Story 054/055: a subagent inner tool relays under the PARENT Task id Zed already rendered
        // (dialogToolCallId) WHEN the parent is resolvable; otherwise it keeps the inner id. Story 055
        // (R2.2) DECOUPLES the attributed title from dialogToolCallId: the title is labelled whenever
        // `subagentLabel` is set (sourced from the payload's agent_type), so a fast subagent whose
        // parent has not yet been resolved still renders `<tool> · from the <agent_type> agent` under
        // the inner id. A main-chain call (no subagentLabel) stays byte-identical: bare tool name.
        toolCallId: dialogToolCallId ?? toolCall.toolUseId,
        title:
          subagentLabel !== undefined
            ? `${toolCall.toolName} · from the ${subagentLabel} agent`
            : toolCall.toolName,
        rawInput: toolCall.toolInput,
      },
      options: buildPermissionOptions(),
    });
  } catch (err) {
    onWarn?.(
      `[gate §9] FAIL CLOSED: session/request_permission transport error for tool_use ` +
        `${toolCall.toolUseId} (${err instanceof Error ? err.message : String(err)}) — denying.`,
    );
    return "deny";
  }

  // 3) Map the outcome back to the enforced decision. Only an explicit allow selection approves;
  //    a cancel or any unrecognized optionId fails closed.
  const outcome = result.outcome;
  if (outcome.outcome === "selected" && outcome.optionId === ALLOW_OPTION_ID) {
    return "allow";
  }
  if (outcome.outcome === "selected" && outcome.optionId === DENY_OPTION_ID) {
    return "deny";
  }
  // 'cancelled' or an unknown optionId → deny (a cancel is not an approval).
  onWarn?.(
    `[gate §9] FAIL CLOSED: tool_use ${toolCall.toolUseId} resolved to ` +
      `${outcome.outcome === "selected" ? `unknown option "${outcome.optionId}"` : "cancelled"} — denying.`,
  );
  return "deny";
}
