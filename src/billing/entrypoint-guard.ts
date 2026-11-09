// Story 022 — entrypoint billing guard-rail.
//
// ── GOOD-FAITH LIMITS (this guard-rail is a SIGNAL, never a lever) ─────────────────────────────────
// Sources: doc §10 "Auditoria de billing — entrypoint"; §0 TL;DR point 3; Appendix row
// "`entrypoint` como prova de billing"; experiments/DEGRAU0-RESULTS.md (E1).
//
//   (a) `entrypoint` is a CLIENT SELF-LABEL, written verbatim from an env var without checking the
//       real mode. It is a GOOD-FAITH SIGNAL — NOT contractual proof that the run billed on the Claude
//       subscription, and NOT a contract published by Anthropic. Billing is decided server-side by the
//       headers the client sends; we do not capture TLS, so this field corroborates, it does not prove.
//   (b) This code NEVER forces or spoofs `entrypoint=cli`. It only READS and REACTS — rewriting the
//       value toward 'cli' would be spoofing-with-enforcement (the OpenClaw case) = evasion. `guardEvent`
//       leaves the observed value untouched and aborts on a credit-class label instead.
//   (c) The subscription GUARANTEE comes from RUNNING THE REAL TUI with a sanitized env — the E1
//       keystone (experiments/DEGRAU0-RESULTS.md: a clean-env PTY writes `entrypoint=='cli'`
//       ORGANICALLY), with billing decided server-side. This guard-rail only DETECTS a drift into
//       credit (sdk-*/print) after the fact; it must never manufacture the subscription posture.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// Story 022 / Task 1.1 — subscription/credit taxonomy + classifier for the runtime
// entrypoint billing guard-rail (doc §10 "Auditoria de billing — entrypoint").
//
// WHAT THIS IS: the centralized §10 taxonomy (two frozen label sets) plus `classifyEntrypoint`,
// a PURE function mapping a client-emitted `entrypoint` self-label to a billing class:
//   - SUBSCRIPTION (OK): the TUI / first-party clients that bill on the Claude subscription.
//   - CREDIT (ABORT): the Agent SDK / headless `-p` clients that bill on API credit.
//   - 'unknown': any label in NEITHER set. It MUST be treated conservatively by the caller
//     (task 2.2) and MUST NEVER fall through to 'subscription' — an unrecognized or newly
//     introduced label is not proof of subscription billing.
//
// WHY a centralized, version-noted constant (doc §10): the taxonomy was reverse-engineered from
// the `claude` binary 2.1.159 and the `entrypoint` field is the client's own self-label (written
// verbatim from an env var, not a published contract). It may drift between 2.1.x versions, so the
// sets live in ONE place with the source version cited below — a binary bump shows up in review.
//
// SOURCE: doc §10 "Auditoria de billing — entrypoint", reverse-engineered from `claude` binary
// 2.1.159. If the binary version changes, re-audit these two sets against the new binary.
//
// RE-AUDITED 2026-11-09 against `claude` 2.1.319 (`strings`, the entrypoint table and the SDK
// predicate): the SDK class is still exactly sdk-ts / sdk-py / sdk-cli, and cli, claude-vscode
// and local-agent still exist. Labels added since (mcp, bench, claude-desktop, remote*,
// ssh-remote, claude-coworker*, claude-in-slack/teams, claude-security) are in neither set, so
// they classify 'unknown' and stay blocked. vscode, jetbrains and firstParty no longer appear in
// the binary; they are kept, since no current label can match them. No set changed.

/**
 * §10 SUBSCRIPTION set (OK) — client labels that bill on the Claude subscription.
 * Source: doc §10, `claude` binary 2.1.159.
 */
export const SUBSCRIPTION_ENTRYPOINTS = [
  "cli",
  "claude-vscode",
  "vscode",
  "jetbrains",
  "firstParty",
  "local-agent",
] as const;

/**
 * §10 CREDIT set (ABORT) — client labels that bill on API credit (Agent SDK / headless `-p`).
 * Source: doc §10, `claude` binary 2.1.159.
 */
export const CREDIT_ENTRYPOINTS = ["sdk-ts", "sdk-py", "sdk-cli", "print"] as const;

export type EntrypointClass = "subscription" | "credit" | "unknown";

/**
 * Classify a client-emitted `entrypoint` self-label into its §10 billing class.
 *
 * @param entrypoint the raw `entrypoint` value read from a message event.
 * @returns `'subscription'` for any label in {@link SUBSCRIPTION_ENTRYPOINTS}; `'credit'` for any
 *   label in {@link CREDIT_ENTRYPOINTS}; `'unknown'` for any other label (conservative — NEVER
 *   classifies an unrecognized label as `'subscription'`).
 */
export function classifyEntrypoint(entrypoint: string): EntrypointClass {
  if ((SUBSCRIPTION_ENTRYPOINTS as readonly string[]).includes(entrypoint)) {
    return "subscription";
  }
  if ((CREDIT_ENTRYPOINTS as readonly string[]).includes(entrypoint)) {
    return "credit";
  }
  return "unknown";
}

// Task 2.1 — read entrypoint per message event, skip lightweight types.
//
// `inspectEvent` is the PURE decision over ONE watched event (the story-015 watcher's
// `SessionMessage` shape). It branches on `.type`:
//   - lightweight types (summary, system, file-history-snapshot, …) structurally lack
//     `.entrypoint` and are SKIPPED — a structurally-absent field is NOT a violation;
//   - `assistant`/`user` are billable message events: their `.entrypoint` self-label is read and
//     classified via {@link classifyEntrypoint}. A missing/empty `.entrypoint` on such an event is
//     conservatively routed as 'unknown' → abort (it is NOT silently allowed).
//
// PURITY: never mutates `event`; performs NO side effects (no logging, no stop). Side effects belong
// to task 2.2's `guardEvent` — `inspectEvent` stays a pure decision so it is trivially testable.

/**
 * Structural shape of one watched message event. Mirrors the story-015 watcher's
 * `SessionMessage` (`{ uuid?: string; [k: string]: unknown }`) plus the two fields this guard
 * reads. Kept LOCAL & structural on purpose — importing `engine-watcher` would pull in node-pty
 * and friends, and this module must stay light and pure.
 */
export interface WatchedMessage {
  type?: string;
  entrypoint?: string;
  sessionId?: string;
  [k: string]: unknown;
}

/**
 * The decision {@link inspectEvent} returns for one watched event:
 *   - `skip`  — a lightweight (non-message) type; nothing to classify.
 *   - `allow` — an `assistant`/`user` event whose entrypoint is in the §10 SUBSCRIPTION set.
 *   - `abort` — an `assistant`/`user` event whose entrypoint is credit OR unknown (incl. missing).
 */
export type GuardDecision =
  | { action: "skip" }
  | { action: "allow"; entrypoint: string; entrypointClass: "subscription" }
  | { action: "abort"; entrypoint: string; entrypointClass: "credit" | "unknown" };

/**
 * Pure decision for one watched message event (see module note). Does not mutate `event` and has
 * no side effects.
 *
 * @param event one event delivered by the story-015 watcher.
 * @returns `{ action: 'skip' }` for non-message (lightweight) types; otherwise an `allow`/`abort`
 *   decision carrying the read `entrypoint` and its §10 class. A missing/empty `.entrypoint` on an
 *   `assistant`/`user` event classifies as `'unknown'` → `abort` (never allowed).
 */
export function inspectEvent(event: WatchedMessage): GuardDecision {
  if (event.type !== "assistant" && event.type !== "user") {
    return { action: "skip" };
  }
  const entrypoint = event.entrypoint ?? "";
  const entrypointClass = classifyEntrypoint(entrypoint);
  if (entrypointClass === "subscription") {
    return { action: "allow", entrypoint, entrypointClass };
  }
  return { action: "abort", entrypoint, entrypointClass };
}

// Task 2.2 — allow subscription, abort/alert on credit (never spoof).
//
// `guardEvent` is the IMPURE companion to `inspectEvent`: it REUSES `inspectEvent`'s decision (it
// never re-derives the class) and acts on it through INJECTED hooks. Side effects flow ONLY through
// `hooks` — no `console`/`process` here — so the guard stays unit-testable and the real teardown is
// wired later in story 023 via the hooks.
//
// §10 stance, enforced here:
//   - 'allow' (subscription) → continue silently, no side effect.
//   - 'skip'  (lightweight)  → no-op.
//   - 'abort' (credit OR unknown) → LOUD alert + stop the session. 'unknown' is deliberately routed
//     by `inspectEvent` to 'abort'; we honour that conservatively — an unrecognized label must NOT
//     bill silently.
// It NEVER mutates/defaults/overwrites the observed `entrypoint` (forcing it toward 'cli' would be
// evasion, §10) — `guardEvent` only READS `decision.entrypoint`/`event.sessionId` and REACTS.

/**
 * Side-effect sink injected into {@link guardEvent}. Kept as an interface (not real I/O) so the guard
 * is pure w.r.t. globals and testable; story 023 wires these to the engine-lifecycle stop.
 */
export interface GuardHooks {
  /** Loud, unambiguous alert sink. The message MUST carry the offending entrypoint value AND session id. */
  alert(message: string): void;
  /** Stop the session (wired to engine-lifecycle stop in story 023). Invoked once per violation. */
  stopSession(info: {
    entrypoint: string;
    sessionId?: string;
    entrypointClass: "credit" | "unknown";
  }): void;
}

/**
 * Apply {@link inspectEvent}'s decision for one watched event against the injected {@link GuardHooks}.
 *
 * @param event one event delivered by the story-015 watcher. NEVER mutated.
 * @param hooks the alert/stop sink (the ONLY channel for side effects).
 * @returns the same {@link GuardDecision} `inspectEvent` produced. On `'abort'` (credit OR unknown),
 *   first {@link GuardHooks.alert | alerts} with a loud message carrying the offending entrypoint value
 *   AND session id, then {@link GuardHooks.stopSession | stops the session}; on `'allow'`/`'skip'` it
 *   returns with no side effect. Does NOT mutate, default, or overwrite `event.entrypoint` (§10).
 */
export function guardEvent(event: WatchedMessage, hooks: GuardHooks): GuardDecision {
  const decision = inspectEvent(event);
  if (decision.action !== "abort") {
    // 'allow' (subscription) and 'skip' (lightweight) continue with no side effect.
    return decision;
  }
  const message =
    `[billing §10] BLOCKED ${decision.entrypointClass}-class entrypoint "${decision.entrypoint}" ` +
    `on session "${event.sessionId ?? "(unknown)"}": this client bills on API credit, not the ` +
    `Claude subscription. Stopping the session to avoid silent credit billing — the entrypoint is ` +
    `NOT being rewritten (forcing it to 'cli' would be evasion).`;
  hooks.alert(message);
  hooks.stopSession({
    entrypoint: decision.entrypoint,
    sessionId: event.sessionId,
    entrypointClass: decision.entrypointClass,
  });
  return decision;
}

// Task 3.1 — startup self-check: fail fast on leaked SDK env BEFORE spawn.
//
// `assertCleanBillingEnv` is the POST-CONDITION assertion for the spawn helper's env-sanitize
// (`buildSanitizedEnv` in engine-pty.ts, which DELETES the billing-sensitive keys). It does NOT
// delete-and-continue — deletion is the helper's job; this is the read-only check that it worked.
// Inheriting any of these keys from the parent Node/ACP process would silently bill the spawned
// TUI as API credit (R1, §10) BEFORE any message event is produced, so this must run BEFORE spawn.
//
// SCOPE (the billing subset of engine-pty's FORBIDDEN_BILLING_VARS): the exact key
// `CLAUDE_CODE_ENTRYPOINT` plus the whole `CLAUDE_AGENT_SDK_*` family. The family is matched by
// PREFIX (not an enumerated list) on purpose: it covers today's `CLAUDE_AGENT_SDK_VERSION` /
// `CLAUDE_AGENT_SDK_CLIENT_APP` AND catches any future `CLAUDE_AGENT_SDK_*` sibling the helper's
// fixed deletion list might miss.
//
// `CLAUDECODE` is deliberately NOT checked here. It IS one of engine-pty's FORBIDDEN_BILLING_VARS,
// but it is the spawn helper's ANTI-RECUSA (anti-nesting) concern — it makes the nested `claude` TUI
// refuse to start — which is distinct from this BILLING check (§10). Folding it in here would
// conflate the two guard-rails, so it stays out of the collection logic.
//
// PURITY: read-only. Does NOT delete keys and does NOT mutate `env`.

/**
 * Fail-fast assertion that NO billing-sensitive env key survived into the env about to be passed to
 * spawn (§10 post-condition for {@link buildSanitizedEnv}). Read-only: never deletes or mutates `env`.
 *
 * @param env the spawn env (process-env shape — values may be `undefined`).
 * @throws {Error} if any key is present (value not `undefined`) that is exactly
 *   `CLAUDE_CODE_ENTRYPOINT` OR starts with `CLAUDE_AGENT_SDK_`. The message NAMES every leaked key
 *   and states the spawn must be refused (these would silently bill the run as API credit — R1, §10).
 *   A key set to `undefined` is treated as absent (not a leak). `CLAUDECODE` is NOT checked here (it
 *   is the spawn helper's anti-recusa concern, distinct from this billing check — §10).
 */
export function assertCleanBillingEnv(env: Record<string, string | undefined>): void {
  const leaked = Object.keys(env).filter(
    (key) =>
      env[key] !== undefined &&
      (key === "CLAUDE_CODE_ENTRYPOINT" || key.startsWith("CLAUDE_AGENT_SDK_")),
  );
  if (leaked.length === 0) {
    return;
  }
  throw new Error(
    `[billing §10] REFUSING TO SPAWN: ${leaked.length} billing-sensitive env key(s) leaked into the ` +
      `spawn env: ${leaked.join(", ")}. These would silently bill the spawned TUI as API credit ` +
      `(R1) instead of the Claude subscription. The spawn-env sanitize must strip them BEFORE spawn — ` +
      `aborting rather than launch a credit-billed run.`,
  );
}
