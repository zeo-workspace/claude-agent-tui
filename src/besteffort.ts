// Story 020 / Task 4.1 — best-effort gate for the plan/image CONVENIENCE surfaces (R4.1, R4.2).
//
// WHAT THIS IS: a standalone building block that splits an event's content blocks into a CORE
// subset (text/thinking/tool_call/tool_result/etc — the live thread) and a CONVENIENCE subset
// (image content + `TodoWrite` tool_use → `plan`). The CORE subset is ALWAYS translated and
// emitted via the unmodified `toAcpNotifications`. The CONVENIENCE subset is translated only when
// its per-surface flag is on, inside a try/catch, so a thrown error or unusable result there is
// CONTAINED — it skips only that surface, logs a drift note, and never aborts the turn/thread.
//
// CONTAINMENT, NOT NEW TRANSLATION (reuse-only constraint, R2.1/R2.3 family): this module owns NO
// translation logic. Both passes delegate to the REUSED, byte-for-byte `toAcpNotifications`
// (acp-agent.ts) — it is merely called on block SUBSETS and the convenience pass is wrapped. The
// only NEW src is this file itself; it is deliberately NOT exported from lib.ts (whose surface is
// frozen to upstream v0.53.0 and locked by test/lib-exports.test.ts) — the unit test imports it
// directly from dist/besteffort.js. No existing translator is modified.
//
// BUILDING-BLOCK POSTURE: like story 016's `classifyEvent`, this gate currently has NO production
// caller — the final Degrau-1 assembly will wire it. It is exercised by its unit test today.
//
// ACCEPTED TRADE-OFFS (documented, not bugs):
//   • Ordering: CORE blocks are translated in one pass preserving their natural order; the gated
//     CONVENIENCE updates are APPENDED after the core updates. Exact interleaving of plan/image
//     RELATIVE to the core stream is NOT preserved. Acceptable per §1 best-effort — plan/image are
//     convenience surfaces and Zed replaces the plan wholesale, so absolute position is immaterial.
//   • `flags` is a REQUIRED parameter (no global default). The future orchestrator decides, per
//     session, whether the convenience surface is enabled — this block must not assume a default.
//   • Injection seam: the CONVENIENCE pass uses `opts?.translate ?? toAcpNotifications`; the CORE
//     pass ALWAYS uses the real `toAcpNotifications`. A test forces a contained throw by injecting
//     `opts.translate = () => { throw … }`, proving the core stream survives a convenience failure.
import { type SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { type ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { toAcpNotifications, type AcpClient, type Logger, type ToolUseCache } from "./acp-agent.js";

/**
 * Per-surface enable flags for the convenience translation. Each surface is gated independently so
 * the orchestrator can, e.g., keep `plan` while suppressing `image` (or disable both entirely).
 */
export interface ConvenienceFlags {
  /** Emit `plan` updates derived from `TodoWrite` tool_use blocks when true. */
  plan: boolean;
  /** Emit `image` content updates derived from `image` blocks when true. */
  image: boolean;
}

/**
 * A CONVENIENCE block is one whose translation produces a best-effort surface (NOT part of the core
 * text/tool thread): an `image` content block, OR a `TodoWrite` tool_use (which routes to `plan`).
 * Everything else (text, thinking, other tool_use, tool_result, …) is CORE.
 */
export function isConvenienceBlock(block: any): boolean {
  return block?.type === "image" || (block?.type === "tool_use" && block?.name === "TodoWrite");
}

type ContentBlock = ContentBlockParam | BetaContentBlock | BetaRawContentBlockDelta;
type TranslateFn = typeof toAcpNotifications;

/**
 * Split `content` into [core, convenience] block subsets using `isConvenienceBlock`. A non-array /
 * string `content` (the bare-string `toAcpNotifications` fast-path) has no per-block convenience
 * surface, so it is treated wholly as CORE (returned via the core subset, empty convenience subset).
 */
function partitionBlocks(content: string | ContentBlock[]): {
  core: string | ContentBlock[];
  convenience: ContentBlock[];
} {
  if (typeof content === "string" || !Array.isArray(content)) {
    return { core: content, convenience: [] };
  }
  const core: ContentBlock[] = [];
  const convenience: ContentBlock[] = [];
  for (const block of content) {
    if (isConvenienceBlock(block)) {
      convenience.push(block);
    } else {
      core.push(block);
    }
  }
  return { core, convenience };
}

/**
 * Keep only the convenience updates whose surface flag is on. A `plan` update survives iff
 * `flags.plan`; an `image`-content update survives iff `flags.image`. Anything else the convenience
 * pass might emit is dropped (the convenience subset only ever contains image/TodoWrite blocks).
 */
function filterConvenienceUpdates(
  updates: SessionNotification[],
  flags: ConvenienceFlags,
): SessionNotification[] {
  return updates.filter((n) => {
    const update: any = n?.update;
    if (update?.sessionUpdate === "plan") {
      return flags.plan;
    }
    if (update?.content?.type === "image") {
      return flags.image;
    }
    return false;
  });
}

/**
 * Translate `content` with the plan/image convenience surface gated behind a best-effort flag.
 *
 * CORE pass (always, never gated): the non-convenience blocks are translated via the REAL
 * `toAcpNotifications` (`registerHooks: false` to stay synchronous, mirroring the §7 seam tests). A
 * convenience failure can NEVER touch these updates — they are produced before the gated pass runs.
 *
 * CONVENIENCE pass (flag-gated + try/catch): only when at least one surface flag is on AND there is
 * at least one convenience block, the convenience subset is translated (via the injectable
 * `opts.translate`, default the real translator) inside a try/catch. Surviving updates are filtered
 * to the enabled surfaces and appended after the core updates. On a thrown error OR an unusable
 * (non-array) result, a drift note is logged via `logger.error(...)` and that surface is SKIPPED
 * (nothing appended) — the error is NEVER rethrown, so the live thread is never broken.
 *
 * Signature mirrors `toAcpNotifications`'s real parameter list/types (acp-agent.ts:2866), with the
 * required `flags` and the optional `opts.translate` test seam appended.
 */
export function translateBestEffort(
  content: string | ContentBlock[],
  role: "assistant" | "user",
  sessionId: string,
  cache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  flags: ConvenienceFlags,
  opts?: { translate?: TranslateFn },
): SessionNotification[] {
  const { core, convenience } = partitionBlocks(content);

  // CORE pass — ALWAYS the real translator, ALWAYS emitted. Outside any try/catch so a convenience
  // failure provably cannot affect it.
  const coreUpdates = toAcpNotifications(core as any, role, sessionId, cache, client, logger, {
    registerHooks: false,
  });

  // CONVENIENCE pass — gated by the flags AND the presence of convenience blocks. Skipped entirely
  // when both surfaces are off or there is nothing convenient to translate.
  const anyFlagOn = flags.plan || flags.image;
  if (!anyFlagOn || convenience.length === 0) {
    return coreUpdates;
  }

  const translate: TranslateFn = opts?.translate ?? toAcpNotifications;
  try {
    const raw = translate(convenience as any, role, sessionId, cache, client, logger, {
      registerHooks: false,
    });
    // Guard against an unusable result (e.g. a stub returning undefined/non-array): treat as a
    // best-effort miss rather than letting a downstream `.filter` throw.
    if (!Array.isArray(raw)) {
      logger.error(
        `[claude-agent-acp] best-effort convenience translation yielded an unusable (non-array) result for session ${sessionId}; skipping the plan/image surface`,
      );
      return coreUpdates;
    }
    const convenienceUpdates = filterConvenienceUpdates(raw, flags);
    // Core first, then the enabled convenience surfaces appended (ordering trade-off above).
    return [...coreUpdates, ...convenienceUpdates];
  } catch (err) {
    // CONTAINMENT: a thrown convenience translation is caught here, logged as a drift note, and
    // swallowed. The core stream (already computed) is returned intact — the turn/thread survives.
    logger.error(
      `[claude-agent-acp] best-effort convenience translation threw for session ${sessionId}; skipping the plan/image surface (thread preserved): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return coreUpdates;
  }
}
