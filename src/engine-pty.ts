// === §2 MOTOR box — node-pty spawn of the real interactive `claude` TUI (story 013) ===
//
// Spawns the user's *subscription* `claude` TUI under a REAL pseudo-terminal with a
// sanitized, subscription-billing environment, so the JSONL transcript self-labels its
// message events with entrypoint='cli' (subscription) rather than an SDK/credit signal.
// Degrau 0 proved the premise empirically: a clean-env PTY run yields the distinct
// entrypoint set {cli}; the negative control (inherited SDK env) flips it to {sdk-ts}
// (experiments/DEGRAU0-RESULTS.md, E1 = PASS — the keystone gate).
//
// Spec is PINNED by IMPLEMENTACAO-FORK-ACP.md §5 (Spawn — mantém assinatura) and §10
// (billing audit). This module imports NO SDK — no credit-billing `query()` path is
// reachable through it (the engine seam stays read-only in Degrau 1).
//
// Scope: this module owns ONLY the spawn moment (argv, sanitized env, taint guard,
// launch). Process lifecycle/resume is story 014; the JSONL tail watcher is story 015;
// the ACP createSession rewrite that wires this engine in is story 023.

import pty from "node-pty";
import type { IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isSafeAgentRef } from "./agent-catalog.js";

// PTY geometry pinned by §5.
const PTY_NAME = "xterm-256color";
const PTY_COLS = 120;
const PTY_ROWS = 40;

/**
 * The four billing/SDK env vars that must never reach the spawned TUI (§10). Inheriting
 * any of `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_AGENT_SDK_VERSION` / `CLAUDE_AGENT_SDK_CLIENT_APP`
 * from the parent Node/ACP process would silently bill the run as credit; `CLAUDECODE`
 * additionally makes the nested `claude` TUI refuse to start (anti-nesting guard).
 */
export const FORBIDDEN_BILLING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
] as const;

/** Opts the CLI into its task tools on every model; see {@link buildSanitizedEnv}. */
export const TODO_TOOLS_ENV = "CLAUDE_CODE_ENABLE_TODO_TOOLS";

/**
 * Build the sanitized spawn env (§5/§10): spread the base env, set the three terminal vars
 * (`TERM`/`COLORTERM`/`FORCE_COLOR`), delete the four {@link FORBIDDEN_BILLING_VARS}, and turn
 * {@link TODO_TOOLS_ENV} on unless the base env already sets it.
 *
 * This is the SINGLE shared definition every spawn path reuses — this story's spawn and
 * story 014's `--resume` — so the deletions never drift across two hand-copied blocks
 * (R2.1-R2.4). Unrelated keys (PATH, HOME, …) pass through untouched.
 */
export function buildSanitizedEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    TERM: PTY_NAME,
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
  for (const key of FORBIDDEN_BILLING_VARS) {
    delete env[key];
  }
  // The CLI enables its task tools only on legacy models unless this is set (upstream
  // claude-agent-acp #1380), so on Opus 5.x the tui would translate no plan at all. Plus
  // injects it the same way (plan-updates.ts); a value the operator already set wins.
  env[TODO_TOOLS_ENV] ??= "1";
  return env;
}

/**
 * Refuse-to-spawn taint guard (R4.1/R4.2). Throws — naming EVERY offending key and the
 * inherited-taint hazard — if any of the four {@link FORBIDDEN_BILLING_VARS} is still
 * present in the spawn env. Defense-in-depth: a future env-build regression that
 * re-introduces a deleted var must abort the spawn loudly rather than launch a run that
 * is silently billed as credit (§10, IMPLEMENTACAO-FORK-ACP.md §13 R1).
 */
export function assertSpawnEnvUntainted(env: Record<string, string | undefined>): void {
  const present = FORBIDDEN_BILLING_VARS.filter((key) => env[key] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `engine-pty: refusing to spawn — forbidden billing var(s) survived sanitization: ` +
        `${present.join(", ")}. Inheriting these from the parent Node/ACP process would ` +
        `silently bill the run as credit instead of subscription (§10, R4).`,
    );
  }
}

/** Resolve the login shell: `process.env.SHELL` when set, else `/bin/bash` (§5, R1.2). */
export function resolveShell(baseEnv: Record<string, string | undefined> = process.env): string {
  return baseEnv.SHELL || "/bin/bash";
}

/**
 * The interactive-TUI command (§5, R1.1). NO `-p`/`--print`, NO `stream-json` — those
 * select the SDK/credit non-interactive path. The pre-generated `sessionId` is embedded
 * verbatim so the JSONL transcript can be correlated by basename.
 *
 * When `planMode` is true, `--permission-mode plan` is appended (story 029 / R4.1).
 * This is the DETERMINISTIC plan-mode entry: the spawn flag is preferred over the
 * interactive Shift+Tab cycle (`\x1b[Z`), which is the §5-appendix UNTESTED fallback
 * (documented in IMPLEMENTACAO-FORK-ACP.md §5, not wired here as primary — R4.2/R4.3).
 *
 * When `settingsFile` is set, `--settings "<file>"` is appended (story 034 / §9 hybrid
 * gate wiring): the per-session SCRATCH settings file carrying the fork's `PreToolUse`
 * type:http hook (story 032 `injectHook`). Injecting via `--settings` from a trusted cwd
 * is the BINDING Degrau-0 recipe (GATE_FINDINGS blocker c) — never a project-local
 * `.claude/` (trust dialog) and never `CLAUDE_CONFIG_DIR` (relocates auth, breaks
 * billing). The path is double-quoted so it survives the `-lc` shell word-splitting.
 * Like `--permission-mode plan`, this flag changes only TUI behavior — it adds no
 * `-p`/`stream-json`, so billing stays subscription `cli` (§10).
 *
 * Story 046 (R3.2): the `planMode` boolean seam is GENERALIZED to a `permissionMode` string. A
 * non-"default" mode is emitted as `--permission-mode <mode>`; "default"/undefined emit nothing;
 * `permissionMode: "plan"` reproduces the old planMode=true path. Still interactive-only — adds no
 * `-p`/`stream-json`, billing stays subscription `cli`.
 *
 * Story 056 (R3.3): an optional `agent` persona name is emitted as `--agent "<name>"` (DOUBLE-QUOTED,
 * grouped with the other behavior flags). This is the SECOND layer of the two-layer command-injection
 * defense — `agent-catalog.ts` already drops any name outside `SAFE_AGENT_REF`
 * (`/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/`, allowing a namespaced `plugin:name`) at discovery, and
 * here we re-assert via {@link isSafeAgentRef} so an unsafe name is silently DROPPED (no flag), never
 * interpolated into the `-lc` shell string. Interactive-only — adds no `-p`/`stream-json`.
 *
 * Story 057 (R1.1/R1.2): an optional `additionalDirectories` list is emitted as ONE double-quoted
 * `--add-dir "<dir>"` flag PER directory (never a single space-joined value — each dir is its own flag,
 * matching the upstream/CLI shape). Each dir is re-asserted via {@link isSafeDir} (absolute + existing +
 * free of shell metacharacters); an unsafe dir is DROPPED and a one-line warning is logged, never
 * interpolated into the `-lc` shell string. Interactive-only — adds no `-p`/`stream-json`.
 *
 * Story 057 (R2.2): an optional `mcpConfigFile` PATH is emitted as the DOUBLE-QUOTED `--mcp-config
 * "<file>"` flag (same style as `--settings` — a file path, so the secret-bearing JSON stays OFF the
 * command line and survives the `-lc` shell word-splitting). The file is the fork-controlled
 * uuid-named scratch from `mcp-config-writer.ts`. R2.2 is a HARD rule: `--strict-mcp-config` is NEVER
 * emitted, so claude MERGES the scratch with the user's own `.mcp.json`/settings MCP servers (the
 * parity target) instead of discarding them. Interactive-only — adds no `-p`/`stream-json`.
 */
export function buildClaudeCmd(
  sessionId: string,
  permissionMode?: string,
  settingsFile?: string,
  effortLevel?: string,
  agent?: string,
  additionalDirectories?: string[],
  mcpConfigFile?: string,
): string {
  let cmd = `claude --session-id ${sessionId}`;
  if (permissionMode && permissionMode !== "default") cmd += ` --permission-mode ${permissionMode}`;
  // Story 046 (R2.2): effort is a spawn flag (Probe B verdict — no live mid-session path), so a
  // non-"default" level is seeded/re-spawned with `--effort <level>`. Interactive-only — no credit path.
  if (effortLevel && effortLevel !== "default") cmd += ` --effort ${effortLevel}`;
  // Story 056 (R3.3): the agent persona, double-quoted, emitted ONLY for a real persona — the "default"
  // sentinel (= no persona, mirrors --effort/--permission-mode) emits nothing — and only when it passes
  // the R3.3 allowlist re-assert (defense-in-depth — an unsafe name is dropped, never interpolated).
  if (agent && agent !== "default" && isSafeAgentRef(agent)) cmd += ` --agent "${agent}"`;
  if (settingsFile) cmd += ` --settings "${settingsFile}"`;
  // Story 057 (R1.1/R1.2): ONE double-quoted `--add-dir "<dir>"` per safe dir (never a space-joined
  // value). Each dir is re-asserted via isSafeDir (absolute + existing + no shell metachar) — an unsafe
  // dir is DROPPED with a one-line warning, never interpolated into the `-lc` shell string.
  cmd += buildAddDirFlags(additionalDirectories);
  // Story 057 (R2.2): the DOUBLE-QUOTED `--mcp-config "<file>"` (mirrors `--settings` above — a file path,
  // so the secret-bearing JSON stays off the command line). Emitted ONLY when set. R2.2 HARD rule: NEVER
  // `--strict-mcp-config` — without it claude MERGES the scratch with the user's own .mcp.json/settings
  // MCP servers (the parity target) instead of discarding them.
  if (mcpConfigFile) cmd += ` --mcp-config "${mcpConfigFile}"`;
  return cmd;
}

/**
 * Story 057 (R1.2). The directory-allowlist predicate, mirroring the discipline of
 * {@link isSafeAgentRef}: a directory is safe to interpolate into a double-quoted `--add-dir "<dir>"`
 * flag ONLY when it is an ABSOLUTE path, currently EXISTS on disk, and is FREE of the shell
 * metacharacters that could break out of (or inject into) the `-lc` double-quoted argument — `"`, `$`,
 * a backtick, or a newline/CR. Single source of truth — exported so engine-lifecycle.ts's resume path
 * reuses it rather than re-implementing the rule.
 */
export function isSafeDir(p: string): boolean {
  return path.isAbsolute(p) && existsSync(p) && !/["$`\n\r]/.test(p);
}

/**
 * Story 057 (R1.1/R1.2). Build the trailing ` --add-dir "<dir>"` fragment for a list of additional
 * directories: ONE double-quoted flag per dir that passes {@link isSafeDir}. An unsafe dir (relative,
 * non-existent, or containing a shell metacharacter) is DROPPED — never interpolated — and a one-line
 * warning is logged to stderr (the fork's diagnostic channel, never the ACP stdout wire). An
 * empty/undefined list emits the empty string (no flags). Shared by the fresh and resume spawn paths.
 */
export function buildAddDirFlags(additionalDirectories?: string[]): string {
  if (!additionalDirectories || additionalDirectories.length === 0) return "";
  let fragment = "";
  for (const dir of additionalDirectories) {
    if (isSafeDir(dir)) {
      fragment += ` --add-dir "${dir}"`;
    } else {
      console.error(
        `engine-pty: dropping unsafe --add-dir entry (not absolute+existing, or contains a shell ` +
          `metacharacter): ${JSON.stringify(dir)}`,
      );
    }
  }
  return fragment;
}

/**
 * Login-shell argv (§5, R1.3). The `-lc` flag is MANDATORY: node-pty's `posix_spawnp`
 * does not execute the `claude` npm launcher's `#!/usr/bin/env node` shebang, so the
 * launcher must run *through* a login shell. (The compiled native-binary is the only
 * thing that could be spawned directly — §5 / IMPLEMENTACAO-FORK-ACP.md §17.)
 */
export function buildSpawnArgv(
  sessionId: string,
  permissionMode?: string,
  settingsFile?: string,
  effortLevel?: string,
  agent?: string,
  additionalDirectories?: string[],
  mcpConfigFile?: string,
): [string, string] {
  return [
    "-lc",
    buildClaudeCmd(
      sessionId,
      permissionMode,
      settingsFile,
      effortLevel,
      agent,
      additionalDirectories,
      mcpConfigFile,
    ),
  ];
}

/** Options for {@link spawnClaudePty}. */
export interface SpawnPtyOptions {
  /** Host working directory the TUI runs in; passed straight through to the PTY (§5). */
  cwd: string;
  /**
   * Story 056 v4 — an OPTIONAL pre-chosen session id for an in-place FRESH re-spawn (a selector change
   * before the first interaction reuses the session's existing id). Absent → a new `randomUUID()` is
   * generated (the normal createSession path). claude accepts a reused `--session-id` once the prior
   * PTY for that id has exited (LIVE-VERIFIED).
   */
  sessionId?: string;
  /** Base environment to sanitize; defaults to the parent process env. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Injectable spawn function (defaults to node-pty's `spawn`). Unit tests pass a fake
   * so they exercise the spawn spec without launching a real process.
   */
  spawn?: typeof pty.spawn;
  /**
   * Story 046 (R3.2): a non-"default" permission mode adds `--permission-mode <mode>` to the spawn
   * command (generalizes the story-029 planMode=plan seam). `"plan"` reproduces the old planMode
   * path. Interactive-only — adds no `-p`/`stream-json`; billing stays subscription `cli`.
   */
  permissionMode?: string;
  /**
   * Story 046 (R2.2): a non-"default" reasoning effort adds `--effort <level>` to the spawn command
   * (Probe B verdict — effort has no live mid-session path, so it is seeded/re-spawned). Interactive-only.
   */
  effortLevel?: string;
  /**
   * Story 034 (§9 hybrid gate): absolute path of the per-session SCRATCH settings file
   * carrying the fork's `PreToolUse` hook; appended as `--settings "<file>"`. The file
   * MUST be written (story 032 `injectHook`) BEFORE this spawn — claude reads settings
   * only at startup (GATE_FINDINGS blocker c), so a late write misses the first tool call.
   * Absent → no flag (the ungated/`FORK_GATE=off` spawn is byte-for-byte pre-034).
   */
  settingsFile?: string;
  /**
   * Story 056 (R3.3): a main-thread agent persona name (from `agent-catalog.ts`) emitted as the
   * interactive-only `--agent "<name>"` spawn flag. DOUBLE-QUOTED and injection-safe — re-asserted
   * against the R3.3 allowlist (`/^[A-Za-z0-9_-]+$/`) so an unsafe name is dropped, never interpolated.
   * Absent → no flag. Adds no `-p`/`stream-json`; billing stays subscription `cli`.
   */
  agent?: string;
  /**
   * Story 057 (R1.1/R1.2): extra workspace directories surfaced as ONE double-quoted
   * `--add-dir "<dir>"` flag per dir. Each dir is re-asserted via {@link isSafeDir} (absolute +
   * existing + no shell metacharacter) — an unsafe dir is dropped (logged), never interpolated.
   * INTERACTIVE-ONLY: adds no `-p`/`--print`/`stream-json`, so billing stays subscription `cli`.
   * Absent/empty → no flag.
   */
  additionalDirectories?: string[];
  /**
   * Story 057 (R2.2): the fork-controlled uuid-named scratch MCP-config PATH (written by
   * `mcp-config-writer.ts`), surfaced as the DOUBLE-QUOTED `--mcp-config "<file>"` flag. A file path —
   * the secret-bearing JSON lives in the file, OFF the command line. NEVER paired with
   * `--strict-mcp-config`, so claude MERGES it with the user's own `.mcp.json`/settings MCP servers
   * (the R2.2 parity target) rather than discarding them. INTERACTIVE-ONLY: adds no
   * `-p`/`--print`/`stream-json`, so billing stays subscription `cli`. Absent → no flag.
   */
  mcpConfigFile?: string;
}

/** Handle returned by {@link spawnClaudePty}; story 014 manages its lifecycle. */
export interface PtyEngineHandle {
  /** Pre-generated v4 `sessionId`, reused verbatim in the argv (R1.1). */
  sessionId: string;
  /** The live PTY handle. */
  pty: IPty;
}

/**
 * Spawn the interactive `claude` TUI under a real PTY with the §5 dimensions and a
 * sanitized, subscription-billing environment.
 *
 * A real PTY (allocated by `pty.spawn`) is MANDATORY: the binary checks `isTTY` (12× in
 * the binary) and a plain pipe yields non-interactive mode (§5, R1.4). The stdio is NOT
 * piped — the PTY is what makes `isTTY` true.
 *
 * Prior art (§4/§5): the login-shell command form, the `xterm-256color` PTY allocation,
 * and the exit-code/signal capture *shape* are borrowed from siteboon/claudecodeui
 * (`shell-websocket.service.ts`) and markes76/claude-code-gui (`pty-bridge.ts`) rather
 * than hand-rolled — adapting only the sanitized env and `--session-id` correlation
 * specific to this fork. The actual `onExit`→cleanup wiring is story 014; here only the
 * spawn/exit shape is borrowed (the handle is returned for 014 to manage). No bespoke
 * process-supervisor or non-PTY spawn variant is introduced.
 */
export function spawnClaudePty(opts: SpawnPtyOptions): PtyEngineHandle {
  const {
    cwd,
    baseEnv = process.env,
    spawn = pty.spawn,
    permissionMode,
    settingsFile,
    effortLevel,
    agent,
    additionalDirectories,
    mcpConfigFile,
  } = opts;

  const sessionId = opts.sessionId ?? randomUUID(); // pre-generated → correlates to the JSONL transcript (v4: reused on a fresh re-spawn)
  const shell = resolveShell(baseEnv);
  const argv = buildSpawnArgv(
    sessionId,
    permissionMode,
    settingsFile,
    effortLevel,
    agent,
    additionalDirectories,
    mcpConfigFile,
  );

  // Sanitized, subscription-billing env (§5/§10) via the single shared definition.
  const env = buildSanitizedEnv(baseEnv);

  // §10 no-spoof contract (R3.1/R3.3): the 'cli' entrypoint label MUST be produced
  // ORGANICALLY by running the real TUI — it is NEVER forged. CLAUDE_CODE_ENTRYPOINT is
  // assigned nowhere on this path; after sanitization it must be absent, and nothing below
  // re-introduces it. Forcing the field would be spoofing-with-enforcement (the OpenClaw
  // evasion case). The argv is interactive-only — buildClaudeCmd() carries no -p/stream-json.
  //
  // Refuse-to-spawn taint guard (R4): abort loudly if ANY of the four forbidden billing
  // vars (incl. CLAUDE_CODE_ENTRYPOINT) survived sanitization, rather than launch a
  // credit-billed run. Checks the SPAWN env, not process.env.
  assertSpawnEnvUntainted(env);

  // Real PTY (not a pipe) so the binary's isTTY check passes → interactive mode (R1.4).
  const p = spawn(shell, argv, {
    name: PTY_NAME,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd,
    env: env as { [key: string]: string },
  });

  return { sessionId, pty: p };
}

// === §8 Fluxo reverso — sendPrompt (story 029) ===
//
// Submission shape pinned by IMPLEMENTACAO-FORK-ACP.md §8 (Submissão):
//   write(payload) → delay (~60 ms) → write('\r')
// Multi-line text MUST use bracketed-paste (the branch in sendPrompt below).
// All writes go directly through `p.write` — no xterm.js interposed.
//
// --- Empirical validation (task 4.2 / R3.3 / R5.3 — live run 2026-06-09, claude 2.1.170) ---
// The previously-UNTESTED bracketed-paste multi-line path is CONFIRMED: a 3-line and a
// 5-line prompt each submitted as EXACTLY ONE `user` event over the wire (R2.3 / R5.2) —
// the TUI treats the `\x1b[200~…\x1b[201~` envelope as a single paste, not one turn per
// embedded newline. The ~60 ms write→`\r` delay commits both single-line and multi-line
// submissions; on long input the `\r` is NOT absorbed into the paste body (R3.2).
//
// Flakiness observed (R3.3): single-line submission is reliable in isolation (3/3 live
// runs), but one transient MISS occurred when the engine was spawned back-to-back with
// other live engines in the same batch — that run created NO transcript at all (the
// submission never committed: no first interaction → no JSONL, per story 028). The miss
// correlates with TUI input-readiness right after a rapid re-spawn, NOT with the 60 ms
// constant (raising the delay would not help a not-yet-ready TUI). The bracketed-paste
// envelope proved the more robust path (atomic paste finalization). Resolving guidance:
// let the TUI reach input-readiness (the BOOT settle) before the first submission; the
// 60 ms submit delay itself needs no change.
//
// Shift+Tab plan-mode entry (`\x1b[Z`) remains the UNTESTED, unwired fallback — see
// buildClaudeCmd above; `--permission-mode plan` is the wired deterministic path (R4).

/** Submission delay (ms) between the payload write and the `\r` (§8 / R1.2). */
export const SUBMISSION_DELAY_MS = 60;

/**
 * The input-clearing keystroke that leads every submission (story 034 G2 fix): Ctrl+U (`\x15`,
 * kill-line). PROVED by `experiments/e-clear.ts` against the real TUI: Ctrl+U empties a non-empty
 * input box (the question submits alone), as does Ctrl+C — but Ctrl+C is unsafe as a universal
 * prefix (a second \x03 in close succession EXITS the TUI). Esc was the first candidate and was
 * REFUTED live twice (sessions 76fbf771 and 78e56a85 still merged the residue). Known limit: a
 * RESTORED MULTI-LINE residue may need one kill-line per line; the common case (a single-line
 * cancelled prompt) is covered.
 */
export const CLEAR_INPUT_KEY = "\x15";

/**
 * Delay (ms) between the input-clearing keystroke and the payload write (story 034 G2 fix) —
 * gives the TUI its own event-loop tick to process the clear before new bytes arrive.
 */
export const CLEAR_INPUT_DELAY_MS = 60;

/**
 * Write `text` to the PTY and submit with a delayed carriage return (§8 / R1.1–R1.4).
 *
 * Sequence (story-034 G2 live fix prepended the clear): `\x15` (Ctrl+U — clear residual input) →
 * delay → write(payload) → delay → `\r`. The G2 acceptance run (session 76fbf771) proved the TUI
 * RESTORES a cancelled prompt into its input box, so a fresh submission would concatenate the
 * residue with the new payload into one turn ("Conte de 1 a 100…Qual o nome…"). Ctrl+U kills the
 * residue and is a no-op on an empty box — idempotent for every submission, whatever left the
 * residue. (The permission allow-keystroke does NOT route through here — `allow-inject` writes
 * raw bytes precisely so no clearing byte can touch a pending native dialog.)
 *
 * For single-line `text`: writes the body verbatim then `\r` after the delay.
 * Multi-line handling (bracketed-paste) is added in story 029 task 2.1.
 *
 * The `schedule` parameter defaults to `setTimeout` and is injectable for unit tests
 * so timing can be verified synchronously (the same pattern as `createEndOfTurnDetector`).
 * Only the leading clear write is synchronous (a dead-PTY failure surfaces there, in the caller's
 * try/catch); the payload and `\r` writes are scheduled and post-exit-safe.
 */
export function sendPrompt(
  p: IPty,
  text: string,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms),
): void {
  // Multi-line: wrap in bracketed-paste so the TUI treats the whole block as ONE turn
  // rather than submitting on each embedded newline (§5 Input / R2.1-R2.4).
  const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
  p.write(CLEAR_INPUT_KEY); // clear any residual input-box text (e.g. a cancelled prompt the TUI restored)
  schedule(() => p.write(payload), CLEAR_INPUT_DELAY_MS);
  schedule(() => p.write("\r"), CLEAR_INPUT_DELAY_MS + SUBMISSION_DELAY_MS);
}
