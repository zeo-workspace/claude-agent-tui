import {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentInput,
  AgentOutput,
  BashInput,
  BashOutput,
  FileEditInput,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  WebSearchOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import path from "node:path";
import { Logger } from "./acp-agent.js";
import type { BackgroundTaskEnd } from "./background-task-end.js";

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
    terminal_info?: {
      terminal_id: string;
    };
    terminal_output?: {
      terminal_id: string;
      data: string;
    };
    terminal_exit?: {
      terminal_id: string;
      exit_code: number | null;
      signal: string | null;
    };
  };
}

/**
 * Item 92 (upstream #1312) — how a backgrounded Bash's terminal exit is reported at its tool result.
 * The result only announces the command; the command's end arrives later as a task notification.
 */
export type BackgroundExitPolicy = {
  /** The task's end, when the transcript already holds its notification (keyed by tool_use id). */
  ended: (toolUseId: string) => BackgroundTaskEnd | undefined;
  /**
   * Leave the exit out while the task runs. Only the live pump sets this, because only it sends the
   * exit later ({@link ClaudeAcpAgent} `flushBackgroundExits`); every other caller exits at the result.
   */
  holdRunning: boolean;
};

/**
 * Upstream #1252: the exit code Claude Code's text of a failed command names. It starts that text with
 * `Exit code N`; a failure that names none (a denial, a command that could not start) yields undefined.
 */
function failureExitCode(text: string): number | undefined {
  const match = text.match(/^Exit code (\d+)(?:\n|$)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  // `path.resolve` throws on a non-string (upstream issue #1308); the type says
  // string, but the value is a model's tool input. Port of claude-agent-plus.
  if (typeof filePath !== "string") return displayValueOf(filePath) ?? "";
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/** A tool input's path, when it is one: a non-empty string. Anything else — a
 *  model can emit `{"file_path": 12345}`, which Claude Code rejects — is no
 *  path, so it is neither resolved nor sent as a location or a diff target
 *  (upstream issue #1308, ported from claude-agent-plus). */
function pathOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** How a tool input value that is not a path still shows in a title: a number
 *  or boolean as its text, so the failed call names what the model sent;
 *  anything else (an object, null) as nothing. */
function displayValueOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

/** The title form of a tool input's path: project-relative when it is a path
 *  under `cwd`, the value's text when it is a scalar that is not a path. */
function displayPathOf(value: unknown, cwd?: string): string | undefined {
  const filePath = pathOf(value);
  return filePath !== undefined ? toDisplayPath(filePath, cwd) : displayValueOf(value);
}

/**
 * Story 025 / Task 2.2 (R2.1, R2.3) — derive the ACP `toolCallId` from a JSONL
 * `tool_use.id`. Pure, total and side-effect-free, and STABLE across the live and
 * replay paths so a loaded thread re-derives identical ids.
 *
 * Default (`namespaced` omitted/false): returns the raw `tool_use.id` VERBATIM — the
 * §7 reuse contract stories 017-021 assume, and the behaviour the live-Zed probe
 * (Task 2.1, FORK.md) confirms or overturns. When the probe shows the user's Zed
 * requires per-session uniqueness, callers pass `{ namespaced: true }` to get a
 * deterministic `${sessionId}:${toolUseId}` id — identical for the same
 * (toolUseId, sessionId) and distinct across sessions. The raw id stays embedded so
 * the original `tool_use.id` remains recoverable.
 */
export function toolCallIdFor(
  toolUseId: string,
  sessionId: string,
  options: { namespaced?: boolean } = {},
): string {
  return options.namespaced ? `${sessionId}:${toolUseId}` : toolUseId;
}

/** Minimal shape of a raw JSONL `tool_use` block consumed by the tool mappers. */
interface RawToolUse {
  name: string;
  id: string;
  input?: unknown;
}

/**
 * Story 074 (#826) — input shape of the code-review `ReportFindings` tool. A pure
 * display type (fork-local, no SDK/elicitation coupling): `line` is optional and the
 * `findings` array may be absent/empty (rendered as "none found").
 */
interface ReportFindingsInput {
  findings?: Array<{
    file: string;
    line?: number;
    summary: string;
  }>;
}

/** Read a Write tool_use input the way the CLI validates it. Port of upstream #1161 (90cde4b):
 *  since 2.1.280 the CLI accepts `path` for `file_path` and `file_text`/`file_content` for
 *  `content` when a model sends those spellings, but the transcript's tool_use block still carries
 *  them raw — without this the call renders as "Preparing file…" with no diff while the write goes
 *  through. The canonical fields win when both spellings are present. */
function normalizeWriteInput(input: unknown): FileWriteInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const filePath = raw.file_path ?? (typeof raw.path === "string" ? raw.path : undefined);
  const content = raw.content ?? raw.file_text ?? raw.file_content;
  return { ...raw, file_path: filePath, content } as FileWriteInput;
}

/** Read a Bash input's description the way the CLI validates it. Since CLI
 *  2.1.295 the CLI accepts `command_description` for `description`, but the
 *  tool_use block keeps the key the model sent. The canonical key wins when both
 *  spellings are present. (Upstream #1330, ported from claude-agent-plus.) */
export function shellDescription(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.description === "string") return raw.description;
  return typeof raw.command_description === "string" ? raw.command_description : undefined;
}

/** Read a Grep input's path the way the CLI validates it. Since CLI 2.1.292 the
 *  CLI accepts `file_path` for `path`; the canonical key wins when both are
 *  present. (Upstream #1271, ported from claude-agent-plus.) */
export function grepPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.path === "string") return raw.path;
  return typeof raw.file_path === "string" ? raw.file_path : undefined;
}

/** Read a Grep input's output mode the way the CLI validates it. Since CLI
 *  2.1.295 the CLI reads a `-l` or `-c` flag (`true` or `"true"`) as
 *  `output_mode: "files_with_matches"` or `"count"` when `output_mode` is
 *  unset. (Upstream #1330, ported from claude-agent-plus.) */
function grepOutputMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.output_mode === "string") return raw.output_mode;
  if (raw["-l"] === true || raw["-l"] === "true") return "files_with_matches";
  if (raw["-c"] === true || raw["-c"] === "true") return "count";
  return undefined;
}

export function toolInfoFromToolUse(
  toolUse: RawToolUse,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput | undefined;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "ReportFindings": {
      // Story 074 (#826): render the code-review ReportFindings tool as a think-kind
      // label — `Report N finding(s)` with one `file:line — summary` block per finding
      // (`:line` omitted when absent), or `Report findings: none found` when empty.
      const input = toolUse.input as ReportFindingsInput | undefined;
      const findings = input?.findings ?? [];
      return {
        title:
          findings.length > 0
            ? `Report ${findings.length} finding${findings.length === 1 ? "" : "s"}`
            : "Report findings: none found",
        kind: "think",
        content: findings.map((f) => ({
          type: "content" as const,
          content: {
            type: "text" as const,
            text: `${f.file}${typeof f.line === "number" ? `:${f.line}` : ""} — ${f.summary}`,
          },
        })),
      };
    }

    case "Bash": {
      const input = toolUse.input as BashInput | undefined;
      const description = shellDescription(input);
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal" as const, terminalId: toolUse.id }]
          : description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: description },
                },
              ]
            : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput | undefined;
      let limit = "";
      if (input?.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input?.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const filePath = pathOf(input?.file_path);
      const displayPath = displayPathOf(input?.file_path, cwd) ?? "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: filePath
          ? [
              {
                path: filePath,
                line: input?.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = normalizeWriteInput(toolUse.input);
      const filePath = pathOf(input?.file_path);
      let content: ToolCallContent[] = [];
      if (input && filePath) {
        content = [
          {
            type: "diff",
            path: filePath,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = displayPathOf(input?.file_path, cwd);
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content,
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput | undefined;
      const filePath = pathOf(input?.file_path);
      let content: ToolCallContent[] = [];
      if (input && filePath && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: filePath,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = displayPathOf(input?.file_path, cwd);
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput | undefined;
      const globPath = pathOf(input?.path);
      let label = "Find";
      if (input?.path) {
        label += ` \`${input.path}\``;
      }
      if (input?.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: globPath ? [{ path: globPath }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput | undefined;
      let label = "grep";

      if (input?.["-i"]) {
        label += " -i";
      }
      if (input?.["-n"]) {
        label += " -n";
      }

      if (input?.["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input?.["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input?.["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      const outputMode = grepOutputMode(input);
      if (outputMode) {
        switch (outputMode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          case "content":
          default:
            break;
        }
      }

      if (input?.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input?.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input?.type) {
        label += ` --type=${input.type}`;
      }

      if (input?.multiline) {
        label += " -P";
      }

      if (input?.pattern) {
        label += ` "${input.pattern}"`;
      }

      const searchPath = grepPath(input);
      if (searchPath) {
        label += ` ${searchPath}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput | undefined;
      let label = input?.query ? `"${input.query}"` : "Web search";

      if (input?.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input?.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput | undefined;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: TodoWriteInput["todos"][number]) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "TaskCreate": {
      const input = toolUse.input as TaskCreateInput | undefined;
      return {
        title: input?.subject ? `Create task: ${input.subject}` : "Create task",
        kind: "think",
        content: [],
      };
    }

    case "TaskUpdate": {
      const input = toolUse.input as TaskUpdateInput | undefined;
      return {
        title: input?.subject ? `Update task: ${input.subject}` : "Update task",
        kind: "think",
        content: [],
      };
    }

    case "TaskList": {
      return {
        title: "List tasks",
        kind: "think",
        content: [],
      };
    }

    case "TaskGet": {
      return {
        title: "Get task",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      const planInput = toolUse.input as { plan?: string } | undefined;
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content: planInput?.plan
          ? [{ type: "content" as const, content: { type: "text" as const, text: planInput.plan } }]
          : [],
      };
    }

    // Upstream #986 (v0.67.0) — the `Skill` tool announces a skill being loaded.
    // Without this case it falls through to `Other` and renders as a generic block
    // titled "Skill" with the raw result text behind an expander. The skill NAME is
    // the tool's only meaningful input, and it arrives as a real JSONL
    // `tool_use.input.skill` (measured: 73 of 3 515 local transcripts), so this is
    // readable from the disk-tail engine with no new source.
    case "Skill": {
      const input = toolUse.input as { skill?: string } | undefined;
      const skillName = input?.skill;
      return {
        title: skillName ? `Load skill: ${skillName}` : "Load skill",
        kind: "other",
        content: [],
      };
    }

    case "Other": {
      const input = toolUse.input;
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

/**
 * Narrow the untyped message-level `toolUseResult` toward a per-tool Output shape: rejects
 * everything but a plain non-null object (arrays pass a bare `typeof === "object"` check, so they're
 * excluded here). The returned value is only *nominally* typed — it arrives from arbitrary CLI
 * versions via the JSONL transcript, so each caller must still guard the specific fields it reads
 * before trusting them.
 */
function structuredResult<T extends object>(toolUseResult: unknown): T | undefined {
  return toolUseResult !== null &&
    typeof toolUseResult === "object" &&
    !Array.isArray(toolUseResult)
    ? (toolUseResult as T)
    : undefined;
}

/**
 * Strip the model-directed trailer from a raw Agent/Task tool_result text: a `<usage>…</usage>`
 * totals block and/or an `agentId: <id> (use SendMessage …)` continuation line at the end of the
 * text. Both patterns are tail-anchored and independent (older CLIs emit variants with only one of
 * them), so a format change makes them stop matching rather than mangle the report.
 *
 * Ported from upstream #879 (v0.60.0), which replaced a regex sweep with this linear parse — the
 * same posture `redos-command-marker.test.ts` guards elsewhere in the fork.
 */
function stripAgentTrailer(text: string): string {
  return stripAgentIdLine(stripUsageBlock(text));
}

const USAGE_OPEN = "<usage>";
const USAGE_CLOSE = "</usage>";

/**
 * Remove a trailing `<usage>…</usage>` block, plus trailing whitespace and one preceding newline.
 * Matches from the *last* `<usage>` so a report that merely mentions the marker earlier isn't
 * truncated at the mention.
 */
function stripUsageBlock(text: string): string {
  const body = text.trimEnd();
  if (!body.endsWith(USAGE_CLOSE)) {
    return text;
  }
  const open = body.lastIndexOf(USAGE_OPEN, body.length - USAGE_CLOSE.length - USAGE_OPEN.length);
  if (open === -1) {
    return text;
  }
  return body.slice(0, open > 0 && body[open - 1] === "\n" ? open - 1 : open);
}

/**
 * The continuation line, anchored to a whole line so the regex has a single start position and no
 * ambiguous repetition (`[\w-]+` can't consume the following space, `[^)]*` can't consume the
 * closing paren) — it runs in linear time on any input.
 */
const AGENT_ID_LINE = /^agentId: [\w-]+ \([^)]*\)$/;

/** Remove a final `agentId: <id> (…)` line, plus trailing whitespace and the preceding newline. */
function stripAgentIdLine(text: string): string {
  const body = text.trimEnd();
  const lineStart = body.lastIndexOf("\n") + 1;
  if (!AGENT_ID_LINE.test(body.slice(lineStart))) {
    return text;
  }
  return body.slice(0, Math.max(lineStart - 1, 0));
}

/**
 * Apply {@link stripAgentTrailer} across a raw tool_result `content` (plain string or block array),
 * leaving non-text blocks untouched.
 */
function stripAgentTrailerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripAgentTrailer(content);
  }
  if (Array.isArray(content)) {
    return content.map((block: unknown) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? { ...block, text: stripAgentTrailer((block as { text: string }).text) }
        : block,
    );
  }
  return content;
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: { name?: string; id?: string; input?: unknown } | undefined,
  supportsTerminalOutput: boolean = false,
  // Story 079 (R3/R4): the message-level `toolUseResult` hydrated from the JSONL transcript by
  // `diff-enriched-reader.ts`. Upstream notes its own structured renders go dark on replay because
  // `getSessionMessages` doesn't expose this field — the fork reads the transcript directly, so the
  // structured path is available on BOTH the live tail and `session/load`.
  toolUseResult?: unknown,
  // Item 92 (#1312): how a backgrounded Bash's exit is reported. Absent → exit at the result, with
  // null as the (unknown) code.
  background?: BackgroundExitPolicy,
): ToolUpdate {
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0 &&
    // Story 056 (#776): a FAILED Bash with a negotiated terminal must still render as terminal
    // output (terminal_output + terminal_exit exit_code 1 via `case "Bash"`), not markdown — so it
    // is excluded from this error-only early-return. Every other errored result is unchanged.
    !(toolUse?.name === "Bash" && supportsTerminalOutput)
  ) {
    // Only return errors
    return toAcpContentUpdate(toolResult.content, true);
  }

  // Shared raw-text fallback: renders the tool_result content the model saw. The structured cases
  // below fall back to this when `toolUseResult` is absent or fails its shape guard (older CLIs, a
  // transcript line without the field).
  const rawContentUpdate = () =>
    toAcpContentUpdate(toolResult.content, "is_error" in toolResult ? toolResult.is_error : false);

  switch (toolUse?.name) {
    case "Read": {
      // The raw tool_result text is the model-facing view: line-numbered content plus any appended
      // <system-reminder> blocks (malicious-code checks, memory staleness notes, …) that clients
      // shouldn't see. The structured FileReadOutput carries the clean content — rebuild the
      // line-numbered view from it. Non-text variants (image/notebook/pdf) fall back to the raw
      // content blocks, which already render fine.
      const structuredRead = structuredResult<FileReadOutput>(toolUseResult);
      if (
        structuredRead?.type === "text" &&
        typeof structuredRead.file?.content === "string" &&
        // An empty file has nothing to line-number; keep the raw view (the model-facing "file is
        // empty" note) rather than a phantom blank line.
        structuredRead.file.content.length > 0
      ) {
        // startLine is typed non-optional but defended anyway; a Read's `offset` input is the same
        // 1-based starting line, so it beats a blind 1 when an emitter omits the field.
        const startLine =
          structuredRead.file.startLine ??
          (toolUse?.input as FileReadInput | undefined)?.offset ??
          1;
        // A trailing newline is a line terminator, not an extra line — don't number a phantom empty
        // line after it.
        let numbered = structuredRead.file.content
          .replace(/\n$/, "")
          .split("\n")
          .map((line, i) => `${startLine + i}\t${line}`)
          .join("\n");
        // The model-facing truncation banner doesn't survive reconstruction from file.content (the
        // SDK flag exists for exactly this case) — re-establish it so a partial first page doesn't
        // read as the whole file.
        if (structuredRead.file.truncatedByTokenCap) {
          const { numLines, totalLines } = structuredRead.file;
          const detail =
            typeof numLines === "number" && typeof totalLines === "number"
              ? `: showing ${numLines} of ${totalLines} lines`
              : "";
          numbered += `\n[File truncated${detail}]`;
        }
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: markdownEscape(numbered) },
            },
          ],
        };
      }
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: unknown) => ({
            type: "content",
            content:
              (content as { type?: string }).type === "text"
                ? {
                    type: "text",
                    text: markdownEscape((content as { text: string }).text),
                  }
                : toAcpContentBlock(content as ToolResultContent, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};
    }

    case "Bash": {
      const result = toolResult.content;
      // The terminal was announced under the tool_use's own id (see `toolInfoFromToolUse`, which
      // emits `terminalId: toolUse.id`), so key the output/exit metas off that: it is the id the
      // client actually created a terminal for. `toolResult.tool_use_id` is the same value whenever
      // present, so preferring `toolUse.id` only adds a source for the case where the result block
      // carries no id at all. Anything that isn't a non-empty string is no id at all: `""` matches
      // no terminal, and stringifying a present-but-undefined field would invent the literal
      // `"undefined"`. Ported from upstream #917 (v0.63.0).
      const terminalIdOf = (id: unknown): string | undefined =>
        typeof id === "string" && id.length > 0 ? id : undefined;
      const terminalId: string | undefined =
        terminalIdOf(toolUse?.id) ??
        terminalIdOf("tool_use_id" in toolResult ? toolResult.tool_use_id : undefined);
      const isError = "is_error" in toolResult && toolResult.is_error;

      // Extract output and exit code from either format:
      // 1. The structured BashOutput (message-level `toolUseResult`): its stdout/stderr exclude the
      //    model-directed suffixes the raw text carries (stale-read hints, gh rate-limit hints, the
      //    persisted-output wrapper for too-large outputs — the interruption and truncation facts
      //    those carried are re-established from the structured flags below). Skipped for image
      //    output (the raw content array carries the actual image blocks) and backgrounded commands
      //    (the raw text carries the background-task notice; structured stdout may be empty).
      // 2. BetaBashCodeExecutionResultBlock: { type: "bash_code_execution_result", stdout, stderr, return_code }
      // 3. Plain string content from a regular tool_result
      // 4. Array content (e.g. [{ type: "text", text: "..." }])
      let output = "";
      // `null` is an exit whose code nobody knows (a replayed backgrounded command); Zeo reads it as
      // "not failed", so a failure always carries a number — the one its text names, else 1.
      let exitCode: number | null = isError ? 1 : 0;

      const structuredBash = structuredResult<BashOutput>(toolUseResult);
      if (
        structuredBash &&
        typeof structuredBash.stdout === "string" &&
        typeof structuredBash.stderr === "string" &&
        !structuredBash.isImage &&
        structuredBash.backgroundTaskId === undefined
      ) {
        output = [structuredBash.stdout, structuredBash.stderr].filter(Boolean).join("\n");
        // Two raw-text notices don't survive the structured stdout/stderr — re-establish them so the
        // client isn't shown a clean-looking result: the CLI appends its abort marker only to the
        // model-facing text, and an aborted command isn't a success, so synthesize a failing exit
        // code when the result wasn't already an error.
        if (structuredBash.interrupted) {
          output = [output, "[Command was aborted before completion]"].filter(Boolean).join("\n");
          exitCode = 1;
        }
        // Structured stdout is clipped (~30k chars) when the full output was persisted to disk;
        // without this note the clip is silent and the path to the full output is lost.
        if (typeof structuredBash.persistedOutputPath === "string") {
          const size =
            typeof structuredBash.persistedOutputSize === "number"
              ? ` (${structuredBash.persistedOutputSize} bytes total)`
              : "";
          output = [
            output,
            `[Output truncated${size}: full output saved to ${structuredBash.persistedOutputPath}]`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } else if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "bash_code_execution_result"
      ) {
        const bashResult = result as BetaBashCodeExecutionResultBlock;
        output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
        exitCode = bashResult.return_code;
      } else if (typeof result === "string") {
        output = result;
      } else if (
        Array.isArray(result) &&
        result.length > 0 &&
        "text" in result[0] &&
        typeof result[0].text === "string"
      ) {
        output = result.map((c: unknown) => (c as { text: string }).text).join("\n");
      }

      // Upstream #1252: a failed command's text starts with `Exit code N` when the command itself
      // exited non-zero. Report N instead of the conventional 1; a failure naming no code keeps 1.
      if (isError) {
        const named = failureExitCode(output);
        if (named !== undefined && named !== 0) exitCode = named;
      }

      // Upstream #1312: a backgrounded command is still running when its result arrives — the result
      // only announces it. Its exit comes from the task's notification: at the result when the
      // transcript already holds it, otherwise from the live pump once it lands (`holdRunning`), or —
      // for callers that cannot send it later (replay, nested rows) — at the result with no code.
      const backgroundTaskId = structuredBash?.backgroundTaskId;
      let holdExit = false;
      if (backgroundTaskId !== undefined && !isError) {
        const end = terminalId !== undefined ? background?.ended(terminalId) : undefined;
        if (end) exitCode = end.exitCode;
        else if (background?.holdRunning) holdExit = true;
        else exitCode = null;
      }

      // Without a terminal id there is nothing the client can reconcile these metas against, and
      // emitting them anyway strands the output: a client that buffers output/exit for terminals it
      // has not been told about (Zed keeps them in `pending_terminal_output`/`pending_terminal_exit`,
      // drained only on a matching create) would hold them forever behind an id that never arrives,
      // showing an empty terminal. Fall through to the code-block rendering below instead.
      if (supportsTerminalOutput && terminalId !== undefined) {
        return {
          content: [{ type: "terminal" as const, terminalId }],
          _meta: {
            terminal_info: {
              terminal_id: terminalId,
            },
            terminal_output: {
              terminal_id: terminalId,
              data: output,
            },
            ...(holdExit
              ? {}
              : {
                  terminal_exit: {
                    terminal_id: terminalId,
                    exit_code: exitCode,
                    signal: null,
                  },
                }),
          },
        };
      }
      // Fallback: format output as a code block without terminal _meta
      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    // The result text is a bare "Launching skill: <name>" restatement of the title
    // the tool_use already produced — suppress it, as Edit/Write suppress theirs.
    case "Skill": {
      return {};
    }

    case "Edit": // Edit is handled in hooks
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "Agent":
    case "Task": {
      // The raw tool_result text ends with a model-directed trailer (an `agentId: … (use
      // SendMessage …)` line plus a `<usage>` totals block) that ACP clients shouldn't see. The
      // structured AgentOutput carries the subagent's report without the trailer — render from it
      // when present (per the SDK 0.3.207 guidance) and fall back to the tail-anchored strip
      // otherwise.
      // Narrowed to the full union, not the completed variant — the status check below is what
      // discriminates it, and pre-narrowing would let future field reads typecheck against a variant
      // the runtime value may not be.
      const structuredAgent = structuredResult<AgentOutput>(toolUseResult);
      if (
        structuredAgent?.status === "completed" &&
        Array.isArray(structuredAgent.content) &&
        // A completed subagent can end with zero text blocks; an empty structured render would beat
        // the raw fallback for no benefit.
        structuredAgent.content.length > 0
      ) {
        return toAcpContentUpdate(
          structuredAgent.content,
          "is_error" in toolResult ? toolResult.is_error : false,
        );
      }
      // No structured report to render from (older CLIs, a transcript line without the field). The
      // tail-anchored strip is the only cleanup available; if the trailer format changes it simply
      // stops matching and the full raw text renders, no worse than before.
      return toAcpContentUpdate(
        stripAgentTrailerFromContent(toolResult.content),
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }

    case "WebSearch": {
      // The raw tool_result text is a model-directed dump ("Web search results for query: …\n\n
      // Links: [{…json…}]"). The structured WebSearchOutput carries the hits — render them the way
      // server-side web_search_result blocks render ("Title (url)").
      const structuredSearch = structuredResult<WebSearchOutput>(toolUseResult);
      if (structuredSearch && Array.isArray(structuredSearch.results)) {
        const lines = structuredSearch.results.flatMap((entry) =>
          typeof entry === "string"
            ? [entry]
            : Array.isArray(entry?.content)
              ? // toolUseResult arrives untyped across CLI version skew — skip off-spec hits rather
                // than rendering "undefined (undefined)" lines.
                entry.content.flatMap((hit) =>
                  typeof hit?.title === "string" && typeof hit?.url === "string"
                    ? [formatWebSearchHit(hit)]
                    : [],
                )
              : [],
        );
        if (lines.length > 0) {
          return {
            content: [
              {
                type: "content",
                content: { type: "text", text: lines.join("\n") },
              },
            ],
          };
        }
      }
      return rawContentUpdate();
    }

    default: {
      return rawContentUpdate();
    }
  }
}

/**
 * One display format for a web-search hit, shared by the structured WebSearchOutput render and the
 * server-side `web_search_result` block so the two paths can't drift.
 */
function formatWebSearchHit(hit: { title: string; url: string }): string {
  return `${hit.title} (${hit.url})`;
}

function toAcpContentUpdate(
  content: unknown,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: unknown) => ({
        type: "content" as const,
        content: toAcpContentBlock(c as ToolResultContent, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content as ToolResultContent, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(formatWebSearchHit(content));
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    // Upstream #974 (v0.67.0): an in-progress item reads better in its active voice
    // ("Fixing the bug") than in its imperative subject ("Fix the bug") — that is what
    // `activeForm` is for. Any other status keeps the subject. Story 020's drift note
    // recorded this field as DROPPED; it is now carried, and that note is updated.
    content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  description?: string;
};
export type TaskState = Map<string, TaskEntry>;

/**
 * Every text payload a tool_result can carry, in the order it should be tried: a bare string, or
 * the `text` of each TextBlockParam-like block. Shared by the three Task* parsers so they cannot
 * disagree about where a tool's output lives.
 */
function toolOutputTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

/**
 * The already-structured object (the JSONL `toolUseResult`), or the first text payload that parses
 * as JSON and satisfies `isValid`. Returns `undefined` when neither holds — never a partial object,
 * so every caller can treat a result as fully shaped.
 */
function parseJsonToolOutput<T>(
  content: unknown,
  isValid: (parsed: unknown) => boolean,
): T | undefined {
  if (content && typeof content === "object" && !Array.isArray(content) && isValid(content)) {
    return content as T;
  }
  for (const text of toolOutputTexts(content)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isValid(parsed)) return parsed as T;
    } catch {
      // Not JSON — fall through to the caller's textual fallback.
    }
  }
  return undefined;
}

/**
 * Best-effort parse of a TaskCreate result. Upstream #974 (v0.67.0).
 *
 * MEASURED at port time, and the reason the textual fallback is not optional here: across 186
 * Task* tool_use/tool_result pairs in the local transcripts, the model-facing `content` is ALWAYS
 * the short sentence ("Task #1 created successfully: <subject>") and never JSON — the structured
 * object lives in the message-level `toolUseResult`. The pre-#974 parser tried `JSON.parse` on
 * `content` alone, so it returned `undefined` for every real TaskCreate and `applyTaskCreate`
 * silently did nothing. On a resumed session, where the TaskCreated hook never fires, that left
 * the plan empty.
 */
export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const structured = parseJsonToolOutput<TaskCreateOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      "task" in (parsed as object) &&
      typeof (parsed as TaskCreateOutput).task?.id === "string",
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const match = /^Task #(\S+) created successfully: (.+)$/.exec(text.trim());
    if (match) return { task: { id: match[1], subject: match[2] } } as TaskCreateOutput;
  }
  return undefined;
}

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

/**
 * One line of a textual TaskList listing — `#<id> [<status>] <subject>`, optionally followed by
 * ` (<owner>)` and ` [blocked by #a, #b]` — or `undefined` when the line is not one.
 *
 * A LINEAR SCANNER, deliberately, and not the regex upstream uses. That regex nests a quantifier
 * inside a quantified group (`(?:#[^,\]]+(?:, )?)+`) and CodeQL flagged it twice on this repo:
 * `js/redos` (exponential) and `js/polynomial-redos`. It reproduces — on `#! [pending] a [blocked
 * by #` followed by N repetitions of `+#`, the match time QUADRUPLES for every 2 characters added
 * (n=20 → 4.9 ms, n=22 → 20 ms, n=24 → 79 ms), so a ~100-character line hangs the process for
 * hours. The input is the model-facing text of a tool_result read from the transcript, so it is
 * not trusted the way a literal in this file would be.
 *
 * This follows the precedent story 051 set for the command-marker stripper: replace the regex with
 * a scanner that makes exactly one pass and never backtracks. Same grammar, same results — the
 * equivalence is pinned by tests — in O(n).
 *
 * The two optional suffixes are anchored at the END of the line, so they are peeled right-to-left
 * with `lastIndexOf`. That reproduces the lazy `(.+?)` subject of the original: the regex, unable
 * to put parentheses inside `[^()]*`, ends up matching the LAST parenthesised group as the owner,
 * which is exactly what `lastIndexOf` finds.
 */
function parseTaskListLine(line: string): TaskListOutput["tasks"][number] | undefined {
  if (!line.startsWith("#")) return undefined;
  const idEnd = line.indexOf(" ");
  // `#` alone is not an id, and `\S+` cannot be empty.
  if (idEnd < 2) return undefined;
  const id = line.slice(1, idEnd);

  const afterId = line.slice(idEnd + 1);
  if (!afterId.startsWith("[")) return undefined;
  const statusEnd = afterId.indexOf("]");
  if (statusEnd < 0) return undefined;
  const status = afterId.slice(1, statusEnd);
  if (!TASK_STATUSES.has(status)) return undefined;

  let tail = afterId.slice(statusEnd + 1);
  if (!tail.startsWith(" ")) return undefined;
  tail = tail.slice(1);

  let blockedBy: string[] = [];
  const BLOCKED_BY = " [blocked by ";
  if (tail.endsWith("]")) {
    const at = tail.lastIndexOf(BLOCKED_BY);
    // `at > 0` also enforces the original's non-empty subject: at 0 there is nothing before it.
    if (at > 0) {
      const entries = tail.slice(at + BLOCKED_BY.length, -1).split(", ");
      // Every entry is `#<id>` with an id that carries no comma and no bracket — the character
      // class the original spelled as `[^,\]]+`.
      if (
        entries.length > 0 &&
        entries.every(
          (entry) =>
            entry.startsWith("#") &&
            entry.length > 1 &&
            !entry.includes(",") &&
            !entry.includes("]"),
        )
      ) {
        blockedBy = entries.map((entry) => entry.slice(1));
        tail = tail.slice(0, at);
      }
    }
  }

  let owner: string | undefined;
  if (tail.endsWith(")")) {
    const at = tail.lastIndexOf(" (");
    if (at > 0) {
      const inner = tail.slice(at + 2, -1);
      // `[^()]*` — the owner group cannot itself contain parentheses.
      if (!inner.includes("(") && !inner.includes(")")) {
        owner = inner;
        tail = tail.slice(0, at);
      }
    }
  }

  // `(.+?)` needs at least one character of subject.
  if (tail.length === 0) return undefined;
  return {
    id,
    subject: tail,
    status: status as TaskListOutput["tasks"][number]["status"],
    ...(owner ? { owner } : {}),
    blockedBy,
  };
}

/**
 * Best-effort parse of a TaskList result — the SDK's AUTHORITATIVE snapshot of the task list.
 * Upstream #974 (v0.67.0).
 *
 * Both shapes are ported, and both are measured: the structured `{ tasks: [...] }` is what the
 * single real TaskList in the local corpus carries in `toolUseResult`, and its `content` is the
 * `#<id> [<status>] <subject>` listing the textual arm below parses. One sample is too few to drop
 * either arm, so neither is dropped.
 */
export function parseTaskListOutput(content: unknown): TaskListOutput | undefined {
  const structured = parseJsonToolOutput<TaskListOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      Array.isArray((parsed as TaskListOutput).tasks) &&
      (parsed as TaskListOutput).tasks.every(
        (task) =>
          Boolean(task) &&
          typeof task.id === "string" &&
          typeof task.subject === "string" &&
          TASK_STATUSES.has(task.status),
      ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    if (text.trim() === "No tasks found") return { tasks: [] };
    const tasks: TaskListOutput["tasks"] = [];
    let clean = true;
    for (const line of text.trim().split("\n")) {
      const task = parseTaskListLine(line);
      // A single unparseable line means this text is not a task listing at all — take none of it
      // rather than a truncated plan that reads as complete.
      if (!task) {
        clean = false;
        break;
      }
      tasks.push(task);
    }
    if (clean && tasks.length > 0) return { tasks };
  }
  return undefined;
}

/**
 * Best-effort parse of a TaskUpdate result. Upstream #974 (v0.67.0).
 *
 * The point is the `success` flag: a TaskUpdate can fail LOGICALLY (unknown task id) while the
 * tool_result itself is not flagged `is_error`. Applying the requested mutation in that case
 * writes a task the CLI does not have. `expectedTaskId` lets the textual arm attribute a
 * "Task #<id> not found" line when the structured output is absent.
 */
export function parseTaskUpdateOutput(
  content: unknown,
  expectedTaskId?: string,
): TaskUpdateOutput | undefined {
  const structured = parseJsonToolOutput<TaskUpdateOutput>(
    content,
    (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      typeof (parsed as TaskUpdateOutput).success === "boolean" &&
      typeof (parsed as TaskUpdateOutput).taskId === "string" &&
      Array.isArray((parsed as TaskUpdateOutput).updatedFields),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const notFound = /^Task #(\S+) not found$/.exec(text.trim());
    const taskId = notFound?.[1] ?? expectedTaskId;
    if (taskId && (notFound || text.trim() === "Failed to delete task")) {
      return { success: false, taskId, updatedFields: [], error: text.trim() };
    }
  }
  return undefined;
}

export function applyTaskCreate(
  state: TaskState,
  input: TaskCreateInput | undefined,
  output: TaskCreateOutput | undefined,
): void {
  const taskId = output?.task?.id;
  if (!taskId || !input) return;
  state.set(taskId, {
    subject: input.subject,
    status: "pending",
    activeForm: input.activeForm,
    description: input.description,
  });
}

export function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void {
  if (!input?.taskId) return;
  if (input.status === "deleted") {
    state.delete(input.taskId);
    return;
  }
  const existing = state.get(input.taskId);
  // Without a subject from either the existing entry or the update payload,
  // we'd produce a plan entry with empty `content` — drop the update.
  const subject = input.subject ?? existing?.subject;
  if (!subject) return;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

/**
 * Reconcile the accumulated task list against the SDK's authoritative TaskList snapshot.
 * Upstream #974 (v0.67.0).
 *
 * This is what repairs a RESUMED or COMPACTED session: the TaskCreate calls that built the list
 * may be gone from replay history, so the accumulated state under-reports. The snapshot replaces
 * the list wholesale — entries it omits were deleted and must disappear — while `activeForm` and
 * `description` are carried over from the previous entry, because the TaskList output does not
 * carry them and dropping them would silently degrade the plan text.
 */
export function applyTaskList(state: TaskState, output: TaskListOutput): void {
  const previous = new Map(state);
  state.clear();
  for (const task of output.tasks) {
    const existing = previous.get(task.id);
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: existing?.activeForm,
      description: existing?.description,
    });
  }
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    // Same rule as `planEntries` above — the two plan sources must not drift.
    content: task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject,
    status: task.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

/* A global variable to store callbacks that should be executed when receiving hooks from Claude Code */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (
    logger: Logger = console,
    options?: {
      onEnterPlanMode?: () => Promise<void>;
    },
  ): HookCallback =>
  async (input, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          delete toolUseCallbacks[toolUseID]; // Cleanup after execution
        } else {
          logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
          delete toolUseCallbacks[toolUseID];
        }
      }
    }
    return { continue: true };
  };

/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export const createTaskHook =
  (options: { taskState: TaskState; onChange?: () => Promise<void> }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    const taskId =
      "task_id" in input && typeof input.task_id === "string" ? input.task_id : undefined;
    if (!taskId) return { continue: true };

    if (input.hook_event_name === "TaskCreated") {
      if (!input.task_subject) return { continue: true };
      if (options.taskState.has(taskId)) return { continue: true };
      options.taskState.set(taskId, {
        subject: input.task_subject,
        status: "pending",
        description: input.task_description,
      });
      if (options.onChange) await options.onChange();
    } else if (input.hook_event_name === "TaskCompleted") {
      const existing = options.taskState.get(taskId);
      if (!existing || existing.status === "completed") return { continue: true };
      options.taskState.set(taskId, { ...existing, status: "completed" });
      if (options.onChange) await options.onChange();
    }
    return { continue: true };
  };
