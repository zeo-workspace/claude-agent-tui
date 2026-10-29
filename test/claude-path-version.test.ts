// Story 049 / Task 4.1 (R1.1, R1.2) — version-aware resolution helpers, tested OFFLINE.
//
// `claude-path.ts` gains three pure/best-effort helpers so binary drift is observable:
//   - parseClaudeVersion(output)         → leading "x.y.z" from `claude --version` text, else null
//   - detectClaudeVersion(bin, exec?)    → run `--version` (args-list, no shell) + parse; null on any
//                                          failure (best-effort observability — NEVER throws)
//   - reportVersionDrift(detected, pinned, log) → emits a one-line stderr warning IFF they differ
//
// All three are tested here with NO real binary: parse is pure; detect takes an injected `exec`
// seam; drift takes an injected `log` sink. This keeps the unit layer offline (R2.5 spirit) while
// `resolveClaudePath` wires the real `execFileSync` + `console.error` in production.
//
// node:test runner: `node --experimental-strip-types --test test/claude-path-version.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Story 059: dist over src — claude-path.ts gained a src→src `./image-vision-smoke.js` import (story 058)
// that does not resolve from src/ under --experimental-strip-types; import the built module (the dominant
// test convention, cf. engine-pty in claude-path-resolve.test.ts) so the compiled module resolves.
import {
  parseClaudeVersion,
  detectClaudeVersion,
  reportVersionDrift,
  PROVENANCE_CLAUDE_VERSION,
} from "../dist/claude-path.js";

// === parseClaudeVersion — pure leading-semver parse ============================================

test("parseClaudeVersion: extracts the leading x.y.z from real `claude --version` output (R1.1)", () => {
  assert.equal(parseClaudeVersion("2.1.186 (Claude Code)\n"), "2.1.186");
  assert.equal(parseClaudeVersion("2.1.159 (Claude Code)\n"), "2.1.159");
  assert.equal(parseClaudeVersion("2.1.121\n"), "2.1.121");
});

test("parseClaudeVersion: returns null on garbage / no version present (R1.1 best-effort)", () => {
  assert.equal(parseClaudeVersion(""), null);
  assert.equal(parseClaudeVersion("not a version at all"), null);
  assert.equal(parseClaudeVersion("\n\n"), null);
});

// === detectClaudeVersion — exec seam, never throws ============================================

test("detectClaudeVersion: parses the injected exec output to a version (R1.1)", () => {
  const v = detectClaudeVersion("/fake/claude", () => "2.1.186 (Claude Code)\n");
  assert.equal(v, "2.1.186");
});

test("detectClaudeVersion: returns null when exec yields unparseable output (R1.1)", () => {
  const v = detectClaudeVersion("/fake/claude", () => "???");
  assert.equal(v, null);
});

test("detectClaudeVersion: returns null (never throws) when exec throws — best-effort (R1.1)", () => {
  const v = detectClaudeVersion("/fake/claude", () => {
    throw new Error("ENOENT: spawn failed");
  });
  assert.equal(v, null, "version detection is best-effort observability, not a gate");
});

test("detectClaudeVersion: passes the args-list `--version` to exec (no shell) (R1.1, C5)", () => {
  let seenBin = "";
  let seenArgs: readonly string[] = [];
  detectClaudeVersion("/path/to/claude", (bin, args) => {
    seenBin = bin;
    seenArgs = args;
    return "2.1.186\n";
  });
  assert.equal(seenBin, "/path/to/claude");
  assert.deepEqual([...seenArgs], ["--version"], "must invoke with an args list, never a shell string");
});

// === reportVersionDrift — warn IFF different ==================================================

test("reportVersionDrift: warns naming BOTH versions when detected != pinned (R1.2)", () => {
  const calls: string[] = [];
  reportVersionDrift("2.1.186", "2.1.159", (...args) => calls.push(args.join(" ")));
  assert.equal(calls.length, 1, "exactly one drift warning");
  assert.match(calls[0], /2\.1\.186/, "must name the detected version");
  assert.match(calls[0], /2\.1\.159/, "must name the pinned version");
});

test("reportVersionDrift: silent when detected == pinned (no drift) (R1.2)", () => {
  const calls: string[] = [];
  reportVersionDrift("2.1.159", "2.1.159", (...args) => calls.push(args.join(" ")));
  assert.equal(calls.length, 0, "no warning when versions match");
});

test("reportVersionDrift: silent when detected is null (nothing to compare) (R1.2)", () => {
  const calls: string[] = [];
  reportVersionDrift(null, "2.1.159", (...args) => calls.push(args.join(" ")));
  assert.equal(calls.length, 0, "a failed detection is not a drift warning");
});

// === PROVENANCE_CLAUDE_VERSION — the pin the drift is measured against ========================

// Story 063 — the pin equals the CLI the suite was verified on (2.1.312, installed 2026-10-29), so
// start-up on that CLI logs no drift.
test("063 PROVENANCE_CLAUDE_VERSION is the provenance pin 2.1.312", () => {
  assert.equal(PROVENANCE_CLAUDE_VERSION, "2.1.312");
});

test("063 the pin equals .fork-provenance.json's claude entry", () => {
  const provenance = JSON.parse(readFileSync(new URL("../.fork-provenance.json", import.meta.url), "utf8"));
  const claude = provenance.externalRuntimeDeps.find((d: { name: string }) => d.name === "claude");
  assert.equal(claude.version, PROVENANCE_CLAUDE_VERSION);
});

test("063 no drift report for the verified CLI against the pin", () => {
  const calls: string[] = [];
  reportVersionDrift("2.1.312", PROVENANCE_CLAUDE_VERSION, (...args) => calls.push(args.join(" ")));
  assert.equal(calls.length, 0);
});
