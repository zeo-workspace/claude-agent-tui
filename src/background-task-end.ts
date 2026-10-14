// Item 92 (upstream #1312) — when a backgrounded command's task ended, read off the raw transcript.
//
// A `run_in_background` Bash returns its tool result as soon as the command detaches, so the result
// cannot carry the command's exit. Claude Code reports the end later, as a `<task-notification>` block
// naming the Bash call's `tool_use_id`. Measured on CLI 2.1.280 (`sdk-cli`) and on an interactive
// (`cli`) transcript: the block is written into a `queue-operation` (`content`) and a `queued_command`
// attachment (`prompt`), and can also reach the transcript as the text of a user message. None of those
// records reaches `getSessionMessages`' reduced shape, so the raw lines are the only source.
//
// The block carries no structured code. Its summary names one ("… completed (exit code 0)", "… failed
// with exit code 3"); without one, `completed` reads 0 and anything else 1, because Zeo marks a command
// failed only on a non-null non-zero code and a stopped or failed command is not a success.

/** How a backgrounded command's task ended, as the notification reports it. */
export type BackgroundTaskEnd = { status: string; exitCode: number };

const BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const SUMMARY_CODE = /exit code (\d+)/i;

function tag(block: string, name: string): string | undefined {
  const open = `<${name}>`;
  const start = block.indexOf(open);
  if (start === -1) return undefined;
  const end = block.indexOf(`</${name}>`, start + open.length);
  if (end === -1) return undefined;
  return block.slice(start + open.length, end).trim();
}

function endOf(status: string, summary: string | undefined): BackgroundTaskEnd {
  const named = summary?.match(SUMMARY_CODE);
  if (named) return { status, exitCode: Number(named[1]) };
  return { status, exitCode: status === "completed" ? 0 : 1 };
}

/**
 * The texts of one transcript record that may hold a notification Claude Code wrote. A tool_result's
 * content and an assistant's text are deliberately excluded: `cat` of a transcript, or a model quoting
 * one, would otherwise end a command that is still running.
 */
function notificationTexts(record: Record<string, unknown>): string[] {
  const texts: string[] = [];
  if (record.type === "queue-operation" && typeof record.content === "string") {
    texts.push(record.content);
  }
  const attachment = record.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (record.type === "attachment" && attachment?.type === "queued_command") {
    if (typeof attachment.prompt === "string") texts.push(attachment.prompt);
  }
  const message = record.message as { role?: unknown; content?: unknown } | undefined;
  if (record.type === "user" && message?.role === "user") {
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      }
    }
  }
  return texts;
}

/**
 * Index every ended background task in the raw transcript lines by the `tool_use_id` of the call that
 * started it. Lines that are not JSON, or carry no notification, are skipped; the last notification for
 * an id wins. Pure; never throws.
 */
export function backgroundTaskEnds(lines: readonly string[]): Map<string, BackgroundTaskEnd> {
  const ends = new Map<string, BackgroundTaskEnd>();
  for (const line of lines) {
    // Cheap pre-filter: nearly every line carries no notification, and parsing them all is the cost.
    if (!line.includes("task-notification")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    for (const text of notificationTexts(record as Record<string, unknown>)) {
      for (const match of text.matchAll(BLOCK)) {
        const block = match[1];
        const toolUseId = tag(block, "tool-use-id");
        const status = tag(block, "status");
        if (!toolUseId || !status) continue;
        ends.set(toolUseId, endOf(status, tag(block, "summary")));
      }
    }
  }
  return ends;
}
