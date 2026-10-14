// Story 068 / Task 1.1 — context-window resolution per model alias (R1, R1.1, R1.2, R2; UB2).
//
// BUG: the Zed panel's token denominator showed 200K for EVERY session because `contextWindowSize`
// was only ever 1M when the model string matched `\b1m\b`, falling back to DEFAULT_CONTEXT_WINDOW
// (200K) otherwise. `opus` (natively 1M) therefore wrongly showed 200K, while `sonnet`/`haiku` (truly
// 200K) were correct by accident. The window is NOT uniform — a blanket "everything is 1M" would be wrong.
//
// FIX (story 068): a static alias→window map (MODEL_CONTEXT_WINDOWS, beside MODEL_CATALOG) keyed by the
// catalog `value`, consulted by `inferContextWindowFromModel` BEFORE the `\b1m\b` regex, then `null`.
// The two call sites keep `?? DEFAULT_CONTEXT_WINDOW`. UB2: `sonnet[1m]` must STAY 1M (it already did
// via the regex; this story must not regress it).
//
// Symbols are namespace-imported so this file LOADS even before the story-068 exports exist (the
// "surface" test then fails cleanly — Red — instead of the whole module erroring on a missing named
// import). `inferContextWindowFromModel` + `DEFAULT_CONTEXT_WINDOW` are exported from acp-agent.ts for
// this unit (they were private before story 068); `MODEL_CONTEXT_WINDOWS` is the new model-catalog map.
//
// node:test runner (build first): `node --experimental-strip-types --test test/context-window.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as acp from "../dist/acp-agent.js";
import * as catalog from "../dist/model-catalog.js";

/** The resolver under test (null = "unknown", caller applies the default). */
const infer = (m: string): number | null => acp.inferContextWindowFromModel(m);
/** Mirror the two call sites' `?? DEFAULT_CONTEXT_WINDOW` to assert the OBSERVABLE denominator. */
const resolve = (m: string): number => infer(m) ?? acp.DEFAULT_CONTEXT_WINDOW;

test("068 surface: the story-068 exports exist (resolver, default, map)", () => {
  assert.equal(
    typeof acp.inferContextWindowFromModel,
    "function",
    "inferContextWindowFromModel must be exported from acp-agent.ts",
  );
  assert.equal(
    typeof acp.DEFAULT_CONTEXT_WINDOW,
    "number",
    "DEFAULT_CONTEXT_WINDOW must be exported from acp-agent.ts",
  );
  assert.equal(
    typeof catalog.MODEL_CONTEXT_WINDOWS,
    "object",
    "MODEL_CONTEXT_WINDOWS must be exported from model-catalog.ts",
  );
  assert.ok(catalog.MODEL_CONTEXT_WINDOWS, "MODEL_CONTEXT_WINDOWS must be a non-null record");
});

test("068 R1.1: opus → 1M (the fix — was wrongly 200K)", () => {
  assert.equal(infer("opus"), 1_000_000);
});

test("068 R1.1: sonnet → 1M (plain `sonnet` resolves to Sonnet 5, native 1M)", () => {
  // The redundant `sonnet[1m]` alias was dropped: Sonnet 5 has no smaller context variant, so the
  // bare `sonnet` alias now seeds 1M directly.
  assert.equal(infer("sonnet"), 1_000_000);
});

test("068 R1.2: a literal `[1m]` suffix still → 1M via the regex fallback", () => {
  // `sonnet[1m]` is no longer a catalog alias, but the `\b1m\b` regex still resolves any lingering
  // `[1m]`-suffixed string to 1M (defensive).
  assert.equal(infer("sonnet[1m]"), 1_000_000);
});

test("item 93: haiku → 1M (plain `haiku` resolves to Haiku 5.5, native 1M)", () => {
  // CLI 2.1.293 made `claude-haiku-5-5` the default Haiku: its baked-in catalogue entry is
  // `context:{window:1e6,native_1m:!0}`. Seeding 200K made the context meter overstate usage 5x.
  assert.equal(infer("haiku"), 1_000_000);
});

test("068 R1.2: unknown alias carrying a 1m token → 1M (regex fallback)", () => {
  assert.equal(infer("claude-sonnet-4-6-1m"), 1_000_000);
});

test("068 R1.2: fully unknown → null; call site applies DEFAULT_CONTEXT_WINDOW", () => {
  assert.equal(infer("totally-unknown-model"), null);
  assert.equal(resolve("totally-unknown-model"), acp.DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolve("totally-unknown-model"), 200_000);
});

test("069 R2: default/fable/opus/sonnet seeds → 1M (all native 1M pre-first-turn)", () => {
  assert.equal(infer("default"), 1_000_000);
  assert.equal(infer("fable"), 1_000_000);
  assert.equal(infer("opus"), 1_000_000);
  assert.equal(infer("sonnet"), 1_000_000);
});

test("069 R3: the fallback rows are SELF-CONTAINED — version plus the picker's own tagline", () => {
  // Rows used to carry a bare tagline and get a curated version prefix bolted on at
  // render time. They no longer do: live rows from the CLI arrive self-contained, and
  // prefixing those produced doubled copy ("Opus 5.5 with 1M context · Opus 5.5 · …").
  // So the fallback rows were reshaped to match, and the taglines stay VERBATIM from
  // the picker — writing a better one would invent a claim Anthropic did not make.
  const byValue: Record<string, { displayName?: string; description?: string }> = {};
  for (const m of catalog.MODEL_CATALOG) byValue[m.value] = m;
  assert.equal(byValue.opus.displayName, "Opus 5.5");
  assert.equal(byValue.opus.description, "Opus 5.5 with 1M context · Best for everyday, complex tasks");
  assert.equal(byValue.sonnet.displayName, "Sonnet 5.5");
  assert.equal(byValue.sonnet.description, "Sonnet 5.5 with 1M context · Most efficient for simpler tasks");
  assert.equal(byValue.haiku.displayName, "Haiku 5.5");
  assert.equal(byValue.haiku.description, "Haiku 5.5 with 1M context · Fastest for quick answers");
  assert.equal(byValue.fable.displayName, "Fable 5.1");
  assert.equal(
    byValue.fable.description,
    "Fable 5.1 with 1M context · Most capable for your hardest and longest-running tasks",
  );
  // `default` carries the Opus text (default = recommended Opus).
  assert.equal(
    byValue.default.description,
    "Opus 5.5 with 1M context · Best for everyday, complex tasks",
  );
});

test("072: modelSelectorDescription prepends the version/context label to the tagline", () => {
  const byValue: Record<string, { value: string; description?: string }> = {};
  for (const m of catalog.MODEL_CATALOG) byValue[m.value] = m;
  // The `/model` picker format: "<version + context> · <static tagline>".
  assert.equal(
    catalog.modelSelectorDescription(byValue.default),
    "Opus 5.5 with 1M context · Best for everyday, complex tasks",
  );
  assert.equal(
    catalog.modelSelectorDescription(byValue.opus),
    "Opus 5.5 with 1M context · Best for everyday, complex tasks",
  );
  assert.equal(
    catalog.modelSelectorDescription(byValue.fable),
    "Fable 5.1 with 1M context · Most capable for your hardest and longest-running tasks",
  );
  assert.equal(
    catalog.modelSelectorDescription(byValue.sonnet),
    "Sonnet 5.5 with 1M context · Most efficient for simpler tasks",
  );
  assert.equal(
    catalog.modelSelectorDescription(byValue.haiku),
    "Haiku 5.5 with 1M context · Fastest for quick answers",
  );
  // A label-less entry → bare tagline, no leading " · " (total-function safeguard).
  assert.equal(
    catalog.modelSelectorDescription({ value: "no-label-x", description: "just the tagline" } as never),
    "just the tagline",
  );
});

test("068 anti-drift: every MODEL_CATALOG value has an explicit MODEL_CONTEXT_WINDOWS entry", () => {
  for (const m of catalog.MODEL_CATALOG) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(catalog.MODEL_CONTEXT_WINDOWS, m.value),
      `catalog alias '${m.value}' must have an explicit MODEL_CONTEXT_WINDOWS entry (drift guard)`,
    );
  }
});

// --- Story 069: authoritative window from the turn's REAL model ID (the transcript `model` field) ---
// The alias seed (068) is the pre-first-turn guess; once a turn carries `model:"claude-opus-4-8"` the
// pump refines the window from this resolver. Windows mirror the claude CLI's `context:{window}` table:
// Opus is NOT uniform (4-6=200K, 4-7/4-8=1M); sonnet/haiku=200K; fable-5=1M.
const inferId = (id: unknown): number | null => acp.inferContextWindowFromModelId(id as string);

test("069 surface: inferContextWindowFromModelId is exported", () => {
  assert.equal(
    typeof acp.inferContextWindowFromModelId,
    "function",
    "inferContextWindowFromModelId must be exported from acp-agent.ts",
  );
});

test("069 R1.1: opus-4-8 / opus-4-7 → 1M (current Opus is native 1M)", () => {
  assert.equal(inferId("claude-opus-4-8"), 1_000_000);
  assert.equal(inferId("claude-opus-4-7"), 1_000_000);
});

test("069 R1.1: opus-4-6 → 200K (Opus is NOT uniformly 1M — the key finding)", () => {
  assert.equal(inferId("claude-opus-4-6"), 200_000);
});

test("069 R1.1: sonnet 4.x IDs → 200K", () => {
  assert.equal(inferId("claude-sonnet-4-6"), 200_000);
  assert.equal(inferId("claude-sonnet-4-5-20250929"), 200_000);
});

test("071 R1.1: sonnet-5 → 1M (Sonnet 5 is native 1M — no smaller context variant)", () => {
  // Sonnet is NOT uniform across generations (mirrors the Opus 4-6 vs 4-7/4-8 split): the
  // subscription CLI serves Sonnet 4.x at 200K but Sonnet 5 at 1M by default. The family
  // heuristic must be version-aware, not a blanket `claude-sonnet → 200K`.
  assert.equal(inferId("claude-sonnet-5"), 1_000_000);
  assert.equal(inferId("claude-sonnet-5-20260115"), 1_000_000);
});

test("069 R1.1: fable-5 → 1M; haiku 4.x → 200K", () => {
  assert.equal(inferId("claude-fable-5"), 1_000_000);
  assert.equal(inferId("claude-haiku-4-5"), 200_000);
  assert.equal(inferId("claude-haiku-4-5-20251001"), 200_000);
});

test("item 93: the 5.5 ids are exact entries → 1M (Haiku 5.5 and Sonnet 5.5 are native 1M)", () => {
  // Read from the CLI's baked-in catalogue (2.1.299): both carry `window:1e6, native_1m:!0`.
  assert.equal(catalog.MODEL_ID_CONTEXT_WINDOWS["claude-haiku-5-5"], 1_000_000);
  assert.equal(catalog.MODEL_ID_CONTEXT_WINDOWS["claude-sonnet-5-5"], 1_000_000);
  assert.equal(inferId("claude-haiku-5-5"), 1_000_000);
  assert.equal(inferId("claude-sonnet-5-5"), 1_000_000);
});

test("item 93: the Haiku heuristic is version-aware, like Sonnet's (5+ → 1M, 4.x → 200K)", () => {
  // A dated snapshot or a provider-prefixed id misses the exact table and reaches the heuristic.
  assert.equal(inferId("claude-haiku-5-5-20260601"), 1_000_000);
  assert.equal(inferId("us.anthropic.claude-haiku-5-5"), 1_000_000);
  assert.equal(inferId("claude-haiku-6"), 1_000_000);
  assert.equal(inferId("claude-haiku-4-5@20251001"), 200_000);
});

test("069 R1.2: unknown ID carrying a 1m token → 1M (regex fallback)", () => {
  assert.equal(inferId("claude-future-x-1m"), 1_000_000);
});

test("069 R1.2: fully unknown ID → null (caller keeps the current value)", () => {
  assert.equal(inferId("gpt-5-turbo"), null);
});

test("069 R1.2: explicit [1m] suffix wins over the family heuristic → 1M", () => {
  // `/model default` resolves to `claude-opus-4-8[1m]` live; Sonnet long-context is `…[1m]` too.
  assert.equal(inferId("claude-opus-4-8[1m]"), 1_000_000);
  assert.equal(inferId("claude-sonnet-4-5-20250929[1m]"), 1_000_000);
});

test("069 R1.3: missing / non-string model → null (no refine on user rows)", () => {
  assert.equal(inferId(undefined), null);
  assert.equal(inferId(""), null);
  assert.equal(inferId(123), null);
});
