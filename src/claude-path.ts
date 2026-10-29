// Resolves the subscription `claude` binary from PATH (story 012 R1/R1.2;
// story 049 R1.1–R1.5, R5.2 — version-aware + fail-loud).
//
// The fork must drive the user's *subscription* claude (resolved from PATH),
// NOT the binary embedded in @anthropic-ai/claude-agent-sdk — the SDK-embedded
// path bills as credit, while the PATH `claude` bills as signature
// (`entrypoint == 'cli'`, the E1 keystone — experiments/DEGRAU0-RESULTS.md).
//
// Resolution is PATH-only. Story 049 DROPPED the hardcoded `2.1.159`
// native-binary fallback (a version-specific `.vscode` path that almost
// certainly no longer exists is a silent dead end): on a miss we now throw a
// fail-loud Error naming the PATH lookup that was attempted plus the install
// hint, so a missing CLI surfaces here rather than as an opaque spawn ENOENT
// deep in the PTY engine (story 013).
//
// On a successful resolve the helper additionally performs a BEST-EFFORT
// `claude --version` probe and logs a one-line provenance-drift warning when
// the live binary differs from the pinned `PROVENANCE_CLAUDE_VERSION`
// (fork/.fork-provenance.json). Drift is observability, never a hard stop: the
// detect/log path never throws out of `resolveClaudePath` and never changes the
// returned path (R5.2 — byte-identical return). The version probe spawns the
// binary directly (execFileSync, args-list, NEVER a shell — C5).
//
// Dependency-free on purpose: only node: builtins (FORK.md pins node-pty + the
// SDK as the only runtime deps; this adds none). R1.5 / C4.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
// Story 058 R3.2 — version-aware image-vision smoke (observability only; NEVER gates image:true, R3.1).
import { reportImageVisionSmoke } from "./image-vision-smoke.js";

/**
 * Provenance pin the live `claude` version is measured against — kept in lockstep
 * with `fork/.fork-provenance.json`'s externalRuntimeDeps `claude` entry. A live
 * binary whose version differs only triggers a soft drift *warning* (R1.2), never
 * a resolution failure.
 */
export const PROVENANCE_CLAUDE_VERSION = "2.1.312";

/** Shared install hint appended to the fail-loud resolution error (R1.3). */
const INSTALL_HINT = 'Install the Claude Code subscription CLI or ensure "claude" is on PATH.';

/** True if `p` exists and is executable by the current process. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the leading `x.y.z` semver from `claude --version` output.
 *
 * e.g. `"2.1.186 (Claude Code)\n"` → `"2.1.186"`. Pure; returns `null` when no
 * `x.y.z` triple is present (`""`, `"not a version"`, `"\n\n"` → `null`).
 */
export function parseClaudeVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match ? match[1] : null;
}

/**
 * Injectable seam for running `claude --version` — args-list, NEVER a shell (C5).
 * Returns the binary's stdout. The default implementation is `defaultVersionExec`.
 */
export type VersionExec = (binPath: string, args: readonly string[]) => string;

/**
 * Production `VersionExec`: spawn the binary directly via `execFileSync` (args-list,
 * NO shell — C5) and capture stdout. Bounded by a short timeout; stderr discarded.
 */
function defaultVersionExec(binPath: string, args: readonly string[]): string {
  return execFileSync(binPath, [...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Best-effort detection of the live `claude` version at `binPath`.
 *
 * Runs `--version` (args-list, no shell) via the injectable `exec` seam and parses
 * the result. Observability only — it NEVER throws: any failure (spawn error,
 * timeout, unparseable output) yields `null`.
 */
export function detectClaudeVersion(
  binPath: string,
  exec: VersionExec = defaultVersionExec,
): string | null {
  try {
    return parseClaudeVersion(exec(binPath, ["--version"]));
  } catch {
    return null;
  }
}

/**
 * Emit a one-line drift warning via `log` IFF `detected` is known AND differs from
 * `pinned` (R1.2). Silent when there is no drift or detection failed (`detected`
 * null). Pure aside from the single `log` call.
 */
export function reportVersionDrift(
  detected: string | null,
  pinned: string,
  log: (...args: unknown[]) => void,
): void {
  if (detected !== null && detected !== pinned) {
    log(
      `[claude-path] claude version drift: detected ${detected} but provenance pins ${pinned} ` +
        `(continuing — drift is a warning, not a hard stop)`,
    );
  }
}

/** Injectable seams for `resolveClaudePath` so callers/tests can stub the version probe. */
export interface ResolveOptions {
  /** Override the version probe (default: {@link detectClaudeVersion}). */
  detectVersion?: (binPath: string) => string | null;
  /** Override the warning sink (default: `console.error` → stderr). */
  log?: (...args: unknown[]) => void;
}

/**
 * Resolve an absolute path to an executable subscription `claude` binary.
 *
 * Resolution is PATH-only: scan each `process.env.PATH` entry for an executable
 * `claude` (which-style). On a hit, run a BEST-EFFORT version probe + drift
 * warning (R1.1, R1.2) and return the SAME absolute PATH candidate (R5.2 — the
 * probe never alters the returned path). On a miss, throw a fail-loud Error
 * naming the PATH lookup plus the install hint (R1.3, R1.4) — there is NO
 * native-binary / `.vscode` fallback anymore.
 *
 * @returns absolute path to an executable `claude`.
 * @throws Error naming the PATH lookup attempt if no executable `claude` is found.
 */
export function resolveClaudePath(opts: ResolveOptions = {}): string {
  // PATH lookup: scan each PATH entry for an executable `claude`.
  const pathEnv = process.env.PATH ?? "";
  const pathEntries = pathEnv.split(delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = join(entry, "claude");
    if (isExecutable(candidate)) {
      // Best-effort, non-fatal version observability — must NOT change the
      // returned path and must NEVER throw out of the success path (R5.2).
      const log = opts.log ?? console.error;
      try {
        const detected = (opts.detectVersion ?? detectClaudeVersion)(candidate);
        if (detected) {
          log(`[claude-path] resolved claude ${candidate} (version ${detected})`);
        }
        reportVersionDrift(detected, PROVENANCE_CLAUDE_VERSION, log);
        // Story 058 R3.2 — version-aware @image vision smoke: warn ONCE (one-liner) when this claude
        // is NOT a version confirmed to vision-encode @image via Read. Observability only — it never
        // blocks and never touches promptCapabilities.image (stays `image: true`, R3.1).
        reportImageVisionSmoke(detected, log);
      } catch {
        // Observability is best-effort; never let it break resolution.
      }
      return candidate;
    }
  }

  // No executable `claude` on PATH: fail loud naming the lookup (no fallback).
  throw new Error(
    `Could not resolve an executable "claude" binary. ` +
      `Tried: PATH lookup over ${pathEntries.length} entr${pathEntries.length === 1 ? "y" : "ies"} ` +
      `("${pathEnv}"). ${INSTALL_HINT}`,
  );
}
