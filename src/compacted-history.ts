// Ported from claude-agent-plus `src/compacted-history.ts` (2026-10-15), adapted to this fork's
// transcript locator (a glob under `~/.claude/projects`, see jsonl.ts) and to its diff-enriched
// reader (a pre-compaction tool result keeps its `toolUseResult` when the caller asks for it).
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "./engine-watcher.js";

/**
 * `<sessionId>.jsonl` anywhere under `<configDir>/projects`, with `configDir` resolved exactly as the SDK's
 * `getSessionMessages` resolves it (`CLAUDE_CONFIG_DIR`, else `~/.claude`): the file read here must
 * be the one the SDK just read, or the two halves of the history would come from different files.
 */
function defaultFindTranscript(sessionId: string): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return globSync(join(configDir, "projects", "**", `${sessionId}.jsonl`));
}

/** Seams for {@link withPrecompactHistory}; production passes the defaults. */
export interface PrecompactHistoryOptions {
  /** Locate `<sessionId>.jsonl`; the first match is read. Default: the SDK's config-dir glob. */
  findTranscript?: (sessionId: string) => string[];
  /**
   * Attach each record's raw `toolUseResult`, as the diff-enriched reader does for the messages
   * after the boundary. Set it exactly when that reader is in use, so both halves render alike.
   */
  hydrateToolUseResult?: boolean;
}

/**
 * The history a compaction hid from `getSessionMessages`, put back in front of it.
 *
 * `getSessionMessages` walks `parentUuid` back from the newest record, and a `compact_boundary`
 * has `parentUuid: null`, so the walk ends there: a reopened compacted thread replays only what
 * came after the compaction summary. Measured 2026-10-14 on this machine's compacted transcripts
 * (PARITY-REPORT §21.7): 21 of 43 prompts replayed, and 1 of 19. The boundary does remember what
 * it followed (`logicalParentUuid`), and the SDK never reads it.
 *
 * This reads the transcript itself and walks back across the boundary: through
 * `logicalParentUuid` when that record is in the file, else from the last main-chain record
 * written before the boundary (a manual `/compact` can name a parent the file never received),
 * and across every earlier boundary the same way. What it returns has the shape and the filters
 * `getSessionMessages` uses — user and assistant records only, never `isMeta`, never a sidechain
 * — so the replay loop cannot tell the two halves apart.
 *
 * It only reads anything when the SDK's first message IS a compaction summary, which SDK
 * >= 0.3.284 flags with `isCompactSummary`; an uncompacted session costs nothing. It never writes.
 */
export async function withPrecompactHistory(
  sessionId: string,
  messages: SessionMessage[],
  opts: PrecompactHistoryOptions = {},
): Promise<SessionMessage[]> {
  if (!startsWithCompactSummary(messages)) return messages;
  let file: string | undefined;
  try {
    file = (opts.findTranscript ?? defaultFindTranscript)(sessionId)[0];
  } catch {
    return messages;
  }
  if (!file) return messages;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return messages;
  }
  const earlier = precompactMessages(parseTranscript(text), sessionId, {
    hydrateToolUseResult: opts.hydrateToolUseResult,
  });
  if (earlier.length === 0) return messages;
  const seen = new Set(messages.map((message) => message.uuid));
  // Messages a compaction preserved keep their uuid on both sides of the boundary; the copy
  // after it is the one the SDK already returns.
  return [...earlier.filter((message) => !seen.has(message.uuid)), ...messages];
}

type TranscriptRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: unknown;
  timestamp?: string;
  toolUseResult?: unknown;
  line: number;
};

export function parseTranscript(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    try {
      const parsed: unknown = JSON.parse(lines[line]);
      if (parsed && typeof parsed === "object") records.push({ ...parsed, line });
    } catch {
      // A torn last line from a crashed writer: skip it, as the SDK does.
    }
  }
  return records;
}

function isBoundary(record: TranscriptRecord): boolean {
  return record.type === "system" && record.subtype === "compact_boundary";
}

function isMainChain(record: TranscriptRecord): boolean {
  return typeof record.uuid === "string" && record.isSidechain !== true;
}

/** The main-chain history written before the LAST compaction boundary, oldest first, in
 *  `getSessionMessages`'s shape. Empty when the file has no boundary. */
export function precompactMessages(
  records: TranscriptRecord[],
  sessionId: string,
  opts: { hydrateToolUseResult?: boolean } = {},
): SessionMessage[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const record of records) if (record.uuid) byUuid.set(record.uuid, record);

  const boundaries = records.filter(isBoundary);
  const last = boundaries[boundaries.length - 1];
  if (!last) return [];

  // Where a boundary's history continues: its logical parent when the file has it, else the
  // last main-chain record written before the boundary.
  const continuation = (boundary: TranscriptRecord): TranscriptRecord | undefined => {
    const logical = boundary.logicalParentUuid ? byUuid.get(boundary.logicalParentUuid) : undefined;
    if (logical) return logical;
    for (let i = records.indexOf(boundary) - 1; i >= 0; i--) {
      if (isMainChain(records[i]) && !isBoundary(records[i])) return records[i];
    }
    return undefined;
  };

  const chain: TranscriptRecord[] = [];
  const visited = new Set<string>();
  let cursor = continuation(last);
  while (cursor && cursor.uuid && !visited.has(cursor.uuid)) {
    visited.add(cursor.uuid);
    if (isBoundary(cursor)) {
      cursor = continuation(cursor);
      continue;
    }
    chain.push(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }

  return chain
    .reverse()
    .filter(
      (record) =>
        (record.type === "user" || record.type === "assistant") &&
        record.isMeta !== true &&
        record.isSidechain !== true,
    )
    .map(
      (record) =>
        ({
          type: record.type as "user" | "assistant",
          uuid: record.uuid as string,
          session_id: sessionId,
          message: record.message,
          parent_tool_use_id: null,
          parent_agent_id: null,
          ...(record.isCompactSummary ? { isCompactSummary: true } : {}),
          is_meta: false,
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
          ...(opts.hydrateToolUseResult && record.toolUseResult !== undefined
            ? { toolUseResult: record.toolUseResult }
            : {}),
        }) as SessionMessage,
    );
}

function startsWithCompactSummary(messages: SessionMessage[]): boolean {
  const first = messages[0] as { isCompactSummary?: unknown } | undefined;
  return first?.isCompactSummary === true;
}
