// Item 107 — the permission mode a loaded session was last in, read from the end of its transcript.
//
// Ported from the plus adapter's `readResumedPermissionMode` (its 0.23.5; upstream #1218's mode half)
// and adapted to the transcripts this adapter reads. Plus runs the SDK, whose transcripts record the
// mode only on prompt records. This adapter drives the INTERACTIVE CLI, which also writes
// `permission-mode` records — several per session, and the only mode record in a short session — and
// the live pump already reconciles from them (story 046). So both count here, and the tail-most wins.
//
// A `plan` before a later `plan_mode_exit` attachment is not the current mode and gives none: leaving
// plan mode through ExitPlanMode writes the attachment, not a mode. The search stops at the first mode,
// or at a human prompt that records none (a transcript that does not record modes). Sidechain
// (subagent) records are ignored. Best-effort: any failure gives undefined and the caller keeps its
// default.
import { open } from "node:fs/promises";

/** The size of one backward read of a transcript. */
const TAIL_CHUNK_BYTES = 64 * 1024;

type TranscriptRecord = {
  type?: unknown;
  isSidechain?: unknown;
  permissionMode?: unknown;
  origin?: { kind?: unknown };
  attachment?: { type?: unknown };
};

/** Visits transcript lines from the end. */
class PermissionModeScan {
  mode: string | undefined;
  private planExited = false;

  /** Visit the previous line. Return true when the search is over. */
  visit(line: Buffer): boolean {
    let parsed: TranscriptRecord | null | undefined;
    // Most lines carry no marker of interest; the check skips their JSON parse.
    const record = (marker: string): TranscriptRecord | undefined => {
      if (line.indexOf(marker) < 0) return undefined;
      if (parsed === undefined) parsed = parseMainThreadRecord(line);
      return parsed ?? undefined;
    };
    const modeEntry = record('"permissionMode"');
    if (
      (modeEntry?.type === "user" || modeEntry?.type === "permission-mode") &&
      typeof modeEntry.permissionMode === "string" &&
      modeEntry.permissionMode.trim() !== ""
    ) {
      const mode = modeEntry.permissionMode.trim();
      if (!(this.planExited && mode === "plan")) this.mode = mode;
      return true;
    }
    if (record('"plan_mode_exit"')?.attachment?.type === "plan_mode_exit") {
      this.planExited = true;
      return false;
    }
    const human = record('"human"');
    return human?.type === "user" && human.origin?.kind === "human";
  }
}

/** The parsed record of one line, or null for a subagent record or a bad line. */
function parseMainThreadRecord(line: Buffer): TranscriptRecord | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const record = entry as TranscriptRecord;
  return record.isSidechain === true ? null : record;
}

/**
 * The permission mode the transcript at `filePath` last recorded, or undefined when it records none,
 * the last one is a `plan` that was exited, or the file cannot be read. Reads backwards in
 * {@link TAIL_CHUNK_BYTES} chunks, so a long transcript costs only its tail.
 */
export async function readTranscriptPermissionMode(filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  const scan = new PermissionModeScan();
  try {
    let end = (await handle.stat()).size;
    // The bytes of the line whose start is not read yet, in file order.
    let pending: Buffer[] = [];
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      let chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.mode;
        pending = [];
        chunk = chunk.subarray(0, at);
      }
      pending.unshift(chunk);
      end = start;
    }
    scan.visit(Buffer.concat(pending));
    return scan.mode;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
