// Story 046 / Task 2.1 — the static curated model catalog (R1.1, R2.1).
//
// Replaces the single `[DEGRAU1_DEFAULT_MODEL_INFO]` entry that collapsed the Zed model selector to
// "Default" and kept the effort selector from ever appearing. These are the interactive `claude` TUI's
// accepted model aliases — the same tokens `/model <alias>` (live switch, design §5) and `--model
// <alias>` (spawn) accept. `default` stays the safe fallback (keep whatever the TUI is configured with).
//
// Effort-capable entries declare `supportsEffort` + a non-empty `supportedEffortLevels`, which is
// exactly what unlocks the effort configOption via `buildConfigOptions` (design §7). The level
// vocabulary is the SDK's (`'low'|'medium'|'high'|'xhigh'|'max'`), which aligns with the
// `reasoning_effort` field seen in real transcripts (NOT the legacy S/M/L/XL display values).
//
// PURE DATA — no spawn, no agent, no `claude`. `ModelInfo` is the SDK shape from
// `@anthropic-ai/claude-agent-sdk` (the same type `acp-agent.ts` builds its model list from).
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClientCapabilities, SessionConfigOption } from "@agentclientprotocol/sdk";

/**
 * Effort levels offered for reasoning-capable models — the SDK's `supportedEffortLevels` vocabulary.
 * Story 060: exported so the ultracode guard test can assert membership stays the five real levels
 * (it must NEVER contain {@link ULTRACODE_EFFORT}; the real `--effort` enum is exactly this set).
 */
export const REASONING_EFFORT_LEVELS: NonNullable<ModelInfo["supportedEffortLevels"]> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Story 060 — the "ultracode" pseudo-level sentinel for the effort selector. NOT a real `--effort`
 * value (claude 2.1.195 rejects `--effort ultracode`; the enum stays {@link REASONING_EFFORT_LEVELS}).
 * Selecting it maps to `--effort xhigh` PLUS activating the ultracode keyword-trigger for the session
 * (story 060 Task 3). Kept OUT of REASONING_EFFORT_LEVELS so no real-effort code path ever emits it.
 */
export const ULTRACODE_EFFORT = "ultracode";

/** The real effort level the ultracode pseudo-level maps to (its documented effort component). */
export const ULTRACODE_EFFORT_LEVEL = "xhigh";

/** Selector label — makes clear it is xhigh + orchestration, NOT a duplicate of the plain `xhigh` entry. */
export const ULTRACODE_EFFORT_LABEL = "ultracode (xhigh + orchestration)";

/**
 * The FALLBACK model list — no longer what the picker normally shows.
 *
 * `live-model-catalog.ts` reads the real list from the CLI at session creation;
 * this is what it falls back to when that read fails (no `claude` on PATH, a
 * spawn error, a timeout). Everything below about hand-curation still applies to
 * THESE rows, and the reason it is no longer the primary source is in that
 * module's doc: the catalogue is backend-served and was measured changing shape
 * twice in one day, which no hand-written list can track.
 *
 * Keep these rows CURRENT anyway. A fallback that nobody maintains is a fallback
 * that ships a two-year-old model list on the day the CLI goes missing.
 *
 * The static curated catalog advertised to the Zed Agent Panel's `model` selector. Each `value` is a
 * `claude` TUI alias accepted by `/model <alias>` (live) and `--model <alias>` (spawn). `default` is
 * first and is the safe fallback.
 *
 * ORDER + membership: `Default (recommended)`, `Fable`, `Opus`, `Sonnet`, `Haiku` — TIER aliases only,
 * never a version-numbered one. The original gets its list from the SDK `supportedModels()` the fork
 * cut, so we curate it statically. The redundant `sonnet[1m]` alias was dropped: Sonnet 5 is natively
 * 1M, so plain `sonnet` already IS the 1M model. The fork-only `opusplan` extra was dropped too (three
 * Sonnet-flavored entries + inconsistent Opus thinking made it more confusing than useful).
 *
 * **The CLI's alias vocabulary is a CLOSED SET, and a version-numbered alias is not in it.** Measured
 * on claude 2.1.280: the accepted spellings are exactly
 * `["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]` — plus any
 * full wire id (`claude-opus-5-5`). Anything else 404s at spawn with `[claude-code:unrecognized_model]`,
 * which is how the `fable51` and `fable5` rows this catalogue used to carry were BOTH dead: the binary
 * contains those tokens (they are the CLI's internal id→short-name map), so reading them out of
 * `strings` looked like confirmation and was not. **Probe an alias with a real turn before adding a
 * row**: `claude -p ok --model <alias> --output-format json | jq '.is_error, .modelUsage'`.
 *
 * A tier alias always points at the newest member of its family, so these rows do NOT age out on a
 * model launch — only the version text in the row does. Verified 2026-09-23:
 * `opus` → `claude-opus-5-5`, `fable` → `claude-fable-5-1`, `sonnet` → `claude-sonnet-5`,
 * `haiku` → `claude-haiku-4-5-20251001`. Re-read 2026-10-14 from CLI 2.1.299's live
 * `supportedModels()`: `sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-5-5` (both moved in
 * CLI 2.1.293).
 *
 * Every row is effort-capable (`supportsEffort` + `supportedEffortLevels`) and carries
 * `supportsAutoMode: true`, which surfaces the `auto` permission mode (a model classifier). `haiku`
 * used to advertise neither: Haiku 4.5 had no effort levels and the original drops `auto` on it.
 * Haiku 5.5 has both, per the live CLI rows.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    // Story 069 (R3): `default` resolves to the recommended Opus, so it carries the Opus description.
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "fable",
    // The title carries the concrete version, matching the live CLI rows this list stands in for.
    displayName: "Fable 5.1",
    // The tier alias, PROBED not guessed: `--model fable` resolves to `claude-fable-5-1` on a real
    // turn (2026-09-23). It replaces the `fable51`/`fable5` rows, which the CLI rejected outright —
    // see the closed-set note on MODEL_CATALOG above.
    // The description is the same string the live `/model` picker shows for the top of the
    // family — the CLI ships exactly three taglines and none is 5.1-specific, so this is
    // verbatim rather than invented.
    description:
      "Fable 5.1 with 1M context · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    displayName: "Opus 5.5",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    // Item 93: `sonnet` resolves to `claude-sonnet-5-5` since CLI 2.1.293 (the baked-in catalogue's
    // `aliases.sonnet.default`); the tagline is the live row's, verbatim (CLI 2.1.299).
    displayName: "Sonnet 5.5",
    description: "Sonnet 5.5 with 1M context · Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    // Item 93: `haiku` resolves to `claude-haiku-5-5` since CLI 2.1.293 — native 1M context, 128k
    // output, and the full effort set (`capabilities: ["effort","max_effort","xhigh_effort",…]` in the
    // baked-in catalogue). The live `supportedModels()` row (CLI 2.1.299) carries `supportsEffort`,
    // all five levels and `supportsAutoMode`, so the fallback row does too.
    displayName: "Haiku 5.5",
    description: "Haiku 5.5 with 1M context · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: REASONING_EFFORT_LEVELS,
    supportsAutoMode: true,
  },
];

/**
 * Story 068 (R1, R1.1, R2) — the REAL per-alias context window, keyed by the EXACT {@link MODEL_CATALOG}
 * `value`. Every alias is natively 1M today; `haiku` was 200K until it moved to Haiku 5.5 (item 93).
 * Older generations are NOT uniform, which is why {@link MODEL_ID_CONTEXT_WINDOWS} refines per turn. This map is the single source of truth that `inferContextWindowFromModel` (acp-agent.ts)
 * consults BEFORE the `\b1m\b` regex fallback — the bug it fixes is `opus` having wrongly reported 200K
 * (the regex only ever matched the literal `1m` token).
 *
 * `sonnet` seeds to 1M because plain `sonnet` now resolves to Sonnet 5, which is natively 1M (the
 * redundant `sonnet[1m]` alias was dropped). `default` and `opus` both resolve to Opus 5.5 and `fable`
 * to Fable 5.1 — all three natively 1M per the CLI's baked-in catalogue. This is only the
 * PRE-FIRST-TURN seed: once a turn arrives, `inferContextWindowFromModelId` (story 069) AUTHORITATIVELY
 * refines the window from the transcript's real `model`. Keys MIRROR `MODEL_CATALOG` `value`s; the drift
 * guard lives in the test (068 anti-drift: every catalog value has an explicit entry).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  default: 1_000_000,
  fable: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  // Item 93: Haiku 5.5 is native 1M. Seeding 200K made every Haiku turn report 5x the real usage.
  haiku: 1_000_000,
};

/**
 * Story 069 (R1.1) — the REAL context window per concrete model ID, mirroring the claude CLI's
 * `context:{window}` table. Used to AUTHORITATIVELY refine the window from a turn's actual `model`
 * (the JSONL `model` field), correcting the alias seed. Opus is NOT uniform: 4.6 = 200K, 4.7+ = 1M.
 * Dated snapshots / future versions are covered by the family+version heuristic in
 * `inferContextWindowFromModelId`; this table is the exact-ID source of truth for today's gateway IDs.
 *
 * Windows are READ FROM THE CLI'S OWN BAKED-IN CATALOGUE (`context.window` / `native_1m` in the JSON
 * the `claude` binary embeds), not from the picker copy: `claude-opus-5-5` and `claude-opus-5` are
 * both `window: 1e6, native_1m: true`, which is why neither needs a `[1m]` suffix to get 1M.
 */
export const MODEL_ID_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * Story 081 (R1.2) — map a turn's REAL model id (the JSONL `model`) onto a catalog `value`, so a
 * RESUMED session can seed its model selector from the transcript instead of the static `default`.
 *
 * Deliberately the same shape as {@link inferContextWindowFromModelId}: match by FAMILY (not exact
 * id) so dated snapshots (`claude-sonnet-4-5-20250929`) and the `[1m]` long-context suffix resolve,
 * and return `null` for anything unplaceable. `null` is meaningful — it routes the caller to leave
 * the existing seed untouched (R2.1), mirroring 069's `?? session.contextWindowSize`.
 *
 * TOTAL FUNCTION: never throws, whatever it is handed. Every returned string is a `value` present in
 * {@link MODEL_CATALOG}; returning anything else would make the selector advertise an entry the
 * client cannot select (asserted in `test/resumed-model.test.ts`).
 *
 * NOTE the asymmetry with the catalog's `default` entry: `default` and `opus` denote the SAME model
 * (see the `MODEL_CATALOG` comment at `value: "default"`), so a `claude-opus-*` id resolves to
 * `opus` here and the CALLER is responsible for treating a `default` seed as already-correct (R1.3)
 * — that equivalence is a UI concern, not a catalog one.
 */
export function resolveCatalogValueFromModelId(id: string): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  if (/claude-opus/.test(id)) return "opus";
  if (/claude-fable/.test(id)) return "fable";
  if (/claude-sonnet/.test(id)) return "sonnet";
  if (/claude-haiku/.test(id)) return "haiku";
  return null;
}

/**
 * The selector description, which is now simply the row's own `description`.
 *
 * Story 072 used to compose `"<version label> · <tagline>"` from a curated
 * MODEL_VERSION_LABELS map, because the hand-written rows carried only a bare
 * tagline and the concrete version lived nowhere else. That map is GONE, and
 * removing it was not cleanup — it was a correctness fix. Rows now arrive from
 * the CLI (see `live-model-catalog.ts`) already carrying the version in both
 * `displayName` and `description`, so prepending a curated prefix produced
 * doubled copy ("Opus 5.5 with 1M context · Opus 5.5 · Best for everyday…") and,
 * worse, could contradict the live row outright once the label went stale.
 *
 * The static {@link MODEL_CATALOG} rows were made self-contained to match, so
 * this function needs no branch: the fallback path and the live path render the
 * same way, which is exactly what "the picker matches the CLI" has to mean.
 *
 * Kept as a named function rather than inlined at the call site: it is the one
 * place to put display policy back if a client ever needs different copy.
 * PURE + TOTAL — never throws on a missing description.
 */
export function modelSelectorDescription(info: ModelInfo): string {
  return info.description ?? "";
}

/**
 * Story 073 (R5.1) — the catalog `value`s that support fast mode (`/fast on|off`). Fast mode "uses
 * Claude Opus with faster output (it does not downgrade to a smaller model)"; the CLI turns it off when
 * switching to a model without it. The gate is a CAPABILITY, not a version range — the CLI's baked-in
 * catalogue lists `fast_mode` on `claude-opus-5-5`, `claude-opus-5` and `claude-opus-4-8`, and on no
 * Fable, Sonnet or Haiku row. `default` resolves to the recommended Opus, so both `default` and `opus`
 * qualify; `fable`/`sonnet`/`haiku` do NOT.
 *
 * Kept HERE (not on {@link ModelInfo}) because `ModelInfo` is the SDK shape and cannot carry a
 * fork-only `supportsFastMode` field — the same reason the effort/auto flags that DO exist on the SDK
 * type live inline while this predicate is external.
 */
export const FAST_MODE_MODELS: ReadonlySet<string> = new Set(["default", "opus"]);

/** Story 073 (R5.1) — true when the catalog `value` is an Opus alias that supports fast mode. */
export function isFastModeCapableModel(value: string): boolean {
  return FAST_MODE_MODELS.has(value);
}

// --- Story 074 / #828 — fast-mode config-option surface (reconcile with upstream v0.57) ----------
// Upstream #828 exports the fast-mode identity as constants, negotiates `type:"boolean"` when the
// client advertises it (select fallback otherwise), and resolves a boolean OR on/off payload. The fork
// adopts that SURFACE while keeping its PTY `/fast on|off` inject and the FAST_MODE_MODELS gate (the
// SDK `applyFlagSettings`/`fast_mode_state`/`cooldown` reconcile has no PTY equivalent — CUT).

/** Story 074 (R4.2) — the fork's fast-mode config-option id, replacing the inline `"fast"` literal. */
export const FAST_MODE_CONFIG_ID = "fast";
/** Story 074 (R4.2) — the on/off select values, replacing the inline `"on"`/`"off"` literals. */
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";

/**
 * Story 074 (R4.1) — did the client advertise support for boolean session config options
 * (`clientCapabilities.session.configOptions.boolean`)? A present (non-null) object — even `{}` —
 * means the agent may emit `type:"boolean"` entries and the client may send boolean `set_config_option`
 * values. Read from the `initialize()`-stored capabilities; NO createSession/prompt touch (R4.5).
 */
export function clientSupportsBooleanConfigOptions(caps?: ClientCapabilities | null): boolean {
  const booleanCap = caps?.session?.configOptions?.boolean;
  return booleanCap !== null && booleanCap !== undefined;
}

/**
 * Story 074 (R4.3) — resolve the intended fast-mode ENABLED state from a `set_config_option` payload
 * that may be a boolean (a client using the boolean option) OR the `"on"`/`"off"` string (the select
 * fallback). Any non-`"on"` string (and any other shape) resolves to OFF — a toggle never half-applies.
 */
export function resolveFastModeEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return value === FAST_MODE_ON;
}

/**
 * Story 074 (R4.1) — build the `fast` config option. Emits `type:"boolean"` (currentValue tracks the
 * toggle) when the client advertised boolean config options, else the `on`/`off` select fallback. The
 * external ACP `id` and on/off values are unchanged from story 073; only the type negotiation aligns
 * with upstream #828. The PTY `/fast on|off` inject mechanism and the FAST_MODE_MODELS gate are kept.
 */
export function createFastModeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast Mode",
    description:
      "Faster Opus output at a higher usage-credit rate (/fast). Turns off on non-Opus models.",
    category: "model" as const,
  };
  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }
  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    // Per-option descriptions mirror the `model` selector — Zed renders the selected option's
    // description as the selector tooltip (an omitted per-option description shows no tooltip).
    options: [
      { value: FAST_MODE_OFF, name: "Off", description: "Standard Opus output speed." },
      {
        value: FAST_MODE_ON,
        name: "On",
        description: "Faster Opus output — draws from usage credits at a higher rate.",
      },
    ],
  };
}

/**
 * Story 073 (R1) — the verdict of parsing the `/fast` panel captured from the live PTY:
 *   - `"available"`   — the panel rendered its On/Off toggle (no gate line) → advertise the toggle.
 *   - `"unavailable"` — the panel rendered a gate line ("requires usage credits", etc.) → omit it.
 *   - `"pending"`     — the panel has not fully rendered yet (or is still checking) → keep waiting; the
 *                       caller fails CLOSED (treats it as unavailable) once its bounded window elapses.
 */
export type FastModeSignal = "available" | "unavailable" | "pending";

/**
 * Story 073 (R1) — strip the ANSI/OSC/CSI control sequences the interactive TUI interleaves so the
 * marker substrings below match on the plain text. Deliberately conservative (removes only escape
 * sequences, never printable bytes) so a marker can never be split apart by cursor-addressing codes.
 */
function stripControlSequences(raw: string): string {
  // Control chars in these regexes are intentional: we are matching ANSI/OSC
  // escape sequences (ESC/BEL), never printable text, so no-control-regex is
  // suppressed by design.
  /* eslint-disable no-control-regex */
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ...BEL / ST
    .replace(/\x1b[@-Z\\-_]/g, "") // 2-byte ESC (Fe)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""); // CSI ...final
  /* eslint-enable no-control-regex */
}

/**
 * Story 073 (R1) — the `/fast` panel header, present in BOTH the available and gated renders (verified
 * live in the spike). Its presence means the panel finished rendering, so a verdict can be reached; its
 * absence means "not rendered yet" → pending.
 */
const FAST_PANEL_ANCHORS = [/fast mode \(research preview\)/i, /high-speed mode for opus/i];

/** Story 073 (R1) — still resolving. Checked BEFORE the gate markers because the CLI renders this as
 *  `Fast mode unavailable: Checking fast mode availability`, which also matches a gate substring. */
const FAST_PENDING_MARKERS = ["checking fast mode availability"];

/**
 * Story 073 (R1) — gate lines that mean fast mode is NOT usable for this account. ANY match ⇒
 * unavailable. `requires usage credits` is the LIVE-captured signal from the spike (Opus 4.8 · Claude
 * Max, no credits); the rest are the sibling reasons mined from the pinned CLI binary (2.1.198): free/
 * oauth → paid subscription, org preference → disabled, first-party gate → Anthropic-API-only, plus the
 * generic `Fast mode unavailable: <reason>` and `Fast mode is not available` families.
 */
const FAST_UNAVAILABLE_MARKERS = [
  "requires usage credits",
  "requires a paid subscription",
  "unavailable during evaluation",
  "has been disabled by your organization",
  "only available when using the anthropic api directly",
  "fast mode unavailable", // generic `Fast mode unavailable: <reason>`
  "fast mode is not available",
  "fast mode is currently unavailable",
];

/**
 * Story 073 (R1) — classify the `/fast` panel text captured from the live PTY into a {@link FastModeSignal}.
 *
 * Pure and side-effect free so it is unit-testable against the spike's live capture; the live PTY drive
 * that FEEDS it lives behind the `FastModeProbe` seam (acp-agent `defaultFastModeProbe`). Order matters:
 * pending is checked first (its text also matches a gate substring), then the gate markers, then — only
 * once the panel anchor confirms a full render with NO gate line — `available`. Anything else is
 * `pending`, and the caller fails closed on timeout (R1.2).
 */
export function classifyFastModeSignal(raw: string): FastModeSignal {
  const text = stripControlSequences(raw).toLowerCase();
  if (FAST_PENDING_MARKERS.some((m) => text.includes(m))) return "pending";
  if (FAST_UNAVAILABLE_MARKERS.some((m) => text.includes(m))) return "unavailable";
  // No gate line. If the panel finished rendering (anchor present), the On/Off toggle is usable.
  if (FAST_PANEL_ANCHORS.some((re) => re.test(text))) return "available";
  return "pending"; // panel not rendered yet → keep waiting within the caller's bounded window
}

/** The safe fallback entry, kept as a named export so callers can seed/anchor on it without a lookup. */
export const DEFAULT_MODEL_INFO: ModelInfo = MODEL_CATALOG[0];
