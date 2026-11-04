// === Story 024 / Task 4.1 — map raw JSONL `message.stop_reason` to the ACP stopReason taxonomy ====
//
// §7 translation JSONL→ACP. The model's terminal `stop_reason` is mapped to the ACP `StopReason`
// the rewritten prompt() loop answers with (§5, §17 acp-agent.ts PromptResponse). The map is TOTAL:
// it never throws, and an unrecognized non-null variant is surfaced (logged) and defaulted rather
// than silently dropped, so model/stop-reason drift is observable for telemetry (R3.3).

import type { StopReason } from "@agentclientprotocol/sdk/unstable";

/** Telemetry sink for an unmapped stop_reason (drift). Structural — the acp-agent logger satisfies it. */
export interface StopReasonLogger {
  error: (...args: unknown[]) => void;
}

/**
 * Map a raw `message.stop_reason` to the ACP {@link StopReason} (R3.1–R3.3):
 * - `end_turn` / `stop_sequence` → `"end_turn"`
 * - `max_tokens` → `"max_tokens"`
 * - `refusal` → `"refusal"`
 * - any unrecognized NON-NULL value → the defined fallback `"end_turn"`, AND the raw value is logged
 *   for drift telemetry (never silently dropped).
 *
 * Total: never throws. `null`/`undefined` (absence, not drift) return the fallback without logging.
 */
export function mapStopReason(raw: unknown, logger?: StopReasonLogger): StopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      if (raw !== null && raw !== undefined) {
        // Drift: a non-null stop_reason outside the known set. Surface it (R3.3) — don't drop it.
        logger?.error("[stop-reason-map] unmapped stop_reason, defaulting to end_turn:", raw);
      }
      return "end_turn";
  }
}
