// === §7 Tree linearization: SessionMessage[] → ordered Turn[] (story 017) ====================
//
// The fork's read path turns a <sessionId>.jsonl transcript into ACP session/update notifications.
// Between "read the file" (story 015 watcher + getSessionMessages) and "translate each message"
// (stories 018-021) sits THIS module: it adopts the SDK's already-ordered, already-filtered main
// chain and exposes it as an ordered Turn[] the translator consumes.
//
// BINDING DECISION E5 "REUSE-live": we do NOT hand-roll a parentUuid tree walker. The SDK's
// getSessionMessages already parses the transcript, builds the conversation chain via parentUuid
// links INTERNALLY, resolves forks/re-prompts/compact anchors, filters isSidechain/isMeta, and
// returns ONLY the main-chain user/assistant messages in chronological order (sdk.d.ts ~L715; E5
// DECISION-E5.md: "0 linearization divergences", "returning 4 main-chain messages").
//
// RECONCILIATION (orchestrator decision, Option 1 — user-confirmed) ============================
// The design.md was written against an ASSUMED SessionMessage carrying parentUuid/isSidechain/cwd/
// timestamp. The REAL, empirically-verified shape (story 015, jsonl.ts:467-485; sdk.d.ts:3837) is
// REDUCED:  { type: 'user'|'assistant'|'system', uuid, session_id, message, parent_tool_use_id }.
// So this module is reconciled to the real shape:
//   - Order (R1.1): adopt the returned ARRAY order verbatim — it is already chronological.
//   - isSidechain/isMeta filtering (R1.2): ALREADY done by the SDK; the live input is main-chain
//     only. The partition in linearizeTurns therefore reads `isSidechain` ONLY if a raw-shaped
//     fixture/fallback carries it, ELSE infers a sidechain from a non-null `parent_tool_use_id`
//     (the only sidechain signal present in the reduced live shape).
//   - Order key (R3): uuid-anchored + monotonic position (NOT parentUuid, which is absent live).
//     Justified by the E5 monotonic-ordered-superset property: a prefix re-parse keeps every prior
//     position, so the key is stable and append-only.
//   - The full parentUuid/isSidechain TREE logic genuinely belongs to the R1.3 fallback
//     (buildChainEquivalent over RAW JSONL lines), where those fields actually exist.
// Each deviation is recorded in LINEARIZATION.md (Task 4.5) and .draft/deviations.yaml.

import type { SessionMessage, GetMessages } from "./engine-watcher.js";

/**
 * One ordered turn in the linearized stream the §7 translator consumes.
 *
 * `role` is typed as `string` (NOT the design's `'user' | 'assistant'`) — a DOCUMENTED DEVIATION:
 * the linearizer must forward-compat unknown `.type` values without breaking the order (story.md
 * constraint; story 016 tolerant switch), so it echoes `.type` verbatim and leaves an unknown type
 * for the downstream tolerant switch to ignore. `parentUuid` is present only when a raw-shaped
 * fixture / the R1.3 fallback carries it; it is `null` for the reduced REUSE-live shape.
 */
export interface Turn {
  /** Stable, append-only, uuid-anchored order key (Task 3.1). Sortable by chain position. */
  orderKey: string;
  /** Message uuid (identity; the dedupe key upstream). Empty string if the input lacks one. */
  uuid: string;
  /** Parent uuid when present (raw fixture / R1.3 fallback); `null` in the reduced live shape. */
  parentUuid: string | null;
  /** Message role — `.type` echoed verbatim (`'user'`/`'assistant'`/unknown), not enumerated. */
  role: string;
  /** The source message, passed through UNTOUCHED to the §7 translator. */
  message: SessionMessage;
  /**
   * Set when THIS turn is itself a sidechain row that appears in the top level — under `inline`, or
   * as an orphan fallback under `nested` (Task 2.3). Points up to its (claimed) spawning Task id.
   */
  sidechain?: { parentToolUseId: string };
  /**
   * Under the `nested` policy (Task 2.1): the sidechain (subagent) rows spawned by a `tool_use` in
   * THIS turn, attached so the translator renders them under the spawning `tool_call`. Absent when
   * the turn spawned no resolved sidechain. (Reinterprets the design's ambiguous `sidechain` field
   * into a concrete parent→children attachment — see .draft/deviations.yaml.)
   */
  nested?: SessionMessage[];
}

/** The sidechain flattening policy (Task 2). `nested` is the default (design Key Decision 2). */
export type SidechainPolicy = "nested" | "hidden" | "inline";

/** Options for {@link linearizeTurns}. Extends the policy options with the orphan-drift sink. */
export interface LinearizeOptions extends ApplyPolicyOptions {
  /** Sidechain flattening policy (Task 2); defaults to `'nested'`. */
  sidechainPolicy?: SidechainPolicy;
}

/** Narrowing helper: a non-null plain object (so we can read string-keyed props safely). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sidechain's spawning Task `tool_use.id`, read from `parent_tool_use_id` (SDK snake_case) or
 * `parentToolUseId` (story-015 typed name) — whichever is a non-empty string. `undefined` when the
 * message has neither (a main-chain row, or an orphan whose parent is absent — Task 2.3).
 */
function parentToolUseIdOf(m: SessionMessage): string | undefined {
  const rec = m as Record<string, unknown>;
  const v = rec.parent_tool_use_id ?? rec.parentToolUseId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Whether a message is a sidechain (subagent) row. RECONCILED to the real SDK shape: there is no
 * `isSidechain` field in the reduced live output, so we read `isSidechain` ONLY when a raw-shaped
 * fixture / the R1.3 fallback supplies it, and otherwise infer a sidechain from a non-null
 * `parent_tool_use_id` (the only sidechain signal in the reduced shape).
 */
function isSidechainMsg(m: SessionMessage): boolean {
  const rec = m as Record<string, unknown>;
  if (typeof rec.isSidechain === "boolean") return rec.isSidechain;
  return parentToolUseIdOf(m) !== undefined;
}

/**
 * Whether a message is a non-conversational anchor/meta row that must NEVER be a top-level turn:
 * a raw `isMeta` flag, OR a `summary` (post-`/compact` continuity anchor, R4.3), OR a `system` row.
 * getSessionMessages already excludes these on the live path (system/summary not returned by
 * default); honouring them here keeps a raw fixture / `includeSystemMessages` input consistent and
 * the linear order continuous across a compaction boundary.
 */
function isMetaMsg(m: SessionMessage): boolean {
  const rec = m as Record<string, unknown>;
  if (rec.isMeta === true) return true;
  if (isReplayHiddenMetaMessage(m)) return true;
  return m.type === "summary" || m.type === "system";
}

/** Origin kinds of the meta user messages `getSessionMessages` returns since SDK 0.3.284 (messages
 *  from other agents, sessions and channels) — the SDK's own inclusion set for meta rows. */
const REPLAY_HIDDEN_META_ORIGIN_KINDS = new Set([
  "peer",
  "channel",
  "observer",
  "observer-activity",
  "slack-ping",
]);

/**
 * True for a transcript message delivered to the model from another agent, session or channel.
 * Since SDK 0.3.284 `getSessionMessages` returns these as `is_meta` user messages whose content is
 * the full harness framing (envelope XML plus the "not typed by your user" preamble). The user never
 * typed them, so they are never a turn — on `session/load` replay AND on the live pump, which reads
 * the same SDK reader here. Other `is_meta` messages (compaction summaries) are kept. Ported from
 * claude-agent-plus, which took it from upstream #1208.
 *
 * `is_meta` and `origin` are runtime fields the SDK does not declare on `SessionMessage`.
 */
export function isReplayHiddenMetaMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { type, is_meta, origin } = message as {
    type?: unknown;
    is_meta?: unknown;
    origin?: { kind?: unknown } | null;
  };
  return (
    type === "user" &&
    is_meta === true &&
    typeof origin?.kind === "string" &&
    REPLAY_HIDDEN_META_ORIGIN_KINDS.has(origin.kind)
  );
}

/** Parent uuid when carried by the input (raw fixture / fallback); `null` otherwise. */
function parentUuidOf(m: SessionMessage): string | null {
  const rec = m as Record<string, unknown>;
  return typeof rec.parentUuid === "string" ? rec.parentUuid : null;
}

/** The message uuid, or `''` when absent (mirrors story-015 projectEvent tolerance). */
function uuidOf(m: SessionMessage): string {
  return typeof m.uuid === "string" ? m.uuid : "";
}

/**
 * The stable, uuid-anchored, append-only order key (Task 3.1, R3.1/R3.2).
 *
 * RECONCILED signature: the design specifies `chainPositionKey(uuid, parentUuid)`, but `parentUuid`
 * is absent in the reduced REUSE-live shape, so the key is derived from the monotonic chain POSITION
 * (array index) anchored to `uuid` — `pad(index):uuid`. The E5 monotonic-ordered-superset property
 * guarantees a prefix re-parse keeps each position, so a turn at order k keeps key k after appends;
 * the leading zero-padded index makes keys sort by chain position, and the `:uuid` suffix anchors
 * identity (two turns can never collide). parentUuid-derived keying is reserved for the R1.3 fallback
 * path (where parentUuid actually exists). See .draft/deviations.yaml.
 *
 * @param uuid the turn's message uuid (identity anchor).
 * @param index the turn's monotonic position in the top-level stream.
 * @returns the sortable, stable, append-only order key.
 */
export function chainPositionKey(uuid: string, index: number): string {
  return `${String(index).padStart(8, "0")}:${uuid}`;
}

/** The `tool_use` block ids inside a message's `message.content` array (the spawning Task ids). */
function toolUseIdsOf(m: SessionMessage): string[] {
  const message = (m as Record<string, unknown>).message;
  if (!isObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "tool_use" && typeof block.id === "string") {
      ids.push(block.id);
    }
  }
  return ids;
}

/** All `tool_use` ids present across the main stream — the set a sidechain must resolve against. */
function collectToolUseIds(mainMessages: SessionMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of mainMessages) {
    for (const id of toolUseIdsOf(m)) ids.add(id);
  }
  return ids;
}

/** A drift record for an orphan sidechain whose `parent_tool_use_id` does not resolve (Task 2.3). */
export interface SidechainDriftRecord {
  kind: "orphan-sidechain";
  /** The unresolved parent tool-use id (or `null` when the sidechain carried none). */
  parentToolUseId: string | null;
  /** The orphan sidechain's uuid. */
  uuid: string;
}

/** Default orphan-drift sink: log to STDERR (never stdout — the ACP protocol channel). */
function defaultSidechainDrift(record: SidechainDriftRecord): void {
  console.error(`[lin-drift] ${JSON.stringify(record)}`);
}

/** Options for {@link applySidechainPolicy} (and forwarded by {@link linearizeTurns}). */
export interface ApplyPolicyOptions {
  /** Injectable orphan-drift sink; defaults to {@link defaultSidechainDrift} (stderr). */
  onDrift?: (record: SidechainDriftRecord) => void;
}

/** The structured result of {@link applySidechainPolicy}. */
export interface AppliedPolicy {
  /** The top-level message stream (main turns; plus inline sidechains under `inline`/orphan). */
  topLevel: SessionMessage[];
  /** `nested` policy only: spawning `tool_use` id → its sidechain rows. */
  nestedByToolUseId?: Map<string, SessionMessage[]>;
}

/**
 * Apply the sidechain flattening policy (R2), encapsulated so it is one decision, not scattered
 * branching. Partitions out `isMeta`, then:
 *   - `nested` (default, R2.2): resolved sidechains group under their spawning `tool_use` id in
 *     `nestedByToolUseId` and are kept OUT of `topLevel` (top-level count = main-chain count). An
 *     ORPHAN sidechain whose `parent_tool_use_id` does not resolve to a main-stream tool_use is
 *     placed INLINE in chronological position (never dropped) and logged as drift once (R2.3).
 *   - `hidden` (R2.3): sidechains dropped; `topLevel` = main, no `nestedByToolUseId`.
 *   - `inline` (R2.3): sidechains merged in chronological position WITHOUT reordering any main turn
 *     (`topLevel` = all non-meta rows in input order; main is a subsequence).
 *
 * @param messages the SDK-ordered message sequence.
 * @param policy the flattening policy.
 * @param opts injectable orphan-drift sink.
 * @returns the {@link AppliedPolicy}.
 */
export function applySidechainPolicy(
  messages: SessionMessage[],
  policy: SidechainPolicy,
  opts: ApplyPolicyOptions = {},
): AppliedPolicy {
  const onDrift = opts.onDrift ?? defaultSidechainDrift;

  const nonMeta: SessionMessage[] = [];
  const main: SessionMessage[] = [];
  const sidechain: SessionMessage[] = [];
  for (const m of messages) {
    if (!isObject(m) || isMetaMsg(m)) continue;
    nonMeta.push(m);
    if (isSidechainMsg(m)) sidechain.push(m);
    else main.push(m);
  }

  if (policy === "hidden") {
    return { topLevel: main };
  }
  if (policy === "inline") {
    // Chronological merge without reordering main: input order already chronological, so the
    // non-meta sequence keeps main as a subsequence with sidechains in place.
    return { topLevel: nonMeta };
  }

  // nested (default): group resolved sidechains; place orphans inline + log drift (Task 2.3).
  const validToolUseIds = collectToolUseIds(main);
  const nestedByToolUseId = new Map<string, SessionMessage[]>();
  const orphans = new Set<SessionMessage>();
  for (const s of sidechain) {
    const pid = parentToolUseIdOf(s);
    if (pid !== undefined && validToolUseIds.has(pid)) {
      const arr = nestedByToolUseId.get(pid) ?? [];
      arr.push(s);
      nestedByToolUseId.set(pid, arr);
    } else {
      orphans.add(s);
      onDrift({ kind: "orphan-sidechain", parentToolUseId: pid ?? null, uuid: uuidOf(s) });
    }
  }

  // topLevel = main turns + orphan sidechains placed INLINE in chronological position. Resolved
  // (nested) sidechains are excluded from topLevel — they live in nestedByToolUseId.
  const topLevel: SessionMessage[] = [];
  for (const m of nonMeta) {
    if (isSidechainMsg(m)) {
      if (orphans.has(m)) topLevel.push(m); // orphan kept inline (R2.3), never silently dropped
    } else {
      topLevel.push(m);
    }
  }
  return { topLevel, nestedByToolUseId };
}

/**
 * Linearize the SDK's `SessionMessage[]` into an ordered top-level `Turn[]` for the §7 translator:
 * adopt the SDK order (R1.1), apply the sidechain flattening policy (R2, default `nested`), and
 * assign each turn a stable, uuid-anchored order key (R3.1/R3.2).
 *
 * Under `nested`, each main turn that spawned resolved sidechains carries them on `Turn.nested`
 * (attached by its `tool_use` ids); a top-level sidechain (inline policy, or orphan) carries
 * `Turn.sidechain = { parentToolUseId }`. The main-turn subsequence is identical across all three
 * policies (R2.3) — only sidechain placement differs.
 *
 * Pure and synchronous: no I/O, no SDK call (the caller supplies `messages`).
 *
 * @param messages the SDK-ordered message sequence (from {@link readOrderedMessages}).
 * @param opts flattening-policy + orphan-drift options (`nested` default).
 * @returns the ordered top-level `Turn[]`.
 */
export function linearizeTurns(messages: SessionMessage[], opts: LinearizeOptions = {}): Turn[] {
  const policy = opts.sidechainPolicy ?? "nested";
  const { topLevel, nestedByToolUseId } = applySidechainPolicy(messages, policy, {
    onDrift: opts.onDrift,
  });

  return topLevel.map((m, index) => {
    const turn: Turn = {
      orderKey: chainPositionKey(uuidOf(m), index),
      uuid: uuidOf(m),
      parentUuid: parentUuidOf(m),
      role: typeof m.type === "string" ? m.type : "",
      message: m,
    };
    if (isSidechainMsg(m)) {
      // A sidechain in the top level (inline policy, or orphan under nested): point up to its Task.
      const pid = parentToolUseIdOf(m);
      if (pid !== undefined) turn.sidechain = { parentToolUseId: pid };
    } else if (policy === "nested" && nestedByToolUseId) {
      // Attach the sidechain rows spawned by this main turn's tool_use blocks. The live merge path
      // (story 041) concatenates the SEPARATE sub-agent stream onto the main chain, so insertion
      // order is NOT a reliable render order; sort the attached children by uuid (R1.2) so the
      // nested block is deterministic regardless of how the two streams interleaved on input.
      const children: SessionMessage[] = [];
      for (const id of toolUseIdsOf(m)) {
        const group = nestedByToolUseId.get(id);
        if (group) children.push(...group);
      }
      if (children.length > 0) {
        children.sort((x, y) => uuidOf(x).localeCompare(uuidOf(y)));
        turn.nested = children;
      }
    }
    return turn;
  });
}

/**
 * Thin SOURCE wrapper (Task 1.1, R1.1): call the injected {@link GetMessages} seam (the SDK's pure,
 * billing-free `getSessionMessages`) and return its `SessionMessage[]` in the SAME chronological
 * order the SDK produced. Performs NO reordering and NO file I/O of its own — the SDK is the single
 * parser (E5 REUSE-live). The seam may be sync or async; we await either way.
 *
 * On an SDK throw (binary/version drift, R1.3 trigger condition) the error is SURFACED with the
 * resolved `sessionId`/`dir` rather than silently swallowed into `[]`, so a drift is loud and
 * diagnosable (the caller decides whether to engage the R1.3 fallback).
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @param dir the runtime cwd (story 015 `readCwdFromInside`) passed as `{ dir }`; may be undefined.
 * @param opts injectable `getMessages` seam (defaults to the SDK reader via dynamic import).
 * @returns the SDK's ordered `SessionMessage[]` (the chronological main chain).
 */
export async function readOrderedMessages(
  sessionId: string,
  dir: string | undefined,
  opts: { getMessages?: GetMessages } = {},
): Promise<SessionMessage[]> {
  const getMessages = opts.getMessages ?? defaultGetMessages;
  try {
    return await getMessages(sessionId, { dir });
  } catch (err) {
    // R1.3 contingency signal: surface the drift loudly with the resolved coordinates. Never `[]`.
    throw new Error(
      `getSessionMessages failed for sessionId="${sessionId}" dir="${dir ?? "<none>"}": ${String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Default {@link GetMessages}: the SDK's pure, billing-free `getSessionMessages`. Imported lazily
 * (dynamic import) so this module — and the deterministic unit tests, which always inject a stub —
 * never force-loads the SDK at module-eval time. Mirrors engine-watcher.ts `defaultGetMessages`.
 *
 * Exported (story 043 R2.1) so acp-agent.ts can reuse it as the PRODUCTION reduced base it wraps in
 * the diff-enriched reader when `liveDiff` is ON (it is the same reduced reader `readOrderedMessages`
 * already falls back to). linearize.ts is a fork module imported directly from ../dist/ — NOT via
 * lib.ts, whose public surface is frozen to upstream v0.53.0 — so this export is safe.
 */
export async function defaultGetMessages(
  sessionId: string,
  opts?: { dir?: string },
): Promise<SessionMessage[]> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.getSessionMessages(sessionId, opts) as Promise<SessionMessage[]>;
}

// === R1.3 contingency: buildChainEquivalent (DISABLED by default) ============================
//
// A behavioral MIRROR of getSessionMessages for the case a future binary makes the SDK
// linearization unavailable/non-equivalent for the live path (R1.3). It operates over RAW JSONL
// lines — the ONLY place parentUuid/isSidechain/isMeta actually exist — reproducing the SDK's
// parentUuid-chain build + isSidechain/isMeta filter + surviving-fork anchor. It is NOT the v1 path
// (E5 REUSE-live is) and is GATED OFF: callers must pass `{ enabled: true }`. See LINEARIZATION.md.

/** Options for {@link buildChainEquivalent}. The fallback is OFF unless `enabled` is `true`. */
export interface FallbackOptions {
  /** Gate: the contingency mirror runs ONLY when this is explicitly `true`. Default OFF. */
  enabled?: boolean;
}

/** A raw JSONL record — an arbitrary object; we read uuid/parentUuid/type/isSidechain/isMeta. */
type RawRecord = {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: unknown;
  [k: string]: unknown;
};

/** The two conversational roles getSessionMessages returns by default (system excluded). */
const MAIN_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

/**
 * Contingency mirror of getSessionMessages over RAW JSONL lines (R1.3) — GATED OFF by default.
 *
 * Reproduces the SDK's linearization behaviorally: parse each line (corrupt lines skipped), keep
 * only main-chain user/assistant rows (drop `isMeta`/`isSidechain`), then follow the parentUuid
 * chain BACKWARD from the latest main row (the tip) to the root and reverse — so abandoned fork
 * branches (not on the tip's ancestry) are excluded (R4.1) and the surviving chain is returned in
 * chronological order. Projects each surviving record into the reduced SDK shape.
 *
 * STUB LIMITATION (documented, contingency-only): the tip is taken as the LAST main row in file
 * order, assuming — as getSessionMessages resolves — that the surviving chain ends at the latest
 * record. A more elaborate anchor-selection is out of scope for a gated-OFF mirror.
 *
 * @param rawLines the transcript's raw JSONL lines (full universal-field shape).
 * @param opts the gate; the mirror runs ONLY with `{ enabled: true }`.
 * @returns the surviving main chain as reduced-shape `SessionMessage[]`, in chronological order.
 */
export function buildChainEquivalent(
  rawLines: string[],
  opts: FallbackOptions = {},
): SessionMessage[] {
  if (opts.enabled !== true) {
    throw new Error(
      "buildChainEquivalent is the R1.3 contingency and is DISABLED by default; " +
        "pass { enabled: true } to engage it. The v1 path is getSessionMessages (E5 REUSE-live).",
    );
  }

  // 1. Parse (skip corrupt/blank lines — forward-compat parser tolerance, §6).
  const records: RawRecord[] = [];
  for (const line of rawLines) {
    if (typeof line !== "string" || line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as unknown;
      if (isObject(rec)) records.push(rec as RawRecord);
    } catch {
      continue;
    }
  }

  // 2. Keep only main-chain user/assistant rows (mirror the SDK isSidechain/isMeta/system filter).
  const main = records.filter((r) => {
    if (r.isMeta === true || r.isSidechain === true) return false;
    return typeof r.type === "string" && MAIN_ROLES.has(r.type);
  });
  if (main.length === 0) return [];

  // 3. Walk the parentUuid chain backward from the tip (latest main row) to the root, then reverse.
  const byUuid = new Map<string, RawRecord>();
  for (const r of main) {
    if (typeof r.uuid === "string") byUuid.set(r.uuid, r);
  }
  const tip = main[main.length - 1];
  const reverseChain: RawRecord[] = [];
  const guard = new Set<string>(); // cycle guard (a malformed parentUuid loop must not hang)
  let cursor: RawRecord | undefined = tip;
  while (cursor) {
    const uuid = typeof cursor.uuid === "string" ? cursor.uuid : "";
    if (uuid && guard.has(uuid)) break;
    if (uuid) guard.add(uuid);
    reverseChain.push(cursor);
    const parent: string | null = typeof cursor.parentUuid === "string" ? cursor.parentUuid : null;
    cursor = parent ? byUuid.get(parent) : undefined;
  }
  reverseChain.reverse();

  // 4. Project each surviving record into the reduced SDK shape getSessionMessages would emit.
  return reverseChain.map((r) => ({
    type: typeof r.type === "string" ? r.type : "",
    uuid: typeof r.uuid === "string" ? r.uuid : "",
    session_id: typeof r.sessionId === "string" ? r.sessionId : "",
    message: r.message,
    parent_tool_use_id:
      typeof r.parentToolUseId === "string"
        ? r.parentToolUseId
        : typeof r.parent_tool_use_id === "string"
          ? r.parent_tool_use_id
          : null,
  }));
}

// === readOrderedTurns: the single live+replay adapter (Task 3.2, R3.3) =======================

/** Options for {@link readOrderedTurns}: the SDK seam plus the linearizer's policy/drift options. */
export interface ReadOrderedTurnsOptions extends LinearizeOptions {
  /** Injectable `getSessionMessages` seam (defaults to the SDK reader). */
  getMessages?: GetMessages;
}

/**
 * The SINGLE seam both the live re-parse path and the `session/load` replay path call (R3.3):
 * `readOrderedMessages` (adopt the SDK's ordered main chain) + `linearizeTurns` (partition, apply
 * the sidechain policy, assign stable order keys). Because both paths funnel through this one
 * function, live and replay CANNOT diverge in ordering — the guarantee holds by construction.
 *
 * The live read path streams mid-turn content on the story-015 debounced-write signal; this
 * stable (re-)ordering re-runs on the story-024 end-of-turn signal (see {@link bindEndOfTurnReparse},
 * Task 3.3). `replaySessionHistory` (story 011/023) calls it once for `session/load`.
 *
 * @param sessionId the session id; equals the transcript filename basename.
 * @param dir the runtime cwd (story 015) passed to `getSessionMessages`; may be undefined.
 * @param opts the SDK seam + sidechain policy / orphan-drift options.
 * @returns the ordered `Turn[]` (identical whether requested via the live or replay seam).
 */
export async function readOrderedTurns(
  sessionId: string,
  dir: string | undefined,
  opts: ReadOrderedTurnsOptions = {},
): Promise<Turn[]> {
  const messages = await readOrderedMessages(sessionId, dir, { getMessages: opts.getMessages });
  return linearizeTurns(messages, {
    sidechainPolicy: opts.sidechainPolicy,
    onDrift: opts.onDrift,
  });
}

// === Task 3.3: bind the live re-parse cadence to the story-024 end-of-turn signal ============
//
// CONSUMES the end-of-turn signal — it does NOT detect it (that is story 024). Re-invokes the
// re-parse (readOrderedTurns) exactly once per detected end-of-turn, with a turn-watchdog safety
// net. Mirrors engine-watcher.ts notifyEndOfTurn cadence, but produces the stable Turn[] ordering.

/** The turn watchdog window (ms) — DEGRAU-0 decision 2. DISTINCT from the 2000ms file-discovery one. */
export const TURN_WATCHDOG_MS = 5583;

/** Default timer seam: fire `fn` after `ms`; the returned fn cancels it. */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

/** Options for {@link bindEndOfTurnReparse}. */
export interface BindEndOfTurnOptions {
  /** Re-parse callback (re-invoke readOrderedTurns). Called once per end-of-turn / watchdog. */
  reparse: () => void | Promise<void>;
  /** Turn-watchdog window (ms); defaults to {@link TURN_WATCHDOG_MS}. */
  watchdogMs?: number;
  /** Injectable timer seam for deterministic tests; defaults to {@link defaultSchedule}. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Handle returned by {@link bindEndOfTurnReparse}. */
export interface EndOfTurnBinding {
  /** Call on the story-024 end-of-turn signal: re-parse once and re-arm the watchdog. */
  notifyEndOfTurn(): void;
  /** Detach: cancel the watchdog and suppress further re-parses. Idempotent. */
  stop(): void;
}

/**
 * Subscribe a re-parse to the end-of-turn cadence (R3.1): re-invoke `reparse` exactly once per
 * detected end-of-turn (the story-024 detector already debounces on terminal stop_reason + Δt=200ms,
 * so we do NOT re-debounce). A turn watchdog (default {@link TURN_WATCHDOG_MS}) re-parses once as a
 * safety net if no end-of-turn signal arrives; a real signal cancels the pending watchdog so a turn
 * never triggers two re-parses. Because the re-parse re-runs `linearizeTurns` over the full monotonic
 * superset, prior orderKeys are reused (R3.1).
 *
 * @param opts the reparse callback + watchdog/timer seams.
 * @returns an {@link EndOfTurnBinding} (`notifyEndOfTurn` + `stop`).
 */
export function bindEndOfTurnReparse(opts: BindEndOfTurnOptions): EndOfTurnBinding {
  const watchdogMs = opts.watchdogMs ?? TURN_WATCHDOG_MS;
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let cancelWatchdog: (() => void) | undefined;

  const armWatchdog = (): void => {
    cancelWatchdog?.();
    cancelWatchdog = schedule(() => {
      cancelWatchdog = undefined;
      if (stopped) return;
      void opts.reparse(); // safety-net re-parse — the signal never came within the window
      armWatchdog(); // re-arm for the next turn
    }, watchdogMs);
  };

  armWatchdog(); // arm for the first turn

  return {
    notifyEndOfTurn(): void {
      if (stopped) return;
      cancelWatchdog?.(); // a real signal cancels the safety net (no double re-parse)
      cancelWatchdog = undefined;
      void opts.reparse(); // exactly one re-parse for this turn
      armWatchdog(); // arm for the next turn
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelWatchdog?.();
      cancelWatchdog = undefined;
    },
  };
}
