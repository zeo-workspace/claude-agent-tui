// Story 021 / Tasks 1.1 + 2.1–2.3 — classify a `user` event's `toolUseResult` as a diff source and
// assemble the SOURCE SHAPE consumed by the reused diff translator (doc §12, §7, design D1/D3).
//
// WHAT THIS IS: a standalone, pure-logic building block that inspects a `user` event's
// `toolUseResult` and (1.1) classifies WHETHER it can serve as a diff source, then (2.1) into WHICH
// diff shape — Edit (`type:update`) or Write (`type:create`) — and (2.2/2.3) builds the
// `{filePath, structuredPatch}` input that the REUSED `toolUpdateFromDiffToolResponse` (tools.ts)
// renders into ACP diff content. This module assembles the input only; it never renders the diff
// itself and never modifies tools.ts.
//
// WHY (design D1, R1.1/R1.2): a `file-history-snapshot` carries ONLY {backupFileName, version,
// backupTime} — no inline file content — and ≈55% have `backupFileName:null` (a new file). It
// references a backup but never the bytes, so it can never reconstruct a diff. It is therefore
// excluded as a diff source here, AND excluded one layer up at the §6 type-routing seam
// (`classifyEvent` → lifecycle). The real diff source is the `user` event's `toolUseResult`:
// `structuredPatch` + `originalFile` for an Edit; `content` (with an EMPTY structuredPatch) for a Write.
//
// DECISION A (reuse-faithful, approved at run start — see `.draft/deviations.yaml` tasks 2.2/2.3):
//   - Edit: the hunks pass through VERBATIM. The reused translator derives oldText/newText from each
//     hunk's `lines` (`-`/context → old, `+`/context → new) and IGNORES `originalFile`, so a diff's
//     oldText is the HUNK-DERIVED pre-edit text (the SDK-identical shape), NOT the whole `originalFile`.
//   - Write: an empty structuredPatch has nothing for the reused translator to read, so the Write is
//     normalised into ONE synthetic all-additions hunk (every `content` line prefixed `+`). With no
//     `-`/context lines the reused translator yields `oldText:null` (literal null, D3) and
//     newText=`content`, rendering the whole new file as added — reusing the SAME function for Write.
//
// POSTURE: READ-ONLY (the module only INSPECTS the payload, never mutates it), dependency-free
// (no `node:` builtins needed), and adds NO custom JSONL parser and NO patch-apply parser. It is
// deliberately self-contained and NOT exported from lib.ts (whose surface is frozen to upstream
// v0.53.0 and locked by test/lib-exports.test.ts) — its unit tests import it directly from
// dist/diff-source.js (and the reused translator from dist/tools.js).
//
// TOLERANCE (skip-and-log, §6): an unknown or odd shape must NEVER throw and must NEVER be emitted as
// a half-built edit/write with an undefined field. A diff-bearing payload whose shape cannot be
// verified — an Edit missing `originalFile`, a Write (empty structuredPatch) missing `content` — is
// logged to STDERR and degraded to `unsupported`; a payload with none of the diff fields stays
// `not-a-diff-source` (Task 1.1, never regressed).
//
// TASK 3.1 (render seam, R4.1/R4.2): `diffToolCallUpdate(source, toolCallId)` renders a classified
// source through the REUSED, unmodified `toolUpdateFromDiffToolResponse` (tools.ts §3) — the ONLY
// place this module calls the reused translator — and wraps the rendered hunks in the §7
// `tool_call_update` envelope attached to the OPEN `toolCallId` (story 019 seam; it does not open a
// new tool call). Reuse-faithful (Decision A): the reused translator dictates oldText/newText, and the
// only normalisation (Write's synthetic hunk) lives in {@link toDiffToolResponse}, never in tools.ts.
//
// TASK 3.2 (cover-or-log MultiEdit/NotebookEdit/MCP, R5.1/R5.2; design D4): only Edit and Write are
// verified upstream. A payload whose `toolUseResult` already has the RECOGNISED Edit shape (non-empty
// structuredPatch + string originalFile) maps to `edit` regardless of tool name (the shape-first
// branch below already does this — MultiEdit included). A diff-bearing tool name whose shape is NOT
// mappable is detected, skip-and-logged for drift telemetry, and degraded to `unsupported` (NOT
// `not-a-diff-source`) — never thrown, never aborting the turn. Diff-bearing names are the set
// {Edit, Write, MultiEdit, NotebookEdit} plus any name starting with `mcp__`; a contentless payload
// with NO diff-bearing name (e.g. a `file-history-snapshot`, name `undefined`) stays the silent
// `not-a-diff-source` (Task 1.1, never regressed).
//
// TASK 4.1 (post-hoc render-only caveat + optional file-history index, R6.1/R6.2): the JSONL records
// the patch AFTER the edit is already applied, so every diff rendered through this module is POST-HOC
// and RENDER-ONLY — it shows what changed but is NOT a pre-apply accept/reject gate. That gate is
// `openDiff` (doc §9), which is OUT OF SCOPE here and, per the Degrau-0 read-only posture
// (experiments/DEGRAU0-RESULTS.md decision 4), is not shipped in Degrau-1 at all: ACP-side input is
// disabled, prompts arrive only via the mirrored TUI, and Zed renders tool calls/diffs post-hoc. The
// `~/.claude/file-history/<uuid>/<hash>@vN` tree is recorded as an OPTIONAL old-version index ONLY;
// its `<uuid>`↔session key is unknown and it is to be investigated ONLY if an old-version lookup is
// ever needed — this module neither builds nor queries it.
import type { ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import { toolUpdateFromDiffToolResponse } from "./tools.js";

/** A single diff hunk — the unit the reused `toolUpdateFromDiffToolResponse` reads `lines` from. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * The classification of a `toolUseResult` as a diff source, discriminated by `kind`.
 *
 * - `not-a-diff-source` — the payload carries none of the diff-source fields and cannot
 *   reconstruct a diff (Task 1.1; e.g. a `file-history-snapshot`).
 * - `edit` — an Edit (`type:update`): carries `filePath`, the pre-edit `originalFile`, and the
 *   `structuredPatch` hunks fed VERBATIM to the reused translator.
 * - `write` — a Write (`type:create`): carries `filePath` and the new-file `content` (its
 *   structuredPatch is empty; the renderable hunk is synthesised in {@link toDiffToolResponse}).
 * - `unsupported` — a diff-bearing payload whose shape could not be verified (skip-and-logged).
 */
export type DiffSource =
  | { readonly kind: "not-a-diff-source" }
  | {
      readonly kind: "edit";
      readonly filePath: string;
      readonly originalFile: string;
      readonly structuredPatch: readonly Hunk[];
    }
  | { readonly kind: "write"; readonly filePath: string; readonly content: string }
  | { readonly kind: "unsupported"; readonly tool?: string };

/** The source shape consumed by the reused `toolUpdateFromDiffToolResponse` (tools.ts). */
export interface DiffToolResponseInput {
  readonly filePath: string;
  readonly structuredPatch: readonly Hunk[];
}

/** The not-a-diff-source result is a singleton — it carries no payload, so it can be shared. */
const NOT_A_DIFF_SOURCE: DiffSource = { kind: "not-a-diff-source" };

/** True when `value` is a non-null object (the only shape that can hold diff-source fields). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when `value` is a string — the type both `originalFile` and `content` must have to be usable. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** The explicit diff-producing tool names (besides the `mcp__` prefix, handled in {@link isDiffBearingName}). */
const DIFF_BEARING_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * True when `name` denotes a diff-producing tool (Task 3.2). A contentless payload from such a tool is
 * skip-and-logged drift telemetry (`unsupported`), whereas a contentless payload with NO diff-bearing
 * name (e.g. a `file-history-snapshot`, name `undefined`) stays the silent `not-a-diff-source` (Task
 * 1.1). The set is {@link DIFF_BEARING_NAMES} plus any MCP tool (`mcp__…`); never assume a fixed set.
 */
function isDiffBearingName(name: string | undefined): boolean {
  return name !== undefined && (DIFF_BEARING_NAMES.has(name) || name.startsWith("mcp__"));
}

/**
 * Skip-and-log seam (§6, consistent with event-switch.ts): a diff-bearing payload whose shape could
 * not be verified is logged to STDERR — NEVER stdout, which carries the ACP stream — and degraded to
 * `unsupported`. Returning the discriminated result keeps every caller a single tolerant expression.
 */
function skipAndLog(name: string | undefined, reason: string): DiffSource {
  console.error(`[diff-source] skipping ${name ?? "<unknown tool>"}: ${reason}`);
  return { kind: "unsupported", tool: name };
}

/**
 * Classify a `user` event's `toolUseResult` as a diff source.
 *
 * Returns, in order: `not-a-diff-source` when `toolUseResult` is not a non-null object, or holds NONE
 * of the diff-source fields (`structuredPatch` array / `content` / `originalFile`) AND its tool name
 * is not diff-bearing (Task 1.1; e.g. a `file-history-snapshot`, name `undefined`); `unsupported`
 * (skip-and-logged) when a diff-bearing tool name (Task 3.2 — `MultiEdit`/`NotebookEdit`/`mcp__…`)
 * carries an unmappable shape; `edit` for an Edit (`name === "Edit"`, or a non-empty `structuredPatch`
 * paired with a string `originalFile` — so a recognised MultiEdit shape maps here too), carrying
 * `{filePath, originalFile, structuredPatch}`; `write` for a Write (`name === "Write"`, or an EMPTY
 * `structuredPatch` paired with a string `content`), carrying `{filePath, content}`; and `unsupported`
 * (skip-and-logged) for a diff-bearing payload whose required field is missing or the wrong type.
 * NEVER throws; NEVER emits a half-built edit/write with an undefined field; NEVER aborts the pipeline.
 *
 * @param name - The originating tool name (`Edit`, `Write`, …), or `undefined` when unknown.
 * @param toolUseResult - The raw `toolUseResult` value to inspect (READ-ONLY, never mutated).
 * @returns A {@link DiffSource}.
 */
export function classifyDiffSource(name: string | undefined, toolUseResult: unknown): DiffSource {
  if (!isObject(toolUseResult)) {
    return NOT_A_DIFF_SOURCE;
  }

  const structuredPatch = toolUseResult.structuredPatch;
  const hasStructuredPatch = Array.isArray(structuredPatch);
  const hasContent = "content" in toolUseResult;
  const hasOriginalFile = "originalFile" in toolUseResult;

  // No diff-source field is present. A diff-bearing tool name (Task 3.2 — MultiEdit/NotebookEdit/MCP)
  // means a tool that SHOULD have produced a patch shipped one we cannot map: detect + log it as drift
  // telemetry and degrade to `unsupported`. A payload with no diff-bearing name (e.g. a
  // `file-history-snapshot`, name `undefined`) is the silent `not-a-diff-source` (Task 1.1).
  if (!hasStructuredPatch && !hasContent && !hasOriginalFile) {
    return isDiffBearingName(name)
      ? skipAndLog(
          name,
          "diff-bearing tool produced no usable structuredPatch/originalFile/content",
        )
      : NOT_A_DIFF_SOURCE;
  }

  const filePath = toolUseResult.filePath;
  const originalFile = toolUseResult.originalFile;
  const content = toolUseResult.content;

  // Edit (`type:update`): an explicit Edit name, OR a non-empty structuredPatch alongside a string
  // `originalFile`. The hunks reconstruct the diff; without `originalFile` (or without a usable
  // filePath/patch) the Edit shape is unverified and skipped — never a half-built edit.
  const looksLikeEdit =
    name === "Edit" || (hasStructuredPatch && structuredPatch.length > 0 && isString(originalFile));
  if (looksLikeEdit) {
    if (!isString(filePath) || !isString(originalFile) || !hasStructuredPatch) {
      return skipAndLog(name, "Edit is missing filePath, originalFile, or structuredPatch");
    }
    return { kind: "edit", filePath, originalFile, structuredPatch: structuredPatch as Hunk[] };
  }

  // Write (`type:create`): an explicit Write name, OR an EMPTY structuredPatch alongside a string
  // `content`. The new-file body lives in `content`; without it there is nothing to render — skip.
  const looksLikeWrite =
    name === "Write" || (hasStructuredPatch && structuredPatch.length === 0 && isString(content));
  if (looksLikeWrite) {
    if (!isString(filePath) || !isString(content)) {
      return skipAndLog(name, "Write is missing filePath or content");
    }
    return { kind: "write", filePath, content };
  }

  // A diff-source field IS present but the shape matched neither a verifiable Edit nor Write.
  return skipAndLog(name, "diff-bearing payload of an unverified shape");
}

/**
 * Build one synthetic all-additions hunk from a new file's `content` (Decision A, D3).
 *
 * Every line of `content` is prefixed `+`, so the reused translator — which reads only the hunk
 * `lines` — collects NO `-`/context lines and therefore yields `oldText:null` (literal null) and
 * newText=`content`. The hunk header marks the whole body as added: oldStart/oldLines 0/0, newStart 1.
 */
function syntheticAdditionHunk(content: string): Hunk {
  const lines = content.split("\n");
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((line) => "+" + line),
  };
}

/**
 * Assemble the `{filePath, structuredPatch}` input consumed by the reused
 * `toolUpdateFromDiffToolResponse` (tools.ts) — the only thing this module produces for rendering.
 *
 * - `edit` — pass the hunks through VERBATIM (same array reference): `{filePath, structuredPatch}`.
 * - `write` — normalise to a single synthetic all-additions hunk (see {@link syntheticAdditionHunk})
 *   so the reused translator emits `oldText:null` / newText=`content`.
 * - `unsupported` / `not-a-diff-source` — not renderable; returns `null`.
 *
 * This module does NOT call `toolUpdateFromDiffToolResponse` and does NOT hand-build diff content —
 * the caller (the tests now; story 023 later) feeds this input to the reused translator.
 *
 * @param source - A {@link DiffSource} from {@link classifyDiffSource}.
 * @returns The reused translator's input, or `null` when `source` is not renderable.
 */
export function toDiffToolResponse(source: DiffSource): DiffToolResponseInput | null {
  switch (source.kind) {
    case "edit":
      return { filePath: source.filePath, structuredPatch: source.structuredPatch };
    case "write":
      return {
        filePath: source.filePath,
        structuredPatch: [syntheticAdditionHunk(source.content)],
      };
    case "unsupported":
    case "not-a-diff-source":
      return null;
    default: {
      // Exhaustiveness guard: if a new DiffSource kind is added, tsc flags this `never` assignment.
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/**
 * The §7 `tool_call_update` envelope carrying rendered diff content, attached to an OPEN tool call.
 *
 * It updates an already-open tool call (the story 019 seam keyed by `toolCallId`); it does NOT open a
 * new one. `content` is the diff content rendered by the reused `toolUpdateFromDiffToolResponse`.
 */
export interface DiffToolCallUpdate {
  readonly sessionUpdate: "tool_call_update";
  readonly toolCallId: string;
  readonly content: ToolCallContent[];
}

/**
 * Render a classified diff source into a §7 `tool_call_update` (Task 3.1, R4.1/R4.2).
 *
 * Feeds {@link toDiffToolResponse}'s `{filePath, structuredPatch}` input to the REUSED, unmodified
 * `toolUpdateFromDiffToolResponse` (tools.ts §3) — the ONLY place this module calls the reused
 * translator — and wraps the rendered hunks in the envelope attached to the OPEN `toolCallId` (story
 * 019 seam; this does not open a new tool call). The reused translator dictates oldText/newText
 * (Decision A): for an Edit the JSONL `structuredPatch` is fed VERBATIM (shim: none); for a Write the
 * synthetic all-additions hunk is supplied by {@link toDiffToolResponse} (the empty structuredPatch is
 * not accepted verbatim), so the new file renders with `oldText:null`.
 *
 * @param source - A {@link DiffSource} from {@link classifyDiffSource}.
 * @param toolCallId - The OPEN tool call id the diff content attaches to.
 * @returns The `tool_call_update` envelope, or `null` when `source` is not renderable or yields no
 *   diff content (an unsupported/not-a-diff-source source, or a translation with no `content`).
 */
export function diffToolCallUpdate(
  source: DiffSource,
  toolCallId: string,
): DiffToolCallUpdate | null {
  const input = toDiffToolResponse(source);
  if (input === null) {
    return null;
  }
  const { content } = toolUpdateFromDiffToolResponse(input);
  if (content === undefined || content.length === 0) {
    return null;
  }
  return { sessionUpdate: "tool_call_update", toolCallId, content };
}
