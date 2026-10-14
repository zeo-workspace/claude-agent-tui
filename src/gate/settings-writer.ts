// Story 032 — safe settings.local.json hook writer (Degrau-2 §9 BLOCKER c).
//
// The Degrau-2 permission gate (HYBRID prototype, story 007 / GATE_FINDINGS.md) attaches a
// `PreToolUse` type:http hook to the real `claude` TUI over TCP loopback. This module is the
// REVERSIBLE, NON-DESTRUCTIVE config-mutation seam that injects that hook into `settings.local.json`
// BEFORE the PTY spawns and restores the user's prior config on teardown — it owns NO server, no
// deny/allow logic, and no engine wiring (those are separate Degrau-2 stories).
//
// HOOK SHAPE (authoritative — empirically FIRED against real claude 2.1.161; see GATE_FINDINGS.md
// keystone + experiments/e-gate.ts `buildScratchSettings`):
//   { hooks: { PreToolUse: [ { matcher, hooks: [ { type:"http", url, timeout } ] } ] } }
// `timeout` is in SECONDS (claude default 600). The endpoint is a 127.0.0.1 TCP-loopback URL
// carrying the dynamically allocated free port (story 032 Task 1 / R1) — a unix-socket URL is
// silently ignored by claude (blocker b), so loopback TCP is mandatory.
//
// FORK-OWNED MARKER (so teardown can surgically remove ONLY our hook — Task 3.2 / R4.3): the hook's
// `url` carries a fixed sentinel PATH segment ({@link FORK_HOOK_MARKER_PATH}). The URL is opaque to
// claude (passed through verbatim), so this is a safe, parse-surviving identifier that never
// collides with a user's own hook entry. We also stamp the matcher group with the same sentinel on a
// dedicated `__forkAcpGate` key for human-readability; the URL path is the AUTHORITATIVE marker.
//
// Tasks 2.1 (buildHookEntry) + 2.2 (mergeHook) live here; the inject/restore seam (Task 3) is added
// below them. The read side reuses `parseJsonc` from zed-register.ts (tolerant of a user's
// hand-edited JSONC settings) rather than a parallel parser.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseJsonc } from "../zed-register.js";

/** Fixed fork-owned sentinel path segment embedded in the hook URL — the surgical-removal marker. */
export const FORK_HOOK_MARKER_PATH = "/__fork-acp-gate__";

/** Key stamped on the fork's matcher group for human-readability; the URL path is authoritative. */
export const FORK_HOOK_MARKER_KEY = "__forkAcpGate";

/** Default hook timeout in SECONDS (claude default is 600); kept a parameter so nothing is magic. */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;

/** Tool matcher for the gate hook; `"*"` matches all tools (the shape the story-007 probe fired). */
export const FORK_HOOK_MATCHER = "*";

/** A single http-hook entry as it appears inside a matcher group's `hooks` array (story-007 shape). */
export interface HttpHookEntry {
  type: "http";
  url: string;
  timeout: number;
}

/** The `{ matcher, hooks:[…] }` group as it appears under `PreToolUse`, plus the fork sentinel key. */
export interface PreToolUseGroup {
  matcher: string;
  hooks: HttpHookEntry[];
  /** Present (and `true`) only on the FORK's own group — never on a user's group. */
  [FORK_HOOK_MARKER_KEY]?: true;
}

/** Story 055 (R1.3) — options for {@link buildHookEntry}: a per-session token plus the hook timeout. */
export interface BuildHookOptions {
  /**
   * Per-session crypto-random secret appended to the hook URL AFTER {@link FORK_HOOK_MARKER_PATH}
   * (e.g. `…/__fork-acp-gate__/<token>`). The hook-server rejects any PreToolUse POST that does not
   * present it — the compensating control for the relaxed JSONL anti-forgery (decide() now seeds the
   * correlator from the hook payload). Appending AFTER the marker keeps {@link isForkHookGroup} /
   * {@link restore} matching on the marker substring, so teardown still recognizes the tokenized URL.
   */
  token?: string;
  /** Hook timeout in SECONDS (default {@link DEFAULT_HOOK_TIMEOUT_SECONDS}). */
  timeout?: number;
}

/**
 * Build the fork's `PreToolUse` `type:http` hook group, pointing at the 127.0.0.1 TCP-loopback
 * endpoint for the dynamically allocated free port (R1 / R2.3). The URL carries the fork-owned
 * sentinel path ({@link FORK_HOOK_MARKER_PATH}) so teardown can surgically remove ONLY this group;
 * when a {@link BuildHookOptions.token} is given (story 055 / R1.3) it is appended AFTER that marker.
 *
 * @param port the verified-free port from {@link import("./port.js").findFreePort} — a positive integer.
 * @param optsOrTimeout either a {@link BuildHookOptions} (token + timeout) OR, for backward
 *   compatibility, the hook timeout in SECONDS as a bare number (default {@link DEFAULT_HOOK_TIMEOUT_SECONDS}).
 * @returns the `{ matcher, hooks:[{type:"http",…}], __forkAcpGate:true }` group.
 * @throws {Error} if `port` is not a positive integer (a bad port would produce a malformed/ungated
 *   hook — fail loud rather than silently emit a hook claude ignores).
 */
export function buildHookEntry(
  port: number,
  optsOrTimeout: number | BuildHookOptions = DEFAULT_HOOK_TIMEOUT_SECONDS,
): PreToolUseGroup {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `buildHookEntry: port must be a positive integer in 1..65535, got ${String(port)} — refusing ` +
        `to build a malformed hook (claude would ignore it and the tool would run ungated).`,
    );
  }
  const opts: BuildHookOptions =
    typeof optsOrTimeout === "number" ? { timeout: optsOrTimeout } : optsOrTimeout;
  const timeout = opts.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
  // R1.3: the token rides AFTER the marker path so isForkHookGroup/restore still match the marker.
  const tokenSuffix = opts.token ? `/${opts.token}` : "";
  return {
    matcher: FORK_HOOK_MATCHER,
    hooks: [
      {
        type: "http",
        url: `http://127.0.0.1:${port}${FORK_HOOK_MARKER_PATH}${tokenSuffix}`,
        timeout,
      },
    ],
    [FORK_HOOK_MARKER_KEY]: true,
  };
}

/** True iff `group` is the FORK's own injected hook group (sentinel key OR sentinel URL path). */
export function isForkHookGroup(group: unknown): boolean {
  if (typeof group !== "object" || group === null) {
    return false;
  }
  const g = group as Record<string, unknown>;
  if (g[FORK_HOOK_MARKER_KEY] === true) {
    return true;
  }
  // Fall back to the authoritative URL-path marker (survives even if the sentinel key were stripped).
  const hooks = g.hooks;
  if (Array.isArray(hooks)) {
    for (const h of hooks) {
      if (
        h !== null &&
        typeof h === "object" &&
        typeof (h as { url?: unknown }).url === "string" &&
        (h as { url: string }).url.includes(FORK_HOOK_MARKER_PATH)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Minimal structural view of a settings document's hooks block (only what the merge touches). */
export interface SettingsLike {
  hooks?: {
    PreToolUse?: unknown[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Merge the fork hook `group` into an existing-or-absent settings object, preserving EVERY
 * pre-existing key/value AND the user's own hooks (R2.1, R2.2, R2.4). Never mutates `prior`.
 *
 *   - `prior` null/absent  → return a minimal object containing ONLY the fork hook (R2.2).
 *   - `prior` present      → deep-clone it, then APPEND the fork group to `hooks.PreToolUse`
 *                            without dropping/overwriting any existing entry (R2.4). An existing
 *                            fork group (idempotent re-inject) is replaced in place, not duplicated.
 *
 * @param prior the parsed prior settings object, or `null` if the file was absent.
 * @param group the fork hook group from {@link buildHookEntry}.
 * @returns a NEW settings object — a superset of `prior` differing only by the added fork hook.
 * @throws {Error} if `prior` is a non-object (array/scalar) — a corrupt root is surfaced loudly, not
 *   silently overwritten (R2.1: a corrupt user file is never clobbered blindly).
 */
export function mergeHook(prior: SettingsLike | null, group: PreToolUseGroup): SettingsLike {
  if (prior === null || prior === undefined) {
    return { hooks: { PreToolUse: [structuredClone(group)] } };
  }
  if (typeof prior !== "object" || Array.isArray(prior)) {
    throw new Error(
      `mergeHook: prior settings root must be a JSON object, got ${Array.isArray(prior) ? "array" : typeof prior}. ` +
        `Refusing to overwrite a malformed settings.local.json (the user's config is never clobbered blindly).`,
    );
  }
  const merged = structuredClone(prior) as SettingsLike;
  if (typeof merged.hooks !== "object" || merged.hooks === null || Array.isArray(merged.hooks)) {
    merged.hooks = {};
  }
  const hooks = merged.hooks as { PreToolUse?: unknown[]; [k: string]: unknown };
  if (!Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = [];
  }
  // Drop any prior fork group (idempotent re-inject) but keep every user group, then append ours.
  hooks.PreToolUse = hooks.PreToolUse.filter((g) => !isForkHookGroup(g));
  hooks.PreToolUse.push(structuredClone(group));
  return merged;
}

/**
 * Parse settings text tolerantly (JSONC — a user may have hand-edited comments/trailing commas) into
 * a {@link SettingsLike} object. Reuses zed-register's `parseJsonc`. A parse failure is surfaced as a
 * clear error (NOT silently swallowed) so a corrupt user file is never clobbered blindly (R2.1).
 *
 * @param text the raw on-disk file contents.
 * @returns the parsed object.
 * @throws {Error} wrapping the underlying parse error with a clear, attributable message.
 */
export function parsePriorSettings(text: string): SettingsLike {
  try {
    const parsed = parseJsonc(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `parsed root is ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object`,
      );
    }
    return parsed as SettingsLike;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `parsePriorSettings: settings.local.json is not parseable JSON/JSONC (${reason}). Refusing to ` +
        `clobber it blindly — the inject path must fall back to a safe handling of a corrupt file.`,
      { cause: err },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — before-spawn inject seam with backup + teardown restore (R3, R4).
//
// injectHook(): snapshot the prior on-disk state (bytes or absence), compute the merged config, and
// write it DURABLY (temp-file + fsync + atomic rename) BEFORE the claude PTY is spawned (BLOCKER c).
// restore(): on teardown, surgically remove ONLY the fork's own hook group (preserving any later
// user edits), falling back to the captured prior bytes when surgical removal is impossible, and
// reporting which path ran. Fully OFFLINE-testable: callers pass a temp `settingsPath`, no spawn.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Captured prior on-disk state of `settings.local.json`, returned by {@link injectHook} and consumed
 * by {@link restore}. Either the exact prior file bytes (`existed:true`) or a record of absence
 * (`existed:false`) — enough to leave the user's config byte-equivalent on teardown (R4.1).
 */
export interface Backup {
  /** Absolute path of the settings file this backup covers. */
  settingsPath: string;
  /** Whether the file existed on disk before inject. */
  existed: boolean;
  /** The exact prior file bytes (only when `existed` is true). */
  priorBytes: Buffer | null;
}

/** Result of {@link restore}: which removal path ran (`'surgical'` preferred, `'backup'` fallback). */
export interface RestoreResult {
  path: "surgical" | "backup";
}

/**
 * Durably write `text` to `filePath` via a temp-file + fsync + atomic `rename` so a reader (claude on
 * startup) never observes a partial file (R3.2). On any failure the partial temp is removed before
 * the error propagates, so a failed write leaves no half-written file behind.
 */
async function durableWrite(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.fork-tmp-${process.pid}-${Date.now()}`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(text, "utf8");
    await handle.sync(); // flush the file's own bytes to disk before the rename
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath); // atomic swap into place
    // Best-effort fsync of the directory entry so the rename itself is durable.
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Some platforms reject O_RDONLY dir fsync; the file fsync above is the load-bearing one.
    }
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // ignore — nothing durable to clean
    }
    throw err;
  }
}

/** Read the prior file bytes, or `null` if it does not exist. Non-ENOENT errors propagate. */
async function readPriorBytes(settingsPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(settingsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Capture the prior on-disk state, compute the merged settings, and DURABLY write
 * `settings.local.json` BEFORE the claude PTY is spawned (R3.1, R3.2, R4.1).
 *
 * CALLER CONTRACT (BLOCKER c — setup ordering): the spawn path MUST `await injectHook(...)` BEFORE it
 * spawns the `claude` PTY, because `claude` reads hook config only at startup; a write that lands
 * after spawn misses the first tool call. The engine-wiring that enforces this ordering is a separate
 * Degrau-2 story (out of scope here — this module is the standalone seam).
 * TODO(degrau-2 engine wiring): call `await injectHook(...)` in createSession BEFORE spawnPty, and
 * `await restore(backup)` on session teardown. Tracked by the Degrau-2 engine-integration story.
 *
 * @param opts.settingsPath absolute path to the `settings.local.json` to mutate.
 * @param opts.port the verified-free port from {@link import("./port.js").findFreePort} (R1).
 * @param opts.timeout optional hook timeout in SECONDS (default {@link DEFAULT_HOOK_TIMEOUT_SECONDS}).
 * @returns a {@link Backup} handle carrying the exact prior bytes (or absence) for {@link restore}.
 * @throws {Error} if the prior file is unreadable for a reason other than absence, or if the merged
 *   config cannot be written — on a write failure the prior bytes are restored (or the partial temp
 *   deleted) before rejecting, so a failed inject never leaves a file claude could read half-written.
 */
export async function injectHook(opts: {
  settingsPath: string;
  port: number;
  timeout?: number;
  /** Story 055 (R1.3) — per-session token bound into the hook URL after {@link FORK_HOOK_MARKER_PATH}. */
  token?: string;
}): Promise<Backup> {
  const { settingsPath, port, timeout, token } = opts;

  // 1) Snapshot the prior state (bytes or absence) — captured BEFORE any mutation (R4.1).
  const priorBytes = await readPriorBytes(settingsPath);
  const backup: Backup = { settingsPath, existed: priorBytes !== null, priorBytes };

  // 2) Compute the merged object from the prior (parsed tolerantly) + the fork hook (R1.3: tokenized).
  const group = buildHookEntry(port, { token, timeout });
  let prior: SettingsLike | null = null;
  if (priorBytes !== null) {
    const text = priorBytes.toString("utf8").trim();
    // An empty existing file is treated as "no prior settings" rather than a parse error.
    prior = text.length === 0 ? null : parsePriorSettings(text);
  }
  const merged = mergeHook(prior, group);
  const out = `${JSON.stringify(merged, null, 2)}\n`;

  // 3) Durably write BEFORE returning control to the spawn path (R3.1, R3.2). On failure, roll back
  //    to the prior bytes (or delete a file we just created) so claude never reads a half-written file.
  try {
    await durableWrite(settingsPath, out);
  } catch (err) {
    try {
      if (backup.existed && backup.priorBytes !== null) {
        await durableWrite(settingsPath, backup.priorBytes.toString("utf8"));
      } else {
        await fs.rm(settingsPath, { force: true });
      }
    } catch {
      // best-effort rollback; surface the ORIGINAL write error below regardless
    }
    throw new Error(
      `injectHook: failed to write ${settingsPath} (${err instanceof Error ? err.message : String(err)}). ` +
        `Rolled back to the prior on-disk state; refusing to leave a half-written settings.local.json.`,
      { cause: err },
    );
  }

  return backup;
}

/** Rewrite the captured prior bytes, or delete the file if the backup recorded absence (R4.2). */
async function applyBackup(backup: Backup): Promise<void> {
  if (backup.existed && backup.priorBytes !== null) {
    await durableWrite(backup.settingsPath, backup.priorBytes.toString("utf8"));
  } else {
    await fs.rm(backup.settingsPath, { force: true });
  }
}

/**
 * Teardown: remove the fork's injected hook, leaving ZERO residue (R4.2, R4.3).
 *
 * Preferred path (`'surgical'`): re-read the current on-disk file; if it parses, delete ONLY the
 * group bearing the fork-owned marker ({@link isForkHookGroup}) and re-write the rest — preserving
 * any edits the user made AFTER inject. If removing the fork group empties `hooks.PreToolUse`/`hooks`,
 * and the backup recorded absence (the fork created the file), the file is deleted so no empty husk
 * is left behind.
 *
 * Fallback path (`'backup'`): if the current file is unparseable, or surgical isolation of the fork
 * entry is not possible, restore the captured prior state — delete the file if it did not previously
 * exist, else rewrite the exact prior bytes.
 *
 * @param backup the handle returned by {@link injectHook}.
 * @returns which path ran, so the caller can log it (R4.3).
 * @throws {Error} only if BOTH the surgical path AND the backup fallback fail — the message names the
 *   underlying error so teardown never silently strands the fork hook.
 */
export async function restore(backup: Backup): Promise<RestoreResult> {
  // Re-read the CURRENT on-disk file (it may carry post-inject user edits).
  let currentBytes: Buffer | null;
  try {
    currentBytes = await readPriorBytes(backup.settingsPath);
  } catch {
    currentBytes = null; // unreadable for a non-ENOENT reason → fall back to the backup
  }

  // If the file is gone, the desired end-state is already the backup's "absence" or prior bytes.
  if (currentBytes === null) {
    try {
      await applyBackup(backup);
      return { path: "backup" };
    } catch (err) {
      throw new Error(
        `restore: file missing and backup re-apply failed (${err instanceof Error ? err.message : String(err)}).`,
        { cause: err },
      );
    }
  }

  // Try the SURGICAL path: parse, drop only the fork group, re-write the rest.
  try {
    const text = currentBytes.toString("utf8").trim();
    const parsed = text.length === 0 ? {} : parsePriorSettings(text);
    const next = structuredClone(parsed) as SettingsLike;
    const hooks = next.hooks as { PreToolUse?: unknown[]; [k: string]: unknown } | undefined;

    let removedSomething = false;
    if (hooks && Array.isArray(hooks.PreToolUse)) {
      const before = hooks.PreToolUse.length;
      hooks.PreToolUse = hooks.PreToolUse.filter((g) => !isForkHookGroup(g));
      removedSomething = hooks.PreToolUse.length < before;
      if (hooks.PreToolUse.length === 0) {
        delete hooks.PreToolUse;
      }
      if (Object.keys(hooks).length === 0) {
        delete next.hooks;
      }
    }

    // If, after removing the fork hook, the document is empty AND the file did not exist before
    // inject (the fork created it), delete it so no empty `{}` husk is left as residue (R4.2).
    if (!backup.existed && Object.keys(next).length === 0) {
      await fs.rm(backup.settingsPath, { force: true });
      return { path: "surgical" };
    }

    void removedSomething; // a no-op removal is still a valid surgical outcome (idempotent teardown)
    await durableWrite(backup.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return { path: "surgical" };
  } catch {
    // Surgical isolation impossible (unparseable / corrupt post-inject file) → backup fallback (R4.3).
    try {
      await applyBackup(backup);
      return { path: "backup" };
    } catch (err) {
      throw new Error(
        `restore: surgical removal failed AND backup fallback failed ` +
          `(${err instanceof Error ? err.message : String(err)}). The fork hook may be stranded — manual ` +
          `inspection of ${backup.settingsPath} is required.`,
        { cause: err },
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Item 84 — mirror the Ultracode switch into the per-session SCRATCH settings file.
//
// The switch is applied live with `/effort ultracode on|off`, which the CLI keeps for "this session
// only" — a re-spawn of the PTY (mode/agent change, resume) starts a new CLI process without it. The
// scratch file is that process's `--settings`, so `ultracode:true` here carries the switch across a
// re-spawn. It is NOT a re-spawn trigger. Story 060 also wrote `ultracodeKeywordTrigger:true`; that is
// not a settings key: CLI 2.1.261, 2.1.285, 2.1.296 (parity audit, round 21) and 2.1.299 use it only
// as a telemetry label — the real key is `workflowKeywordTriggerEnabled` — so it was dropped.
// ─────────────────────────────────────────────────────────────────────────────

/** The settings key that keeps Ultracode on for a (re-)spawned session. */
const ULTRACODE_SETTINGS_KEY = "ultracode";

/**
 * Item 84 — set (`active`) or remove the `ultracode` key in the per-session SCRATCH settings file the
 * gate wrote, preserving the hook and EVERY other key. Read tolerantly (JSONC) and written durably
 * (temp+fsync+rename), mirroring {@link injectHook}. A missing/empty file is treated as an empty
 * object. Idempotent: re-applying the same `active` produces a byte-equivalent document.
 *
 * @param settingsPath absolute path to the per-session scratch `settings.local.json` (the gate's file).
 * @param active whether Ultracode is on (set the key) or off (remove it).
 * @throws {Error} only on a genuine read/parse/write failure — NEVER on the benign absence of the file
 *   (ENOENT → treated as `{}`), mirroring the rest of the module's discipline.
 */
export async function applyUltracodeSettings(settingsPath: string, active: boolean): Promise<void> {
  // 1) Read the current bytes; a missing file (ENOENT) is treated as "no prior settings" (→ `{}`).
  const priorBytes = await readPriorBytes(settingsPath);
  let current: SettingsLike = {};
  if (priorBytes !== null) {
    const text = priorBytes.toString("utf8").trim();
    // An empty existing file is treated as an empty object rather than a parse error (mirrors inject).
    if (text.length > 0) {
      current = parsePriorSettings(text);
    }
  }

  // 2) Clone (never mutate the parsed prior) and toggle ONLY the ultracode key — every other key
  //    (the gate hook, the user's own config) is preserved verbatim.
  const next = structuredClone(current) as SettingsLike;
  if (active) {
    next[ULTRACODE_SETTINGS_KEY] = true;
  } else {
    delete next[ULTRACODE_SETTINGS_KEY];
  }

  // 3) Durably write (temp+fsync+rename) so a concurrent (re-)spawn read never sees a half-written file.
  await durableWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}
