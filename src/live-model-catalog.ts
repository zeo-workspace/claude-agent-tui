import type { ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { MODEL_CATALOG } from "./model-catalog.js";
import { filterSupersededModels } from "./model-recency.js";
import { resolveClaudePath } from "./claude-path.js";

/**
 * The model picker, read from the CLI at runtime instead of curated by hand.
 *
 * WHY THIS REPLACED A STATIC LIST. `model-catalog.ts` was written when the CLI
 * appeared to expose no way to enumerate models, and that premise was wrong: the
 * SDK's `query().supportedModels()` is exactly such an endpoint, and this package
 * already depends on the SDK. The hand-curated list cost two silent bugs in one
 * month — `fable51`/`fable5`, aliases the CLI rejects outright, and an `Opus 4.8`
 * label on rows that had been serving Opus 5.5 for weeks. Neither failed a test,
 * because there was nothing to compare the list against.
 *
 * WHAT MADE IT UNFIXABLE BY HAND. The catalogue is served by the BACKEND, not
 * baked into the installed CLI. Measured 2026-09-23, it alternated between two
 * shapes within minutes under a fixed binary — five rows with `[1m]`-suffixed
 * values and bare family titles ("Fable", "Opus (1M context)"), and eleven rows
 * with version-bearing titles ("Fable 5.1", "Opus 5.5") and different taglines
 * entirely. No snapshot of either is right for long, so the only list that stays
 * correct is the one fetched.
 *
 * **It must be the PATH `claude`, never the SDK's embedded binary.** That is the
 * keystone this whole fork rests on: the PATH binary bills as subscription
 * (`entrypoint == 'cli'`), the SDK-embedded one bills as credit — see
 * `claude-path.ts`. Pointing the fetch at the embedded binary would also read a
 * DIFFERENT catalogue from the one the PTY actually runs, which is the exact
 * divergence this module exists to close. Both reasons point the same way.
 *
 * FAIL-SOFT, ALWAYS. Every failure path — no CLI on PATH, a spawn error, a
 * control-request timeout, an empty answer — falls back to {@link MODEL_CATALOG}.
 * The static list is therefore no longer the source of truth, but it is still the
 * floor: a picker with stale rows beats a session that cannot start.
 *
 * @module live-model-catalog
 */

/** How long a fetched catalogue is reused before the next session refetches it. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** How long to wait for `supportedModels()` before falling back. */
export const CATALOG_TIMEOUT_MS = 20_000;

/** Injectable seam: returns the raw SDK rows. Replaced wholesale in tests — no spawn, no CLI. */
export type SupportedModelsSource = () => Promise<ModelInfo[]>;

interface CatalogLogger {
  log: (...args: unknown[]) => void;
}

interface CacheEntry {
  models: ModelInfo[];
  at: number;
  /** The source that produced `models`: a cached read is served only to a caller of the same source. */
  source: SupportedModelsSource;
}
let cache: CacheEntry | null = null;
/** Whether the fallback has already been reported in this process. See {@link resolveModelCatalog}. */
let fallbackReported = false;

/** Drop the memoised catalogue AND the once-per-process report latch. Tests use it; production does not. */
export function resetLiveModelCatalogCache(): void {
  cache = null;
  fallbackReported = false;
}

/**
 * Environment variable that selects where the default source reads from.
 * `builtin` serves {@link MODEL_CATALOG} without spawning anything — an offline
 * knob for production, and what the test harness sets on every adapter it spawns
 * as a child process. Unset (or any other value) means the live CLI read.
 */
export const MODEL_CATALOG_ENV = "CLAUDE_TUI_MODEL_CATALOG";

/**
 * Opt-in for a test that genuinely needs the live CLI read. Without it, the live
 * source refuses to run under the node test runner — see {@link LiveCatalogInTestsError}.
 */
export const LIVE_CATALOG_TESTS_ENV = "CLAUDE_TUI_LIVE_CATALOG_TESTS";

/**
 * Raised when the LIVE source is reached from inside `node --test` without the
 * {@link LIVE_CATALOG_TESTS_ENV} opt-in.
 *
 * WHY IT EXISTS. Each test file runs in its own process with an empty cache, and
 * most suites create sessions without injecting a catalogue. Before this guard,
 * one `npm run test:fork` spawned ~50 real CLI sessions — each loading the
 * user's hooks, plugins and MCP servers — and five runs made 248 SDK sessions in
 * 17 minutes (measured 2026-10-14). The test setup module installs a stub as the
 * default source; this error is the tripwire for anything that bypasses it.
 *
 * {@link resolveModelCatalog} rethrows it instead of falling back, so the test
 * that reached the live read FAILS rather than passing on the built-in list.
 * `NODE_TEST_CONTEXT` is set only by node's test runner, so production never
 * sees this.
 */
export class LiveCatalogInTestsError extends Error {
  constructor() {
    super(
      "the live model catalogue (a real `claude` spawn) was requested under the node test runner. " +
        "Run tests through `npm run test:fork` (it preloads test/helpers/test-setup.ts, which installs " +
        "the stub), inject `deps.modelCatalogSource`, or opt in with " +
        `${LIVE_CATALOG_TESTS_ENV}=1 for a test that truly needs the CLI.`,
    );
    this.name = "LiveCatalogInTestsError";
  }
}

/** Throws {@link LiveCatalogInTestsError} under `node --test` unless the live opt-in is set. */
export function assertLiveCatalogAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_TEST_CONTEXT && env[LIVE_CATALOG_TESTS_ENV] !== "1") {
    throw new LiveCatalogInTestsError();
  }
}

/** Set by {@link setDefaultModelCatalogSource}; `undefined` means the live CLI read. */
let defaultOverride: SupportedModelsSource | undefined;

/**
 * Replace the source used when a caller passes none. Only the test setup module
 * calls this (test/helpers/test-setup.ts, preloaded by `npm run test:fork`), so
 * every session a test creates reads a fixed catalogue instead of the host CLI.
 * Pass `undefined` to restore the live read. Production never calls it.
 */
export function setDefaultModelCatalogSource(source: SupportedModelsSource | undefined): void {
  defaultOverride = source;
  cache = null;
}

/** The source a caller without its own gets: the test override, or the live read. */
function defaultSource(): Promise<ModelInfo[]> {
  return defaultOverride ? defaultOverride() : liveSource();
}

/**
 * A prompt stream that never yields a message and ends only when `signal` aborts.
 *
 * This is what keeps the catalogue read INERT. `query({ prompt: "" })` does not
 * mean "no prompt": the SDK submits the empty string as a real user turn, the
 * model answers it, and that answer is billed. Measured 2026-10-14: the session
 * transcript held a user record with a `promptId`, and 51 Opus responses were
 * billed across one day's test runs. With streaming input and no message, the
 * CLI starts, answers control requests such as `supportedModels()`, and never
 * has a turn to run.
 */
export function silentPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const ended = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    const end = () => resolve({ value: undefined, done: true });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
  });
  // Every `next()` waits for the abort and then reports the end: no message is ever produced.
  return { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
}

/**
 * The SDK options of the catalogue read, and why each one is there.
 *
 * - `settingSources: ["user"]` — the user's own settings still shape the list
 *   (`availableModels`, `env`, a model override), so the picker matches what
 *   their CLI would offer.
 * - `settings: { disableAllHooks: true }` — the inline settings are the flag
 *   layer, which outranks the user file, so the user's hooks (SessionStart,
 *   SessionEnd, statusLine…) do not run for a read that is not a session.
 *   Without it, every catalogue read fired them like a real session.
 * - `strictMcpConfig` with no `mcpServers` — no MCP server is started.
 * - `persistSession: false` — nothing is written under `~/.claude/projects/`.
 */
export function catalogQueryOptions(pathToClaudeCodeExecutable: string): Options {
  return {
    pathToClaudeCodeExecutable,
    settingSources: ["user"],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
  };
}

/** The slice of the SDK's `query` the catalogue read uses; injectable so tests need no spawn. */
export type CatalogQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Pick<Query, "supportedModels" | "close">;

/**
 * Read the model list from a CLI started with {@link catalogQueryOptions} and
 * {@link silentPrompt}, then close it. `supportedModels()` is a control request,
 * not a turn: with no message on the prompt stream, no model call is made and
 * no quota is used.
 */
export async function readSupportedModels(
  queryFn: CatalogQueryFn,
  pathToClaudeCodeExecutable: string,
): Promise<ModelInfo[]> {
  const stop = new AbortController();
  const q = queryFn({
    prompt: silentPrompt(stop.signal),
    options: catalogQueryOptions(pathToClaudeCodeExecutable),
  });
  try {
    return await q.supportedModels();
  } finally {
    // Never let a failed teardown mask a successful read.
    try {
      q.close();
    } catch {
      /* the process is going away regardless */
    }
    // Release the prompt stream, so nothing waits on it after the CLI is gone.
    stop.abort();
  }
}

/** The production source: the PATH `claude`, read inertly. See {@link readSupportedModels}. */
async function liveSource(): Promise<ModelInfo[]> {
  assertLiveCatalogAllowed();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return readSupportedModels(query, resolveClaudePath());
}

/** Reject after {@link CATALOG_TIMEOUT_MS} so a hung control request cannot stall session creation. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`model catalogue fetch timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Rewrite the `default` row's description to NAME the model it resolves to.
 *
 * The CLI ships `default` with a description of its own ("Opus 5.5 · Best for
 * everyday, complex tasks"), which tells the user everything except the one thing
 * the row is ambiguous about — which model "Default (recommended)" actually is
 * today. Upstream `claude-agent-acp` and `claude-agent-plus` both replace it with
 * the sibling row's title ("Opus 5.5"), and this fork matches them: three
 * adapters rendering the same catalogue should render it the same way.
 *
 * The sibling is found by shared `resolvedModel`, never by family name or
 * position — the alias that resolves alongside `default` is exactly the row whose
 * title is the honest answer. With no sibling and no `resolvedModel` the row is
 * returned UNTOUCHED, which is the only safe move: an invented description would
 * be worse than the vendor's own.
 *
 * Returns a new array; the untouched rows keep their identity.
 */
export function nameDefaultRow(models: ModelInfo[]): ModelInfo[] {
  const defaultRow = models.find((m) => m.value === "default");
  const resolved = defaultRow?.resolvedModel;
  if (!defaultRow || !resolved) return models;
  const sibling = models.find((m) => m.value !== "default" && m.resolvedModel === resolved);
  const description = sibling?.displayName ?? resolved;
  return models.map((m) => (m === defaultRow ? { ...m, description } : m));
}

/**
 * The picker list for a new session: the live catalogue with superseded
 * generations removed, or {@link MODEL_CATALOG} if anything at all goes wrong.
 *
 * Memoised for {@link CATALOG_TTL_MS}, because the alternative is one CLI spawn
 * per session and the catalogue does not move on that timescale. A fallback is
 * NEVER cached: a CLI that was missing when the first session started may be
 * present by the next one, and caching the failure would keep the picker stale
 * for the rest of the process.
 *
 * @param logger - Where a fallback is reported. Optional, for library callers.
 * @param source - Test seam; defaults to spawning the PATH `claude` (see {@link defaultSource}).
 */
export async function resolveModelCatalog(
  logger?: CatalogLogger,
  source: SupportedModelsSource = defaultSource,
): Promise<ModelInfo[]> {
  // The offline knob: the built-in list, served as-is, with nothing spawned.
  if (source === defaultSource && !defaultOverride && process.env[MODEL_CATALOG_ENV] === "builtin")
    return MODEL_CATALOG;
  // Keyed by source, so an injected catalogue never answers for the CLI and vice versa (item 93).
  if (cache && cache.source === source && Date.now() - cache.at < CATALOG_TTL_MS)
    return cache.models;
  try {
    const raw = await withTimeout(source(), CATALOG_TIMEOUT_MS);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("the CLI returned no models");
    }
    const models = nameDefaultRow(filterSupersededModels(raw));
    // filterSupersededModels fails open, so an empty result here means the input
    // was empty — already excluded above. Guard anyway: an empty picker is worse
    // than a stale one, and this function must never return one.
    const resolved = models.length > 0 ? models : raw;
    cache = { models: resolved, at: Date.now(), source };
    return resolved;
  } catch (error) {
    // The test tripwire must fail the test that reached it, not degrade quietly.
    if (error instanceof LiveCatalogInTestsError) throw error;
    // `log`, NOT `error`, and ONCE per process. Both halves are deliberate.
    //
    // Level: this path is degraded-but-recovered — the picker still works, from
    // the built-in list. An unreachable CLI that actually matters surfaces
    // LOUDLY a moment later, when `resolveClaudePath` throws out of the PTY
    // engine; raising ERROR here would be a second alarm for a fault that
    // already has one, or a false alarm for a fetch that merely timed out.
    //
    // Once: the condition does not change between sessions in a process, so
    // re-reporting it per session is pure noise. It also stopped two unrelated
    // suites dead — they assert an exact error count on the agent, and a
    // per-session ERROR from here made it 2 where they expect 1. That was a real
    // defect this caught, not a test to loosen.
    if (!fallbackReported) {
      fallbackReported = true;
      logger?.log(
        `Could not read the model catalogue from the CLI; using the built-in list for this process. ${String(error)}`,
      );
    }
    return MODEL_CATALOG;
  }
}
