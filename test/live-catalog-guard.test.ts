// The test suite must never read the model catalogue from the real `claude`.
//
// That read is a full CLI session (hooks, plugins, MCP servers), and every test file runs in its own
// process with an empty cache: before this guard one `npm run test:fork` spawned ~50 of them, and
// five runs made 248 SDK sessions in 17 minutes (measured 2026-10-14). These tests pin the three
// layers that keep the count at zero — the preloaded stub default, the `builtin` env for spawned
// adapters, and the tripwire that turns any bypass into a failing test instead of a silent spawn.
//
// node:test runner (build first; the setup module is what `npm run test:fork` preloads):
//   npm run build && node --experimental-strip-types --import ./test/helpers/test-setup.ts \
//     --test test/live-catalog-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelCatalog,
  resetLiveModelCatalogCache,
  setDefaultModelCatalogSource,
  assertLiveCatalogAllowed,
  LiveCatalogInTestsError,
  MODEL_CATALOG_ENV,
  LIVE_CATALOG_TESTS_ENV,
} from "../dist/live-model-catalog.js";
import { MODEL_CATALOG } from "../dist/model-catalog.js";
import { STUB_MODEL_CATALOG, stubModelCatalogSource } from "./helpers/stub-model-catalog.ts";

const recorder = () => {
  const lines: unknown[][] = [];
  return { lines, log: (...args: unknown[]) => void lines.push(args) };
};

test("the test runner is detected: NODE_TEST_CONTEXT is set in this process", () => {
  // Every other assertion here depends on it; if node ever stops setting it, the tripwire is off.
  assert.ok(process.env.NODE_TEST_CONTEXT, "node --test must set NODE_TEST_CONTEXT in test processes");
});

test("the preloaded setup makes the stub the DEFAULT source: no injection, no spawn", async () => {
  resetLiveModelCatalogCache();
  const logger = recorder();
  const models = await resolveModelCatalog(logger);
  assert.deepEqual(
    models.map((m) => m.value),
    STUB_MODEL_CATALOG.map((m) => m.value),
    "a session that injects nothing must get the stub rows, not the host CLI's",
  );
  assert.equal(logger.lines.length, 0, "the stub is not a fallback: nothing may be reported");
});

test("the setup also marks spawned adapters as builtin-only", () => {
  assert.equal(process.env[MODEL_CATALOG_ENV], "builtin");
});

test("tripwire: with no default installed, reaching the live read FAILS instead of spawning", async () => {
  const savedOptIn = process.env[LIVE_CATALOG_TESTS_ENV];
  const savedEnv = process.env[MODEL_CATALOG_ENV];
  delete process.env[LIVE_CATALOG_TESTS_ENV];
  delete process.env[MODEL_CATALOG_ENV];
  setDefaultModelCatalogSource(undefined);
  resetLiveModelCatalogCache();
  try {
    // Rethrown, NOT swallowed into the built-in fallback: a silent fallback is how a suite could
    // keep passing while it spawned the CLI.
    await assert.rejects(resolveModelCatalog(recorder()), LiveCatalogInTestsError);
  } finally {
    setDefaultModelCatalogSource(stubModelCatalogSource);
    if (savedOptIn !== undefined) process.env[LIVE_CATALOG_TESTS_ENV] = savedOptIn;
    if (savedEnv !== undefined) process.env[MODEL_CATALOG_ENV] = savedEnv;
    resetLiveModelCatalogCache();
  }
});

test("the builtin knob serves the built-in list as-is, with nothing spawned", async () => {
  setDefaultModelCatalogSource(undefined);
  resetLiveModelCatalogCache();
  try {
    // MODEL_CATALOG_ENV is `builtin` here (set by the setup module), so the tripwire is never reached.
    const models = await resolveModelCatalog(recorder());
    assert.equal(models, MODEL_CATALOG);
  } finally {
    setDefaultModelCatalogSource(stubModelCatalogSource);
    resetLiveModelCatalogCache();
  }
});

test("assertLiveCatalogAllowed: the opt-in and production environments pass, the test runner does not", () => {
  assert.throws(() => assertLiveCatalogAllowed({ NODE_TEST_CONTEXT: "child-v8" }), LiveCatalogInTestsError);
  assert.doesNotThrow(() =>
    assertLiveCatalogAllowed({ NODE_TEST_CONTEXT: "child-v8", [LIVE_CATALOG_TESTS_ENV]: "1" }),
  );
  assert.doesNotThrow(() => assertLiveCatalogAllowed({}), "production (no test runner) is never blocked");
});
