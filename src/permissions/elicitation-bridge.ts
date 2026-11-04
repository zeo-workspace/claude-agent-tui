// Story 065 / Task 2.2 — the pure elicitation bridge: project an AskUserQuestion tool_input into an
// ACP `session/request_elicitation` (form) request, map the user's outcome back to a gate `deny`+reason
// decision, and perform the bounded, fail-closed round-trip against an injectable client (R1.1, R1.2,
// R2, R4).
//
// FLOW: claude's `AskUserQuestion` tool cannot be satisfied by a PreToolUse hook (a hook can only
// allow/deny — it cannot synthesize a native tool_result). So the gate ALWAYS denies AskUserQuestion at
// the wire (R2.1 seam) and instead raises a real ACP form elicitation in Zed; whatever the user picks
// travels back to the model INSIDE the deny `reason` string (mirrors hook-server's DenyWithReason).
//
// FAIL CLOSED (the load-bearing safety posture — design.md "Fail closed everywhere"):
//   - a timeout waiting on the client → cancel (a dismissal, NEVER an accept);
//   - an ACP transport error (client throws) → cancel;
//   - a malformed response (action not one of accept|decline|cancel) → cancel;
//   - a cancel/decline (or any unrecognized action) maps to a `deny` whose reason reads as a user
//     dismissal, not an answer.
//
// This module owns NO server and NO PTY; it is a pure projection + ACP-bridge unit driven by an
// injectable client surface so a unit test runs it OFFLINE against a fake client. It imports NOTHING
// internal, and only `import type` from the SDK — the runtime zod validators are NOT importable here
// (the package `exports` map blocks the deep specifier), so every guard below is STRUCTURAL.
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";

/**
 * The gate decision this bridge yields. Mirrors hook-server's `DenyWithReason`: AskUserQuestion is
 * ALWAYS denied at the wire, and the user's selection (or the dismissal note) is carried in `reason`.
 */
export interface ElicitationDecision {
  decision: "deny";
  reason: string;
}

/** The `AskUserQuestion` tool_input subset the bridge projects into a form elicitation. */
export interface AskUserQuestionInput {
  questions: Array<{
    /** The human-readable question text — becomes the property `title`. */
    question: string;
    /** The short key — becomes the property name AND a `required` entry. */
    header: string;
    /** Whether multiple options may be selected (currently projected as a single string-enum). */
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

/**
 * The minimal ACP client surface the bridge needs — structurally satisfied by the kept
 * `AgentSideConnection` (`client.createElicitation(params)`). Injected so a unit test drives
 * the bridge with a fake client OFFLINE (no AgentSideConnection, no Zed).
 */
export interface ElicitationClient {
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

/**
 * Project an `AskUserQuestion` tool_input into an ACP form `CreateElicitationRequest`, scoped to the
 * session and tied to the originating tool call by `tool_use.id` (R1.1, R1.2).
 *
 * Each question becomes one string-enum property keyed by its `header`: `{ type: "string", title:
 * <question>, enum: <option labels, in order> }`, and every header is marked `required` (one entry per
 * question, in order). The returned literal is shaped to satisfy the pinned SDK `zCreateElicitationRequest`.
 */
export function buildElicitationRequest(
  toolUseId: string,
  sessionId: string,
  toolInput: AskUserQuestionInput,
): CreateElicitationRequest {
  const properties: Record<string, { type: "string"; title: string; enum: string[] }> = {};
  const required: string[] = [];

  for (const q of toolInput.questions) {
    properties[q.header] = {
      type: "string",
      title: q.question,
      enum: q.options.map((o) => o.label),
    };
    required.push(q.header);
  }

  const message =
    toolInput.questions.length === 1
      ? `Please answer: ${toolInput.questions[0]?.question ?? "the question below"}`
      : `Please answer the following ${toolInput.questions.length} question(s).`;

  // The SDK `CreateElicitationRequest` is an awkward mode/scope intersection; this well-formed form
  // literal parses against `zCreateElicitationRequest` (verified by the C1 test), so a single localized
  // cast is used rather than scattering `any` across the object.
  return {
    mode: "form",
    message,
    sessionId,
    toolCallId: toolUseId,
    requestedSchema: {
      type: "object",
      properties,
      required,
    },
  } as CreateElicitationRequest;
}

/** The wire actions the bridge recognizes as a well-formed elicitation response. */
const KNOWN_ACTIONS = new Set(["accept", "decline", "cancel"]);

/**
 * True iff `resp` is a structurally well-formed `CreateElicitationResponse` — i.e. an object whose
 * `action` is one of accept|decline|cancel. Used to fail closed on a malformed wire response WITHOUT
 * importing the zod validators (blocked by the package `exports` map).
 */
function hasKnownAction(resp: unknown): resp is CreateElicitationResponse & { action: string } {
  return (
    typeof resp === "object" &&
    resp !== null &&
    "action" in resp &&
    typeof (resp as { action: unknown }).action === "string" &&
    KNOWN_ACTIONS.has((resp as { action: string }).action)
  );
}

/**
 * Map an elicitation outcome back to a gate decision (R2). EVERY branch returns a `deny`: the gate
 * always denies AskUserQuestion at the wire and surfaces the result through `reason` (the R2.1 seam — a
 * PreToolUse hook cannot synthesize a native tool_result).
 *
 *   - `accept`: the reason embeds EVERY selected answer (e.g. `Env=prod, Cache=yes`) so the model can
 *     read the choice from the deny reason. `content` null/undefined is handled defensively (still deny).
 *   - `decline`/`cancel`/any unrecognized-or-missing action: the reason reads as a user DISMISSAL, not
 *     an answer (default-deny defensively for unknown actions).
 */
export function mapOutcomeToDecision(resp: CreateElicitationResponse): ElicitationDecision {
  // `resp` is a typed union, but we read `action`/`content` defensively (a synthetic fail-closed
  // cancel or a malformed upstream value may reach here) via a single localized view.
  const view = resp as {
    action?: unknown;
    content?: Record<string, unknown> | null;
  } | null;

  if (view?.action === "accept") {
    const content = view.content;
    const answers =
      content !== undefined && content !== null
        ? Object.entries(content)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")
        : "";
    const reason =
      answers.length > 0
        ? `AskUserQuestion answered by the user: ${answers}. (The tool is always denied at the ` +
          `gate; this selection is returned to you via this reason.)`
        : `AskUserQuestion was accepted but returned no selection. (The tool is always denied at ` +
          `the gate; treat this as no usable answer.)`;
    return { decision: "deny", reason };
  }

  // decline, cancel, or any unrecognized/missing action → a dismissal, never an answer.
  return {
    decision: "deny",
    reason:
      `The user dismissed the AskUserQuestion prompt without providing an answer (no answer was ` +
      `selected). (The tool is always denied at the gate.)`,
  };
}

/** Options for {@link requestElicitation}. */
export interface RequestElicitationOptions {
  /** The hard upper bound (ms) on the round-trip; a slower client fails closed to a cancel. */
  timeoutMs: number;
  /** Optional sink for the fail-closed diagnostics (defaults to no-op; production wires the logger). */
  onWarn?: (message: string) => void;
}

/** A synthetic fail-closed outcome — a cancel is a dismissal, mapped to a deny at the gate. */
function failClosedCancel(): CreateElicitationResponse {
  // `{ action: "cancel" }` satisfies the SDK response union; a localized cast avoids widening the API.
  return { action: "cancel" } as CreateElicitationResponse;
}

/**
 * Perform the bounded, fail-closed elicitation round-trip (R4). NEVER throws and NEVER hangs past
 * ~`timeoutMs`.
 *
 *   - Happy path (a well-formed response, action ∈ {accept,decline,cancel}) → returned UNCHANGED.
 *   - Timeout → `onWarn` (naming the timeout) and resolve `{ action: "cancel" }`.
 *   - Client throws → `onWarn` (including the underlying error text) and resolve `{ action: "cancel" }`.
 *   - Malformed response (action not accept|decline|cancel) → normalized to `{ action: "cancel" }`.
 *
 * The timer is always cleared on settle so no live handle keeps the event loop open.
 */
export async function requestElicitation(
  client: ElicitationClient,
  req: CreateElicitationRequest,
  opts: RequestElicitationOptions,
): Promise<CreateElicitationResponse> {
  const { timeoutMs, onWarn } = opts;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    const settled = await Promise.race([
      // DEFER the client call through a resolved microtask so a SYNCHRONOUS throw (the method is
      // `undefined` — capability advertised but absent — or it throws before returning a promise)
      // becomes a REJECTION the inline handler below catches, instead of escaping at argument-
      // evaluation time (this `try` has only a `finally`, so an eager throw would re-throw out of
      // requestElicitation, violating "never throws"). Async rejections still take the same path.
      Promise.resolve()
        .then(() => client.createElicitation(req))
        .then(
          (resp): { ok: true; resp: unknown } => ({ ok: true, resp }),
          (err): { ok: false; err: unknown } => ({ ok: false, err }),
        ),
      timeout,
    ]);

    // Timeout won the race — fail closed to a cancel.
    if ("__timedOut" in settled) {
      onWarn?.(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion elicitation timed out after ${timeoutMs}ms ` +
          `— resolving as a cancel (dismissal), never an accept.`,
      );
      return failClosedCancel();
    }

    // The client threw — fail closed to a cancel, surfacing the underlying error text.
    if (!settled.ok) {
      const err = settled.err;
      onWarn?.(
        `[gate elicitation] FAIL CLOSED: AskUserQuestion elicitation transport error ` +
          `(${err instanceof Error ? err.message : String(err)}) — resolving as a cancel.`,
      );
      return failClosedCancel();
    }

    // A well-formed response is returned unchanged; a malformed one is normalized to a cancel.
    if (hasKnownAction(settled.resp)) {
      return settled.resp;
    }
    onWarn?.(
      `[gate elicitation] FAIL CLOSED: malformed elicitation response (action not accept|decline|` +
        `cancel) — resolving as a cancel.`,
    );
    return failClosedCancel();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
