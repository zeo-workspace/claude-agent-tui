// Story 009 / Task 8.2 — the reachable half of the `v0.71.0` → `v0.75.1` window (R5.2, R7.3, R7.4).
//
// CONTRACT. §16 of docs/REBASE-AND-DRIFT.md classified 13 upstream commits and found three
// portable FRAGMENTS, no whole commits. This file pins one behaviour per ported fragment, plus
// the catalogue entry R5.2 asks for.
//
//   R5.2  Fable 5.1 joins the curated catalogue, under the alias the CLI ACCEPTS and declaring its
//         effort capability like every other Claude-5-family surface. The alias was originally
//         taken from `strings /opt/bin/claude` (`fable51`), and that was WRONG: the binary carries
//         that token as an internal id→short-name mapping, not as a `--model` value. The CLI's
//         alias vocabulary is a closed set that holds only tier names, so `fable51` 404'd at spawn
//         with `[claude-code:unrecognized_model]`. Corrected 2026-09-23 to the probed `fable`.
//   R7.3  `#1079` and `#1080` are PORTABLE IN PART, so the reachable part lands AND the code
//         records which half was cut.
//   R7.4  A port that would deliver upstream's degraded path, or produce data no client renders,
//         says so at the call site instead of presenting itself as parity. `CUT_FROM_UPSTREAM`
//         is that statement, made machine-checkable rather than left in prose.
//
// What is NOT here, deliberately: `#991`'s outcome. §16.7 made it conditional on a client asking
// for a compaction event, and none does — this engine already keeps continuity across the
// boundary through the JSONL `summary` row (linearize.ts:106-109).
//
// node:test runner (build first):
//   npm run build && node --experimental-strip-types --test test/window-v0.71-port.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG,
  MODEL_CONTEXT_WINDOWS,
  MODEL_ID_CONTEXT_WINDOWS,
  REASONING_EFFORT_LEVELS,
} from "../dist/model-catalog.js";
import {
  billsClaudeSubscription,
  holdsNonSubscriptionCredential,
  CUT_FROM_UPSTREAM as HIDE_AUTH_CUT,
} from "../dist/hide-claude-auth.js";
import {
  gatewayAuthStatus,
  notLoggedInAuthStatus,
  CUT_FROM_UPSTREAM as AUTH_STATUS_CUT,
} from "../dist/auth-status.js";

// ---- R5.2 — Fable 5.1 in the curated catalogue ---------------------------------------------

test("R5.2 the catalogue offers Fable 5.1 under the alias the installed CLI accepts", () => {
  const entry = MODEL_CATALOG.find((m) => m.value === "fable");
  assert.ok(
    entry,
    "MODEL_CATALOG must carry a `fable` entry — that is the tier alias `--model` accepts, probed " +
      "with a real turn (→ claude-fable-5-1). The version-numbered `fable51` this test used to " +
      "demand is rejected by the CLI, so asserting it pinned a picker row that could only 404",
  );
});

test("R5.2 the Fable 5.1 entry declares its effort capability", () => {
  const entry = MODEL_CATALOG.find((m) => m.value === "fable");
  assert.equal(
    entry?.supportsEffort,
    true,
    "every Claude-5-family surface in this catalogue is effort-capable; an entry that omits it " +
      "silently drops the effort selector for anyone who picks that model",
  );
  assert.deepEqual(
    entry?.supportedEffortLevels,
    REASONING_EFFORT_LEVELS,
    "the levels must be the same enum the rest of the catalogue advertises, not a subset",
  );
});

test("R5.2 Fable leads the family rows, right after `default`", () => {
  const iFable = MODEL_CATALOG.findIndex((m) => m.value === "fable");
  assert.equal(
    iFable,
    1,
    "Fable must sit IMMEDIATELY AFTER `default` — the most capable family leads the picker. A row " +
      "parked at the end of the list is present but not offered",
  );
});

test("R5.2 no catalogue row is a version-numbered alias, which the CLI rejects", () => {
  // The regression this guards is the one that produced `fable51`/`fable5`: a token lifted out of
  // `strings /opt/bin/claude` that is an INTERNAL id→short-name mapping, not a `--model` value.
  // The accepted vocabulary is tier names (plus `best`, `opusplan`, a `[1m]` suffix) and full wire
  // ids; anything else 404s at spawn, and nothing in this repo fails until a user picks the row.
  const offenders = MODEL_CATALOG.map((m) => m.value).filter((v) => /^[a-z]+\d/.test(v));
  assert.deepEqual(
    offenders,
    [],
    "a version-numbered alias (fable51, opus55, sonnet46…) is not in the CLI's alias set. Pin the " +
      "tier alias instead, or the full wire id, and PROBE it: " +
      "`claude -p ok --model <value> --output-format json | jq .is_error`",
  );
});

test("R5.2 the Fable fallback row names its concrete version, in title AND description", () => {
  // The INTENT is unchanged from when this asserted MODEL_VERSION_LABELS: the version
  // the tier alias resolves to — the one thing the alias itself cannot show — must be
  // visible in the picker. The MECHANISM changed: rows are now self-contained, because
  // live rows arrive that way and a curated prefix prepended to them produced doubled
  // copy. So the assertion moved from the removed label map onto the row itself.
  const entry = MODEL_CATALOG.find((m) => m.value === "fable");
  assert.match(entry?.displayName ?? "", /Fable 5\.2/);
  assert.match(entry?.description ?? "", /Fable 5\.2/);
});

test("R5.2 Fable 5.1's window is declared in BOTH tables, which are not the same table", () => {
  assert.equal(
    MODEL_CONTEXT_WINDOWS.fable,
    1_000_000,
    "the alias table seeds the window from what `/model fable` sends",
  );
  assert.equal(
    MODEL_ID_CONTEXT_WINDOWS["claude-fable-5-1"],
    1_000_000,
    "the ID table is the exact-ID source of truth that AUTHORITATIVELY refines the window from a " +
      "turn's actual `model` field in the JSONL. Seeding only the alias leaves the refinement " +
      "step with no entry, so the correction silently does not happen",
  );
  // CLI 2.1.321 moved `fable` to Fable 5.2; the ID table must know the id the alias now sends.
  assert.equal(MODEL_ID_CONTEXT_WINDOWS["claude-fable-5-2"], 1_000_000);
});

// ---- R7.3 — `#1079`'s reachable half: pure credential classification ------------------------

test("R7.3 billsClaudeSubscription is an allowlist: every field must prove the subscription pays", () => {
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max" }),
    true,
    "a plain subscription account bills the subscription",
  );
  assert.equal(
    billsClaudeSubscription(undefined),
    false,
    "no account cannot bill anything",
  );
  assert.equal(
    billsClaudeSubscription({}),
    false,
    "without subscriptionType the CLI reports no subscription",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", tokenSource: "bearer" }),
    false,
    "a bearer/OAuth environment token pays instead of the subscription",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiProvider: "bedrock" }),
    false,
    "the Anthropic OAuth login applies only to firstParty; a third-party backend authenticates externally",
  );
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" }),
    false,
    "credential precedence puts that key above the /login subscription, so the key pays",
  );
});

test("R7.3 an unknown apiKeySource keeps the guard on rather than assuming a subscription", () => {
  assert.equal(
    billsClaudeSubscription({ subscriptionType: "max", apiKeySource: "something-new" }),
    true,
    "the SDK types apiKeySource as an open string, so this is an ALLOWLIST of keys that outrank " +
      "the subscription — an unrecognised source is not one of them and the subscription still pays",
  );
});

test("R7.3 holdsNonSubscriptionCredential is the complement, and false means no way to pay", () => {
  assert.equal(holdsNonSubscriptionCredential(undefined), false);
  assert.equal(
    holdsNonSubscriptionCredential({ subscriptionType: "max" }),
    false,
    "a subscription-only account holds no credential this integration accepts",
  );
  assert.equal(holdsNonSubscriptionCredential({ apiProvider: "vertex" }), true);
  assert.equal(holdsNonSubscriptionCredential({ tokenSource: "oauth" }), true);
  assert.equal(
    holdsNonSubscriptionCredential({ apiKeySource: "apiKeyHelper" }),
    true,
  );
});

// ---- R7.3 — `#1080`'s reachable half: pure AuthStatus constructors --------------------------

test("R7.3 notLoggedInAuthStatus is the signed-out identity, and is not shared state", () => {
  const a = notLoggedInAuthStatus();
  assert.deepEqual(a, { kind: "none", label: "Not logged in" });
  a.label = "mutated";
  assert.equal(
    notLoggedInAuthStatus().label,
    "Not logged in",
    "it must return a fresh object; a shared constant would let one caller's edit reach every other",
  );
});

test("R7.3 gatewayAuthStatus reduces a base URL to its host, and survives a malformed one", () => {
  assert.deepEqual(gatewayAuthStatus("https://gw.example.com/v1"), {
    kind: "gateway",
    label: "Custom model gateway",
    detail: "gw.example.com",
  });
  assert.deepEqual(
    gatewayAuthStatus(),
    { kind: "gateway", label: "Custom model gateway" },
    "no URL means no detail key at all, not an empty one",
  );
  assert.equal(
    gatewayAuthStatus("not a url").detail,
    "not a url",
    "an unparseable base URL falls back to the raw string rather than throwing — the gateway owns " +
      "the credentials either way, and losing the identity to a URL typo would be the worse failure",
  );
});

// ---- R7.4 — the cut halves say so, at the call site -----------------------------------------

test("R7.4 the hide-claude-auth port records which half was cut and why", () => {
  assert.equal(HIDE_AUTH_CUT.pr, 1079);
  assert.ok(
    HIDE_AUTH_CUT.cut.includes("refuseClaudeSubscriptionTurn"),
    "the turn-refusal half is the cut one — it acts on a turn, and this fork's prompt() loop is " +
      "story 011's stub (ENGINE_NOT_IMPLEMENTED_011) pending 023",
  );
  assert.match(
    HIDE_AUTH_CUT.why,
    /turn|023|stub/i,
    "R7.4 wants the REASON at the call site, not just a list of missing names",
  );
});

test("R7.4 the auth-status port records that the notification is unreachable chain-wide", () => {
  assert.equal(AUTH_STATUS_CUT.pr, 1080);
  assert.ok(
    AUTH_STATUS_CUT.cut.includes("_auth/status_update"),
    "the notification is the cut half",
  );
  assert.match(
    AUTH_STATUS_CUT.why,
    /schema|capability|zed/i,
    "the reason is that no client in this chain negotiates it — zero occurrences in the packaged " +
      "Zed's crates AND in agent-client-protocol-schema-1.5.0 — which is a stronger claim than " +
      "'not wired yet' and must not be softened into one",
  );
});
