import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Story 011 / Task 4.1 (updated by story 045, 047, then story 056) — lock that the
// `SessionUpdate` discriminated union is reused 1:1 from `@agentclientprotocol/sdk`
// 1.0.0: no local redefinition or unexpected shape drift, proving the ACP schema
// layer is kept 1:1.

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..");
const sdkRoot = join(forkRoot, "node_modules", "@agentclientprotocol", "sdk");

// The 1.8.0 discriminant set (the `sessionUpdate` literal of each variant).
// 0.25.0 added `plan_update` and `plan_removed` to the union (additive vs 0.22.1).
// The 0.28.1 → 1.0.0 major bump (story 056) did NOT change the SessionUpdate
// discriminant set — the 1.0.0 delta is additive elsewhere; these 13 variants are
// unchanged (verified ADDED=[] / REMOVED=[] vs the 0.28.1 set). Nothing was removed.
// The 1.0.0 → 1.2.0 minor bump (story 074, upstream v0.57.0) is ALSO union-identical
// — verified ADDED=[] / REMOVED=[]; the 1.2.0 delta is elicitation/providers/NES
// types, none on the SessionUpdate path.
// The 1.2.0 → 1.3.0 minor bump (story 079, upstream v0.65.0) is union-identical too —
// verified ADDED=[] / REMOVED=[] by this very assertion.
// The 1.3.0 → 1.4.0 minor bump is the FIRST one that is NOT union-identical:
// ADDED=["compaction_update", "compaction_summary_chunk"], REMOVED=[]. Compaction
// became first-class on the wire, so the frozen set is 15 rather than 13. The same
// minor also RENAMED `unstable_createElicitation` → `createElicitation` on
// `AgentSideConnection` (and `unstable_completeElicitation` likewise) — a removal
// shipped in a minor, which is why the bump did not typecheck until the call sites
// moved. Recorded here because the union assertion is the only place this project
// keeps a per-version ledger of what the SDK did.
// The 1.4.0 → 1.5.1 bump (2026-09-29, for GHSA-6q4g-4xp9-ch96 — uncapped stdio
// buffering, fixed in 1.5.1) adds ONE variant: ADDED=["notice"], REMOVED=[]. 1.5.0
// introduced session notices; this adapter sends none, so nothing consumes it.
// The 1.5.1 → 1.8.0 bump (2026-10-15, matching upstream's pin at d6f60f51 / v0.90.0)
// adds THREE variants: ADDED=["subagent_update", "session_message",
// "session_message_chunk"], REMOVED=[]. All three are marked UNSTABLE/@experimental
// in the SDK, and this adapter sends none of them. The same range stabilised
// `notice` and `compaction_update` (their UNSTABLE markers were dropped) and reshaped
// `IdleStateUpdate`/`ErrorStopReason`, neither of which this tree references.
const EXPECTED_VARIANTS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "compaction_update",
  "compaction_summary_chunk",
  "notice",
  "subagent_update",
  "session_message",
  "session_message_chunk",
];

test("session update union: the ACP SDK is pinned to 1.8.0", () => {
  const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, "1.8.0", "the ACP schema/transport SDK is pinned at 1.8.0");
});

test("session update union: SessionUpdate is not redefined or shadowed in fork src", () => {
  const files = readdirSync(join(forkRoot, "src")).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const code = readFileSync(join(forkRoot, "src", f), "utf8");
    assert.ok(
      !/\b(?:type|interface)\s+SessionUpdate\b/.test(code),
      `src/${f} must not locally declare SessionUpdate — it is reused from the SDK`,
    );
  }
});

test("session update union: variant set matches SDK 1.8.0 (no unexpected shape drift)", () => {
  const dts = readFileSync(join(sdkRoot, "dist", "schema", "types.gen.d.ts"), "utf8");
  const declIdx = dts.indexOf("export type SessionUpdate =");
  assert.ok(declIdx !== -1, "SessionUpdate union must be defined in the SDK type surface");
  // The union spans until the next top-level declaration; slice that window only.
  const nextExport = dts.indexOf("\nexport ", declIdx + 1);
  const block = dts.slice(declIdx, nextExport === -1 ? undefined : nextExport);

  const found = [...block.matchAll(/sessionUpdate:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...found].sort(),
    [...EXPECTED_VARIANTS].sort(),
    "the SessionUpdate discriminated-union variant set drifted from the expected 1.8.0 set",
  );
});

test("session update union: the UNSTABLE usage_update variant is present (§15 open-question anchor)", () => {
  // §15 🧪 (deferred to story 025): whether the user's Zed tolerates the UNSTABLE
  // usage_update is unverified — but the variant must exist in the frozen union we
  // advertise. This anchors that open question to a concrete, present discriminant.
  assert.ok(EXPECTED_VARIANTS.includes("usage_update"));
});
