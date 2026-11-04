// Story 025 / Group 3 (R3.1, R3.2) — the optional UNSTABLE `usage_update` mapping.
// `usage_update` exists ONLY in the @agentclientprotocol/sdk 0.22.1 schema and is
// best-effort per §1; it maps the JSONL message-event `usage.{input,output}_tokens` into the
// SDK's { sessionUpdate:"usage_update", size, used } shape. Story 042 FLIPPED the default to ON
// (story 039 confirmed the user's Zed ACCEPTS+RENDERS it by code); only the explicit opt-out
// USAGE_UPDATE=0/false disables it (see usage-env.ts). A rejected emission is still suppressed by
// the pump's per-session reject latch (Task 5.1, R8).
//
// Kept a self-contained module (cf. diff-source.ts) imported by the acp-agent pump; it does
// NOT go through lib.ts (the frozen upstream export surface).

import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";

/** The UNSTABLE `usage_update` variant of the SDK 0.22.1 SessionUpdate union. */
export type UsageUpdateNotification = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

/** Defensive view of a JSONL message-event's `usage` block (§7). All fields optional. */
export interface UsageCarrier {
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
  /**
   * The turn's model id, as the JSONL writes it on `assistant.message.model` (story 066).
   * Read ONLY by {@link usageByModel}; {@link toUsageUpdate} ignores it — the pinned wire
   * shape has no field for it. Optional and possibly empty, like every other field here.
   */
  model?: string | null;
}

export interface UsageOptions {
  /**
   * Total context-window size for the notification's `size` field. The pump supplies
   * SessionState.contextWindowSize; absent it, `size` best-effort falls back to `used`
   * (never an invented number — §1 "never fabricate counts").
   */
  contextWindowSize?: number;
}

/**
 * The tokens ONE carrier accounts for — `input_tokens + output_tokens` — or `undefined` when it
 * carries neither count.
 *
 * That `undefined` is the §1 best-effort skip, and it lives here so the module has exactly ONE
 * definition of "there is nothing to report": {@link toUsageUpdate} turns it into an emitted
 * nothing, {@link usageByModel} into an absent row. A genuine zero is a count, not a skip — only
 * absence (missing or null on BOTH fields) skips, so the two can never drift on that distinction.
 */
function tokensUsed(message: UsageCarrier): number | undefined {
  const input = message?.usage?.input_tokens;
  const output = message?.usage?.output_tokens;
  if ((input === undefined || input === null) && (output === undefined || output === null)) {
    return undefined;
  }
  return (input ?? 0) + (output ?? 0);
}

/**
 * Task 3.2 (R3.2) — map a message-event `usage.{input,output}_tokens` into the UNSTABLE
 * `usage_update` notification. PURE and TOTAL: returns `undefined` (best-effort skip, §1)
 * when neither token count is present; never throws on a partial/absent usage block.
 *
 * Story 042 — the EMITTED SHAPE is pinned to the Zed v1 `UsageUpdate` struct (story 039):
 * EXACTLY `{ sessionUpdate: "usage_update", size, used }`, camelCase, and nothing more.
 *   • R2.2 — `used = input_tokens + output_tokens`; `size = contextWindowSize` (the inferred
 *     window). The `?? used` here is ONLY a library fallback for a caller that omits the window;
 *     the live pump (acp-agent.ts) ALWAYS supplies `contextWindowSize`, so the live path never
 *     takes it (the degenerate `size === used` cannot occur over the wire).
 *   • R3.1 — the optional `cost` field is INTENTIONALLY OMITTED and must NEVER be fabricated:
 *     the JSONL usage block carries only token counts, and `cost` is optional in the Zed v1 struct,
 *     so omitting it is contract-correct (an invented cost would violate §1 "never fabricate").
 *     Story 059 EVIDENCE (2026-06-28): an audit of 5169 local transcripts found 0 carrying
 *     `total_cost_usd` as a JSON key — it lives only in the SDK `result` envelope (`claude -p`), never
 *     in the interactive PTY+tail JSONL mapped here (the 68 substring hits were all conversation text).
 */
export function toUsageUpdate(
  message: UsageCarrier,
  options: UsageOptions = {},
): UsageUpdateNotification | undefined {
  const used = tokensUsed(message);
  // best-effort: no usage tokens at all -> emit nothing, never fabricate.
  if (used === undefined) return undefined;
  const size = options.contextWindowSize ?? used;
  return { sessionUpdate: "usage_update", size, used };
}

export interface UsageFlagOptions extends UsageOptions {
  /** Feature flag (Task 3.1, R3.1) — defaults OFF. When false, NOTHING is constructed. */
  usageUpdate?: boolean;
}

/**
 * Task 3.1 (R3.1) — the feature-flag gate. Returns the `usage_update` notifications to append
 * to a turn's session/update stream: an EMPTY array when the flag is OFF, so the stream is
 * byte-for-byte unaffected by the flag's presence; a single notification when the flag is ON and
 * the message carries usage tokens. A no-op when OFF — `toUsageUpdate` is not even called — not a
 * suppressed-after-build.
 *
 * Story 042 — the flag DEFAULT is decided by the caller: the entrypoint (src/usage-env.ts,
 * `usageUpdateEnabled`) now defaults it ON, while a directly-constructed/test agent stays opt-in
 * (acp-agent.ts `?? false`). Each emitted object is EXACTLY the pinned `{ sessionUpdate, size, used }`
 * shape (see {@link toUsageUpdate}): no `cost`, and `size` is the inferred window on the live path.
 */
export function usageUpdatesFor(
  message: UsageCarrier,
  options: UsageFlagOptions = {},
): UsageUpdateNotification[] {
  if (!options.usageUpdate) return []; // flag OFF (default) -> construct nothing
  const update = toUsageUpdate(message, options);
  return update ? [update] : [];
}

// ─── Task 3.1 (R5.1, R5.3) — per-model token usage, and what this port does NOT deliver ──────────
//
// WHAT IT DELIVERS. Upstream #1037 reports token usage PER MODEL. The dimension the mapping above
// lacks is the model, and the JSONL already carries it: story 066's probe established that a model
// switch surfaces as a per-turn `assistant.message.model` tag, on the very carrier `toUsageUpdate`
// already reads. Grouping by that tag needs no new source (REBASE-AND-DRIFT.md §15.6).
//
// WHAT IT DOES NOT DELIVER. Stated here on purpose: the difference between a port and a claim of
// parity is whether the code admits its own gap.
//
//   • NO CURRENT CLIENT RENDERS IT. Zed's `update_token_usage` is called only from `crates/agent/`
//     — its NATIVE agent. Nothing in `crates/agent_servers/`, the path an ACP agent such as this one
//     reaches Zed through, feeds it. The totals below are correct and have nowhere to arrive. That
//     is the inverse of a CUT seam: reachable here, inert at the far end.
//   • NOTHING HERE PUBLISHES OR BUMPS THE PACKAGE. This project is closed as a product
//     (PROJECT-CLOSURE.md); adding this function releases no npm version and bumps none, so it
//     cannot reach a client even if one later learned to render it.
//   • NO WIRE SURFACE. `usageByModel` is deliberately NOT wired into the acp-agent pump and adds no
//     field to the pinned `{ sessionUpdate, size, used }` shape. Inventing an unspecified field on
//     an UNSTABLE notification is precisely the §1 "never fabricate" failure. It is a library
//     function with tests and, by design, no caller.
//
// The ledger's word for this state is KNOWINGLY UNCONSUMED — ported because the data is present and
// the grouping is verifiable, recorded as unconsumed because no reader exists. Do not read its
// presence as parity.

/**
 * The key a turn's usage is filed under: its model id verbatim, or `null` when the turn carries no
 * usable model tag.
 *
 * `null` rather than a string sentinel, and that is a correctness choice, not a style one. R5.1
 * names only `assistant.message.model`, so the untagged bucket is a key this port INVENTS — and any
 * string it invented could collide with a real model id. A turn tagged `"unknown"` is a model named
 * "unknown"; a turn with no tag is a different thing entirely, and folding the two together would
 * report two unrelated things as one row. `null` cannot collide, because no model id is `null`.
 */
export type UsageModelKey = string | null;

/**
 * The model key for one carrier. VERBATIM: the id is used exactly as the JSONL wrote it, with no
 * normalisation, lower-casing, prefix match or suffix stripping. `claude-opus-4-8` and
 * `claude-opus-4-8[1m]` are two models with two different context windows (see
 * `inferContextWindowFromModelId`), so any rule that merged them would merge two models' spend into
 * one row.
 *
 * Absent, non-string or EMPTY tags fold into the untagged bucket. The `length > 0` half matches the
 * convention the live path already uses on this exact field (acp-agent.ts, story 069): an empty
 * string is a missing tag, not a model whose name is "".
 */
function modelKeyOf(model: unknown): UsageModelKey {
  return typeof model === "string" && model.length > 0 ? model : null;
}

/**
 * Task 3.1 (R5.1) — group token usage per model, keyed by the JSONL's per-turn
 * `assistant.message.model`. PURE and TOTAL, like the rest of this module: it never throws on a
 * partial carrier and never fabricates a count.
 *
 * Each key's value is `input_tokens + output_tokens` summed across every turn filed under it — the
 * same `used` arithmetic {@link toUsageUpdate} emits (R2.2), only partitioned. A carrier with no
 * token counts at ALL contributes nothing and opens no row, matching that function's best-effort
 * skip; a carrier reporting a genuine zero is not the same thing and does open one.
 *
 * See the block comment above for what this does NOT deliver (R5.3).
 */
export function usageByModel(messages: Iterable<UsageCarrier>): Map<UsageModelKey, number> {
  const totals = new Map<UsageModelKey, number>();
  for (const message of messages) {
    const used = tokensUsed(message);
    // best-effort: no usage tokens at all -> no row, never a fabricated zero.
    if (used === undefined) continue;
    const key = modelKeyOf(message?.model);
    totals.set(key, (totals.get(key) ?? 0) + used);
  }
  return totals;
}
