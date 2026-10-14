// Story 046 / Task 2.1 — the static curated model catalog (R1.1, R2.1).
//
// CONTRACT (story.md R1.1 / R2.1 + design.md §5/§7): a new `model-catalog.ts` exports a static
// curated `ModelInfo[]` of TUI-accepted aliases — `default`, `fable`, `opus`, `sonnet`, `haiku` —
// replacing the single static `[DEGRAU1_DEFAULT_MODEL_INFO]`. `default` stays a safe fallback entry.
// Effort-capable entries declare `supportsEffort` + a non-empty `supportedEffortLevels` (which is what
// unlocks the effort selector via `buildConfigOptions`, design §7). This file pins the catalog as a
// pure data contract — no spawn, no agent, no claude.
//
// node:test runner (build first): `node --experimental-strip-types --test test/model-catalog.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG } from "../dist/model-catalog.js";

// Story 009 R5.2 added `fable51` and this round REMOVED it, together with `fable5`: neither is in
// the CLI's alias vocabulary, so both rows 404'd at spawn. The single `fable` tier alias replaces
// them — probed with a real turn (`--model fable` → `claude-fable-5-1`), not read out of `strings`.
// The contract is unchanged: exact order + exact membership.
const EXPECTED_ALIASES = ["default", "fable", "opus", "sonnet", "haiku"];

test("2.1 catalog: exports more than the single static entry (R1.1 — was 1 item)", () => {
  assert.ok(Array.isArray(MODEL_CATALOG), "MODEL_CATALOG is an array of ModelInfo");
  assert.ok(MODEL_CATALOG.length > 1, `the catalog must have >1 entry, got ${MODEL_CATALOG.length}`);
});

test("2.1 catalog: every curated TUI alias is present by `value` (R1.1)", () => {
  const values = MODEL_CATALOG.map((m) => m.value);
  for (const alias of EXPECTED_ALIASES) {
    assert.ok(values.includes(alias), `expected catalog alias '${alias}' in: ${values.join(", ")}`);
  }
});

test("2.1 catalog: `default` is retained as a safe fallback entry (R1.1)", () => {
  const def = MODEL_CATALOG.find((m) => m.value === "default");
  assert.ok(def, "the `default` fallback entry must remain in the catalog");
  assert.equal(typeof def!.displayName, "string", "the default entry carries a displayName");
});

test("2.1 catalog: every entry has a value + displayName (the configOption `select` shape)", () => {
  for (const m of MODEL_CATALOG) {
    assert.equal(typeof m.value, "string", `entry value is a string: ${JSON.stringify(m)}`);
    assert.ok(m.value.length > 0, `entry value is non-empty: ${JSON.stringify(m)}`);
    assert.equal(typeof m.displayName, "string", `entry displayName is a string: ${JSON.stringify(m)}`);
  }
});

test("2.1 catalog: at least one entry declares effort support — unlocks the effort selector (R2.1)", () => {
  const effortCapable = MODEL_CATALOG.filter((m) => m.supportsEffort === true);
  assert.ok(
    effortCapable.length >= 1,
    "at least one catalog model must declare supportsEffort so the effort option can surface (R2.1)",
  );
  for (const m of effortCapable) {
    assert.ok(
      Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0,
      `an effort-capable model must list non-empty supportedEffortLevels: ${JSON.stringify(m)}`,
    );
  }
});

test("2.1 catalog: `haiku` advertises effort — it resolves to Haiku 5.5 (item 93)", () => {
  // `haiku` used to be the genuine non-effort model (Haiku 4.5). CLI 2.1.293 made Haiku 5.5 the
  // default Haiku, and the live picker (CLI 2.1.299) serves it with the full effort set. A fallback
  // row that still hid effort would make the picker disagree with the CLI it stands in for. The
  // "non-effort model hides the effort option" contract now lives in the agent-level suites, on a
  // stub catalogue (test/helpers/stub-model-catalog.ts).
  const haiku = MODEL_CATALOG.find((m) => m.value === "haiku");
  assert.ok(haiku, "haiku entry present");
  assert.equal(haiku!.supportsEffort, true, "`haiku` (Haiku 5.5) declares effort support");
});
