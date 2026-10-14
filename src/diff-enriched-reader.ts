// Story 043 / Task 1.1 (R1.1, R1.2, R1.3, R4.2) — the diff-enriched reduced-shape reader.
//
// PROBLEM. `getSessionMessages` returns the REDUCED shape (6 fields; see the
// getsessionmessages-reduced-shape follow-up): it does NOT carry the per-type `toolUseResult` that the
// story-021/026 Edit/Write diff block reads off `turn.message.toolUseResult` (acp-agent.ts:1461). With
// the PTY engine the PostToolUse hook that once produced diffs is GONE, so a live pump over the reduced
// shape renders no diff — the diff silently no-ops.
//
// SOLUTION (REUSE-faithful, billing-free). WRAP the base reader and HYDRATE each returned message's
// `toolUseResult` from the raw JSONL transcript, matched by `uuid`:
//   - ordering / identity stay the base reader's (the SDK is the single parser; we add ONE key);
//   - the raw read is a pure `fs` read of the transcript located via `findTranscript(sessionId)` — NO
//     SDK call, so NO token billing (R4.2);
//   - a message whose raw record has no `toolUseResult` is returned UNCHANGED — we NEVER fabricate a
//     patch (R1.2 / R4.2);
//   - any failure to locate / read / parse the transcript falls back to the plain reduced messages so
//     the diff degrades to the existing graceful no-op and the pump NEVER crashes (R1.3).
//
// DEVIATION (recorded in .draft/deviations.yaml, task 1.1/2.2). design.md sketched
// `createDiffEnrichedReader(session.transcriptPath, base)`, but `session.transcriptPath` does not exist
// (neither SessionState nor StartedEngine expose it) and `this.getMessages` is AGENT-level (shared
// across sessions). So the reader derives the path itself from the `sessionId` it already receives via
// `findTranscript(sessionId)[0]` — keeping the wiring agent-level (one `this.getMessages` covers both
// pumpUpdates and replaySessionHistory), multi-session safe, and correct on the story-028 fresh path
// (the path resolves at use-time, when the transcript already exists).
//
// node: builtins + the in-fork jsonl glob only — no new runtime dep, no lib.ts export (frozen surface).
import { readFileSync } from "node:fs";
import { findTranscript as defaultFindTranscript } from "./jsonl.js";
import type { GetMessages, SessionMessage } from "./engine-watcher.js";

/**
 * Build a `uuid → toolUseResult` index from raw JSONL transcript lines.
 *
 * Only records that ARE plain objects carrying BOTH a string `uuid` AND a defined `toolUseResult`
 * enter the map — a record without a `toolUseResult` is intentionally absent so the matching message is
 * returned unchanged (R1.2). Empty/whitespace lines and malformed JSON are skipped silently (robustness:
 * a torn or partially-written final line must never throw and abort the hydration).
 *
 * @param rawLines the transcript's newline-split lines (READ-ONLY; never mutated).
 * @returns a map from message uuid to its raw `toolUseResult` value (possibly empty).
 */
export function toolUseResultMap(rawLines: string[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const line of rawLines) {
    if (line.trim() === "") continue; // skip blank lines (e.g. the trailing newline split)
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed / partially-written line — skip silently, never throw
    }
    if (rec === null || typeof rec !== "object") continue;
    const { uuid, toolUseResult } = rec as { uuid?: unknown; toolUseResult?: unknown };
    if (typeof uuid === "string" && toolUseResult !== undefined) {
      map.set(uuid, toolUseResult);
    }
  }
  return map;
}

/** Construction options for {@link createDiffEnrichedReader} — both seams injectable for tests. */
export interface DiffEnrichedReaderOptions {
  /**
   * Locate the session's transcript file(s). Defaults to the in-fork {@link defaultFindTranscript}
   * (a billing-free recursive glob of `<sessionId>.jsonl` under `~/.claude/projects`). First match.
   */
  findTranscript?: (sessionId: string) => string[];
  /**
   * Read a transcript file into its newline-split lines. Defaults to a synchronous
   * `readFileSync(path,'utf8').split('\n')`. Injected so tests can stub the raw read (and simulate an
   * unreadable transcript for the R1.3 fallback) without touching the filesystem.
   */
  readRawLines?: (path: string) => string[];
  /**
   * Item 92 (upstream #1312): handed the raw lines of every successful read, so a caller can derive
   * more from the same read (the agent indexes ended background tasks) without reading the transcript
   * twice. Not called when the transcript cannot be located or read.
   */
  onRawLines?: (sessionId: string, lines: string[]) => void;
}

/**
 * Wrap a base `getSessionMessages`-shaped reader so each returned message gains its `toolUseResult`
 * from the raw transcript, matched by `uuid`. This is PURE hydration: ordering and identity come from
 * `base`; only the top-level `toolUseResult` key is added (exactly where the diff block reads it,
 * `turn.message.toolUseResult`). Billing-free — the only extra cost is one `fs` read of the transcript
 * located from the `sessionId` (R4.2). On ANY locate/read/parse failure, or when no record carries a
 * `toolUseResult`, the plain reduced messages are returned unchanged (R1.3) and NO patch is fabricated.
 *
 * @param base the underlying reader (the SDK `getSessionMessages`, or an injected stub).
 * @param opts injectable {@link DiffEnrichedReaderOptions} seams (defaults are production behaviour).
 * @returns a {@link GetMessages} that yields the base messages with `toolUseResult` hydrated by uuid.
 */
export function createDiffEnrichedReader(
  base: GetMessages,
  opts: DiffEnrichedReaderOptions = {},
): GetMessages {
  const findTranscript = opts.findTranscript ?? defaultFindTranscript;
  const readRawLines =
    opts.readRawLines ?? ((path: string) => readFileSync(path, "utf8").split("\n"));

  return async (sessionId: string, readerOpts?: { dir?: string }): Promise<SessionMessage[]> => {
    // base is the single source of order/identity (and the only billed reader) — invoked exactly once.
    const reduced = await base(sessionId, readerOpts);

    // Locate the transcript from the sessionId. A throw OR an empty glob → no raw source: return the
    // reduced messages unchanged (R1.3; no fabrication, R4.2).
    let path: string | undefined;
    try {
      path = findTranscript(sessionId)[0];
    } catch {
      return reduced;
    }
    if (!path) return reduced;

    // Read the raw transcript. A read failure must NEVER crash the pump → fall back to reduced (R1.3).
    let raw: string[];
    try {
      raw = readRawLines(path);
    } catch {
      return reduced;
    }

    opts.onRawLines?.(sessionId, raw);

    const map = toolUseResultMap(raw);
    if (map.size === 0) return reduced; // nothing to hydrate → reduced unchanged

    // Attach the matched toolUseResult as a top-level key; unmatched messages pass through UNCHANGED
    // (they never gain a `toolUseResult` key — R1.2 / R4.2).
    return reduced.map((m) =>
      typeof m.uuid === "string" && map.has(m.uuid) ? { ...m, toolUseResult: map.get(m.uuid) } : m,
    );
  };
}
